import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseRolePatch, type ReviewerRole, type RoleMessage } from '../shared/roles.js'
import { DiffoDb } from './db.js'
import { DeliveryQueue } from './delivery.js'
import { createApp, type UiSettings } from './index.js'
import { ReviewStore } from './review.js'
import { ROLE_DELETED, RoleStore } from './roles.js'
import { ChangesetStore } from './store.js'

const cleanups: (() => void | Promise<void>)[] = []
afterEach(async () => {
  for (const fn of cleanups.splice(0)) await fn()
})

const memory = (): UiSettings & { kv: Map<string, string> } => {
  const kv = new Map<string, string>()
  return { kv, get: (key) => kv.get(key) ?? null, set: (key, value) => void kv.set(key, value) }
}

const perf: ReviewerRole = {
  id: 'perf',
  name: 'Performance',
  blurb: 'slow',
  focus: 'A query inside a loop.',
}
const DRAFT = 'draft-0a1b2c3d'

describe('parseRolePatch', () => {
  it('takes any of the three fields, held to a role’s limits', () => {
    expect(parseRolePatch({ name: '  Perf\n', focus: ' loops ' })).toEqual({
      ok: true,
      patch: { name: 'Perf', focus: 'loops' },
    })
    const error = (raw: unknown) => {
      const parsed = parseRolePatch(raw)
      return parsed.ok ? null : parsed.error
    }
    expect(error([])).toMatch(/name\?, blurb\?, focus\?/)
    expect(error({})).toMatch(/nothing to change/)
    expect(error({ name: 3 })).toMatch(/"name" must be a string/)
    expect(error({ name: ' ' })).toMatch(/needs a "name"/)
    expect(error({ name: 'x'.repeat(33) })).toMatch(/under 32/)
    expect(error({ blurb: 'x'.repeat(121) })).toMatch(/under 120/)
    expect(error({ focus: '' })).toMatch(/needs a "focus"/)
    expect(error({ focus: 'x'.repeat(2001) })).toMatch(/under 2000/)
  })
})

describe('RoleStore', () => {
  it('keeps an id the way it reads back, so the next edit finds it', () => {
    const store = new RoleStore(memory())
    expect(store.upsert('Perf', { name: 'Performance', focus: 'loops' })).toMatchObject({
      ok: true,
      role: { id: 'perf' },
    })
    expect(store.roles().map((r) => r.id)).toEqual(['perf'])
    expect(store.upsert('Perf', { focus: 'memory too' })).toMatchObject({ ok: true })
    expect(store.roles()).toMatchObject([{ id: 'perf', focus: 'memory too' }])
  })

  it('makes a role from a name and a focus, under an id that passes as a reviewer name', () => {
    const store = new RoleStore(memory())
    expect(store.upsert('perf', { name: 'Performance' })).toMatchObject({
      ok: false,
      error: expect.stringContaining('needs a "name" and a "focus"'),
    })
    expect(store.upsert('Two Words', { name: 'A', focus: 'b' })).toMatchObject({ ok: false })
    expect(store.upsert('agent', { name: 'A', focus: 'b' })).toMatchObject({ ok: false })
    expect(store.upsert(DRAFT, { name: 'A', focus: 'b' })).toMatchObject({
      ok: false,
      error: expect.stringContaining('names the conversation'),
    })
    expect(store.upsert('security', { focus: 'b' })).toMatchObject({
      ok: false,
      error: expect.stringContaining('built in'),
    })
    const made = store.upsert('perf', { name: 'Performance', focus: 'loops' })
    expect(made).toEqual({
      ok: true,
      role: { id: 'perf', name: 'Performance', blurb: '', focus: 'loops' },
      change: { fields: ['name', 'focus'], before: {}, created: true },
    })
    // An edit records the values before, for undo.
    expect(store.upsert('perf', { focus: 'memory' })).toMatchObject({
      ok: true,
      change: { fields: ['focus'], before: { focus: 'loops' } },
    })
    expect(store.roles()).toEqual([{ id: 'perf', name: 'Performance', blurb: '', focus: 'memory' }])
  })

  it('a saved role a built-in later took the id of loads as my-<id>, and the rest still load', () => {
    const settings = memory()
    settings.set(
      'reviewerRoles',
      JSON.stringify([
        { id: 'comments', name: 'No comments', blurb: '', focus: 'Flag needless comments.' },
        { id: 'perf', name: 'Perf', blurb: '', focus: 'Queries in loops.' },
      ]),
    )
    expect(new RoleStore(settings).roles().map((r) => [r.id, r.name])).toEqual([
      ['my-comments', 'No comments'],
      ['perf', 'Perf'],
    ])
  })

  it('a clash renamed onto an id the reviewer has too takes the next free one', () => {
    const settings = memory()
    settings.set(
      'reviewerRoles',
      JSON.stringify([
        { id: 'comments', name: 'Old', blurb: '', focus: 'Flag needless comments.' },
        { id: 'my-comments', name: 'Mine', blurb: '', focus: 'Flag stale comments.' },
      ]),
    )
    expect(new RoleStore(settings).roles().map((r) => [r.id, r.name])).toEqual([
      ['my-comments-2', 'Old'],
      ['my-comments', 'Mine'],
    ])
  })

  it('a bad saved role is dropped alone, and the next write keeps the rest', () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const settings = memory()
    settings.set(
      'reviewerRoles',
      JSON.stringify([
        { id: 'perf', name: 'Perf', blurb: '', focus: 'Queries in loops.' },
        { id: 'Bad Id', name: 'Bad', blurb: '', focus: 'x' },
        { id: 'perf', name: 'Twice', blurb: '', focus: 'again' },
      ]),
    )
    const store = new RoleStore(settings)
    expect(store.roles().map((r) => r.id)).toEqual(['perf'])
    expect(store.upsert('style', { name: 'Style', focus: 'naming' }).ok).toBe(true)
    expect(store.roles().map((r) => r.id)).toEqual(['perf', 'style'])
    expect(errors).toHaveBeenCalled()
    errors.mockRestore()
  })

  it('tells every write to its listeners', () => {
    const store = new RoleStore(memory())
    const heard = vi.fn()
    store.subscribe(heard)
    store.saveRoles([perf])
    store.addMessage('perf', 'reviewer', 'memory too')
    store.clearThread('perf')
    expect(heard).toHaveBeenCalledTimes(3)
  })

  it('a deleted role takes its conversation with it, and stays deleted', () => {
    const store = new RoleStore(memory())
    store.saveRoles([perf])
    store.addMessage('perf', 'reviewer', 'memory too')
    store.addMessage('security', 'reviewer', 'stricter')
    store.addMessage(DRAFT, 'reviewer', 'a docs reviewer')
    store.saveRoles([])
    expect(store.thread('perf').messages).toEqual([])
    // A built-in's and a draft's conversations belong to no saved role.
    expect(store.thread('security').messages).toHaveLength(1)
    expect(store.thread(DRAFT).messages).toHaveLength(1)
    expect(store.wasDeleted('perf')).toBe(true)
    expect(store.upsert('perf', { name: 'Performance', focus: 'loops' })).toEqual({
      ok: false,
      error: ROLE_DELETED,
    })
  })

  it('the conversation waiting on a new role is the latest built-in’s or draft’s the reviewer spoke last in', async () => {
    const store = new RoleStore(memory())
    store.saveRoles([perf])
    expect(store.waitingAsk()).toBeUndefined()
    store.addMessage('perf', 'reviewer', 'memory too')
    expect(store.waitingAsk()).toBeUndefined()
    store.addMessage('security', 'reviewer', 'stricter')
    await new Promise((r) => setTimeout(r, 5))
    store.addMessage(DRAFT, 'reviewer', 'a docs reviewer')
    expect(store.waitingAsk()).toBe(DRAFT)
    store.addMessage(DRAFT, 'agent', 'which docs?')
    expect(store.waitingAsk()).toBe('security')
  })
})

function tempRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'diffo-roles-'))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] })
  git('init', '-b', 'main')
  git('config', 'user.email', 'test@example.com')
  git('config', 'user.name', 'Test')
  git('config', 'commit.gpgsign', 'false')
  writeFileSync(join(dir, 'app.ts'), 'const a = 1\n')
  git('add', '-A')
  git('commit', '-m', 'seed')
  writeFileSync(join(dir, 'app.ts'), 'const a = 2\n')
  return dir
}

function setup(roles: ReviewerRole[] = []) {
  const root = tempRepo()
  const dbDir = `${root}-db`
  cleanups.push(() => rmSync(dbDir, { recursive: true, force: true }))
  const store = new ChangesetStore(root, { kind: 'working-tree' })
  const review = new ReviewStore(root, new DiffoDb(join(dbDir, 'diffo.db')), {
    kind: 'working-tree',
  })
  const queue = new DeliveryQueue()
  const settings = memory()
  settings.set('reviewerRoles', JSON.stringify(roles))
  const app = createApp(
    { root, spec: { kind: 'working-tree' }, clientDir: '/nope', uiSettings: settings },
    store,
    review,
    queue,
  )
  const send = (path: string, body: unknown, method = 'POST') =>
    app.request(path, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  const thread = async (key: string) =>
    (
      (await (await app.request(`/api/reviewer/roles/${key}/thread`)).json()) as {
        thread: { messages: RoleMessage[] }
      }
    ).thread.messages
  const roleList = async () =>
    (
      (await (await app.request('/api/reviewer/roles')).json()) as {
        roles: ReviewerRole[]
      }
    ).roles
  return { app, queue, send, thread, roleList }
}

describe('the conversation about a reviewer role', () => {
  it('the reviewer writes, the message rides the poll, and the agent edits with an undo', async () => {
    const { app, queue, send, thread } = setup([perf])
    expect((await send('/api/reviewer/roles/perf/messages', { text: ' ' })).status).toBe(400)
    // Only a role, or a new role's draft, has a conversation.
    expect((await send('/api/reviewer/roles/nope/messages', { text: 'hi' })).status).toBe(400)
    expect((await send('/api/reviewer/roles/perf/messages', { text: ' memory too ' })).status).toBe(
      200,
    )
    expect(queue.take()).toEqual({ kind: 'role', id: 'perf' })
    const payload = (await (
      await app.request('/api/agent/poll', { headers: { 'x-diffo-agent': 'cli' } })
    ).json()) as { kind: string; prompt: string; next_step: string }
    expect(payload.kind).toBe('role')
    expect(payload.prompt).toContain('"Performance" (id `perf`)')
    expect(payload.prompt).toContain('- Reviewer: memory too')
    expect(payload.next_step).toContain('diffo role update')
    expect(queue.take()).toBeNull()
    // The agent's edit: only the fields it sends change.
    expect((await send('/api/reviewer/roles/perf', { fields: {} })).status).toBe(400)
    expect((await send('/api/reviewer/roles/tests', { fields: { focus: 'x' } })).status).toBe(400)
    const edited = await send('/api/reviewer/roles/perf', {
      fields: { focus: 'Queries in loops, and memory held.' },
      message: 'Memory is in now.',
    })
    expect(edited.status).toBe(200)
    expect(await edited.json()).toMatchObject({
      role: { id: 'perf', name: 'Performance', focus: 'Queries in loops, and memory held.' },
    })
    expect((await thread('perf')).map((m) => [m.author, m.text, m.change])).toEqual([
      ['reviewer', 'memory too', undefined],
      ['agent', 'Memory is in now.', { fields: ['focus'], before: { focus: perf.focus } }],
    ])
    // The agent's plain reply changes nothing and owes nothing.
    expect(
      (await send('/api/reviewer/roles/perf/messages', { author: 'agent', text: 'Sure?' })).status,
    ).toBe(200)
    expect(queue.take()).toBeNull()
    // The undo is the page's save of the values before.
    expect((await send('/api/reviewer/roles', { roles: [perf] }, 'PUT')).status).toBe(200)
  })

  it('a draft waits for the agent to name the role; its conversation carries on under it', async () => {
    const { app, send, thread, roleList } = setup()
    await send(`/api/reviewer/roles/${DRAFT}/messages`, { text: 'a performance reviewer' })
    // No role is made on the first word: it has no id yet.
    expect((await roleList()).map((r) => r.id)).not.toContain(DRAFT)
    const payload = (await (
      await app.request('/api/agent/poll', { headers: { 'x-diffo-agent': 'cli' } })
    ).json()) as { prompt: string }
    expect(payload.prompt).toContain('a new role, which has no id yet')
    // The agent may ask first, under the draft.
    expect(
      (await send(`/api/reviewer/roles/${DRAFT}/messages`, { author: 'agent', text: 'Memory?' }))
        .status,
    ).toBe(200)
    await send(`/api/reviewer/roles/${DRAFT}/messages`, { text: 'time only' })
    // It cannot make the role under the draft key.
    expect(
      (await send(`/api/reviewer/roles/${DRAFT}`, { fields: { name: 'P', focus: 'f' } })).status,
    ).toBe(400)
    const made = await send('/api/reviewer/roles/query-cost', {
      fields: { name: 'Performance', blurb: 'What gets slower', focus: 'Queries in loops.' },
      message: 'Made it.',
    })
    expect(made.status).toBe(200)
    expect((await roleList()).map((r) => r.id)).toContain('query-cost')
    // The draft hears which role it became; the role has the whole conversation.
    expect((await thread(DRAFT)).at(-1)).toMatchObject({
      author: 'agent',
      text: 'Made it.',
      change: { created: true, roleId: 'query-cost' },
    })
    expect((await thread('query-cost')).map((m) => [m.author, m.text])).toEqual([
      ['reviewer', 'a performance reviewer'],
      ['agent', 'Memory?'],
      ['reviewer', 'time only'],
      ['agent', 'Made it.'],
    ])
    // A later edit is said in the role's conversation only.
    await send('/api/reviewer/roles/query-cost', { fields: { blurb: 'slow' }, message: 'x' })
    expect(await thread(DRAFT)).toHaveLength(4)
  })

  it('a copy the agent makes of a built-in is answered in the built-in’s conversation too', async () => {
    const { send, thread } = setup()
    await send('/api/reviewer/roles/tests/messages', { text: 'stricter' })
    const made = await send('/api/reviewer/roles/tests-strict', {
      fields: { name: 'Tests, strict', focus: 'Every branch tested.' },
      message: 'A stricter copy.',
    })
    expect(made.status).toBe(200)
    expect((await thread('tests')).at(-1)).toMatchObject({
      text: 'A stricter copy.\n\nThe copy is “Tests, strict”, under your reviewer agents.',
      change: { created: true, roleId: 'tests-strict' },
    })
    expect((await thread('tests-strict')).map((m) => m.text)).toEqual(['A stricter copy.'])
  })

  it('a new conversation clears the messages; deleting the role deletes them, and a late answer is refused', async () => {
    const { queue, app, send, thread } = setup([perf])
    await send('/api/reviewer/roles/perf/messages', { text: 'memory too' })
    const cleared = await app.request('/api/reviewer/roles/perf/thread', { method: 'DELETE' })
    expect(await cleared.json()).toMatchObject({ cleared: true, thread: { messages: [] } })
    expect(queue.take()).toBeNull()
    await send('/api/reviewer/roles/perf/messages', { text: 'again' })
    expect((await send('/api/reviewer/roles', { roles: [] }, 'PUT')).status).toBe(200)
    expect(await thread('perf')).toEqual([])
    expect(queue.take()).toBeNull()
    const late = await send('/api/reviewer/roles/perf', {
      fields: { name: 'Performance', focus: 'loops' },
    })
    expect(late.status).toBe(400)
    expect(((await late.json()) as { error: string }).error).toContain('deleted this role')
    expect(
      (await send('/api/reviewer/roles/perf/messages', { author: 'agent', text: 'Which?' })).status,
    ).toBe(400)
  })
})
