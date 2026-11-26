import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DiffoDb } from './db.js'
import { DeliveryQueue } from './delivery.js'
import { createApp } from './index.js'
import { ReviewStore } from './review.js'
import { ChangesetStore } from './store.js'
import { type MachineIdStore, Telemetry, type TelemetryStore } from './telemetry.js'

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const fn of cleanups.splice(0)) fn()
})

function memoryStore(): TelemetryStore {
  const map = new Map<string, string>()
  return { get: (key) => map.get(key) ?? null, set: (key, value) => void map.set(key, value) }
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

function fakeFetch() {
  const events: Record<string, unknown>[] = []
  const impl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    events.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
    return new Response('{"status":1}')
  })
  return { events, impl: impl as unknown as typeof fetch }
}

const ctx = {
  root: '/nonexistent-repo',
  spec: { kind: 'working-tree' } as const,
  clientDir: '/nonexistent-client-dir',
}

function withTelemetry(env: NodeJS.ProcessEnv = {}) {
  const { events, impl } = fakeFetch()
  const telemetry = new Telemetry({ store: memoryStore(), ids: memoryIds(), env, fetch: impl })
  return { app: createApp({ ...ctx, telemetry }), telemetry, events }
}

const put = (app: ReturnType<typeof createApp>, body: unknown) =>
  app.request('/api/telemetry', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })

const opened = (app: ReturnType<typeof createApp>, body: unknown) =>
  app.request('/api/telemetry/opened', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })

describe('/api/telemetry', () => {
  it('is unavailable, not on, for a server without it', async () => {
    const app = createApp(ctx)
    expect((await app.request('/api/telemetry')).status).toBe(503)
    expect((await put(app, { enabled: false })).status).toBe(503)
    // An open still answers, and reports nothing.
    const res = await opened(app, { agent: 'claude' })
    expect(await res.json()).toEqual({ ok: true, armed: false })
  })

  it('reports the state the page and the CLI share', async () => {
    const { app } = withTelemetry()
    const res = await app.request('/api/telemetry')
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ enabled: true, source: 'default', notice: 'pending' })
  })

  it('the page marks the notice shown, then acknowledged', async () => {
    const { app } = withTelemetry()
    expect(await (await put(app, { notice: 'shown' })).json()).toMatchObject({ notice: 'shown' })
    expect(await (await put(app, { notice: 'acknowledged' })).json()).toMatchObject({
      notice: 'acknowledged',
    })
  })

  it('turning off is a setting, and refuses anything it does not understand', async () => {
    const { app, events } = withTelemetry()
    await put(app, { notice: 'shown' })
    await opened(app, { agent: 'claude' })
    expect(await (await put(app, { enabled: false })).json()).toMatchObject({
      enabled: false,
      source: 'setting',
    })
    expect(events.map((e) => e.event)).toEqual(['review_opened', 'telemetry_disabled'])
    expect(events[1]!.properties).toMatchObject({ source: 'ui' })
    expect((await put(app, { enabled: 'yes' })).status).toBe(400)
    expect((await put(app, { notice: 'never' })).status).toBe(400)
    expect((await put(app, 'garbage')).status).toBe(400)
  })

  it('an open before the notice arms nothing, and re-running diffo on it resumes it dark', async () => {
    const { app, events } = withTelemetry()
    expect(await (await opened(app, { agent: 'claude' })).json()).toEqual({
      ok: true,
      armed: false,
    })
    await put(app, { notice: 'shown' })
    expect(await (await opened(app, { agent: 'claude' })).json()).toEqual({
      ok: true,
      armed: false,
    })
    expect(events).toEqual([])
  })

  it('after the notice, an open reports once, with a narrowed agent', async () => {
    const { app, events } = withTelemetry()
    await put(app, { notice: 'shown' })
    expect(await (await opened(app, { agent: '/usr/bin/evil' })).json()).toEqual({
      ok: true,
      armed: true,
    })
    await opened(app, { agent: 'claude' })
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      event: 'review_opened',
      properties: { kind: 'tree', agent: 'other' },
    })
  })

  it('DO_NOT_TRACK on the server side keeps the page notice away and the open dark', async () => {
    const { app, events } = withTelemetry({ DO_NOT_TRACK: '1' })
    expect(await (await app.request('/api/telemetry')).json()).toMatchObject({
      enabled: false,
      source: 'env',
      variable: 'DO_NOT_TRACK',
    })
    await put(app, { notice: 'shown' })
    expect(await (await opened(app, { agent: 'claude' })).json()).toEqual({
      ok: true,
      armed: false,
    })
    expect(events).toEqual([])
  })
})

function git(dir: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd: dir,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

function tempRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'diffo-telemetry-api-'))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  git(dir, 'init', '-b', 'main')
  git(dir, 'config', 'user.email', 'test@example.com')
  git(dir, 'config', 'user.name', 'Test')
  git(dir, 'config', 'commit.gpgsign', 'false')
  writeFileSync(join(dir, 'app.ts'), 'const a = 1\nconst b = 2\n')
  git(dir, 'add', '-A')
  git(dir, 'commit', '-m', 'seed')
  writeFileSync(join(dir, 'app.ts'), 'const a = 1\nconst b = 42\n')
  return dir
}

describe('review_finished from the finish route', () => {
  it('counts the batch and the reviewer messages, never their text', async () => {
    const root = tempRepo()
    const dbDir = `${root}-db`
    cleanups.push(() => rmSync(dbDir, { recursive: true, force: true }))
    const db = new DiffoDb(join(dbDir, 'diffo.db'))
    cleanups.push(() => db.close())
    const store = new ChangesetStore(root, { kind: 'working-tree' })
    const review = new ReviewStore(root, db, { kind: 'working-tree' })
    const { events, impl } = fakeFetch()
    const telemetry = new Telemetry({
      store: memoryStore(),
      ids: memoryIds(),
      env: {},
      fetch: impl,
    })
    telemetry.acknowledge()
    const app = createApp(
      { root, spec: { kind: 'working-tree' }, clientDir: '/nope', telemetry },
      store,
      review,
      new DeliveryQueue(),
    )
    expect(await (await opened(app, { agent: 'claude' })).json()).toEqual({ ok: true, armed: true })

    const file = store.get().files[0]!
    const create = await app.request('/api/review/threads', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        anchor: { kind: 'hunk', hunkId: file.hunks[0]!.id, path: file.path, side: 'new', line: 2 },
        text: 'why 42? this is the secret text',
      }),
    })
    expect(create.status).toBe(200)

    const finish = await app.request('/api/review/finish', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ coverage: { read: 'all' } }),
    })
    expect(finish.status).toBe(200)
    await telemetry.flush()

    expect(events.map((e) => e.event)).toEqual(['review_opened', 'review_finished'])
    expect(events[1]!.properties).toMatchObject({
      kind: 'tree',
      threads: 1,
      comments: 1,
      layers: false,
      duration: '<5m',
    })
    expect(JSON.stringify(events)).not.toContain('secret')
    expect(JSON.stringify(events)).not.toContain(root)
    // No reviewer agents: no reviewer counts at all.
    expect(events[1]!.properties).not.toHaveProperty('reviewer_agents')
  })
})

describe('reviewer agents in usage data', () => {
  it('one event per ask with the count and built-in roles, then counts on finish', async () => {
    const root = tempRepo()
    const dbDir = `${root}-db`
    cleanups.push(() => rmSync(dbDir, { recursive: true, force: true }))
    const db = new DiffoDb(join(dbDir, 'diffo.db'))
    cleanups.push(() => db.close())
    const store = new ChangesetStore(root, { kind: 'working-tree' })
    const review = new ReviewStore(root, db, { kind: 'working-tree' })
    const { events, impl } = fakeFetch()
    const telemetry = new Telemetry({
      store: memoryStore(),
      ids: memoryIds(),
      env: {},
      fetch: impl,
    })
    telemetry.acknowledge()
    const settings = new Map<string, string>([
      [
        'reviewerRoles',
        JSON.stringify([{ id: 'secret-role', name: 'Secret role', blurb: '', focus: 'x' }]),
      ],
    ])
    const app = createApp(
      {
        root,
        spec: { kind: 'working-tree' },
        clientDir: '/nope',
        telemetry,
        uiSettings: {
          get: (key) => settings.get(key) ?? null,
          set: (key, value) => void settings.set(key, value),
        },
      },
      store,
      review,
      new DeliveryQueue(),
    )
    await opened(app, { agent: 'claude' })
    const json = { 'Content-Type': 'application/json' }
    const ask = await app.request('/api/reviewer/request', {
      method: 'POST',
      headers: json,
      body: JSON.stringify({ roles: ['general', 'ai-slop', 'secret-role'] }),
    })
    expect(ask.status).toBe(200)
    // A reviewer joins and comments: none of it is an event of its own.
    const cli = { ...json, 'x-diffo-agent': 'cli' }
    await app.request('/api/reviewer/join', {
      method: 'POST',
      headers: cli,
      body: JSON.stringify({ role: 'general' }),
    })
    const name = review.get().reviewers![0]!.name
    await app.request('/api/review/threads', {
      method: 'POST',
      headers: cli,
      body: JSON.stringify({ as: name, file: 'app.ts', line: 2, text: 'off by one' }),
    })
    // A second ask, for exactly the set the agent picked for this change.
    await app.request('/api/reviewer/pick', {
      method: 'POST',
      headers: cli,
      body: JSON.stringify({ set: 'refactor', reason: 'secret-reason' }),
    })
    await app.request('/api/reviewer/request', {
      method: 'POST',
      headers: json,
      body: JSON.stringify({ roles: ['tests', 'blast-radius', 'simplicity'] }),
    })
    await app.request('/api/review/finish', {
      method: 'POST',
      headers: json,
      body: JSON.stringify({ coverage: { read: 'all' } }),
    })
    await telemetry.flush()

    expect(events.map((e) => e.event)).toEqual([
      'review_opened',
      'reviewers_requested',
      'reviewers_requested',
      'review_finished',
    ])
    expect(events[1]!.properties).toMatchObject({
      kind: 'tree',
      count: 3,
      roles: 'ai-slop,custom,general',
      suggested: false,
    })
    // No set, no word about one.
    expect(events[1]!.properties).not.toHaveProperty('set')
    expect(events[1]!.properties).not.toHaveProperty('agent_pick')
    expect(events[2]!.properties).toMatchObject({ count: 3, set: 'refactor', agent_pick: true })
    expect(events[3]!.properties).toMatchObject({ reviewer_agents: 1, reviewer_threads: 1 })
    expect(JSON.stringify(events)).not.toContain('secret-reason')
    expect(JSON.stringify(events)).not.toContain('secret-role')
    expect(JSON.stringify(events)).not.toContain('off by one')
  })
})

describe('layers_requested from the request route', () => {
  it('reports one ask, whether the agent suggested it, and not the clicks that repeat it', async () => {
    const root = tempRepo()
    const dbDir = `${root}-db`
    cleanups.push(() => rmSync(dbDir, { recursive: true, force: true }))
    const db = new DiffoDb(join(dbDir, 'diffo.db'))
    cleanups.push(() => db.close())
    const store = new ChangesetStore(root, { kind: 'working-tree' })
    const review = new ReviewStore(root, db, { kind: 'working-tree' })
    const { events, impl } = fakeFetch()
    const telemetry = new Telemetry({
      store: memoryStore(),
      ids: memoryIds(),
      env: {},
      fetch: impl,
    })
    telemetry.acknowledge()
    const app = createApp(
      { root, spec: { kind: 'working-tree' }, clientDir: '/nope', telemetry },
      store,
      review,
      new DeliveryQueue(),
    )
    await opened(app, { agent: 'claude' })
    review.suggestLayers('a flow worth following in order')

    const ask = () => app.request('/api/review/layers/request', { method: 'POST' })
    expect((await ask()).status).toBe(200)
    // The same ask, still waiting for the agent.
    expect((await ask()).status).toBe(200)
    await telemetry.flush()

    expect(events.map((e) => e.event)).toEqual(['review_opened', 'layers_requested'])
    expect(events[1]!.properties).toMatchObject({
      kind: 'tree',
      suggested: true,
      refresh: false,
      note: false,
    })
    expect(JSON.stringify(events)).not.toContain('a flow worth')
  })
})
