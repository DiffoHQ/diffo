import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp } from '../server/index.js'
import {
  createRemoteControl,
  normalizeRelayUrl,
  printable,
  REMOTE_OFF,
  type RemoteControl,
  type RemoteStatus,
} from './tunnel.js'

const KEY = 'k3y-SUPER-secret-0123456789'

/** A stand-in for the relay's end of the socket: records what the tunnel
 * sends, and lets a test speak the relay's frames and close codes. */
class FakeSocket {
  static readonly OPEN = 1
  static all: FakeSocket[] = []
  readyState = 0
  bufferedAmount = 0
  sent: Record<string, unknown>[] = []
  closedWith: number | null = null
  private listeners = new Map<string, ((event: unknown) => void)[]>()
  constructor(readonly url: string) {
    FakeSocket.all.push(this)
  }
  addEventListener(type: string, fn: (event: unknown) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn])
  }
  private emit(type: string, event: unknown) {
    for (const fn of this.listeners.get(type) ?? []) fn(event)
  }
  send(data: string) {
    this.sent.push(JSON.parse(data) as Record<string, unknown>)
  }
  close(code = 1000) {
    if (this.readyState === 3) return
    this.closedWith = code
    this.readyState = 3
  }
  /** The relay side. */
  open() {
    this.readyState = 1
    this.emit('open', {})
  }
  frame(frame: object) {
    this.emit('message', { data: JSON.stringify(frame) })
  }
  drop(code: number) {
    this.readyState = 3
    this.emit('close', { code })
  }
  kinds() {
    return this.sent.map((f) => f.t)
  }
}

const latest = () => FakeSocket.all.at(-1)!
const tick = () => new Promise((r) => setImmediate(r))

/** Start, and answer the hello the way the relay does. */
async function started(
  remote: RemoteControl,
  ready: object = { claimed: false, expiresAt: Date.now() + 900_000 },
  key = KEY,
): Promise<{ status: RemoteStatus; ws: FakeSocket }> {
  const pending = remote.start('https://relay.example.dev', key)
  await tick()
  const ws = latest()
  ws.open()
  ws.frame({ t: 'ready', ...ready })
  return { status: await pending, ws }
}

describe('RemoteTunnel, protocol v2', () => {
  let logs: string[]
  let remote: RemoteControl
  beforeEach(() => {
    FakeSocket.all = []
    logs = []
    vi.stubGlobal('WebSocket', FakeSocket)
    remote = createRemoteControl(4949, (m) => logs.push(m))
  })
  afterEach(() => {
    remote.stop()
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  const keyNowhere = () => {
    expect(JSON.stringify(remote.status())).not.toContain(KEY)
    expect(logs.join('\n')).not.toContain(KEY)
  }

  it('says hello v2 with its token and the access key, and reports the session', async () => {
    const expiresAt = Date.now() + 900_000
    const { status, ws } = await started(remote, { claimed: false, expiresAt })
    expect(ws.url).toMatch(/^wss:\/\/relay\.example\.dev\/__relay\/connect\/[\w-]{22}$/)
    const hello = ws.sent[0]!
    expect(hello).toMatchObject({ t: 'hello', v: 2, key: KEY })
    expect(hello.token).toMatch(/^[\w-]{43}$/)
    expect(status).toMatchObject({
      relay: 'https://relay.example.dev',
      connected: true,
      claimed: false,
      device: null,
      knocks: { count: 0, lastAt: null },
      expiresAt,
      ended: null,
    })
    expect(status.url).toMatch(/^https:\/\/relay\.example\.dev\/s\/[\w-]{22}$/)
    keyNowhere()
  })

  it('records the paired device, its user agent made printable', async () => {
    const { ws } = await started(remote)
    const expiresAt = Date.now() + 86_400_000
    ws.frame({
      t: 'claimed',
      device: {
        ua: `Phone\u001b[2J\u202eevil${'x'.repeat(300)}`,
        country: 'IL',
        at: 1_700_000_000_000,
      },
      expiresAt,
    })
    const { device, claimed, expiresAt: until } = remote.status()
    expect(claimed).toBe(true)
    expect(until).toBe(expiresAt)
    expect(device?.ua.startsWith('Phone[2Jevil')).toBe(true)
    expect(device?.ua).toHaveLength(200)
    expect(device).toMatchObject({ country: 'IL', at: 1_700_000_000_000 })
    expect(logs.some((l) => l.includes('a device paired: Phone[2Jevil'))).toBe(true)
    // A country that is not a code is no country.
    ws.frame({ t: 'claimed', device: { ua: 'x', country: '<b>', at: 1 }, expiresAt })
    expect(remote.status().device?.country).toBeNull()
    keyNowhere()
  })

  it('a device already paired before a reconnect comes back in ready', async () => {
    const { status } = await started(remote, {
      claimed: true,
      expiresAt: Date.now() + 1000,
      device: { ua: 'Safari', country: null, at: 5 },
    })
    expect(status).toMatchObject({ claimed: true, device: { ua: 'Safari', country: null, at: 5 } })
  })

  it('counts knocks on the used link', async () => {
    const { ws } = await started(remote)
    ws.frame({ t: 'knock', at: 1000, ua: 'curl', country: 'US' })
    ws.frame({ t: 'knock', at: 2000, ua: 'curl', country: 'US' })
    expect(remote.status().knocks).toEqual({ count: 2, lastAt: 2000 })
    expect(logs.filter((l) => l.includes('someone tried the used link again'))).toHaveLength(2)
  })

  it('4003: refused key fails the start, never names the key, and does not retry', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval'] })
    const pending = remote.start('https://relay.example.dev', KEY)
    await vi.advanceTimersByTimeAsync(0)
    latest().open()
    latest().drop(4003)
    const err = await pending.catch((e: Error) => e)
    expect((err as Error).message).toBe('relay refused the access key')
    expect((err as Error).message).not.toContain(KEY)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(FakeSocket.all).toHaveLength(1)
    expect(remote.status()).toEqual(REMOTE_OFF)
    keyNowhere()
  })

  it('4004: the session ended; it stops with the reason and does not retry', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval'] })
    const pending = remote.start('https://relay.example.dev', KEY)
    await vi.advanceTimersByTimeAsync(0)
    latest().open()
    latest().frame({ t: 'ready', claimed: false, expiresAt: Date.now() + 1000 })
    await pending
    latest().drop(4004)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(FakeSocket.all).toHaveLength(1)
    expect(remote.status()).toMatchObject({
      connected: false,
      ended: 'remote session expired; run `diffo --remote` for a new link',
    })
    expect(logs.some((l) => l.includes('remote session expired'))).toBe(true)
  })

  it('4000: replaced by a newer tunnel stops quietly', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval'] })
    const pending = remote.start('https://relay.example.dev', KEY)
    await vi.advanceTimersByTimeAsync(0)
    latest().open()
    latest().frame({ t: 'ready', claimed: false, expiresAt: Date.now() + 1000 })
    await pending
    const before = logs.length
    latest().drop(4000)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(FakeSocket.all).toHaveLength(1)
    expect(logs.length).toBe(before)
    expect(remote.status().ended).toBe('replaced by a newer tunnel')
  })

  it('4002 and plain drops reconnect, saying hello with the key again', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval'] })
    const pending = remote.start('https://relay.example.dev', KEY)
    await vi.advanceTimersByTimeAsync(0)
    latest().open()
    latest().frame({ t: 'ready', claimed: false, expiresAt: Date.now() + 1000 })
    await pending
    latest().drop(4002)
    await vi.advanceTimersByTimeAsync(1000)
    expect(FakeSocket.all).toHaveLength(2)
    latest().open()
    expect(latest().sent[0]).toMatchObject({ t: 'hello', v: 2, key: KEY })
    keyNowhere()
  })

  it('stop() says bye, closes, and leaves remote mode off', async () => {
    const { ws } = await started(remote)
    expect(remote.stop()).toEqual(REMOTE_OFF)
    expect(ws.kinds()).toContain('bye')
    expect(ws.closedWith).toBe(1000)
  })

  it('re-uses an unpaired live session, and mints a new one when it is used, expired, ended, or the key changed', async () => {
    const first = await started(remote)
    // Same relay, same key, unpaired: the same link, no new socket.
    expect((await remote.start('https://relay.example.dev', KEY)).url).toBe(first.status.url)
    expect(FakeSocket.all).toHaveLength(1)

    first.ws.frame({
      t: 'claimed',
      device: { ua: 'a', country: null, at: 1 },
      expiresAt: Date.now() + 1000,
    })
    const second = await started(remote)
    expect(second.status.url).not.toBe(first.status.url)
    expect(first.ws.kinds()).toContain('bye')

    const expired = await started(remote, { claimed: false, expiresAt: Date.now() - 1 })
    const third = await started(remote)
    expect(third.status.url).not.toBe(expired.status.url)

    third.ws.drop(4004)
    const fourth = await started(remote)
    expect(fourth.status.url).not.toBe(third.status.url)

    const fifth = await started(remote, undefined, 'another-key')
    expect(fifth.status.url).not.toBe(fourth.status.url)
    expect(fourth.ws.kinds()).toContain('bye')
  })

  it('waits for the socket to drain before sending more of a response', async () => {
    const chunks = [new Uint8Array(10), new Uint8Array(10)]
    vi.stubGlobal(
      'fetch',
      async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              for (const c of chunks) controller.enqueue(c)
              controller.close()
            },
          }),
        ),
    )
    const { ws } = await started(remote)
    ws.bufferedAmount = 8 * 1024 * 1024
    ws.frame({ t: 'req', id: 'r1', method: 'GET', path: '/api/review', headers: [], body: null })
    await new Promise((r) => setTimeout(r, 80))
    expect(ws.kinds()).toContain('head')
    expect(ws.kinds()).not.toContain('data')
    ws.bufferedAmount = 0
    await new Promise((r) => setTimeout(r, 80))
    expect(ws.kinds().filter((k) => k === 'data')).toHaveLength(2)
    expect(ws.kinds()).toContain('end')
  })

  it('only ever calls this server: a request target that is not a path is refused', async () => {
    const urls: string[] = []
    vi.stubGlobal('fetch', async (url: string) => {
      urls.push(url)
      return new Response('ok')
    })
    const { ws } = await started(remote)
    for (const path of ['@evil.example/x', 'http://evil.example/x', '', '.evil.example/']) {
      ws.frame({
        t: 'req',
        id: `p${urls.length}${path}`,
        method: 'GET',
        path,
        headers: [],
        body: null,
      })
    }
    ws.frame({
      t: 'req',
      id: 'ok',
      method: 'GET',
      path: '//evil.example/x',
      headers: [],
      body: null,
    })
    await new Promise((r) => setTimeout(r, 20))
    // A leading slash keeps it a path on the loopback origin, doubled or not.
    expect(urls).toEqual(['http://127.0.0.1:4949//evil.example/x'])
    expect(ws.kinds().filter((k) => k === 'error')).toHaveLength(4)
  })

  it('marks every request it hands down as relayed, whatever the device sent', async () => {
    const seen: Headers[] = []
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
      seen.push(new Headers(init.headers))
      return new Response('ok')
    })
    const { ws } = await started(remote)
    ws.frame({
      t: 'req',
      id: 'r1',
      method: 'GET',
      path: '/api/review',
      headers: [
        ['X-Diffo-Via', 'nope'],
        ['x-diffo-agent', 'claude'],
        ['x-diffo-session-pid', '42'],
        ['cookie', 'a=b'],
        ['authorization', 'Bearer x'],
        ['x-forwarded-for', '10.0.0.1'],
        ['origin', 'https://evil.example'],
        ['x-something-new', '1'],
        ['accept', 'application/json'],
        ['last-event-id', '7'],
      ],
      body: null,
    })
    await new Promise((r) => setTimeout(r, 20))
    // An allowlist: only headers the page needs get through, known or not.
    expect([...(seen[0]?.keys() ?? [])].sort()).toEqual(['accept', 'last-event-id', 'x-diffo-via'])
    expect(seen[0]?.get('x-diffo-via')).toBe('relay')
    expect(seen[0]?.get('x-diffo-agent')).toBeNull()
    expect(seen[0]?.get('x-diffo-session-pid')).toBeNull()
    expect(seen[0]?.get('cookie')).toBeNull()
  })
})

describe('printable', () => {
  it('strips control and bidi characters and caps the length', () => {
    expect(printable('a\u0000b\u001b[31mc\u007f\u0085d\u202ee\u2066f\n')).toBe('ab[31mcdef')
    expect(printable('x'.repeat(500))).toHaveLength(200)
  })
})

describe('normalizeRelayUrl', () => {
  it('takes an https relay, trimmed to its origin', () => {
    expect(normalizeRelayUrl('https://relay.example.dev')).toBe('https://relay.example.dev')
    expect(normalizeRelayUrl(' https://relay.example.dev/ ')).toBe('https://relay.example.dev')
  })

  it('allows plain http only for a relay on this machine', () => {
    expect(normalizeRelayUrl('http://localhost:8787')).toBe('http://localhost:8787')
    expect(normalizeRelayUrl('http://127.0.0.1:8787')).toBe('http://127.0.0.1:8787')
    expect(normalizeRelayUrl('http://relay.example.dev')).toBeNull()
  })

  it('refuses anything that is not a bare relay origin', () => {
    expect(normalizeRelayUrl('relay.example.dev')).toBeNull()
    expect(normalizeRelayUrl('ftp://relay.example.dev')).toBeNull()
    expect(normalizeRelayUrl('https://relay.example.dev/s/abc')).toBeNull()
    expect(normalizeRelayUrl('https://relay.example.dev/?x=1')).toBeNull()
    expect(normalizeRelayUrl('https://user:pw@relay.example.dev')).toBeNull()
  })
})

describe('createRemoteControl', () => {
  it('starts with no tunnel', () => {
    expect(createRemoteControl(4949).status()).toEqual(REMOTE_OFF)
  })

  it('fails fast, and stays off, when the relay cannot be reached', async () => {
    const remote = createRemoteControl(4949)
    const err = await remote.start('http://127.0.0.1:1', KEY).catch((e: Error) => e)
    expect((err as Error).message).toMatch(/could not reach the relay/)
    expect((err as Error).message).not.toContain(KEY)
    expect(remote.status().url).toBeNull()
  })
})

describe('/api/remote', () => {
  const base = {
    root: '/nonexistent-repo',
    spec: { kind: 'working-tree' } as const,
    clientDir: '/nonexistent-client-dir',
  }
  const live = (relay: string): RemoteStatus => ({
    ...REMOTE_OFF,
    url: `${relay}/s/session`,
    relay,
    connected: true,
  })
  const fake = (): RemoteControl & { started: [string, string][]; stops: number } => {
    const control = {
      started: [] as [string, string][],
      stops: 0,
      current: REMOTE_OFF,
      status: () => control.current,
      start: async (relay: string, key: string) => {
        control.started.push([relay, key])
        control.current = live(relay)
        return control.current
      },
      stop: () => {
        control.stops += 1
        control.current = REMOTE_OFF
        return REMOTE_OFF
      },
    }
    return control
  }
  const call = (
    app: ReturnType<typeof createApp>,
    method: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ) =>
    app.request('/api/remote', {
      method,
      headers: { host: '127.0.0.1:4949', 'content-type': 'application/json', ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
  const relayed = { 'x-diffo-via': 'relay' }

  it('opens the tunnel for the CLI with the relay and key, and answers with the link', async () => {
    const remote = fake()
    const res = await call(createApp({ ...base, remote }), 'POST', {
      relay: 'https://relay.example.dev/',
      key: KEY,
    })
    expect(res.status).toBe(200)
    const body = await res.text()
    expect(JSON.parse(body)).toMatchObject({ url: 'https://relay.example.dev/s/session' })
    expect(body).not.toContain(KEY)
    expect(remote.started).toEqual([['https://relay.example.dev', KEY]])
  })

  it('needs the access key, and never echoes a bad one', async () => {
    const remote = fake()
    const app = createApp({ ...base, remote })
    for (const key of [undefined, '', 'has space', 'x'.repeat(2000), 42]) {
      const res = await call(app, 'POST', { relay: 'https://relay.example.dev', key })
      expect(res.status).toBe(400)
      expect(await res.text()).not.toContain('has space')
    }
    expect(remote.started).toEqual([])
  })

  it('never lets a request that came through the relay re-point or end the tunnel', async () => {
    const remote = fake()
    const app = createApp({ ...base, remote })
    const post = await call(app, 'POST', { relay: 'https://evil.example', key: KEY }, relayed)
    expect(post.status).toBe(403)
    expect((await call(app, 'DELETE', undefined, relayed)).status).toBe(403)
    expect(remote.started).toEqual([])
    expect(remote.stops).toBe(0)
  })

  it('is opened, ended and read from this machine only, never through a reverse proxy', async () => {
    vi.stubEnv('DIFFO_PUBLIC_URL', 'https://diffo-{port}.devbox.internal')
    try {
      const remote = fake()
      const app = createApp({ ...base, port: 4949, remote })
      // Through the proxy: its public Host, or loopback Host with forwarding headers.
      const throughProxy: Record<string, string>[] = [
        { host: 'diffo-4949.devbox.internal' },
        { 'x-forwarded-for': '203.0.113.7' },
        { forwarded: 'for=203.0.113.7' },
        { 'x-real-ip': '203.0.113.7' },
      ]
      for (const headers of throughProxy) {
        const post = await call(app, 'POST', { relay: 'https://evil.example', key: KEY }, headers)
        expect(post.status, JSON.stringify(headers)).toBe(403)
        expect((await call(app, 'DELETE', undefined, headers)).status).toBe(403)
      }
      expect(remote.started).toEqual([])
      expect(remote.stops).toBe(0)
      // The unpaired link pairs whoever opens it first: only this machine reads it.
      await call(app, 'POST', { relay: 'https://relay.example.dev', key: KEY })
      const viaProxy = await call(app, 'GET', undefined, { host: 'diffo-4949.devbox.internal' })
      expect((await viaProxy.json()).url).toBeNull()
      const local = await call(app, 'GET')
      expect((await local.json()).url).toBe('https://relay.example.dev/s/session')
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('DELETE turns it off for a loopback client', async () => {
    const remote = fake()
    const app = createApp({ ...base, remote })
    await call(app, 'POST', { relay: 'https://relay.example.dev', key: KEY })
    const res = await call(app, 'DELETE')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual(REMOTE_OFF)
    expect(remote.stops).toBe(1)
  })

  it('shows a relayed reader the state, never the link', async () => {
    const remote = fake()
    const app = createApp({ ...base, remote })
    await call(app, 'POST', { relay: 'https://relay.example.dev', key: KEY })
    expect(await (await call(app, 'GET')).json()).toMatchObject({
      url: 'https://relay.example.dev/s/session',
    })
    const seen = (await (await call(app, 'GET', undefined, relayed)).json()) as RemoteStatus & {
      viaRelay?: boolean
    }
    expect(seen.url).toBeNull()
    expect(seen.viaRelay).toBe(true)
    expect(seen.connected).toBe(true)
  })

  it('refuses a relay that is not an https origin', async () => {
    const remote = fake()
    const res = await call(createApp({ ...base, remote }), 'POST', {
      relay: 'http://relay.example.dev',
      key: KEY,
    })
    expect(res.status).toBe(400)
    expect(remote.started).toEqual([])
  })

  it('reports no tunnel on a server without remote mode', async () => {
    const app = createApp(base)
    expect(await (await call(app, 'GET')).json()).toEqual(REMOTE_OFF)
    expect((await call(app, 'POST', { relay: 'https://relay.example.dev', key: KEY })).status).toBe(
      501,
    )
    expect((await call(app, 'DELETE')).status).toBe(200)
  })

  it('answers a relayed request only on the reviewer routes', async () => {
    const app = createApp(base)
    const send = (path: string, method = 'GET', headers: Record<string, string> = {}) =>
      app.request(path, {
        method,
        headers: { host: '127.0.0.1:4949', 'x-diffo-via': 'relay', ...headers },
      })
    expect((await send('/api/agent/poll', 'GET', { 'x-diffo-agent': 'claude' })).status).toBe(403)
    expect((await send('/api/agent/end', 'POST')).status).toBe(403)
    expect((await send('/api/agent/invite')).status).toBe(403)
    expect((await send('/api/shutdown', 'POST')).status).toBe(403)
    expect((await send('/api/health')).status).toBe(403)
    expect((await send('/api/remote')).status).toBe(200)
    // Odd spellings of a blocked route never reach it.
    for (const path of [
      '//api/agent/poll',
      '/api//agent/poll',
      '/api/review/../agent/poll',
      '/api/review/%2e%2e/agent/poll',
      '/api/agent%2Fpoll',
    ]) {
      expect([403, 404]).toContain((await send(path)).status)
    }
  })
})
