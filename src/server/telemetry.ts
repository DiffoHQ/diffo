import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { HarnessName } from '../agentSession.js'
import { HARNESS_NAMES } from '../agentSession.js'
import type { ChangesetSpec } from '../shared/types.js'
import { VERSION } from '../version.js'

/**
 * Anonymous usage data, Homebrew-style: on by default, announced in the review
 * page before the first event leaves, one command or variable to turn off. Two
 * events per review, `review_opened` and `review_finished`, and one last
 * `telemetry_disabled` when a machine that has reported turns it off; `send`
 * below is the authoritative list of what they carry, and the docs page links here. Never
 * paths, repo or branch names, code, comment text, or anything IP-derived. The
 * one identifier is a random UUID per machine, in a file of its own
 * (`~/.diffo/telemetry-id`) rather than the database: `DIFFO_DB` moves the
 * database, and one machine must count as one machine wherever it keeps state.
 */

export const TELEMETRY_DOCS_URL = 'https://diffohq.github.io/diffo/telemetry'
/** PostHog Cloud, EU region. */
export const TELEMETRY_ENDPOINT = 'https://eu.i.posthog.com/capture/'
/** Public and write-only by design: adds events, reads nothing. */
export const TELEMETRY_KEY = 'phc_nZqoJQbyccraPZwxsHaaAUPjf5z8k2QqdnWYedyhQzCx'
/** A blocked host must never be felt. */
export const SEND_TIMEOUT_MS = 2000

export type ReviewKind = 'tree' | 'branch' | 'pr'
export type NoticeState = 'pending' | 'shown' | 'acknowledged'
/** `unknown` is a plain terminal run; `other` is a value this build does not know. */
export type AgentName = HarnessName | 'unknown' | 'other'
/** Where an opt-out came from: the page's Settings → Privacy, or `diffo telemetry off`. */
export type OptOutSource = 'ui' | 'cli'

export interface TelemetryStatus {
  enabled: boolean
  /** Why it is off — or `default` while it is on. `env` names the variable. */
  source: 'default' | 'setting' | 'env'
  variable?: string
  notice: NoticeState
  machineId: string | null
  /** A source checkout; its events carry `dev: true` so they can be filtered out. */
  dev: boolean
  docs: string
}

/** The DB's per-human settings, narrowed so this module never holds a database. */
export interface TelemetryStore {
  get(key: string): string | null
  set(key: string, value: string): void
}

/** The machine id's home. `read` is what `status` reports; `claim` puts a new id
 * on disk unless one got there first, and answers with the id now on disk, or
 * null when the disk refused. */
export interface MachineIdStore {
  read(): string | null
  claim(id: string): string | null
  clear(): void
}

export function defaultMachineIdPath(): string {
  return join(homedir(), '.diffo', 'telemetry-id')
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** One UUID and a newline, owner-readable like the database next to it. */
export function fileMachineIdStore(path = defaultMachineIdPath()): MachineIdStore {
  const read = (): string | null => {
    try {
      const id = readFileSync(path, 'utf8').trim()
      return UUID.test(id) ? id : null
    } catch {
      return null
    }
  }
  const write = (id: string, flag: 'wx' | 'w'): string | null => {
    try {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
      writeFileSync(path, `${id}\n`, { flag, mode: 0o600 })
      return id
    } catch (err) {
      // Two servers minting at once: the second keeps whichever landed first.
      if (flag === 'wx' && (err as NodeJS.ErrnoException).code === 'EEXIST')
        return read() ?? write(id, 'w')
      return null
    }
  }
  return {
    read,
    claim: (id) => write(id, 'wx'),
    clear() {
      try {
        rmSync(path, { force: true })
      } catch {
        // An id that cannot be deleted is one nothing will be sent under.
      }
    },
  }
}

export interface TelemetryDeps {
  store: TelemetryStore
  ids: MachineIdStore
  env?: NodeJS.ProcessEnv
  fetch?: typeof fetch
  now?: () => number
  log?: (line: string) => void
  dev?: boolean
  version?: string
  platform?: string
  arch?: string
  nodeMajor?: number
}

const KEY = {
  enabled: 'telemetry.enabled',
  notice: 'telemetry.notice',
  noticeAt: 'telemetry.notice_at',
} as const

const DEBUG_VAR = 'DIFFO_TELEMETRY_DEBUG'

/** `0`, `false` and the empty string mean unset, as most tools read them. */
function isSet(value: string | undefined): boolean {
  if (value === undefined) return false
  const v = value.trim().toLowerCase()
  return v !== '' && v !== '0' && v !== 'false'
}

/** The variable that turns usage data off, in precedence order, or null. */
export function envOptOut(env: NodeJS.ProcessEnv): string | null {
  if (isSet(env.DO_NOT_TRACK)) return 'DO_NOT_TRACK'
  if (isSet(env.DIFFO_TELEMETRY_DISABLED)) return 'DIFFO_TELEMETRY_DISABLED'
  if (isSet(env.CI)) return 'CI'
  return null
}

export function reviewKindOf(spec: ChangesetSpec, pr: boolean): ReviewKind {
  if (pr) return 'pr'
  return spec.kind === 'branch' ? 'branch' : 'tree'
}

const AGENT_NAMES: ReadonlySet<string> = new Set<string>([...HARNESS_NAMES, 'unknown'])

/** Whatever the CLI reported, narrowed to a name this build knows. */
export function agentNameOf(raw: unknown): AgentName {
  return typeof raw === 'string' && AGENT_NAMES.has(raw) ? (raw as AgentName) : 'other'
}

/** Coarse on purpose: low cardinality, and nobody's afternoon timed. */
export function durationBucket(ms: number): string {
  const min = ms / 60_000
  if (min < 5) return '<5m'
  if (min < 15) return '5-15m'
  if (min < 30) return '15-30m'
  if (min < 60) return '30-60m'
  return '1h+'
}

export interface OpenedProps {
  kind: ReviewKind
  agent: AgentName
}

export interface FinishedProps {
  kind: ReviewKind
  /** In the finish batch; `comments` counts the reviewer's messages across them. */
  threads: number
  comments: number
  layers: boolean
  /** The GitHub event a pull-request review submitted, when it did. */
  event?: string
}

export class Telemetry {
  private readonly store: TelemetryStore
  private readonly ids: MachineIdStore
  private readonly env: NodeJS.ProcessEnv
  private readonly fetchImpl: typeof fetch
  private readonly now: () => number
  private readonly log: (line: string) => void
  private readonly dev: boolean
  private readonly base: Record<string, string | number | boolean>
  /** Decided at open and kept for the finish, so the review that first shows the
   * notice reports nothing at all. Undefined until the first open. */
  private armedReview: boolean | undefined
  private openedAt: number | undefined
  private inFlight: Promise<void>[] = []
  /** The id this process settled on when the disk refused to keep one. */
  private fallbackId: string | undefined

  constructor(deps: TelemetryDeps) {
    this.store = deps.store
    this.ids = deps.ids
    this.env = deps.env ?? process.env
    this.fetchImpl = deps.fetch ?? globalThis.fetch
    this.now = deps.now ?? Date.now
    this.log = deps.log ?? (() => {})
    this.dev = deps.dev ?? false
    this.base = {
      version: deps.version ?? VERSION,
      platform: deps.platform ?? process.platform,
      arch: deps.arch ?? process.arch,
      node: deps.nodeMajor ?? Number.parseInt(process.versions.node.split('.')[0] ?? '0', 10),
      dev: this.dev,
    }
  }

  status(): TelemetryStatus {
    const shared = {
      notice: this.notice(),
      machineId: this.readMachineId(),
      dev: this.dev,
      docs: TELEMETRY_DOCS_URL,
    }
    const variable = envOptOut(this.env)
    if (variable !== null) return { enabled: false, source: 'env', variable, ...shared }
    if (this.store.get(KEY.enabled) === 'false')
      return { enabled: false, source: 'setting', ...shared }
    return { enabled: true, source: 'default', ...shared }
  }

  /**
   * Either way the machine id goes: back on means a new history, not the old one.
   * Turning off a machine that has reported sends one last `telemetry_disabled`,
   * so opt-outs can be counted; a machine that never reported, or one an
   * environment variable already silenced, sends nothing. Returns whether it did.
   */
  setEnabled(on: boolean, source: OptOutSource): boolean {
    const farewell = !on && this.status().enabled && this.readMachineId() !== null
    if (farewell) this.send('telemetry_disabled', { source })
    this.store.set(KEY.enabled, on ? 'true' : 'false')
    this.ids.clear()
    this.fallbackId = undefined
    // Asking for it by hand is its own acknowledgement.
    if (on) this.store.set(KEY.notice, 'acknowledged')
    return farewell
  }

  /** The review page rendered the notice; nothing is sent before this. */
  noticeShown(): void {
    if (this.notice() !== 'pending') return
    this.store.set(KEY.notice, 'shown')
    this.store.set(KEY.noticeAt, new Date(this.now()).toISOString())
  }

  /** The reviewer dismissed the notice; it stays gone. */
  acknowledge(): void {
    if (this.notice() === 'pending') this.noticeShown()
    this.store.set(KEY.notice, 'acknowledged')
  }

  /** A `diffo` open landed. Decides whether this review reports, and says so. */
  reviewOpened(props: OpenedProps): boolean {
    const armed = this.armed()
    this.armedReview = armed
    this.openedAt = this.now()
    if (armed) this.send('review_opened', { kind: props.kind, agent: props.agent })
    return armed
  }

  /** Only for a review that was opened reporting, and is still on. */
  reviewFinished(props: FinishedProps): void {
    if (this.armedReview !== true || !this.armed()) return
    this.send('review_finished', {
      kind: props.kind,
      threads: props.threads,
      comments: props.comments,
      layers: props.layers,
      ...(props.event ? { event: props.event } : {}),
      ...(this.openedAt !== undefined
        ? { duration: durationBucket(this.now() - this.openedAt) }
        : {}),
    })
  }

  /** Every send so far, settled. Tests, and an orderly shutdown. */
  async flush(): Promise<void> {
    await Promise.all(this.inFlight.splice(0))
  }

  private notice(): NoticeState {
    const raw = this.store.get(KEY.notice)
    return raw === 'shown' || raw === 'acknowledged' ? raw : 'pending'
  }

  /** On, and the notice has been on a screen at least once. */
  private armed(): boolean {
    return this.status().enabled && this.notice() !== 'pending'
  }

  private readMachineId(): string | null {
    return this.ids.read() ?? this.fallbackId ?? null
  }

  /** The id on disk, minted on the first send; a disk that refuses it gets one
   * id per process rather than one per event. */
  private machineId(): string {
    const existing = this.readMachineId()
    if (existing) return existing
    const id = randomUUID()
    const claimed = this.ids.claim(id)
    if (claimed === null) this.fallbackId = id
    return claimed ?? id
  }

  private send(event: string, properties: Record<string, string | number | boolean>): void {
    const payload = {
      api_key: TELEMETRY_KEY,
      event,
      distinct_id: this.machineId(),
      timestamp: new Date(this.now()).toISOString(),
      properties: {
        $lib: 'diffo',
        $lib_version: this.base.version,
        // No person profile, and no city or coordinates derived from the IP at
        // ingestion: asked per event, so neither hangs on a project setting.
        $process_person_profile: false,
        $geoip_disable: true,
        ...this.base,
        ...properties,
      },
    }
    if (isSet(this.env[DEBUG_VAR])) this.log(`telemetry: ${JSON.stringify(payload)}`)
    // Fire and forget: the review never waits on, or hears about, this request.
    let request: Promise<unknown>
    try {
      request = this.fetchImpl(TELEMETRY_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
      })
    } catch {
      request = Promise.resolve()
    }
    const debug = isSet(this.env[DEBUG_VAR])
    this.inFlight.push(
      request.then(
        (res) => {
          if (debug)
            this.log(`telemetry: ${event} → ${(res as Response | undefined)?.status ?? 'sent'}`)
        },
        (err: unknown) => {
          if (debug)
            this.log(`telemetry: ${event} failed: ${(err as Error)?.message ?? String(err)}`)
        },
      ),
    )
  }
}

/** `diffo telemetry [status|on|off]`, for a human's terminal. */
export function describeTelemetry(
  status: TelemetryStatus,
  asked: 'status' | 'on' | 'off',
  farewell = false,
): string {
  const lines: string[] = []
  if (status.enabled) {
    lines.push(
      asked === 'on' ? 'usage data: on (turned on)' : 'usage data: on',
      '  what: two anonymous events per review (opened, finished) — version, OS,',
      '        kind of review, agent, counts. Never code, paths, or comment text',
      '  off:  diffo telemetry off, or DIFFO_TELEMETRY_DISABLED=1 (DO_NOT_TRACK=1 counts too)',
    )
    if (status.notice === 'pending') {
      lines.push('  note: nothing has been sent yet; the review page shows a notice first')
    }
    if (status.dev) {
      lines.push('  dev:  running from a source checkout; every event carries dev: true')
    }
  } else {
    const why =
      status.source === 'env'
        ? `${status.variable} is set`
        : asked === 'off'
          ? 'turned off'
          : 'turned off with `diffo telemetry off`'
    lines.push(`usage data: off (${why})`)
    if (asked === 'off' && farewell) {
      lines.push('  sent: one last event saying this machine turned it off; nothing follows')
    }
    if (asked === 'on' && status.source === 'env') {
      lines.push(`  note: it stays off while ${status.variable} is set`)
    }
    if (status.source === 'setting') lines.push('  on:   diffo telemetry on')
  }
  lines.push(`  more: ${status.docs}`)
  return lines.join('\n')
}
