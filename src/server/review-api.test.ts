import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { type OutgoingThread, type ReviewThread, undeliveredThreadIds } from '../shared/review.js'
import { DiffoDb } from './db.js'
import { DeliveryQueue } from './delivery.js'
import { createApp } from './index.js'
import { ReviewStore } from './review.js'
import { ChangesetStore } from './store.js'

const cleanups: (() => void | Promise<void>)[] = []
afterEach(async () => {
  for (const fn of cleanups.splice(0)) await fn()
})

function git(dir: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd: dir,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

function tempRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'diffo-review-api-'))
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

function makeDb(root: string): DiffoDb {
  const dbDir = `${root}-db`
  cleanups.push(() => rmSync(dbDir, { recursive: true, force: true }))
  return new DiffoDb(join(dbDir, 'diffo.db'))
}

function setup(pollHeartbeatMs?: number, batchSettleMs?: number, pollMaxMs?: number) {
  const root = tempRepo()
  const store = new ChangesetStore(root, { kind: 'working-tree' })
  const review = new ReviewStore(root, makeDb(root), { kind: 'working-tree' })
  const queue = new DeliveryQueue(undefined, undefined, {}, batchSettleMs)
  const app = createApp(
    { root, spec: { kind: 'working-tree' }, clientDir: '/nope', pollHeartbeatMs, pollMaxMs },
    store,
    review,
    queue,
  )
  return { root, store, review, queue, app }
}

async function post(app: ReturnType<typeof setup>['app'], path: string, body?: unknown) {
  return app.request(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

async function pollResult(res: Response): Promise<Record<string, unknown>> {
  return JSON.parse((await res.text()).trim()) as Record<string, unknown>
}

async function answeredThread(
  app: ReturnType<typeof setup>['app'],
  review: ReturnType<typeof setup>['review'],
): Promise<string> {
  const created = await post(app, '/api/review/threads', {
    anchor: { kind: 'changeset' },
    text: 'why 42?',
  })
  const { id } = (await created.json()) as ReviewThread
  await post(app, `/api/review/threads/${id}/send`, {})
  review.setState(id, 'addressed')
  return id
}

const tick = () => new Promise((r) => setTimeout(r, 20))

describe('review API', () => {
  it('creates a hunk thread with a code-context snapshot', async () => {
    const { app, store } = setup()
    const hunk = store.get().files[0]!.hunks[0]!
    const res = await post(app, '/api/review/threads', {
      anchor: { kind: 'hunk', hunkId: hunk.id, path: 'app.ts', side: 'new', line: 2 },
      text: 'why 42?',
    })
    expect(res.status).toBe(200)
    const thread = (await res.json()) as ReviewThread
    expect(thread.state).toBe('open')
    expect(thread.codeContext).toContain('+const b = 42')
    expect(thread.codeContext).toContain('-const b = 2')

    const list = await (await app.request('/api/review')).json()
    expect(list.threads).toHaveLength(1)
  })

  it('a reply can be withheld — written into the thread, not handed over', async () => {
    const { app } = setup()
    const created = await post(app, '/api/review/threads', {
      anchor: { kind: 'changeset' },
      text: 'why 42?',
    })
    const { id } = (await created.json()) as ReviewThread
    await post(app, `/api/review/threads/${id}/send`, {})

    const held = await post(app, `/api/review/threads/${id}/messages`, {
      text: 'second thought',
      deliver: false,
    })
    const { thread, delivered } = (await held.json()) as {
      thread: ReviewThread
      delivered: boolean
    }
    expect(thread.messages.at(-1)?.text).toBe('second thought')
    expect(thread.withheld).toBe(true)
    expect(delivered).toBe(false)

    await post(app, `/api/review/threads/${id}/send`, {})
    const after = (await (await app.request('/api/review')).json()) as {
      threads: ReviewThread[]
    }
    expect(after.threads[0]!.withheld).toBeUndefined()
  })

  it('Send hands over a held reply on an answered thread too', async () => {
    const { app, review } = setup()
    const id = await answeredThread(app, review)

    await post(app, `/api/review/threads/${id}/messages`, {
      text: 'still not right',
      deliver: false,
    })
    expect(review.get().threads[0]!.withheld).toBe(true)

    await post(app, `/api/review/threads/${id}/send`, {})
    expect(review.get().threads[0]!.withheld).toBeUndefined()
  })

  it('a delivered reply releases a held one — the queued prompt carries the whole thread', async () => {
    const { app, review } = setup()
    const id = await answeredThread(app, review)

    await post(app, `/api/review/threads/${id}/messages`, {
      text: 'thinking out loud',
      deliver: false,
    })
    expect(review.get().threads[0]!.withheld).toBe(true)

    const res = await post(app, `/api/review/threads/${id}/messages`, { text: 'ship it all' })
    const { thread } = (await res.json()) as { thread: ReviewThread }
    expect(thread.withheld).toBeUndefined()
    expect(review.get().threads[0]!.withheld).toBeUndefined()
  })

  it('Send stays a no-op on an answered thread with nothing held', async () => {
    const { app, review } = setup()
    const id = await answeredThread(app, review)

    const res = await post(app, `/api/review/threads/${id}/send`, {})
    const { delivered } = (await res.json()) as { delivered: boolean }
    expect(delivered).toBe(false)
  })

  it('omitting the flag still delivers — the CLI and every old caller are unchanged', async () => {
    const { app } = setup()
    const created = await post(app, '/api/review/threads', {
      anchor: { kind: 'changeset' },
      text: 'why 42?',
    })
    const { id } = (await created.json()) as ReviewThread
    await post(app, `/api/review/threads/${id}/send`, {})
    const res = await post(app, `/api/review/threads/${id}/messages`, { text: 'follow-up' })
    const { thread } = (await res.json()) as { thread: ReviewThread }
    expect(thread.withheld).toBeUndefined()
  })

  it('rejects garbage bodies', async () => {
    const { app } = setup()
    expect((await post(app, '/api/review/threads', { text: 'no anchor' })).status).toBe(400)
    expect(
      (await post(app, '/api/review/threads', { anchor: { kind: 'changeset' }, text: '  ' }))
        .status,
    ).toBe(400)
    expect((await post(app, '/api/review/threads/nope/messages', { text: 'hi' })).status).toBe(404)
    expect((await post(app, '/api/review/threads/nope/state', { state: 'sent' })).status).toBe(400)
  })

  it('reply → send returns a prompt with the CLI protocol → resolve', async () => {
    const { app } = setup()
    const created = await post(app, '/api/review/threads', {
      anchor: { kind: 'file', path: 'app.ts' },
      text: 'general note',
    })
    const thread = (await created.json()) as ReviewThread

    const reply = await post(app, `/api/review/threads/${thread.id}/messages`, { text: 'more' })
    const replyBody = (await reply.json()) as { thread: ReviewThread; delivered: boolean }
    expect(replyBody.thread.messages).toHaveLength(2)
    expect(replyBody.delivered).toBe(false)

    const sent = await post(app, `/api/review/threads/${thread.id}/send`)
    const sentBody = (await sent.json()) as {
      thread: ReviewThread
      prompt: string
      delivered: boolean
      presence: string
    }
    expect(sentBody.thread.state).toBe('sent')
    expect(sentBody.prompt).toContain('general note')
    expect(sentBody.prompt).toContain('npx -y @diffohq/diffo reply')
    expect(sentBody.delivered).toBe(false)
    expect(sentBody.presence).toBe('waiting')

    const resolved = await post(app, `/api/review/threads/${thread.id}/state`, {
      state: 'resolved',
    })
    expect(((await resolved.json()) as ReviewThread).state).toBe('resolved')
  })

  it('finish flushes open threads and reports coverage in the prompt', async () => {
    const { app } = setup()
    await post(app, '/api/review/threads', { anchor: { kind: 'changeset' }, text: 'overall' })
    const res = await post(app, '/api/review/finish', {
      coverage: { viewedHunks: 1, totalHunks: 3, skippedFiles: ['b.ts'] },
    })
    const body = (await res.json()) as { threads: ReviewThread[]; prompt: string }
    expect(body.threads[0]!.state).toBe('sent')
    expect(body.prompt).toContain('1/3 hunks read')
    expect(body.prompt).toContain('b.ts')
  })

  it('the closing note rides the coverage into the prompt; junk is dropped', async () => {
    const { app } = setup()
    const res = await post(app, '/api/review/finish', {
      coverage: {
        viewedHunks: 1,
        totalHunks: 1,
        skippedFiles: [],
        note: '  merge it please  ',
      },
    })
    const body = (await res.json()) as { threads: ReviewThread[]; prompt: string }
    expect(body.prompt).toContain('merge it please')

    // The note is a thread of the reviewer's, sent with the batch it closes — so the
    // agent has an id to reply to, and the queue counts it as an answer still owed.
    const note = body.threads.find((t) => t.closingNote)!
    expect(note.anchor).toEqual({ kind: 'changeset' })
    expect(note.messages).toEqual([
      expect.objectContaining({ author: 'reviewer', text: 'merge it please' }),
    ])
    expect(note.state).toBe('sent')
    expect(undeliveredThreadIds(body.threads)).toContain(note.id)
    expect(body.prompt).toContain(`id: ${note.id}`)

    // A pre-removal client still sending a verdict must not break anything.
    const junk = (await (
      await post(app, '/api/review/finish', {
        coverage: {
          viewedHunks: 1,
          totalHunks: 1,
          skippedFiles: [],
          verdict: 'approve',
          note: '  ',
        },
      })
    ).json()) as { threads: ReviewThread[]; prompt: string }
    expect(junk.prompt).not.toContain('Verdict:')
    // A blank note adds no second thread — only the first finish's note is there.
    expect(junk.threads.filter((t) => t.closingNote)).toHaveLength(1)
  })

  it('the closing note leads the batch, and the agent can reply to it', async () => {
    const { app } = setup()
    await post(app, '/api/review/threads', {
      anchor: { kind: 'changeset' },
      text: 'why 42?',
      intent: 'question',
    })
    const finished = (await (
      await post(app, '/api/review/finish', {
        coverage: {
          viewedHunks: 1,
          totalHunks: 1,
          skippedFiles: [],
          note: 'ship it after the nit',
        },
      })
    ).json()) as { threads: ReviewThread[]; prompt: string }

    // Thread 1 of the prompt, quoted once — not repeated as a preamble block.
    expect(finished.prompt).toContain('Thread 1 [their closing note on the whole review]')
    expect(finished.prompt.match(/ship it after the nit/g)).toHaveLength(1)
    expect(finished.prompt).toContain('Their closing note is Thread 1 below')

    const note = finished.threads.find((t) => t.closingNote)!
    const replied = (await post(app, `/api/review/threads/${note.id}/messages`, {
      author: 'agent',
      text: 'will do',
    })) as Response
    expect(replied.status).toBe(200)
    const { thread } = (await replied.json()) as { thread: ReviewThread }
    expect(thread.messages.at(-1)).toMatchObject({ author: 'agent', text: 'will do' })
    expect(undeliveredThreadIds([thread])).toEqual([])
  })

  it('the finish preview shows the closing note as one of the outgoing threads', async () => {
    const { app, review } = setup()
    const res = await post(app, '/api/review/finish/preview', {
      coverage: { viewedHunks: 1, totalHunks: 1, skippedFiles: [], note: 'one nit, then ship' },
    })
    const body = (await res.json()) as { outgoing: OutgoingThread[]; prompt: string }
    expect(body.outgoing).toEqual([
      expect.objectContaining({
        anchor: { kind: 'changeset' },
        text: 'one nit, then ship',
        fresh: true,
      }),
    ])
    expect(body.prompt).toContain('their closing note on the whole review')
    // A preview writes nothing — the reviewer can still walk away.
    expect(review.get().threads).toEqual([])
  })

  it('a closing note survives a restart as a thread', async () => {
    const { app, root } = setup()
    await post(app, '/api/review/finish', {
      coverage: { viewedHunks: 1, totalHunks: 1, skippedFiles: [], note: 'read it all, one nit' },
    })
    const reopened = new ReviewStore(root, makeDb(root), { kind: 'working-tree' })
    const note = reopened.get().threads.find((t) => t.closingNote)
    expect(note?.messages[0]?.text).toBe('read it all, one nit')
  })

  it('finish leaves behind the threads whose changeset is behind you', async () => {
    const { app } = setup()
    await post(app, '/api/review/threads', {
      anchor: { kind: 'file', path: 'app.ts' },
      text: 'live-note-xyz',
    })
    await post(app, '/api/review/threads', {
      anchor: { kind: 'file', path: 'gone.ts' },
      text: 'past-note-xyz',
    })

    const res = await post(app, '/api/review/finish', {
      coverage: { viewedHunks: 1, totalHunks: 1, skippedFiles: [] },
    })
    const body = (await res.json()) as { threads: ReviewThread[]; prompt: string }
    const state = (text: string) => body.threads.find((t) => t.messages[0]!.text === text)!.state
    expect(state('live-note-xyz')).toBe('sent')
    expect(state('past-note-xyz')).toBe('open')
    expect(body.prompt).toContain('live-note-xyz')
    expect(body.prompt).not.toContain('past-note-xyz')
  })

  it('a sent thread left behind by its changeset stops riding Finish', async () => {
    const { app } = setup()
    const ghost = (await (
      await post(app, '/api/review/threads', {
        anchor: { kind: 'file', path: 'gone.ts' },
        text: 'ghost note',
      })
    ).json()) as ReviewThread
    await post(app, `/api/review/threads/${ghost.id}/send`)

    const coverage = { viewedHunks: 1, totalHunks: 1, skippedFiles: [] }
    const preview = (await (
      await post(app, '/api/review/finish/preview', { coverage })
    ).json()) as { outgoing: unknown[]; prompt: string }
    expect(preview.outgoing).toEqual([])
    expect(preview.prompt).not.toContain('ghost note')

    const finished = (await (await post(app, '/api/review/finish', { coverage })).json()) as {
      prompt: string
    }
    expect(finished.prompt).not.toContain('ghost note')
    // With the ghost out of the batch, a fully-read finish reads as the clean one.
    expect(finished.prompt).toContain('green light')
  })

  it('previews the batch without sending or flushing anything', async () => {
    const { app, review, queue } = setup()
    await post(app, '/api/review/threads', { anchor: { kind: 'changeset' }, text: 'overall' })
    const res = await post(app, '/api/review/finish/preview', {
      coverage: { viewedHunks: 1, totalHunks: 3, skippedFiles: ['b.ts'] },
    })
    const body = (await res.json()) as {
      outgoing: { text: string; fresh: boolean }[]
      prompt: string
    }
    expect(body.outgoing).toEqual([{ ...body.outgoing[0], text: 'overall', fresh: true }])
    expect(body.prompt).toContain('overall')
    expect(body.prompt).toContain('1/3 hunks read')
    expect(review.get().threads[0]!.state).toBe('open')
    expect(queue.take()).toBeNull()
  })

  it('preview and finish agree — a listed row is a thread block', async () => {
    const { app, store } = setup()
    const hunk = store.get().files[0]!.hunks[0]!
    await post(app, '/api/review/threads', { anchor: { kind: 'changeset' }, text: 'note' })
    const sent = (await (
      await post(app, '/api/review/threads', {
        anchor: { kind: 'hunk', hunkId: hunk.id, path: 'app.ts', side: 'new', line: 2 },
        text: 'this one went earlier',
      })
    ).json()) as ReviewThread
    await post(app, `/api/review/threads/${sent.id}/send`)

    const coverage = { viewedHunks: 1, totalHunks: 1, skippedFiles: [] }
    const preview = (await (
      await post(app, '/api/review/finish/preview', { coverage })
    ).json()) as { outgoing: { id: string; fresh: boolean }[]; prompt: string }
    const finished = (await (await post(app, '/api/review/finish', { coverage })).json()) as {
      prompt: string
    }
    expect(preview.outgoing.map((t) => t.fresh)).toEqual([true, false])
    expect(finished.prompt).toBe(preview.prompt)
    for (const t of preview.outgoing) expect(finished.prompt).toContain(t.id)
  })

  it('deliver:false finishes the review but sends nothing down the poll', async () => {
    const { app, review, queue } = setup()
    await post(app, '/api/review/threads', { anchor: { kind: 'changeset' }, text: 'by hand' })
    const res = await post(app, '/api/review/finish', {
      coverage: { viewedHunks: 1, totalHunks: 1, skippedFiles: [] },
      deliver: false,
    })
    const body = (await res.json()) as { prompt: string; delivered: boolean }
    expect(body.delivered).toBe(false)
    expect(body.prompt).toContain('by hand')
    expect(review.get().threads[0]!.state).toBe('sent')
    expect(queue.take()).toBeNull()
  })

  it('review endpoints 503 without a review store', async () => {
    const app = createApp({ root: '/x', spec: { kind: 'working-tree' }, clientDir: '/nope' })
    expect((await app.request('/api/review')).status).toBe(503)
    expect((await app.request('/api/review/threads/x', { method: 'DELETE' })).status).toBe(503)
    expect(
      (await app.request('/api/agent/poll', { headers: { 'x-diffo-agent': 'cli' } })).status,
    ).toBe(503)
    expect((await app.request('/api/agent/end', { method: 'POST' })).status).toBe(503)
  })

  it('poll refuses a request with no x-diffo-* header (a no-cors browser GET cannot send one)', async () => {
    const { app, queue } = setup()
    const res = await app.request('/api/agent/poll')
    expect(res.status).toBe(403)
    // The refused request must leave no trace: no session claimed, nothing confirmed.
    expect(queue.ownerPid()).toBeNull()
  })

  it('DELETE drops a thread and its pending delivery; unknown ids 404', async () => {
    const { app, queue } = setup()
    const created = await post(app, '/api/review/threads', {
      anchor: { kind: 'changeset' },
      text: 'stray thought',
    })
    const thread = (await created.json()) as ReviewThread
    await post(app, `/api/review/threads/${thread.id}/send`)
    expect(queue.take()).toMatchObject({ kind: 'threads', threadIds: [thread.id] })

    const res = await app.request(`/api/review/threads/${thread.id}`, { method: 'DELETE' })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ removed: true })
    expect(queue.take()).toBeNull()

    const list = (await (await app.request('/api/review')).json()) as { threads: ReviewThread[] }
    expect(list.threads).toEqual([])

    const again = await app.request(`/api/review/threads/${thread.id}`, { method: 'DELETE' })
    expect(again.status).toBe(404)
  })

  it('DELETE on the collection clears the review and its pending deliveries', async () => {
    const { app, queue } = setup()
    for (const text of ['one', 'two']) {
      const created = await post(app, '/api/review/threads', {
        anchor: { kind: 'changeset' },
        text,
      })
      await post(app, `/api/review/threads/${((await created.json()) as ReviewThread).id}/send`)
    }

    const res = await app.request('/api/review/threads', { method: 'DELETE' })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ removed: 2 })
    // The pending thread deliveries are gone; what remains is the one heads-up
    // that the slate was cleared (the changeset on screen still has files).
    expect(queue.take()).toEqual({ kind: 'cleared' })

    const list = (await (await app.request('/api/review')).json()) as { threads: ReviewThread[] }
    expect(list.threads).toEqual([])
    // A reset of an already-empty review owes nothing — no second heads-up.
    const again = await app.request('/api/review/threads', { method: 'DELETE' })
    expect(again.status).toBe(200)
    expect(await again.json()).toEqual({ removed: 0 })
    expect(queue.take()).toEqual({ kind: 'cleared' })
  })

  it('DELETE on the collection is a full reset: lastFinish and the landed marker go too', async () => {
    const { app, review } = setup()
    await post(app, '/api/review/threads', { anchor: { kind: 'changeset' }, text: 'old round' })
    await post(app, '/api/review/finish', { coverage: { viewedHunks: 1, totalHunks: 1 } })
    review.markLanded({ sha: 'landing', subject: 'ship it', at: new Date().toISOString() })

    await app.request('/api/review/threads', { method: 'DELETE' })

    const state = review.get()
    expect(state.threads).toEqual([])
    expect(state.lastFinish).toBeUndefined()
    expect(state.landed).toBeUndefined()
  })

  it('DELETE /api/review/landed keeps the offer away but the review intact', async () => {
    const { app, review } = setup()
    await post(app, '/api/review/threads', { anchor: { kind: 'changeset' }, text: 'kept' })
    review.markLanded({ sha: 'landing', subject: 'ship it', at: new Date().toISOString() })

    const res = await app.request('/api/review/landed', { method: 'DELETE' })
    expect(res.status).toBe(200)
    expect(review.get().landed).toBeUndefined()
    expect(review.get().threads).toHaveLength(1)
  })

  it('the full loop: sent thread flips addressed when the hunk is edited', async () => {
    const { app, store, review, root } = setup()
    const hunk = store.get().files[0]!.hunks[0]!
    const created = await post(app, '/api/review/threads', {
      anchor: { kind: 'hunk', hunkId: hunk.id, path: 'app.ts', side: 'new', line: 2 },
      text: 'fix this',
    })
    const thread = (await created.json()) as ReviewThread
    await post(app, `/api/review/threads/${thread.id}/send`)

    writeFileSync(join(root, 'app.ts'), 'const a = 1\nconst b = 7\n')
    await store.refresh()
    review.reconcile(new Set(store.get().files.flatMap((f) => f.hunks.map((h) => h.id))))

    const list = await (await app.request('/api/review')).json()
    expect(list.threads[0].state).toBe('addressed')
  })
})

describe('the pull loop', () => {
  it('a queued send is returned by the next poll — and only marked delivered then', async () => {
    const { app, queue } = setup()
    const created = await post(app, '/api/review/threads', {
      anchor: { kind: 'changeset' },
      text: 'explain the design',
    })
    const thread = (await created.json()) as ReviewThread
    await post(app, `/api/review/threads/${thread.id}/send`)

    const payload = await pollResult(
      await app.request('/api/agent/poll', { headers: { 'x-diffo-agent': 'cli' } }),
    )
    expect(payload.status).toBe('feedback')
    expect(payload.kind).toBe('threads')
    expect(payload.threadIds).toEqual([thread.id])
    expect(payload.prompt).toContain('explain the design')
    expect(payload.prompt).toContain('npx -y @diffohq/diffo reply')
    expect(payload.next_step).toContain('diffo poll')

    expect(queue.take()).toBeNull()
    expect(queue.presence()).toBe('working')
  })

  it('a reset wakes a waiting poll with the cleared heads-up — a fresh guide is owed', async () => {
    const { app, queue } = setup()
    const created = await post(app, '/api/review/threads', {
      anchor: { kind: 'changeset' },
      text: 'the old guide',
    })
    await post(app, `/api/review/threads/${((await created.json()) as ReviewThread).id}/send`)
    // Drain the send: the agent is mid-round when the reviewer starts over.
    await pollResult(await app.request('/api/agent/poll', { headers: { 'x-diffo-agent': 'cli' } }))

    const poll = Promise.resolve(
      app.request('/api/agent/poll', { headers: { 'x-diffo-agent': 'cli' } }),
    ).then(pollResult)
    await tick()
    await app.request('/api/review/threads', { method: 'DELETE' })

    const payload = await poll
    expect(payload.status).toBe('feedback')
    expect(payload.kind).toBe('cleared')
    expect(payload.threadIds).toEqual([])
    expect(payload.prompt).toContain('cleared the review')
    expect(payload.prompt).toContain('post it — one comment on the whole changeset')
    expect(payload.prompt).toContain('npx -y @diffohq/diffo comment')
    expect(payload.next_step).toContain('diffo poll')
    // Consumed: the next poll owes nothing.
    expect(queue.take()).toBeNull()
  })

  it('a send resolves a WAITING poll immediately and reports delivered', async () => {
    const { app } = setup()
    const created = await post(app, '/api/review/threads', {
      anchor: { kind: 'changeset' },
      text: 'live question',
    })
    const thread = (await created.json()) as ReviewThread

    const poll = Promise.resolve(
      app.request('/api/agent/poll', { headers: { 'x-diffo-agent': 'cli' } }),
    ).then(pollResult)
    await tick()
    const sent = (await (await post(app, `/api/review/threads/${thread.id}/send`)).json()) as {
      delivered: boolean
      presence: string
    }
    expect(sent.presence).toBe('listening')
    expect(sent.delivered).toBe(true)

    const payload = await poll
    expect(payload.status).toBe('feedback')
    expect(payload.threadIds).toEqual([thread.id])
  })

  it('sends while the agent is working pool, and the next poll drains them as ONE coalesced payload', async () => {
    const { app } = setup()
    const ids: string[] = []
    for (const text of ['first', 'second', 'third']) {
      const res = await post(app, '/api/review/threads', { anchor: { kind: 'changeset' }, text })
      ids.push(((await res.json()) as ReviewThread).id)
    }
    const poll1 = Promise.resolve(
      app.request('/api/agent/poll', { headers: { 'x-diffo-agent': 'cli' } }),
    ).then(pollResult)
    await tick()
    await post(app, `/api/review/threads/${ids[0]}/send`)
    expect((await poll1).threadIds).toEqual([ids[0]])

    await post(app, `/api/review/threads/${ids[1]}/send`)
    await post(app, `/api/review/threads/${ids[2]}/send`)

    const payload = await pollResult(
      await app.request('/api/agent/poll', { headers: { 'x-diffo-agent': 'cli' } }),
    )
    expect(payload.kind).toBe('threads')
    expect(new Set(payload.threadIds as string[])).toEqual(new Set([ids[1], ids[2]]))
    expect(payload.prompt).toContain('2 review threads')
  })

  it('Finish flushes the batch and absorbs pooled per-thread sends', async () => {
    const { app } = setup()
    const a = (await (
      await post(app, '/api/review/threads', { anchor: { kind: 'changeset' }, text: 'note a' })
    ).json()) as ReviewThread
    await post(app, '/api/review/threads', { anchor: { kind: 'changeset' }, text: 'note b' })
    await post(app, `/api/review/threads/${a.id}/send`)

    const finish = (await (
      await post(app, '/api/review/finish', {
        coverage: { viewedHunks: 1, totalHunks: 1, skippedFiles: [] },
      })
    ).json()) as { delivered: boolean }
    expect(finish.delivered).toBe(false)

    const payload = await pollResult(
      await app.request('/api/agent/poll', { headers: { 'x-diffo-agent': 'cli' } }),
    )
    expect(payload.kind).toBe('finish')
    expect(payload.prompt).toContain('1/1 hunks read')
    expect(payload.prompt).toContain('note a')
    expect(payload.prompt).toContain('note b')
    expect((payload.threadIds as string[]).length).toBe(2)
  })

  it('the poll rebuilds the finish payload with the closing note as a thread id', async () => {
    const { app } = setup()
    const finished = (await (
      await post(app, '/api/review/finish', {
        coverage: { viewedHunks: 1, totalHunks: 1, skippedFiles: [], note: 'nothing blocking' },
      })
    ).json()) as { threads: ReviewThread[] }
    const note = finished.threads.find((t) => t.closingNote)!

    // Rebuilt from the stored coverage, so this is the path a poll that arrives after a
    // restart takes — the note must come back as an answerable thread, not as prose.
    const payload = await pollResult(
      await app.request('/api/agent/poll', { headers: { 'x-diffo-agent': 'cli' } }),
    )
    expect(payload.kind).toBe('finish')
    expect(payload.threadIds).toEqual([note.id])
    expect(payload.prompt).toContain('their closing note on the whole review')
    expect(payload.prompt).not.toContain('Nothing to act on')
  })

  it('a reply to a sent thread flows through the poll; replies to open threads stay local', async () => {
    const { app } = setup()
    const sent = (await (
      await post(app, '/api/review/threads', { anchor: { kind: 'changeset' }, text: 'q1' })
    ).json()) as ReviewThread
    await post(app, `/api/review/threads/${sent.id}/send`)
    await pollResult(await app.request('/api/agent/poll', { headers: { 'x-diffo-agent': 'cli' } }))

    const poll = Promise.resolve(
      app.request('/api/agent/poll', { headers: { 'x-diffo-agent': 'cli' } }),
    ).then(pollResult)
    await tick()
    const reply = (await (
      await post(app, `/api/review/threads/${sent.id}/messages`, { text: 'follow-up' })
    ).json()) as { delivered: boolean }
    expect(reply.delivered).toBe(true)
    expect((await poll).threadIds).toEqual([sent.id])
  })

  it('the agent replies via the CLI route: message lands, no re-delivery, duration stamped', async () => {
    const { app, review, queue } = setup()
    const created = await post(app, '/api/review/threads', {
      anchor: { kind: 'changeset' },
      text: 'why?',
    })
    const thread = (await created.json()) as ReviewThread
    await post(app, `/api/review/threads/${thread.id}/send`)
    await pollResult(await app.request('/api/agent/poll', { headers: { 'x-diffo-agent': 'cli' } }))
    expect(queue.presence()).toBe('working')

    const res = await post(app, `/api/review/threads/${thread.id}/messages`, {
      author: 'agent',
      text: 'because X',
    })
    const body = (await res.json()) as { thread: ReviewThread; delivered: boolean }
    expect(body.delivered).toBe(false)
    const last = body.thread.messages.at(-1)!
    expect(last.author).toBe('agent')
    expect(typeof review.get().threads[0]!.messages.at(-1)!.durationMs).toBe('number')
    expect(queue.presence()).toBe('working')
    expect(queue.presenceDetail().reason).toBe('replied')
  })

  it('a comment raced in mid-answer lands BELOW the reply — the reply never saw it', async () => {
    const { app, review } = setup()
    const created = await post(app, '/api/review/threads', {
      anchor: { kind: 'changeset' },
      text: 'why?',
    })
    const thread = (await created.json()) as ReviewThread
    await post(app, `/api/review/threads/${thread.id}/send`)
    await pollResult(await app.request('/api/agent/poll', { headers: { 'x-diffo-agent': 'cli' } }))
    // The hand-over is stamped on the thread, so the UI can tell delivered
    // words from raced ones.
    expect(review.get().threads[0]!.deliveredThrough).toBeDefined()
    await tick()

    // The reviewer fires a follow-up while the agent is still composing its answer…
    await post(app, `/api/review/threads/${thread.id}/messages`, { text: 'raced follow-up' })
    // …so the answer, arriving later on the clock, still belongs before it.
    await post(app, `/api/review/threads/${thread.id}/messages`, {
      author: 'agent',
      text: 'because X',
    })

    const messages = review.get().threads[0]!.messages
    expect(messages.map((m) => m.text)).toEqual(['why?', 'because X', 'raced follow-up'])
    expect(messages[1]!.durationMs).toBeDefined()
    // The raced comment keeps the thread waiting on the agent, and the next
    // delivery re-ships it — nothing is lost.
    expect(messages.at(-1)!.author).toBe('reviewer')
    const repoll = await pollResult(
      await app.request('/api/agent/poll', { headers: { 'x-diffo-agent': 'cli' } }),
    )
    expect(repoll.threadIds).toEqual([thread.id])
    expect(String(repoll.prompt)).toMatch(/because X[\s\S]*raced follow-up/)
  })

  it('a reply with no delivery outstanding still appends at the end', async () => {
    const { app, review } = setup()
    const created = await post(app, '/api/review/threads', {
      anchor: { kind: 'changeset' },
      text: 'why?',
    })
    const thread = (await created.json()) as ReviewThread
    await post(app, `/api/review/threads/${thread.id}/send`)
    // No poll took this thread — the reply concludes nothing and has no
    // causal slot to claim.
    await post(app, `/api/review/threads/${thread.id}/messages`, { text: 'second thought' })
    await post(app, `/api/review/threads/${thread.id}/messages`, {
      author: 'agent',
      text: 'proactive note',
    })
    expect(review.get().threads[0]!.messages.map((m) => m.text)).toEqual([
      'why?',
      'second thought',
      'proactive note',
    ])
  })

  it("the agent's next poll strands what it skipped; re-sending puts it back on the clock", async () => {
    const { app, review } = setup(undefined, 0)
    const answered = (await (
      await post(app, '/api/review/threads', { anchor: { kind: 'changeset' }, text: 'q1' })
    ).json()) as ReviewThread
    const skipped = (await (
      await post(app, '/api/review/threads', { anchor: { kind: 'changeset' }, text: 'q2' })
    ).json()) as ReviewThread
    await post(app, `/api/review/threads/${answered.id}/send`)
    await post(app, `/api/review/threads/${skipped.id}/send`)
    await pollResult(await app.request('/api/agent/poll', { headers: { 'x-diffo-agent': 'cli' } }))
    await post(app, `/api/review/threads/${answered.id}/messages`, {
      author: 'agent',
      text: 'because X',
    })
    expect(review.get().threads.every((t) => t.unanswered === undefined)).toBe(true)

    void app.request('/api/agent/poll', { headers: { 'x-diffo-agent': 'cli' } })
    await tick()
    const stranded = review.get().threads.find((t) => t.id === skipped.id)!
    expect(stranded.unanswered).toBe(true)
    expect(review.get().threads.find((t) => t.id === answered.id)!.unanswered).toBeUndefined()

    await post(app, `/api/review/threads/${skipped.id}/send`)
    await tick()
    expect(review.get().threads.find((t) => t.id === skipped.id)!.unanswered).toBeUndefined()
  })

  it('a finish records the changeset it was read against, and the poll collects it', async () => {
    const { app, review, store } = setup(undefined, 0)
    await post(app, '/api/review/threads', { anchor: { kind: 'changeset' }, text: 'q1' })
    await post(app, '/api/review/finish', {
      coverage: { viewedHunks: 1, totalHunks: 1, skippedFiles: [] },
    })

    const finish = review.get().lastFinish!
    expect(finish.hunkIds).toEqual(store.get().files.flatMap((f) => f.hunks.map((h) => h.id)))
    expect(finish.hunkIds.length).toBeGreaterThan(0)
    expect(finish.collectedAt).toBeUndefined()

    await pollResult(await app.request('/api/agent/poll', { headers: { 'x-diffo-agent': 'cli' } }))
    expect(typeof review.get().lastFinish!.collectedAt).toBe('string')
  })

  it('a thread the agent abandoned is named in the next batch’s prompt', async () => {
    const { app } = setup(undefined, 0)
    const thread = (await (
      await post(app, '/api/review/threads', { anchor: { kind: 'changeset' }, text: 'why?' })
    ).json()) as ReviewThread
    const cov = { coverage: { viewedHunks: 1, totalHunks: 1, skippedFiles: [] } }
    await post(app, '/api/review/finish', cov)
    await pollResult(await app.request('/api/agent/poll', { headers: { 'x-diffo-agent': 'cli' } }))
    const next = Promise.resolve(
      app.request('/api/agent/poll', { headers: { 'x-diffo-agent': 'cli' } }),
    ).then(pollResult)
    await tick()

    await post(app, '/api/review/finish', cov)
    const payload = await next
    expect(payload.prompt).toContain('YOU NEVER ANSWERED THIS')
    expect(payload.prompt).toContain('1 of the threads below you were already given once')
    expect(payload.threadIds).toContain(thread.id)
  })

  it('a copied finish still records where you left off — that is not the agent‘s to grant', async () => {
    const { app, review } = setup()
    await post(app, '/api/review/finish', {
      coverage: { viewedHunks: 1, totalHunks: 1, skippedFiles: [] },
      deliver: false,
    })
    expect(review.get().lastFinish!.hunkIds.length).toBeGreaterThan(0)
    expect(review.get().lastFinish!.collectedAt).toBeUndefined()
  })

  it('a second poll supersedes the first; `end` detaches and keeps queued feedback', async () => {
    const { app, queue } = setup()
    const poll1 = Promise.resolve(
      app.request('/api/agent/poll', { headers: { 'x-diffo-agent': 'cli' } }),
    ).then(pollResult)
    await tick()
    expect(queue.presence()).toBe('listening')
    const poll2 = Promise.resolve(
      app.request('/api/agent/poll', { headers: { 'x-diffo-agent': 'cli' } }),
    ).then(pollResult)
    await tick()
    expect((await poll1).status).toBe('superseded')

    await post(app, '/api/agent/end', {})
    expect((await poll2).status).toBe('ended')
    expect(queue.presence()).toBe('waiting')

    const created = await post(app, '/api/review/threads', {
      anchor: { kind: 'changeset' },
      text: 'after end',
    })
    const thread = (await created.json()) as ReviewThread
    await post(app, `/api/review/threads/${thread.id}/send`)
    const payload = await pollResult(
      await app.request('/api/agent/poll', { headers: { 'x-diffo-agent': 'cli' } }),
    )
    expect(payload.threadIds).toEqual([thread.id])
  })

  it('streams whitespace heartbeats while waiting, then one parseable JSON payload', async () => {
    const { app } = setup(25)
    const created = await post(app, '/api/review/threads', {
      anchor: { kind: 'changeset' },
      text: 'heartbeat check',
    })
    const thread = (await created.json()) as ReviewThread

    const res = await app.request('/api/agent/poll', { headers: { 'x-diffo-agent': 'cli' } })
    const reader = res.body!.getReader()
    const decoder = new TextDecoder()
    const first = await reader.read()
    expect(decoder.decode(first.value).trim()).toBe('')

    await post(app, `/api/review/threads/${thread.id}/send`)
    let text = ''
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      text += decoder.decode(value)
    }
    const payload = JSON.parse(text.trim()) as { status: string; threadIds: string[] }
    expect(payload.status).toBe('feedback')
    expect(payload.threadIds).toEqual([thread.id])
  })

  it('presence events flow over /api/events', async () => {
    const { app, queue } = setup()
    const res = await app.request('/api/events')
    const reader = res.body!.getReader()
    const decoder = new TextDecoder()
    let seen = ''
    const readUntil = async (marker: string) => {
      while (!seen.includes(marker)) {
        const { done, value } = await reader.read()
        if (done) break
        seen += decoder.decode(value)
      }
    }
    await readUntil('event: presence')
    expect(seen).toContain('"state":"waiting"')
    expect(seen).toContain('"reason":"no-agent"')
    const poll = Promise.resolve(
      app.request('/api/agent/poll', { headers: { 'x-diffo-agent': 'cli' } }),
    ).then((r) => r.text())
    await readUntil('"state":"listening"')
    expect(seen).toContain('"reason":"polling"')
    queue.end()
    expect((await poll).trim()).toContain('ended')
    expect(queue.presence()).toBe('waiting')
    await reader.cancel()
  })
})

describe('the invite (bringing an agent in)', () => {
  it('serves the install command and the one prompt you paste after it', async () => {
    const { app } = setup()
    const res = await app.request('/api/agent/invite')
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(body.install).toEqual({
      global: 'npx skills add DiffoHQ/diffo --skill diffo -g',
      project: 'npx skills add DiffoHQ/diffo --skill diffo',
    })
    expect(body.presence).toBe('waiting')
    // The join prompt must bootstrap a skill-less agent: name the poll command
    // and how to hold it — the payloads teach the rest.
    expect(body.join).toContain('join the diffo review')
    expect(body.join).toContain('poll')
    expect(body.join).toContain('tracked background task')
    expect(Object.keys(body).sort()).toEqual(['install', 'join', 'presence'])
  })

  it('is available with no review store — inviting is how you get one attached', async () => {
    const app = createApp({ root: '/x', spec: { kind: 'working-tree' }, clientDir: '/nope' })
    expect((await app.request('/api/agent/invite')).status).toBe(200)
  })
})

describe('agent threads (diffo comment)', () => {
  const create = (app: ReturnType<typeof setup>['app'], body: Record<string, unknown>) =>
    post(app, '/api/review/threads', { author: 'agent', ...body })

  it('lands as an agent-voice thread on the hunk showing its line', async () => {
    const { app, review, store } = setup()
    const res = await create(app, { file: 'app.ts', line: 2, text: 'name this' })
    expect(res.status).toBe(200)
    const thread = (await res.json()) as ReviewThread
    const hunk = store.get().files[0]!.hunks[0]!
    expect(thread.anchor).toEqual({
      kind: 'hunk',
      hunkId: hunk.id,
      path: 'app.ts',
      side: 'new',
      line: 2,
    })
    expect(thread.state).toBe('open')
    expect(thread.messages[0]).toMatchObject({ author: 'agent', text: 'name this' })
    expect(thread.codeContext).toContain('+const b = 42')
    expect(review.get().threads).toHaveLength(1)
  })

  it('falls back to the file, then the changeset, when the line has no home', async () => {
    const { app } = setup()
    const onFile = (await (
      await create(app, { file: 'app.ts', line: 999, text: 'whole file' })
    ).json()) as ReviewThread
    expect(onFile.anchor).toEqual({ kind: 'file', path: 'app.ts' })

    const orphan = (await (
      await create(app, { file: 'gone.ts', line: 1, text: 'left behind' })
    ).json()) as ReviewThread
    expect(orphan.anchor).toEqual({ kind: 'changeset' })

    const changesetNote = (await (
      await create(app, { text: 'start with app.ts' })
    ).json()) as ReviewThread
    expect(changesetNote.anchor).toEqual({ kind: 'changeset' })
  })

  it('a reviewer reply makes it theirs to Send — the same dance as their own threads', async () => {
    const { app, review } = setup()
    const note = (await (
      await create(app, { file: 'app.ts', text: 'why 42 is right' })
    ).json()) as ReviewThread

    // Reply writes in; nothing is handed over yet.
    const res = await post(app, `/api/review/threads/${note.id}/messages`, {
      text: 'expand on that?',
    })
    expect(res.status).toBe(200)
    let updated = review.get().threads[0]!
    expect(updated.state).toBe('open')
    expect(updated.messages.at(-1)).toMatchObject({ author: 'reviewer', text: 'expand on that?' })
    expect(undeliveredThreadIds(review.get().threads)).toEqual([])

    // Send hands it over, and the redelivery contract now covers it.
    await post(app, `/api/review/threads/${note.id}/send`, {})
    updated = review.get().threads[0]!
    expect(updated.state).toBe('sent')
    expect(undeliveredThreadIds(review.get().threads)).toEqual([note.id])
  })

  it('an engaged agent thread rides the finish flush; an untouched one never does', async () => {
    const { app, review } = setup()
    const touched = (await (
      await create(app, { file: 'app.ts', text: 'context' })
    ).json()) as ReviewThread
    const untouched = (await (
      await create(app, { file: 'app.ts', text: 'left alone' })
    ).json()) as ReviewThread
    await post(app, `/api/review/threads/${touched.id}/messages`, { text: 'and?' })

    await post(app, '/api/review/finish', { coverage: {}, deliver: false })
    const byId = new Map(review.get().threads.map((t) => [t.id, t]))
    expect(byId.get(touched.id)!.state).toBe('sent')
    expect(byId.get(untouched.id)!.state).toBe('open')
  })
})

describe('server lifecycle endpoints', () => {
  it('health names the repo, the app, and this build (the CLI handshake)', async () => {
    const { root, app } = setup()
    const body = (await (await app.request('/api/health')).json()) as {
      ok: boolean
      repo: string
      app: string
      version: string
    }
    expect(body.ok).toBe(true)
    expect(body.repo).toContain(root.split('/').pop())
    expect(body.app).toBe('diffo')
    expect(body.version).toMatch(/^\d+\.\d+\.\d+/)
  })

  it('shutdown answers first, then hands control to onShutdownRequest', async () => {
    const root = tempRepo()
    const store = new ChangesetStore(root, { kind: 'working-tree' })
    const review = new ReviewStore(root, makeDb(root), { kind: 'working-tree' })
    const queue = new DeliveryQueue()
    let shutdowns = 0
    const app = createApp(
      {
        root,
        spec: { kind: 'working-tree' },
        clientDir: '/nope',
        onShutdownRequest: () => shutdowns++,
      },
      store,
      review,
      queue,
    )
    const res = await app.request('/api/shutdown', { method: 'POST' })
    expect(res.status).toBe(200)
    expect(((await res.json()) as { ok: boolean }).ok).toBe(true)
    expect(shutdowns).toBe(0)
    await new Promise((r) => setImmediate(r))
    expect(shutdowns).toBe(1)
  })
})

describe('the poll window', () => {
  it('sends the agent away to re-poll instead of waiting forever', async () => {
    const { app, queue } = setup(5, undefined, 30)
    const res = await app.request('/api/agent/poll', { headers: { 'x-diffo-agent': 'cli' } })
    const payload = await pollResult(res)

    expect(payload.status).toBe('timeout')
    expect(String(payload.message)).toMatch(/nothing is lost|re-run/)
    expect(queue.hasListener()).toBe(false)
    expect(queue.presence()).toBe('waiting')
  })

  it('delivers feedback that arrives inside the window, window untouched', async () => {
    const { app, review, queue } = setup(5, undefined, 5_000)
    const thread = review.createThread({ kind: 'changeset' }, 'why this?', null)
    const polling = app.request('/api/agent/poll', { headers: { 'x-diffo-agent': 'cli' } })
    await tick()
    await post(app, `/api/review/threads/${thread.id}/send`)

    const payload = await pollResult(await polling)
    expect(payload.status).toBe('feedback')
    expect(payload.threadIds).toEqual([thread.id])
    expect(queue.hasListener()).toBe(false)
  })
})

describe('two agent sessions on one review', () => {
  const SESSION_A = process.pid
  const SESSION_B = process.ppid

  const pollAs = (app: ReturnType<typeof setup>['app'], pid: number) =>
    app.request('/api/agent/poll', { headers: { 'x-diffo-session-pid': String(pid) } })

  it('lets the second session in, and tells it whose review it took', async () => {
    const { app, queue } = setup()
    const first = Promise.resolve(pollAs(app, SESSION_A)).then(pollResult)
    await tick()
    expect(queue.presence()).toBe('listening')

    const second = await pollAs(app, SESSION_B)
    expect(second.headers.get('x-diffo-took-over-from')).toBe(String(SESSION_A))
    expect((await first).status).toBe('superseded')
    expect(queue.ownerPid()).toBe(SESSION_B)
  })

  it('says nothing when there was nobody to take it from', async () => {
    const { app } = setup()
    const res = await pollAs(app, SESSION_A)
    expect(res.headers.get('x-diffo-took-over-from')).toBeNull()
  })

  it("a non-owner's reply cannot retarget the liveness watch", async () => {
    const { app, queue } = setup()
    void pollAs(app, SESSION_A)
    await tick()

    const created = await post(app, '/api/review/threads', {
      anchor: { kind: 'changeset' },
      text: 'who wrote this?',
    })
    const thread = (await created.json()) as ReviewThread
    await app.request(`/api/review/threads/${thread.id}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-diffo-session-pid': String(SESSION_B) },
      body: JSON.stringify({ author: 'agent', text: 'not my review' }),
    })
    expect(queue.ownerPid()).toBe(SESSION_A)
  })

  it("refuses a non-owner's end rather than detaching the attached agent", async () => {
    const { app, queue } = setup()
    const first = Promise.resolve(pollAs(app, SESSION_A)).then(pollResult)
    await tick()

    const refused = (await (
      await app.request('/api/agent/end', {
        method: 'POST',
        headers: { 'x-diffo-session-pid': String(SESSION_B) },
      })
    ).json()) as { ok: boolean; reason: string; ownerPid: number }
    expect(refused.ok).toBe(false)
    expect(refused.reason).toBe('not-owner')
    expect(refused.ownerPid).toBe(SESSION_A)

    await tick()
    expect(queue.hasListener()).toBe(true)

    await app.request('/api/agent/end', {
      method: 'POST',
      headers: { 'x-diffo-session-pid': String(SESSION_A) },
    })
    expect((await first).status).toBe('ended')
  })
})

describe('the guide (an agent comment on the whole changeset)', () => {
  it('the agent can update its own guide by replying into it, unprompted', async () => {
    const { app, review } = setup()
    const posted = await post(app, '/api/review/threads', {
      author: 'agent',
      text: 'what this change does',
    })
    const guide = (await posted.json()) as ReviewThread
    expect(guide.anchor).toEqual({ kind: 'changeset' })

    // No reviewer turn in between: the guide is a document the agent maintains.
    const updated = await post(app, `/api/review/threads/${guide.id}/messages`, {
      author: 'agent',
      text: 'update: the adopt step is gone',
    })
    expect(updated.status).toBe(200)
    const after = review.get().threads.find((t) => t.id === guide.id)!
    expect(after.messages.map((m) => m.author)).toEqual(['agent', 'agent'])
    expect(after.messages.at(-1)!.text).toContain('adopt step is gone')
  })
})
