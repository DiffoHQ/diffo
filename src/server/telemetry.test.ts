import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  agentNameOf,
  describeTelemetry,
  durationBucket,
  envOptOut,
  fileMachineIdStore,
  type MachineIdStore,
  reviewKindOf,
  SEND_TIMEOUT_MS,
  TELEMETRY_DOCS_URL,
  TELEMETRY_ENDPOINT,
  Telemetry,
  type TelemetryStore,
} from './telemetry.js'

function memoryStore(): TelemetryStore & { map: Map<string, string> } {
  const map = new Map<string, string>()
  return {
    map,
    get: (key) => map.get(key) ?? null,
    set: (key, value) => void map.set(key, value),
  }
}

function memoryIds(): MachineIdStore {
  let id: string | null = null
  return {
    read: () => id,
    claim: (next) => {
      id ??= next
      return id
    },
    clear: () => {
      id = null
    },
  }
}

type Sent = { url: string; body: Record<string, unknown>; signal: AbortSignal | undefined }

function harness(overrides: Partial<ConstructorParameters<typeof Telemetry>[0]> = {}) {
  const store = memoryStore()
  const ids = memoryIds()
  const sent: Sent[] = []
  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    sent.push({
      url: String(url),
      body: JSON.parse(String(init?.body)) as Record<string, unknown>,
      signal: init?.signal ?? undefined,
    })
    return new Response('{"status":1}')
  })
  let clock = 1_700_000_000_000
  const logged: string[] = []
  const telemetry = new Telemetry({
    store,
    ids,
    env: {},
    fetch: fetchImpl as unknown as typeof fetch,
    now: () => clock,
    log: (line) => void logged.push(line),
    version: '9.9.9',
    platform: 'testos',
    arch: 'test64',
    nodeMajor: 24,
    ...overrides,
  })
  return { telemetry, store, ids, sent, logged, tick: (ms: number) => (clock += ms) }
}

/** The notice has been on a screen, and a review has since been opened. */
function armed(overrides: Partial<ConstructorParameters<typeof Telemetry>[0]> = {}) {
  const h = harness(overrides)
  h.telemetry.noticeShown()
  return h
}

describe('envOptOut', () => {
  it('is null with nothing set, and ignores the spellings that mean unset', () => {
    expect(envOptOut({})).toBeNull()
    expect(envOptOut({ DO_NOT_TRACK: '0', DIFFO_TELEMETRY_DISABLED: 'false', CI: '' })).toBeNull()
  })

  it('names the variable, DO_NOT_TRACK first', () => {
    expect(envOptOut({ DO_NOT_TRACK: '1', CI: 'true' })).toBe('DO_NOT_TRACK')
    expect(envOptOut({ DIFFO_TELEMETRY_DISABLED: '1' })).toBe('DIFFO_TELEMETRY_DISABLED')
    expect(envOptOut({ CI: 'true' })).toBe('CI')
  })
})

describe('small helpers', () => {
  it('names the kind of review', () => {
    expect(reviewKindOf({ kind: 'working-tree' }, false)).toBe('tree')
    expect(reviewKindOf({ kind: 'branch', base: 'main' }, false)).toBe('branch')
    expect(reviewKindOf({ kind: 'branch', base: 'main' }, true)).toBe('pr')
  })

  it('narrows the agent to a known name, never a free string', () => {
    expect(agentNameOf('claude')).toBe('claude')
    expect(agentNameOf('unknown')).toBe('unknown')
    expect(agentNameOf('/Users/sam/.local/bin/mytool')).toBe('other')
    expect(agentNameOf(42)).toBe('other')
  })

  it('buckets durations coarsely', () => {
    expect(durationBucket(60_000)).toBe('<5m')
    expect(durationBucket(10 * 60_000)).toBe('5-15m')
    expect(durationBucket(20 * 60_000)).toBe('15-30m')
    expect(durationBucket(45 * 60_000)).toBe('30-60m')
    expect(durationBucket(3 * 3_600_000)).toBe('1h+')
  })
})

describe('Telemetry status', () => {
  it('is on by default, notice pending, no id minted yet', () => {
    const { telemetry } = harness()
    expect(telemetry.status()).toEqual({
      enabled: true,
      source: 'default',
      notice: 'pending',
      machineId: null,
      dev: false,
      docs: TELEMETRY_DOCS_URL,
    })
  })

  it('an environment variable wins over everything and says which', () => {
    const { telemetry } = harness({ env: { DO_NOT_TRACK: '1' } })
    telemetry.setEnabled(true, 'cli')
    expect(telemetry.status()).toMatchObject({
      enabled: false,
      source: 'env',
      variable: 'DO_NOT_TRACK',
    })
  })

  it('a source checkout reports like any other, with every event tagged dev', () => {
    const { telemetry, sent } = armed({ dev: true })
    expect(telemetry.status()).toMatchObject({ enabled: true, dev: true })
    telemetry.reviewOpened({ kind: 'tree', agent: 'claude' })
    expect(sent[0]!.body.properties).toMatchObject({ dev: true })
  })

  it('off by setting is off, and back on starts a fresh id', () => {
    const { telemetry, store } = armed()
    telemetry.reviewOpened({ kind: 'tree', agent: 'claude' })
    const firstId = telemetry.status().machineId
    expect(firstId).toMatch(/^[0-9a-f-]{36}$/)
    telemetry.setEnabled(false, 'cli')
    expect(telemetry.status()).toMatchObject({ enabled: false, source: 'setting', machineId: null })
    telemetry.setEnabled(true, 'cli')
    expect(telemetry.status()).toMatchObject({ enabled: true, notice: 'acknowledged' })
    telemetry.reviewOpened({ kind: 'tree', agent: 'claude' })
    expect(telemetry.status().machineId).not.toBe(firstId)
    expect(store.map.get('telemetry.enabled')).toBe('true')
  })
})

describe('Telemetry notice gate', () => {
  it('sends nothing while the notice has never been shown', () => {
    const { telemetry, sent } = harness()
    expect(telemetry.reviewOpened({ kind: 'tree', agent: 'claude' })).toBe(false)
    telemetry.reviewFinished({ kind: 'tree', threads: 3, comments: 4, layers: false })
    expect(sent).toEqual([])
  })

  it('the review that shows the notice reports nothing, not even its finish', () => {
    const { telemetry, sent } = harness()
    expect(telemetry.reviewOpened({ kind: 'tree', agent: 'claude' })).toBe(false)
    telemetry.noticeShown()
    telemetry.reviewFinished({ kind: 'tree', threads: 3, comments: 4, layers: true })
    expect(sent).toEqual([])
    // The next open is armed.
    expect(telemetry.reviewOpened({ kind: 'tree', agent: 'claude' })).toBe(true)
    expect(sent.map((s) => s.body.event)).toEqual(['review_opened'])
  })

  it('records when the notice was shown, once', () => {
    const { telemetry, store } = harness()
    telemetry.noticeShown()
    const at = store.map.get('telemetry.notice_at')
    expect(at).toBe(new Date(1_700_000_000_000).toISOString())
    telemetry.noticeShown()
    expect(store.map.get('telemetry.notice_at')).toBe(at)
    expect(telemetry.status().notice).toBe('shown')
    telemetry.acknowledge()
    expect(telemetry.status().notice).toBe('acknowledged')
  })

  it('acknowledging an unseen notice counts as having shown it', () => {
    const { telemetry } = harness()
    telemetry.acknowledge()
    expect(telemetry.status().notice).toBe('acknowledged')
    expect(telemetry.reviewOpened({ kind: 'pr', agent: 'codex' })).toBe(true)
  })
})

describe('Telemetry payloads', () => {
  it('review_opened carries the build, the machine, the kind and the agent — and nothing else', () => {
    const { telemetry, sent } = armed()
    telemetry.reviewOpened({ kind: 'branch', agent: 'cursor' })
    expect(sent).toHaveLength(1)
    const { url, body, signal } = sent[0]!
    expect(url).toBe(TELEMETRY_ENDPOINT)
    expect(signal).toBeInstanceOf(AbortSignal)
    expect(body).toEqual({
      api_key: expect.any(String),
      event: 'review_opened',
      distinct_id: telemetry.status().machineId,
      timestamp: new Date(1_700_000_000_000).toISOString(),
      properties: {
        $lib: 'diffo',
        $lib_version: '9.9.9',
        $process_person_profile: false,
        $geoip_disable: true,
        version: '9.9.9',
        platform: 'testos',
        arch: 'test64',
        node: 24,
        dev: false,
        kind: 'branch',
        agent: 'cursor',
      },
    })
  })

  it('review_finished carries counts and a coarse duration, keyed to the same machine', () => {
    const { telemetry, sent, tick } = armed()
    telemetry.reviewOpened({ kind: 'pr', agent: 'claude' })
    tick(12 * 60_000)
    telemetry.reviewFinished({
      kind: 'pr',
      threads: 5,
      comments: 7,
      layers: true,
      event: 'APPROVE',
    })
    expect(sent).toHaveLength(2)
    expect(sent[1]!.body.distinct_id).toBe(sent[0]!.body.distinct_id)
    expect(sent[1]!.body.properties).toMatchObject({
      kind: 'pr',
      threads: 5,
      comments: 7,
      layers: true,
      event: 'APPROVE',
      duration: '5-15m',
    })
  })

  it('never carries a path, a repo name, or free text', () => {
    const { telemetry, sent } = armed()
    telemetry.reviewOpened({ kind: 'tree', agent: agentNameOf('/Users/sam/code/secret-repo') })
    telemetry.reviewFinished({ kind: 'tree', threads: 1, comments: 1, layers: false })
    const text = JSON.stringify(sent)
    expect(text).not.toContain('/Users')
    expect(text).not.toContain('secret')
    for (const { body } of sent) {
      for (const value of Object.values(body.properties as Record<string, unknown>)) {
        expect(['string', 'number', 'boolean']).toContain(typeof value)
      }
    }
  })

  it('turning off mid-review sends one farewell under the same id, then the finish stays silent', () => {
    const { telemetry, sent } = armed()
    telemetry.reviewOpened({ kind: 'tree', agent: 'claude' })
    expect(telemetry.setEnabled(false, 'ui')).toBe(true)
    telemetry.reviewFinished({ kind: 'tree', threads: 1, comments: 1, layers: false })
    expect(sent.map((s) => s.body.event)).toEqual(['review_opened', 'telemetry_disabled'])
    expect(sent[1]!.body.distinct_id).toBe(sent[0]!.body.distinct_id)
    expect(sent[1]!.body.properties).toMatchObject({ source: 'ui' })
    expect(telemetry.status().machineId).toBeNull()
  })

  it('a machine that never reported, or that an env var silenced, says nothing on opt-out', () => {
    const fresh = harness()
    expect(fresh.telemetry.setEnabled(false, 'cli')).toBe(false)
    expect(fresh.sent).toEqual([])
    const silenced = armed({ env: { DO_NOT_TRACK: '1' } })
    silenced.ids.claim('had-one')
    expect(silenced.telemetry.setEnabled(false, 'ui')).toBe(false)
    expect(silenced.sent).toEqual([])
    // Turning on never sends: the next review_opened is the signal.
    const on = armed()
    expect(on.telemetry.setEnabled(true, 'cli')).toBe(false)
    expect(on.sent).toEqual([])
  })

  it('a dead endpoint is silent: no throw, no rejection, no retry', async () => {
    const failing = vi.fn(async () => {
      throw new TypeError('fetch failed')
    })
    const { telemetry } = armed({ fetch: failing as unknown as typeof fetch })
    expect(() => telemetry.reviewOpened({ kind: 'tree', agent: 'claude' })).not.toThrow()
    await expect(telemetry.flush()).resolves.toBeUndefined()
    expect(failing).toHaveBeenCalledTimes(1)
  })

  it('a hung endpoint is bounded by the send timeout', () => {
    const { telemetry, sent } = armed()
    telemetry.reviewOpened({ kind: 'tree', agent: 'claude' })
    // AbortSignal.timeout(): the only signal kind the module hands to fetch.
    expect(sent[0]!.signal?.aborted).toBe(false)
    expect(SEND_TIMEOUT_MS).toBeLessThanOrEqual(3000)
  })

  it('DIFFO_TELEMETRY_DEBUG writes the exact payload before sending, and the answer after', async () => {
    const { telemetry, sent, logged } = armed({ env: { DIFFO_TELEMETRY_DEBUG: '1' } })
    telemetry.reviewOpened({ kind: 'tree', agent: 'goose' })
    expect(logged).toHaveLength(1)
    expect(JSON.parse(logged[0]!.replace(/^telemetry: /, ''))).toEqual(sent[0]!.body)
    await telemetry.flush()
    expect(logged[1]).toBe('telemetry: review_opened → 200')
  })

  it('DIFFO_TELEMETRY_DEBUG names a failed send; without it nothing is said', async () => {
    const failing = vi.fn(async () => {
      throw new TypeError('fetch failed')
    })
    const loud = armed({
      env: { DIFFO_TELEMETRY_DEBUG: '1' },
      fetch: failing as unknown as typeof fetch,
    })
    loud.telemetry.reviewOpened({ kind: 'tree', agent: 'claude' })
    await loud.telemetry.flush()
    expect(loud.logged[1]).toBe('telemetry: review_opened failed: fetch failed')
    const quiet = armed({ fetch: failing as unknown as typeof fetch })
    quiet.telemetry.reviewOpened({ kind: 'tree', agent: 'claude' })
    await quiet.telemetry.flush()
    expect(quiet.logged).toEqual([])
  })
})

describe('fileMachineIdStore', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })
  function idPath(): string {
    const dir = mkdtempSync(join(tmpdir(), 'diffo-id-'))
    dirs.push(dir)
    // Two levels down: the store has to make the directory, as `~/.diffo` may
    // not exist on a machine that has never opened a review.
    return join(dir, 'home', '.diffo', 'telemetry-id')
  }
  const uuid = /^[0-9a-f-]{36}$/

  it('mints one id into a file, owner-only, and reads it back', () => {
    const path = idPath()
    const ids = fileMachineIdStore(path)
    expect(ids.read()).toBeNull()
    expect(ids.claim('11111111-2222-4333-8444-555555555555')).toBe(
      '11111111-2222-4333-8444-555555555555',
    )
    expect(readFileSync(path, 'utf8')).toBe('11111111-2222-4333-8444-555555555555\n')
    expect(statSync(path).mode & 0o777).toBe(0o600)
    expect(fileMachineIdStore(path).read()).toBe('11111111-2222-4333-8444-555555555555')
  })

  it('a second claim keeps the id that landed first', () => {
    const ids = fileMachineIdStore(idPath())
    ids.claim('11111111-2222-4333-8444-555555555555')
    expect(ids.claim('99999999-2222-4333-8444-555555555555')).toBe(
      '11111111-2222-4333-8444-555555555555',
    )
  })

  it('treats a file that is not an id as absent, and overwrites it', () => {
    const path = idPath()
    const ids = fileMachineIdStore(path)
    ids.claim('11111111-2222-4333-8444-555555555555')
    writeFileSync(path, 'not an id\n')
    expect(ids.read()).toBeNull()
    expect(ids.claim('99999999-2222-4333-8444-555555555555')).toBe(
      '99999999-2222-4333-8444-555555555555',
    )
  })

  it('clear deletes the file, and is quiet when there is none', () => {
    const path = idPath()
    const ids = fileMachineIdStore(path)
    ids.claim('11111111-2222-4333-8444-555555555555')
    ids.clear()
    expect(existsSync(path)).toBe(false)
    expect(() => ids.clear()).not.toThrow()
    expect(ids.read()).toBeNull()
  })

  it('one machine, one id: every database on it reports under the same one', () => {
    const path = idPath()
    // Two servers with their own DIFFO_DB, the case the walkthroughs hit.
    const a = armed({ ids: fileMachineIdStore(path) })
    const b = armed({ ids: fileMachineIdStore(path) })
    a.telemetry.reviewOpened({ kind: 'tree', agent: 'claude' })
    b.telemetry.reviewOpened({ kind: 'branch', agent: 'codex' })
    expect(a.sent[0]!.body.distinct_id).toMatch(uuid)
    expect(b.sent[0]!.body.distinct_id).toBe(a.sent[0]!.body.distinct_id)
    expect(b.telemetry.status().machineId).toBe(a.telemetry.status().machineId)
    // Off on one is off for the machine's id, whichever database said so.
    b.telemetry.setEnabled(false, 'cli')
    expect(a.telemetry.status().machineId).toBeNull()
  })

  it('a disk that refuses the file gets one id per process, not one per event', () => {
    const dir = mkdtempSync(join(tmpdir(), 'diffo-id-'))
    dirs.push(dir)
    writeFileSync(join(dir, 'home'), 'a file where a directory should be')
    const { telemetry, sent } = armed({
      ids: fileMachineIdStore(join(dir, 'home', '.diffo', 'telemetry-id')),
    })
    telemetry.reviewOpened({ kind: 'tree', agent: 'claude' })
    telemetry.reviewFinished({ kind: 'tree', threads: 1, comments: 1, layers: false })
    expect(sent[0]!.body.distinct_id).toMatch(uuid)
    expect(sent[1]!.body.distinct_id).toBe(sent[0]!.body.distinct_id)
    expect(telemetry.status().machineId).toBe(sent[0]!.body.distinct_id)
    telemetry.setEnabled(false, 'ui')
    expect(telemetry.status().machineId).toBeNull()
  })
})

describe('describeTelemetry', () => {
  const base = {
    notice: 'shown' as const,
    machineId: null,
    dev: false,
    docs: TELEMETRY_DOCS_URL,
  }

  it('says on, what, and how to turn off', () => {
    const text = describeTelemetry({ enabled: true, source: 'default', ...base }, 'status')
    expect(text).toContain('usage data: on')
    expect(text).toContain('diffo telemetry off')
    expect(text).toContain('DO_NOT_TRACK=1')
    expect(text).toContain(TELEMETRY_DOCS_URL)
    expect(text).not.toContain('nothing has been sent yet')
  })

  it('before the notice, says nothing has gone out', () => {
    const text = describeTelemetry(
      { enabled: true, source: 'default', ...base, notice: 'pending' },
      'status',
    )
    expect(text).toContain('nothing has been sent yet')
  })

  it('says why it is off', () => {
    expect(
      describeTelemetry({ enabled: false, source: 'env', variable: 'CI', ...base }, 'status'),
    ).toContain('usage data: off (CI is set)')
    expect(
      describeTelemetry({ enabled: true, source: 'default', ...base, dev: true }, 'status'),
    ).toContain('every event carries dev: true')
    const setting = describeTelemetry({ enabled: false, source: 'setting', ...base }, 'status')
    expect(setting).toContain('usage data: off')
    expect(setting).toContain('diffo telemetry on')
  })

  it('says when the off command sent its one last event', () => {
    const off = { enabled: false as const, source: 'setting' as const, ...base }
    expect(describeTelemetry(off, 'off', true)).toContain('one last event')
    expect(describeTelemetry(off, 'off', false)).not.toContain('one last event')
  })

  it('warns when `on` cannot win against the environment', () => {
    const text = describeTelemetry(
      { enabled: false, source: 'env', variable: 'DO_NOT_TRACK', ...base },
      'on',
    )
    expect(text).toContain('stays off while DO_NOT_TRACK is set')
  })
})
