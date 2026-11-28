/**
 * Remote mode: reach this review from another device (a phone) through a
 * relay. The server dials OUT to the relay over one WebSocket, so nothing on
 * this machine listens beyond loopback; every request the relay hands down
 * becomes a plain call to this server on 127.0.0.1, and the reply streams back
 * (the live update stream included).
 *
 * The link it hands out is `<relay>/s/<session>`, and it pairs once: the first
 * device to confirm on it is paired with the session, and the relay refuses the
 * link after that (a later try arrives here as a `knock`). A remote device gets
 * the reviewer's role only (see access.ts). The relay sees the traffic;
 * end-to-end encryption is the next phase.
 *
 * Protocol v2 (frames are JSON text). Relay → here: `ready {claimed, expiresAt,
 * device?}`, `claimed {device, expiresAt}`, `knock {at, ua, country}`,
 * `req {id,method,path,headers,body}`, `cancel {id}`, `pong`. Here → relay:
 * `hello {v:2, token, key}` first, then `head {id,status,headers}`,
 * `data {id,b64}`*, `end {id}`, `error {id,message}`, `ping`, and `bye` to end
 * the session for good.
 *
 * The access key is held here and sent in `hello` only: it never appears in a
 * log line, an error, or a status.
 */
import { randomBytes } from 'node:crypto'

/** Marks a request that came through the relay, for routes the reviewer's
 * remote device must not reach (re-pointing the tunnel itself). */
export const VIA_RELAY_HEADER = 'x-diffo-via'
export const VIA_RELAY_VALUE = 'relay'

const CHUNK = 192 * 1024 // raw bytes per data frame; base64 stays well under the relay's 1 MiB frame cap
const HIGH_WATER = 4 * 1024 * 1024 // past this much unsent, a response waits for the socket
const DRAIN_POLL_MS = 20
const PING_MS = 25_000
const READY_TIMEOUT_MS = 8_000
const MAX_BACKOFF_MS = 15_000
const UA_MAX = 200
// The request headers passed to the local server. An allowlist: the server is
// answering a loopback client now, so everything else a device might send
// (host, origin, cookie, authorization, every x-* and so every x-diffo-*,
// which speak for the CLI or the agent) is dropped, known or not.
const FORWARD = new Set([
  'accept',
  'accept-language',
  'cache-control',
  'content-type',
  'if-modified-since',
  'if-none-match',
  'last-event-id',
  'user-agent',
])

/** Close codes the relay ends a tunnel with, and what each means here. A code
 * not listed (4002 a bad frame, a dropped network) is worth a reconnect. */
const FINAL: Record<number, string> = {
  4000: 'replaced by a newer tunnel',
  4001: 'the relay refused this tunnel: the session has another owner',
  4003: 'relay refused the access key',
  4004: 'remote session expired; run `diffo --remote` for a new link',
}

/**
 * The relay's base URL, or null when it isn't one: http(s) only, no path
 * beyond `/`, and plain http only for a relay on this machine (a dev relay).
 */
export function normalizeRelayUrl(raw: string): string | null {
  let url: URL
  try {
    url = new URL(raw.trim())
  } catch {
    return null
  }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) return null
  if (url.search || url.hash || url.username || url.password) return null
  if (url.pathname !== '/' && url.pathname !== '') return null
  return `${url.protocol}//${url.host}`
}

/** The device a session is paired with, as the relay saw it. */
export interface RemoteDevice {
  /** Its user agent: what the device said about itself, so untrusted. */
  ua: string
  /** Two-letter country code, or null when the relay could not tell. */
  country: string | null
  at: number
}

/** Control characters (C0, DEL, C1) and the Unicode bidi overrides: a user
 * agent is printed to terminals and logs, where these would rewrite the line. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: the point is to match them
const UNPRINTABLE = /[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/g

export function printable(text: string, max = UA_MAX): string {
  return text.replace(UNPRINTABLE, '').slice(0, max)
}

const parseAt = (raw: unknown): number | null =>
  typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? raw : null

const parseCountry = (raw: unknown): string | null =>
  typeof raw === 'string' && /^[A-Z]{2}$/.test(raw) ? raw : null

function parseDevice(raw: unknown): RemoteDevice | null {
  if (typeof raw !== 'object' || raw === null) return null
  const d = raw as { ua?: unknown; country?: unknown; at?: unknown }
  return {
    ua: typeof d.ua === 'string' ? printable(d.ua) : '',
    country: parseCountry(d.country),
    at: parseAt(d.at) ?? Date.now(),
  }
}

/** One line naming a device, for logs and the CLI. */
export function describeDevice(device: { ua: string; country: string | null }): string {
  return `${printable(device.ua) || 'unknown device'}, ${device.country ?? 'unknown country'}`
}

type Frame =
  | { t: 'ready'; claimed?: boolean; expiresAt?: unknown; device?: unknown }
  | { t: 'claimed'; device?: unknown; expiresAt?: unknown }
  | { t: 'knock'; at?: unknown; ua?: unknown; country?: unknown }
  | { t: 'pong' }
  | {
      t: 'req'
      id: string
      method: string
      path: string
      headers: [string, string][]
      body: string | null
    }
  | { t: 'cancel'; id: string }

export interface TunnelOptions {
  relay: string
  /** The relay's access key (from the environment or `diffo remote setup`). */
  key: string
  localPort: number
  log?: (message: string) => void
}

export class RemoteTunnel {
  readonly relay: string
  readonly url: string
  // An ES private field: never enumerable, so no serializer or inspector shows it.
  readonly #key: string
  private readonly session = randomBytes(16).toString('base64url')
  private readonly token = randomBytes(32).toString('base64url')
  private readonly localPort: number
  private readonly log: (message: string) => void
  private readonly inflight = new Map<string, AbortController>()
  private ws: WebSocket | null = null
  private ping: ReturnType<typeof setInterval> | null = null
  private backoff = 500
  private stopped = false
  private isConnected = false
  private isClaimed = false
  private endedWith: string | null = null
  device: RemoteDevice | null = null
  expiresAt: number | null = null
  readonly knocks: { count: number; lastAt: number | null } = { count: 0, lastAt: null }

  constructor(options: TunnelOptions) {
    this.relay = options.relay
    this.#key = options.key
    this.localPort = options.localPort
    this.log = options.log ?? (() => {})
    this.url = `${this.relay}/s/${this.session}`
  }

  get connected(): boolean {
    return this.isConnected
  }

  /** A device has paired, so the link itself no longer works. */
  get claimed(): boolean {
    return this.isClaimed
  }

  /** Still trying: connected, or between reconnects. False once stopped or refused. */
  get active(): boolean {
    return !this.stopped
  }

  /** Why the relay ended this tunnel for good, when it did. */
  get ended(): string | null {
    return this.endedWith
  }

  get expired(): boolean {
    return this.expiresAt !== null && this.expiresAt <= Date.now()
  }

  /** Whether `key` is the one this tunnel says hello with. */
  usesKey(key: string): boolean {
    return key === this.#key
  }

  /** Connect, and resolve once the relay accepts this tunnel as the session's owner. */
  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.stop()
        reject(
          new Error(`the relay at ${this.relay} did not answer within ${READY_TIMEOUT_MS / 1000}s`),
        )
      }, READY_TIMEOUT_MS)
      this.connect({
        ready: () => {
          clearTimeout(timer)
          resolve()
        },
        refused: (why) => {
          clearTimeout(timer)
          this.stop()
          reject(new Error(why))
        },
      })
    })
  }

  /** Stop for good. `bye` also tells the relay to end the session now, so the
   * paired device is cut off rather than left to the session's expiry. */
  stop(options: { bye?: boolean } = {}): void {
    if (options.bye) this.send({ t: 'bye' })
    this.stopped = true
    this.isConnected = false
    if (this.ping) clearInterval(this.ping)
    for (const ac of this.inflight.values()) ac.abort()
    this.inflight.clear()
    try {
      this.ws?.close(1000, 'stopped')
    } catch {
      // already closed
    }
    this.ws = null
  }

  private connect(first?: { ready: () => void; refused: (why: string) => void }): void {
    if (this.stopped) return
    const ws = new WebSocket(`${this.relay.replace(/^http/, 'ws')}/__relay/connect/${this.session}`)
    this.ws = ws

    ws.addEventListener('open', () => {
      ws.send(JSON.stringify({ t: 'hello', v: 2, token: this.token, key: this.#key }))
      this.ping = setInterval(() => this.send({ t: 'ping' }), PING_MS)
    })

    ws.addEventListener('message', (event) => {
      let frame: Frame
      try {
        frame = JSON.parse(String(event.data)) as Frame
      } catch {
        return
      }
      if (frame.t === 'ready') {
        this.backoff = 500
        if (!this.isConnected && !first) this.log('remote: reconnected to the relay')
        this.isConnected = true
        this.expiresAt = parseAt(frame.expiresAt) ?? this.expiresAt
        if (frame.claimed) {
          this.isClaimed = true
          this.device = parseDevice(frame.device) ?? this.device
        }
        first?.ready()
        first = undefined
      } else if (frame.t === 'claimed') {
        this.isClaimed = true
        this.device = parseDevice(frame.device) ?? { ua: '', country: null, at: Date.now() }
        this.expiresAt = parseAt(frame.expiresAt) ?? this.expiresAt
        this.log(
          `remote: a device paired: ${describeDevice(this.device)}; the link is used up, and only that device can open the review`,
        )
      } else if (frame.t === 'knock') {
        this.knocks.count += 1
        this.knocks.lastAt = parseAt(frame.at) ?? Date.now()
        this.log(
          `remote: someone tried the used link again (${describeDevice({
            ua: typeof frame.ua === 'string' ? frame.ua : '',
            country: parseCountry(frame.country),
          })}); it was refused`,
        )
      } else if (frame.t === 'req') {
        void this.handle(frame)
      } else if (frame.t === 'cancel') {
        this.inflight.get(frame.id)?.abort()
      }
    })

    // 'error' may come alone (Node's WebSocket can fail a connect without a
    // 'close'), so both end here, once per socket.
    let ended = false
    const lost = (code: number) => {
      if (ended) return
      ended = true
      if (this.ping) clearInterval(this.ping)
      this.isConnected = false
      for (const ac of this.inflight.values()) ac.abort()
      this.inflight.clear()
      if (this.stopped || this.ws !== ws) return
      const final = FINAL[code]
      if (final !== undefined) {
        // Replaced is the relay's own housekeeping: a newer tunnel holds the
        // session, so there is nothing to tell anyone.
        if (code !== 4000) this.log(`remote: ${final}`)
        first?.refused(final)
        this.stopped = true
        this.endedWith = final
        return
      }
      if (first) {
        first.refused(`could not reach the relay at ${this.relay}`)
        return
      }
      try {
        ws.close()
      } catch {
        // already closed
      }
      this.log(
        `remote: lost the relay (${code || 'no code'}), retrying in ${Math.round(this.backoff / 1000)}s`,
      )
      setTimeout(() => this.connect(), this.backoff).unref?.()
      this.backoff = Math.min(this.backoff * 2, MAX_BACKOFF_MS)
    }
    ws.addEventListener('close', (event) => lost(event.code))
    ws.addEventListener('error', () => lost(0))
  }

  private async handle(frame: Extract<Frame, { t: 'req' }>): Promise<void> {
    // The path is appended to the loopback origin as it is, so it must be an
    // origin-relative path: anything else (`@host/…`) would send the request,
    // and whatever this server answers, to another host.
    if (typeof frame.path !== 'string' || !frame.path.startsWith('/')) {
      this.send({ t: 'error', id: frame.id, message: 'Not a path on the diffo server.' })
      return
    }
    const ac = new AbortController()
    this.inflight.set(frame.id, ac)
    try {
      const headers = new Headers()
      for (const [k, v] of frame.headers) {
        if (FORWARD.has(k.toLowerCase())) headers.append(k, v)
      }
      headers.set(VIA_RELAY_HEADER, VIA_RELAY_VALUE)
      const res = await fetch(`http://127.0.0.1:${this.localPort}${frame.path}`, {
        method: frame.method,
        headers,
        body: frame.body ? Buffer.from(frame.body, 'base64') : undefined,
        signal: ac.signal,
        redirect: 'manual',
      })
      const out: [string, string][] = []
      res.headers.forEach((v, k) => {
        out.push([k, v])
      })
      this.send({ t: 'head', id: frame.id, status: res.status, headers: out })
      if (res.body) {
        for await (const chunk of res.body as AsyncIterable<Uint8Array>) {
          for (let i = 0; i < chunk.length; i += CHUNK) {
            await this.drain(ac.signal)
            if (ac.signal.aborted) return
            this.send({
              t: 'data',
              id: frame.id,
              b64: Buffer.from(chunk.subarray(i, i + CHUNK)).toString('base64'),
            })
          }
        }
      }
      this.send({ t: 'end', id: frame.id })
    } catch (err) {
      if (!ac.signal.aborted) {
        const e = err as Error & { cause?: { code?: string } }
        this.send({
          t: 'error',
          id: frame.id,
          message: `The diffo server did not answer (${e.cause?.code ?? e.message}).`,
        })
      }
    } finally {
      this.inflight.delete(frame.id)
    }
  }

  /** Waits while the socket holds more unsent than HIGH_WATER, so one large
   * response cannot pile up in memory faster than the network takes it. */
  private async drain(signal: AbortSignal): Promise<void> {
    while (
      !signal.aborted &&
      this.ws?.readyState === WebSocket.OPEN &&
      this.ws.bufferedAmount > HIGH_WATER
    ) {
      await new Promise((r) => setTimeout(r, DRAIN_POLL_MS))
    }
  }

  private send(frame: object): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(frame))
  }
}

export interface RemoteStatus {
  url: string | null
  relay: string | null
  connected: boolean
  /** A device already paired on `url`, so it no longer works for anyone else. */
  claimed: boolean
  /** The paired device, once there is one. */
  device: RemoteDevice | null
  /** Opens of the link after it was used: someone else holding it. */
  knocks: { count: number; lastAt: number | null }
  /** When the session ends (ms epoch): the link's life while unpaired, the
   * session's once paired. */
  expiresAt: number | null
  /** Why the relay ended the tunnel for good, when it has. */
  ended: string | null
}

export const REMOTE_OFF: RemoteStatus = {
  url: null,
  relay: null,
  connected: false,
  claimed: false,
  device: null,
  knocks: { count: 0, lastAt: null },
  expiresAt: null,
  ended: null,
}

/**
 * What the server holds: at most one tunnel. Asking again re-uses it while its
 * link is still unopened and alive; once a device has paired, the session
 * expired, or the tunnel stopped, the next ask opens a fresh session with a
 * new link, and the old device is cut off.
 */
export interface RemoteControl {
  status(): RemoteStatus
  start(relay: string, key: string): Promise<RemoteStatus>
  /** End the session (`bye`) and drop the tunnel. */
  stop(): RemoteStatus
}

export function createRemoteControl(
  localPort: number,
  log?: (message: string) => void,
): RemoteControl {
  let tunnel: RemoteTunnel | null = null
  // One start at a time: two racing asks would otherwise each mint a tunnel,
  // and the one not kept would stay connected with nobody holding it.
  let turn: Promise<unknown> = Promise.resolve()
  // Bumped by stop(): a start still connecting when the reviewer turned
  // remote off must not come back to life after it.
  let generation = 0
  const status = (): RemoteStatus =>
    tunnel
      ? {
          url: tunnel.url,
          relay: tunnel.relay,
          connected: tunnel.connected,
          claimed: tunnel.claimed,
          device: tunnel.device ? { ...tunnel.device } : null,
          knocks: { ...tunnel.knocks },
          expiresAt: tunnel.expiresAt,
          ended: tunnel.ended,
        }
      : { ...REMOTE_OFF, knocks: { ...REMOTE_OFF.knocks } }
  return {
    status,
    start(relay, key) {
      const run = turn.then(() => startNow(relay, key))
      turn = run.catch(() => {})
      return run
    },
    stop() {
      generation += 1
      if (tunnel) {
        tunnel.stop({ bye: true })
        tunnel = null
        log?.('remote: turned off; the session is ended at the relay')
      }
      return status()
    },
  }

  async function startNow(relay: string, key: string): Promise<RemoteStatus> {
    const reusable =
      tunnel?.active &&
      tunnel.relay === relay &&
      tunnel.usesKey(key) &&
      !tunnel.claimed &&
      !tunnel.expired
    if (reusable) return status()
    // The old session ends at the relay too, so its device loses the review now.
    tunnel?.stop({ bye: true })
    tunnel = null
    const mine = generation
    const next = new RemoteTunnel({ relay, key, localPort, ...(log ? { log } : {}) })
    await next.start()
    if (mine !== generation) {
      next.stop({ bye: true })
      throw new Error('remote mode was turned off while it was starting')
    }
    tunnel = next
    log?.(`remote: reachable at ${relay} through the relay`)
    return status()
  }
}
