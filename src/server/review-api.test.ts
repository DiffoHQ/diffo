import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { type OutgoingThread, type ReviewThread, undeliveredThreadIds } from '../shared/review.js'
import { DiffoDb } from './db.js'
import { DeliveryQueue } from './delivery.js'
import { createApp } from './index.js'
import { buildConnectAsk, CLI_COMMANDS } from './prompt.js'
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

function setup(
  pollHeartbeatMs?: number,
  batchSettleMs?: number,
  pollMaxMs?: number,
  pollQuietLimit?: number,
) {
  const root = tempRepo()
  const store = new ChangesetStore(root, { kind: 'working-tree' })
  const review = new ReviewStore(root, makeDb(root), { kind: 'working-tree' })
  const queue = new DeliveryQueue(undefined, undefined, {}, batchSettleMs)
  const app = createApp(
    {
      root,
      spec: { kind: 'working-tree' },
      clientDir: '/nope',
      pollHeartbeatMs,
      pollMaxMs,
      pollQuietLimit,
    },
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

describe('review API — layer threads', () => {
  it('a layer thread needs a layer the outline has, takes its title, and freezes the step', async () => {
    const { app, review } = setup()
    await post(app, '/api/review/layers', {
      items: [{ title: 'Contract', summary: 'the parser', files: ['a.ts', { path: 'b.ts' }] }],
    })
    const layerId = review.get().layers!.items[0]!.id
    const nope = await post(app, '/api/review/threads', {
      anchor: { kind: 'layer', layerId: 'not-a-layer', title: 'x' },
      text: 'why?',
    })
    expect(nope.status).toBe(400)
    const created = await post(app, '/api/review/threads', {
      anchor: { kind: 'layer', layerId, title: 'whatever the client said' },
      text: 'why is this one step?',
      intent: 'question',
    })
    expect(created.status).toBe(200)
    const thread = (await created.json()) as ReviewThread
    expect(thread.anchor).toEqual({ kind: 'layer', layerId, title: 'Contract' })
    expect(thread.codeContext).toBeNull()
    expect(thread.anchoredLayer).toEqual({
      title: 'Contract',
      summary: 'the parser',
      files: ['a.ts', 'b.ts'],
    })
  })

  it('a layer thread is never a public comment', async () => {
    const { app, review } = setup()
    await post(app, '/api/review/layers', { items: [{ title: 'Contract', files: ['a.ts'] }] })
    const layerId = review.get().layers!.items[0]!.id
    const res = await post(app, '/api/review/threads', {
      anchor: { kind: 'layer', layerId, title: 'Contract' },
      text: 'for github',
      audience: 'pr',
    })
    expect(res.status).toBe(400)
  })
})

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

  it("a reply to the agent's own comment sends the thread in that one step", async () => {
    const { app, review } = setup()
    const created = await post(app, '/api/review/threads', { author: 'agent', text: 'rename?' })
    const { id } = (await created.json()) as ReviewThread
    expect(review.get().threads[0]!.state).toBe('open')

    const res = await post(app, `/api/review/threads/${id}/messages`, { text: 'yes, do it' })
    const { thread } = (await res.json()) as { thread: ReviewThread }
    expect(thread.state).toBe('sent')
    expect(thread.withheld).toBeUndefined()
    expect(undeliveredThreadIds([thread])).toEqual([id])
  })

  it('the agent can offer the reviewer a reply on a comment or a reply — one trimmed line', async () => {
    const { app } = setup()
    const created = await post(app, '/api/review/threads', {
      author: 'agent',
      text: 'fold these two guards?',
      suggestedReply: '  yes,\n fold   them ',
    })
    const { id, messages } = (await created.json()) as ReviewThread
    expect(messages[0]!.suggestedReply).toBe('yes, fold them')

    await post(app, `/api/review/threads/${id}/messages`, { text: 'which two?' })
    const replied = await post(app, `/api/review/threads/${id}/messages`, {
      author: 'agent',
      text: 'lines 4 and 9 — want that?',
      suggestedReply: 'yes',
    })
    const { thread } = (await replied.json()) as { thread: ReviewThread }
    expect(thread.messages.at(-1)).toMatchObject({ author: 'agent', suggestedReply: 'yes' })

    // Junk or empty offers are dropped, never stored as a stray field.
    const noisy = await post(app, `/api/review/threads/${id}/messages`, {
      author: 'agent',
      text: 'done',
      suggestedReply: 42,
    })
    const { thread: after } = (await noisy.json()) as { thread: ReviewThread }
    expect('suggestedReply' in after.messages.at(-1)!).toBe(false)

    // The reviewer cannot offer themselves one.
    const own = await post(app, `/api/review/threads/${id}/messages`, {
      text: 'ok',
      suggestedReply: 'nope',
    })
    const { thread: theirs } = (await own.json()) as { thread: ReviewThread }
    expect('suggestedReply' in theirs.messages.at(-1)!).toBe(false)
  })

  it('a suggested PR comment is refused off a pull request, and the words are not lost silently', async () => {
    const { app, review } = setup()
    const created = await post(app, '/api/review/threads', {
      anchor: { kind: 'changeset' },
      text: 'why?',
    })
    const { id } = (await created.json()) as ReviewThread
    const res = await post(app, `/api/review/threads/${id}/messages`, {
      author: 'agent',
      text: 'because',
      prComment: 'Keep the streak?',
    })
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: string }).error).toMatch(/pull request/)
    expect(review.get().threads[0]!.messages).toHaveLength(1)
    const comment = await post(app, '/api/review/threads', {
      author: 'agent',
      text: 'bug here',
      prComment: 'Loops forever',
    })
    expect(comment.status).toBe(400)
  })

  it("a withheld reply to the agent's comment keeps it open for Send", async () => {
    const { app, review } = setup()
    const created = await post(app, '/api/review/threads', { author: 'agent', text: 'rename?' })
    const { id } = (await created.json()) as ReviewThread
    await post(app, `/api/review/threads/${id}/messages`, { text: 'thinking…', deliver: false })
    expect(review.get().threads[0]).toMatchObject({ state: 'open', withheld: true })

    const sent = await post(app, `/api/review/threads/${id}/send`)
    const { thread } = (await sent.json()) as { thread: ReviewThread }
    expect(thread.state).toBe('sent')
    expect(thread.withheld).toBeUndefined()
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

  it('a share errand rides the finish only with layers, in a repo that can share', async () => {
    const shareApp = (canShare?: () => Promise<boolean>) => {
      const root = tempRepo()
      return createApp(
        {
          root,
          spec: { kind: 'working-tree' },
          clientDir: '/nope',
          ...(canShare ? { canShare } : {}),
        },
        new ChangesetStore(root, { kind: 'working-tree' }),
        new ReviewStore(root, makeDb(root), { kind: 'working-tree' }),
        new DeliveryQueue(),
      )
    }
    const coverage = { viewedHunks: 1, totalHunks: 1, skippedFiles: [], shareLayers: true }
    const layers = { items: [{ title: 'Contract', files: ['a.ts'] }] }
    type Preview = { prompt: string; canShareLayers: boolean }

    // A Bitbucket or GitLab origin, or no gh: never offered, never sent.
    const elsewhere = shareApp(async () => false)
    await post(elsewhere, '/api/review/layers', layers)
    const offered = (await (
      await post(elsewhere, '/api/review/finish/preview', { coverage })
    ).json()) as Preview
    expect(offered.canShareLayers).toBe(false)
    expect(offered.prompt).not.toContain(CLI_COMMANDS.share)
    const sent = (await (await post(elsewhere, '/api/review/finish', { coverage })).json()) as {
      prompt: string
    }
    expect(sent.prompt).not.toContain(CLI_COMMANDS.share)

    const app = shareApp(async () => true)
    const bare = (await (await post(app, '/api/review/finish', { coverage })).json()) as {
      prompt: string
    }
    expect(bare.prompt).not.toContain(CLI_COMMANDS.share)

    await post(app, '/api/review/layers', layers)
    const preview = (await (
      await post(app, '/api/review/finish/preview', { coverage })
    ).json()) as Preview
    expect(preview.canShareLayers).toBe(true)
    expect(preview.prompt).toContain(CLI_COMMANDS.share)
    const res = (await (await post(app, '/api/review/finish', { coverage })).json()) as {
      prompt: string
    }
    expect(res.prompt).toContain(`run \`${CLI_COMMANDS.share}\``)
    expect(res.prompt).toContain('right after you open one')
  })

  it('each finish counts toward the star nudge, across reviews', async () => {
    const root = tempRepo()
    const kv = new Map<string, string>()
    const app = createApp(
      {
        root,
        spec: { kind: 'working-tree' },
        clientDir: '/nope',
        uiSettings: { get: (k) => kv.get(k) ?? null, set: (k, v) => void kv.set(k, v) },
      },
      new ChangesetStore(root, { kind: 'working-tree' }),
      new ReviewStore(root, makeDb(root), { kind: 'working-tree' }),
      new DeliveryQueue(),
    )
    const coverage = { viewedHunks: 1, totalHunks: 1, skippedFiles: [] }
    await post(app, '/api/review/finish', { coverage })
    expect(kv.get('finishes')).toBe('1')
    await post(app, '/api/review/finish', { coverage })
    expect(kv.get('finishes')).toBe('2')
    await post(app, '/api/review/finish', { coverage })
    const settings = (await (await app.request('/api/settings')).json()) as { starNudge: string }
    expect(settings.starNudge).toBe('show')
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

  it('finish never re-opens the reply clock on a thread the agent already answered', async () => {
    const { app } = setup()
    const ids: string[] = []
    for (const text of ['answered before finish', 'still waiting']) {
      const res = await post(app, '/api/review/threads', { anchor: { kind: 'changeset' }, text })
      ids.push(((await res.json()) as ReviewThread).id)
      await post(app, `/api/review/threads/${ids.at(-1)}/send`)
    }
    // The agent picks both up and answers the first — its reply is the last word there.
    await pollResult(await app.request('/api/agent/poll', { headers: { 'x-diffo-agent': 'cli' } }))
    await post(app, `/api/review/threads/${ids[0]}/messages`, {
      author: 'agent',
      text: 'done — see the thread',
    })

    await post(app, '/api/review/finish', {
      coverage: { viewedHunks: 1, totalHunks: 1, skippedFiles: [] },
    })
    const payload = await pollResult(
      await app.request('/api/agent/poll', { headers: { 'x-diffo-agent': 'cli' } }),
    )
    expect(payload.kind).toBe('finish')
    // Only the unanswered thread is owed; the answered one rides the prompt as a
    // one-line mention — id and anchor, not its re-shipped history.
    expect(payload.threadIds).toEqual([ids[1]])
    expect(payload.prompt).toContain('you already answered, with nothing new since')
    expect(payload.prompt).toContain(`- ${ids[0]} —`)
    expect(payload.prompt).not.toContain('answered before finish')
    expect(payload.prompt).toContain('still waiting')
  })

  it('review endpoints 503 without a review store', async () => {
    const app = createApp({ root: '/x', spec: { kind: 'working-tree' }, clientDir: '/nope' })
    expect((await app.request('/api/review')).status).toBe(503)
    expect((await app.request('/api/review/threads/x', { method: 'DELETE' })).status).toBe(503)
    expect(
      (await app.request('/api/agent/poll', { headers: { 'x-diffo-agent': 'cli' } })).status,
    ).toBe(503)
    expect((await app.request('/api/agent/end', { method: 'POST' })).status).toBe(503)
    expect(
      (
        await app.request('/api/agent/arrive', {
          method: 'POST',
          headers: { 'x-diffo-agent': 'cli' },
        })
      ).status,
    ).toBe(503)
  })

  it('poll refuses a request with no x-diffo-* header (a no-cors browser GET cannot send one)', async () => {
    const { app, queue } = setup()
    const res = await app.request('/api/agent/poll')
    expect(res.status).toBe(403)
    // The refused request must leave no trace: no session claimed, nothing confirmed.
    expect(queue.ownerPid()).toBeNull()
  })

  it('a poll titles the review; a later untitled one leaves that name alone', async () => {
    const { app, review } = setup()
    const headers = { 'x-diffo-agent': 'cli' }
    const ask = async (text: string) => {
      const created = await post(app, '/api/review/threads', {
        anchor: { kind: 'changeset' },
        text,
      })
      const thread = (await created.json()) as ReviewThread
      await post(app, `/api/review/threads/${thread.id}/send`)
    }

    // Nothing has polled — no name to show, and the tab stays as it shipped.
    expect(review.get().title).toBeUndefined()

    await ask('first')
    await pollResult(
      await app.request(`/api/agent/poll?title=${encodeURIComponent('  tab\ntitles  ')}`, {
        headers,
      }),
    )
    // Whatever the agent sent, made fit for a tab strip.
    expect(review.get().title).toBe('tab titles')

    await ask('second')
    await pollResult(await app.request('/api/agent/poll', { headers }))
    expect(review.get().title).toBe('tab titles')

    // The changeset became something else: the newest title wins.
    await ask('third')
    await pollResult(
      await app.request('/api/agent/poll?title=retry%20on%20flaky%20uploads', {
        headers,
      }),
    )
    expect(review.get().title).toBe('retry on flaky uploads')
  })

  it('clearing the review drops its title — the next round names itself', async () => {
    const { app, review } = setup()
    const created = await post(app, '/api/review/threads', {
      anchor: { kind: 'changeset' },
      text: 'a note',
    })
    await post(app, `/api/review/threads/${((await created.json()) as ReviewThread).id}/send`)
    await pollResult(
      await app.request('/api/agent/poll?title=tab%20titles', {
        headers: { 'x-diffo-agent': 'cli' },
      }),
    )
    expect(review.get().title).toBe('tab titles')

    await app.request('/api/review/threads', { method: 'DELETE' })
    expect(review.get().title).toBeUndefined()
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

  it('the second delivery to the same session carries the compact protocol', async () => {
    const { app } = setup()
    const headers = { 'x-diffo-agent': 'cli', 'x-diffo-session-pid': String(process.pid) }
    const send = async (text: string) => {
      const created = await post(app, '/api/review/threads', {
        anchor: { kind: 'changeset' },
        text,
      })
      await post(app, `/api/review/threads/${((await created.json()) as ReviewThread).id}/send`)
    }

    await send('one')
    const first = await pollResult(await app.request('/api/agent/poll', { headers }))
    expect(first.prompt).toContain('If you notice something worth a comment')

    await send('two')
    const second = await pollResult(await app.request('/api/agent/poll', { headers }))
    expect(second.prompt).toContain('Same protocol as your earlier deliveries')
    expect(second.prompt).toContain('npx -y @diffohq/diffo reply')

    // An anonymous poll (no session pid) is always given the full protocol.
    await send('three')
    const third = await pollResult(
      await app.request('/api/agent/poll', { headers: { 'x-diffo-agent': 'cli' } }),
    )
    expect(third.prompt).toContain('If you notice something worth a comment')
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

  it('a --more reply keeps the thread with the agent; the follow-up settles it', async () => {
    const { app, review, queue } = setup()
    const created = await post(app, '/api/review/threads', {
      anchor: { kind: 'changeset' },
      text: 'why?',
    })
    const thread = (await created.json()) as ReviewThread
    await post(app, `/api/review/threads/${thread.id}/send`)
    await pollResult(await app.request('/api/agent/poll', { headers: { 'x-diffo-agent': 'cli' } }))

    await post(app, `/api/review/threads/${thread.id}/messages`, {
      author: 'agent',
      text: 'digging in — back soon',
      more: true,
    })
    const interim = review.get().threads[0]!
    expect(interim.awaitingFollowUp).toBe(true)
    expect(interim.messages.at(-1)!.durationMs).toBeDefined()
    // Still in the agent's hands: the spinner and presence both keep waiting.
    expect(queue.deliveredThreadIds()).toEqual([thread.id])
    expect(queue.presence()).toBe('working')
    expect(queue.presenceDetail().reason).toBe('delivered')

    await post(app, `/api/review/threads/${thread.id}/messages`, {
      author: 'agent',
      text: 'found it — fixed',
    })
    const settled = review.get().threads[0]!
    expect('awaitingFollowUp' in settled).toBe(false)
    expect(queue.deliveredThreadIds()).toEqual([])
    expect(queue.presenceDetail().reason).toBe('replied')
  })

  it('a batch concluded on only a --more reply marks the thread unanswered', async () => {
    const { app, review } = setup()
    const created = await post(app, '/api/review/threads', {
      anchor: { kind: 'changeset' },
      text: 'why?',
    })
    const thread = (await created.json()) as ReviewThread
    await post(app, `/api/review/threads/${thread.id}/send`)
    await pollResult(await app.request('/api/agent/poll', { headers: { 'x-diffo-agent': 'cli' } }))
    await post(app, `/api/review/threads/${thread.id}/messages`, {
      author: 'agent',
      text: 'digging in — back soon',
      more: true,
    })

    // The agent detaches without the promised follow-up.
    await post(app, '/api/agent/end', {})
    const after = review.get().threads[0]!
    expect(after.unanswered).toBe(true)
    expect('awaitingFollowUp' in after).toBe(false)
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
  it('serves one ask that points the agent at this repo', async () => {
    const { app, root } = setup()
    const res = await app.request('/api/agent/invite')
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(body.presence).toBe('waiting')
    expect(body.ask).toBe(buildConnectAsk(false, resolve(root), homedir()))
    expect(Object.keys(body).sort()).toEqual(['ask', 'presence'])
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

  it('a reviewer reply takes it up — replying IS the hand-over, no Send after', async () => {
    const { app, review } = setup()
    const note = (await (
      await create(app, { file: 'app.ts', text: 'why 42 is right' })
    ).json()) as ReviewThread

    const res = await post(app, `/api/review/threads/${note.id}/messages`, {
      text: 'expand on that?',
    })
    expect(res.status).toBe(200)
    const updated = review.get().threads[0]!
    expect(updated.state).toBe('sent')
    expect(updated.messages.at(-1)).toMatchObject({ author: 'reviewer', text: 'expand on that?' })
    // The redelivery contract covers it from this reply on.
    expect(undeliveredThreadIds(review.get().threads)).toEqual([note.id])
  })

  it('a held reply keeps the old dance — it stays open until Send', async () => {
    const { app, review } = setup()
    const note = (await (
      await create(app, { file: 'app.ts', text: 'why 42 is right' })
    ).json()) as ReviewThread

    await post(app, `/api/review/threads/${note.id}/messages`, {
      text: 'expand on that?',
      deliver: false,
    })
    let updated = review.get().threads[0]!
    expect(updated).toMatchObject({ state: 'open', withheld: true })
    expect(undeliveredThreadIds(review.get().threads)).toEqual([])

    await post(app, `/api/review/threads/${note.id}/send`, {})
    updated = review.get().threads[0]!
    expect(updated.state).toBe('sent')
    expect(updated.withheld).toBeUndefined()
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
    // Held back, so it is still open when the flush comes for it.
    await post(app, `/api/review/threads/${touched.id}/messages`, { text: 'and?', deliver: false })

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
    // Sent away, not gone: it re-polls next, and the reviewer keeps an agent meanwhile.
    expect(queue.presenceDetail()).toMatchObject({ state: 'working', reason: 'repolling' })
  })

  it('after the quiet limit, the timing-out poll tells the agent to stop and ask the user', async () => {
    const { app, queue } = setup(5, undefined, 20, 2)
    const poll = async () =>
      pollResult(await app.request('/api/agent/poll', { headers: { 'x-diffo-agent': 'cli' } }))

    expect((await poll()).status).toBe('timeout')
    const quiet = await poll()
    expect(quiet.status).toBe('quiet')
    expect(String(quiet.message)).toMatch(/asking the user/)
    expect(String(quiet.message)).toMatch(/only on a yes/)
    // Not coming back on its own: the reviewer is not told it is re-polling.
    expect(queue.presenceDetail()).toMatchObject({ state: 'waiting', reason: 'disconnected' })
    // The user said yes: the re-poll listens again.
    expect((await poll()).status).toBe('timeout')
  })

  it('polls a harness cut off count too: the next one stops at once', async () => {
    const { app, queue } = setup(5, undefined, 5_000, 2)
    for (let i = 0; i < 2; i++) {
      const res = await app.request('/api/agent/poll', { headers: { 'x-diffo-agent': 'cli' } })
      const reader = res.body!.getReader()
      await reader.read() // a heartbeat: the poll is live
      await reader.cancel() // and the harness kills it, no timeout ever written
      await vi.waitFor(() => expect(queue.hasListener()).toBe(false))
    }
    const res = await app.request('/api/agent/poll', { headers: { 'x-diffo-agent': 'cli' } })
    expect((await pollResult(res)).status).toBe('quiet')
    expect(queue.hasListener()).toBe(false)
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

describe('POST /api/review/layers', () => {
  it('posts the outline, mints ids, and answers with the stored layers', async () => {
    const { app, review } = setup()
    const res = await post(app, '/api/review/layers', {
      items: [
        { title: 'Contract', summary: 'the shape', files: ['app.ts'] },
        { title: 'Callers', kind: 'mechanical', files: [{ path: 'cli.ts', note: 'follows' }] },
      ],
    })
    expect(res.status).toBe(200)
    const { layers } = (await res.json()) as { layers: { items: { id: string; title: string }[] } }
    expect(layers.items.map((l) => l.title)).toEqual(['Contract', 'Callers'])
    expect(layers.items.every((l) => typeof l.id === 'string' && l.id.length > 0)).toBe(true)
    expect(review.get().layers?.items).toHaveLength(2)
    // GET /api/review carries them.
    const got = (await (await app.request('/api/review')).json()) as { layers?: unknown }
    expect(got.layers).toEqual(layers)
  })

  it('reports the hunks and files the outline leaves in no layer, against the live changeset', async () => {
    const { app } = setup()
    // app.ts has one hunk, its change on line 2; a range that misses the hunk
    // leaves that line uncovered.
    const missed = await post(app, '/api/review/layers', {
      items: [{ title: 'Contract', files: ['app.ts:900-950'] }],
    })
    expect(missed.status).toBe(200)
    const { uncovered } = (await missed.json()) as { uncovered: unknown }
    expect(uncovered).toEqual([{ path: 'app.ts', ranges: ['2'] }])
    // A file the outline never names is reported whole; a whole-file entry
    // covers everything.
    const whole = await post(app, '/api/review/layers', {
      items: [{ title: 'Contract', files: ['app.ts'] }],
    })
    expect(((await whole.json()) as { uncovered: unknown }).uncovered).toEqual([])
    const none = await post(app, '/api/review/layers', {
      items: [{ title: 'Contract', files: ['other.ts'] }],
    })
    expect(((await none.json()) as { uncovered: unknown }).uncovered).toEqual([{ path: 'app.ts' }])
  })

  it('refuses an outline that claims a changed line in two layers', async () => {
    const { app, review } = setup()
    // app.ts changes line 2: highlighted in one layer, and claimed whole by the
    // other because it lists the file without a highlight.
    const res = await post(app, '/api/review/layers', {
      items: [
        { title: 'Contract', files: [{ path: 'app.ts', highlight: '2' }] },
        { title: 'Callers', files: ['app.ts'] },
      ],
    })
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: string }).error).toContain('app.ts:2 (layers 1, 2)')
    expect(review.get().layers).toBeUndefined()
  })

  it('refuses a file listed whole in one layer and by range in another', async () => {
    const { app, review } = setup()
    const res = await post(app, '/api/review/layers', {
      items: [
        { title: 'Contract', files: ['app.ts'] },
        { title: 'Callers', files: ['app.ts:1-2'] },
      ],
    })
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: string }).error).toContain(
      'listed by range here and whole',
    )
    expect(review.get().layers).toBeUndefined()
  })

  it('carries a layer’s decisions through the store and back out', async () => {
    const { app, review } = setup()
    const decisions = [
      {
        text: 'Caches parsed dates per request',
        detail: 'Dies with the request.',
        at: 'app.ts:12-18',
      },
      { text: 'Todos have a date, never a time' },
    ]
    const res = await post(app, '/api/review/layers', {
      items: [{ title: 'Contract', files: ['app.ts'], decisions }],
    })
    expect(res.status).toBe(200)
    expect(review.get().layers?.items[0]?.decisions).toEqual([
      {
        text: 'Caches parsed dates per request',
        detail: 'Dies with the request.',
        at: [{ path: 'app.ts', line: 12, endLine: 18 }],
      },
      { text: 'Todos have a date, never a time' },
    ])
    const six = Array.from({ length: 6 }, (_, i) => ({ text: `f${i}` }))
    const tooMany = await post(app, '/api/review/layers', {
      items: [{ title: 'Contract', files: ['app.ts'], decisions: six }],
    })
    expect(tooMany.status).toBe(400)
    expect(((await tooMany.json()) as { error: string }).error).toContain('keep "decisions" to 5')
    // The refused post left the stored outline alone.
    expect(review.get().layers?.items[0]?.decisions).toHaveLength(2)
  })

  it('refuses a malformed post with the validator’s own words, and stores nothing', async () => {
    const { app, review } = setup()
    const res = await post(app, '/api/review/layers', { items: [{ title: 'No files' }] })
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: string }).error).toContain('needs a non-empty "files"')
    expect(review.get().layers).toBeUndefined()
    const shapeless = await post(app, '/api/review/layers', {})
    expect(shapeless.status).toBe(400)
  })

  it('a suggestion is recorded with its reason, and cleared by the post that answers it', async () => {
    const { app, review } = setup()
    const res = await post(app, '/api/review/layers', {
      suggest: true,
      reason: 'the parser change explains the rest\nsecond line dropped',
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ suggested: true })
    expect(review.get().layersSuggested).toEqual({ reason: 'the parser change explains the rest' })
    await post(app, '/api/review/layers', { items: [{ title: 'A', files: ['app.ts'] }] })
    expect(review.get().layersSuggested).toEqual({
      reason: 'the parser change explains the rest',
      answered: true,
    })
  })

  it('a suggestion after the post is refused, not recorded', async () => {
    const { app, review } = setup()
    await post(app, '/api/review/layers', { items: [{ title: 'A', files: ['app.ts'] }] })
    const res = await post(app, '/api/review/layers', { suggest: true })
    expect(await res.json()).toMatchObject({ suggested: false })
    expect(review.get().layersSuggested).toBeUndefined()
  })

  it('fans out over the SSE review event like any other review change', async () => {
    const { app } = setup()
    const res = await app.request('/api/events')
    const reader = res.body!.getReader()
    const decoder = new TextDecoder()
    let seen = ''
    const readUntil = async (marker: string) => {
      while (!seen.includes(marker)) {
        const { value, done } = await reader.read()
        if (done) break
        seen += decoder.decode(value)
      }
    }
    await readUntil('event: changeset')
    await post(app, '/api/review/layers', { items: [{ title: 'A', files: ['app.ts'] }] })
    await readUntil('event: review')
    expect(seen).toContain('event: review')
    await reader.cancel()
  })
})

describe('the layers request loop', () => {
  const poll = (app: ReturnType<typeof setup>['app']) =>
    Promise.resolve(app.request('/api/agent/poll', { headers: { 'x-diffo-agent': 'cli' } })).then(
      pollResult,
    )

  it('the click rides to a waiting poll as a `layers` item, and presence says outlining', async () => {
    const { app, queue } = setup()
    const pending = poll(app)
    await tick()
    const res = await post(app, '/api/review/layers/request')
    expect(await res.json()).toMatchObject({ ok: true })
    const payload = await pending
    expect(payload.status).toBe('feedback')
    expect(payload.kind).toBe('layers')
    expect(payload.threadIds).toEqual([])
    expect(payload.prompt).toContain('asked for layers')
    expect(payload.prompt).toContain('npx -y @diffohq/diffo layers --json')
    expect(payload.next_step).toContain('diffo layers')
    expect(queue.layersRequest()).toBe('outlining')
    expect(queue.presence()).toBe('working')
    // The post answers it.
    await post(app, '/api/review/layers', { items: [{ title: 'A', files: ['app.ts'] }] })
    expect(queue.layersRequest()).toBeNull()
    expect(queue.take()).toBeNull()
  })

  it('with nobody polling the request parks, and answers as queued', async () => {
    const { app, queue } = setup()
    const res = await post(app, '/api/review/layers/request')
    expect(await res.json()).toMatchObject({ ok: true, request: 'queued', presence: 'waiting' })
    expect(queue.take()).toEqual({ kind: 'layers', ask: { kind: 'auto' } })
  })

  it('a refresh over an existing outline names it in the prompt', async () => {
    const { app } = setup()
    await post(app, '/api/review/layers', {
      items: [{ title: 'Contract', files: ['app.ts'] }],
    })
    await post(app, '/api/review/layers/request')
    const payload = await poll(app)
    expect(payload.kind).toBe('layers')
    expect(payload.prompt).toContain('refresh the layers')
    expect(payload.prompt).toContain('"Contract"')
  })

  it('clearing the review withdraws the request with the layers', async () => {
    const { app, queue } = setup()
    await post(app, '/api/review/layers/request')
    await app.request('/api/review/threads', { method: 'DELETE' })
    expect(queue.take()).toBeNull()
  })

  it('the presence stream carries where the request stands', async () => {
    const { app } = setup()
    const res = await app.request('/api/events')
    const reader = res.body!.getReader()
    const decoder = new TextDecoder()
    let seen = ''
    const readUntil = async (marker: string) => {
      while (!seen.includes(marker)) {
        const { value, done } = await reader.read()
        if (done) break
        seen += decoder.decode(value)
      }
    }
    await readUntil('event: presence')
    expect(seen).toContain('"layers":null')
    await post(app, '/api/review/layers/request')
    await readUntil('"layers":"queued"')
    await poll(app)
    await readUntil('"layers":"outlining"')
    await reader.cancel()
  })
})

describe('editing a message', () => {
  const agentPoll = async (app: ReturnType<typeof setup>['app']) =>
    pollResult(await app.request('/api/agent/poll', { headers: { 'x-diffo-agent': 'cli' } }))
  const edit = (
    app: ReturnType<typeof setup>['app'],
    threadId: string,
    messageId: string,
    body: unknown,
  ) =>
    app.request(`/api/review/threads/${threadId}/messages/${messageId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })

  /** A sent thread the agent has taken and answered once. */
  async function answered(app: ReturnType<typeof setup>['app']): Promise<ReviewThread> {
    const created = await post(app, '/api/review/threads', {
      anchor: { kind: 'changeset' },
      text: 'cache this',
    })
    const thread = (await created.json()) as ReviewThread
    await post(app, `/api/review/threads/${thread.id}/send`)
    await agentPoll(app)
    await post(app, `/api/review/threads/${thread.id}/messages`, {
      author: 'agent',
      text: 'added an LRU cache',
    })
    return thread
  }

  it('a rewind cuts the answer and re-delivers, telling the agent its reply is withdrawn', async () => {
    const { app, review } = setup()
    const thread = await answered(app)

    const res = await edit(app, thread.id, thread.messages[0]!.id, {
      text: 'memoize per request instead',
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { thread: ReviewThread }
    expect(body.thread.messages.map((m) => m.text)).toEqual(['memoize per request instead'])
    expect(body.thread.rewound).toBe(true)

    const redelivered = await agentPoll(app)
    expect(redelivered.threadIds).toEqual([thread.id])
    const prompt = String(redelivered.prompt)
    expect(prompt).toContain('EDITED:')
    expect(prompt).toContain('- reviewer (edited): memoize per request instead')
    expect(prompt).not.toContain('added an LRU cache')
    // Said once: the delivery that carried it clears it.
    expect(review.get().threads[0]!.rewound).toBeUndefined()
  })

  it('refuses while the agent is answering — its reply would land under words it never read', async () => {
    const { app, review } = setup()
    const created = await post(app, '/api/review/threads', {
      anchor: { kind: 'changeset' },
      text: 'why?',
    })
    const thread = (await created.json()) as ReviewThread
    await post(app, `/api/review/threads/${thread.id}/send`)
    await agentPoll(app)

    const res = await edit(app, thread.id, thread.messages[0]!.id, { text: 'why, really?' })
    expect(res.status).toBe(409)
    expect(((await res.json()) as { error: string }).error).toContain('the agent is answering')
    expect(review.get().threads[0]!.messages[0]!.text).toBe('why?')
  })

  it('deliver:false holds a rewind — written and withheld, nothing queued', async () => {
    const { app, review, queue } = setup()
    const thread = await answered(app)

    const res = await edit(app, thread.id, thread.messages[0]!.id, {
      text: 'memoize instead',
      deliver: false,
    })
    const body = (await res.json()) as { thread: ReviewThread; delivered: boolean }
    expect(body.delivered).toBe(false)
    expect(body.thread.withheld).toBe(true)
    expect(queue.take()).toBeNull()
    // Send releases it, with the withdrawal note still owed.
    await post(app, `/api/review/threads/${thread.id}/send`)
    expect(String((await agentPoll(app)).prompt)).toContain('EDITED:')
    expect(review.get().threads[0]!.withheld).toBeUndefined()
  })

  it('a draft is fixed in place and sends nothing', async () => {
    const { app, queue } = setup()
    const created = await post(app, '/api/review/threads', {
      anchor: { kind: 'changeset' },
      text: 'rename ths',
    })
    const thread = (await created.json()) as ReviewThread

    const res = await edit(app, thread.id, thread.messages[0]!.id, { text: 'rename this' })
    const body = (await res.json()) as { thread: ReviewThread }
    expect(body.thread.messages[0]!.text).toBe('rename this')
    expect(body.thread.messages[0]!.editedAt).toBeUndefined()
    expect(body.thread.state).toBe('open')
    expect(queue.take()).toBeNull()
  })

  it("refuses the agent's words, a resolved thread, blank text, and unknown ids", async () => {
    const { app, review } = setup()
    const thread = await answered(app)
    const agentMessage = review.get().threads[0]!.messages[1]!

    expect((await edit(app, thread.id, agentMessage.id, { text: 'x' })).status).toBe(400)
    expect((await edit(app, thread.id, thread.messages[0]!.id, { text: '  ' })).status).toBe(400)
    expect((await edit(app, thread.id, 'nope', { text: 'x' })).status).toBe(404)
    expect((await edit(app, 'nope', thread.messages[0]!.id, { text: 'x' })).status).toBe(404)
    review.setState(thread.id, 'resolved')
    expect((await edit(app, thread.id, thread.messages[0]!.id, { text: 'x' })).status).toBe(409)
    expect(review.get().threads[0]!.messages.map((m) => m.text)).toEqual([
      'cache this',
      'added an LRU cache',
    ])
  })
})

describe('review api — the agent announces it opened the review', () => {
  it('turns presence to working (arriving) until the first poll, and queues a send meanwhile', async () => {
    const { app, queue } = setup()
    expect(queue.presence()).toBe('waiting')
    const res = await app.request('/api/agent/arrive', {
      method: 'POST',
      headers: { 'x-diffo-agent': 'cli' },
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true, arrived: true, presence: 'working' })
    expect(queue.presenceDetail()).toMatchObject({ state: 'working', reason: 'arriving' })

    const created = await post(app, '/api/review/threads', {
      anchor: { kind: 'changeset' },
      text: 'is the retry bounded?',
    })
    const thread = (await created.json()) as ReviewThread
    const sent = (await (await post(app, `/api/review/threads/${thread.id}/send`)).json()) as {
      delivered: boolean
      presence: string
    }
    // Not delivered (no poll yet) — but not the copy-the-prompt fallback either.
    expect(sent).toMatchObject({ delivered: false, presence: 'working' })

    const payload = await pollResult(
      await app.request('/api/agent/poll', { headers: { 'x-diffo-agent': 'cli' } }),
    )
    expect(payload).toMatchObject({ kind: 'threads', threadIds: [thread.id] })
  })

  it('refuses an arrival without the agent header, like the poll', async () => {
    const { app, queue } = setup()
    expect((await app.request('/api/agent/arrive', { method: 'POST' })).status).toBe(403)
    expect(queue.presence()).toBe('waiting')
  })
})

describe('the layers request names what the layers are for', () => {
  const settingsApp = (blob: unknown) => {
    const root = tempRepo()
    const store = new ChangesetStore(root, { kind: 'working-tree' })
    const review = new ReviewStore(root, makeDb(root), { kind: 'working-tree' })
    const queue = new DeliveryQueue()
    const kv = new Map<string, string>([['layersPresets', JSON.stringify(blob)]])
    const app = createApp(
      {
        root,
        spec: { kind: 'working-tree' },
        clientDir: '/nope',
        uiSettings: {
          get: (key) => kv.get(key) ?? null,
          set: (key, value) => void kv.set(key, value),
        },
      },
      store,
      review,
      queue,
    )
    return { app, queue, review }
  }
  const mine = {
    id: 'mine1',
    name: 'Data and storage',
    blurb: 'types and keys',
    whenToUse: 'A change that adds stored state.',
    instructions: 'Type files whole.',
  }

  it('no body means the default: the agent picks, or the preset Settings names', async () => {
    const auto = settingsApp({ presets: [mine], default: 'agent' })
    await post(auto.app, '/api/review/layers/request')
    expect(auto.queue.take()).toEqual({ kind: 'layers', ask: { kind: 'auto' } })
    const named = settingsApp({ presets: [mine], default: 'mine1' })
    await post(named.app, '/api/review/layers/request')
    expect(named.queue.take()).toEqual({ kind: 'layers', ask: { kind: 'preset', id: 'mine1' } })
    // A default that was switched off is the agent's pick again.
    const off = settingsApp({ presets: [mine], disabled: ['mine1'], default: 'mine1' })
    await post(off.app, '/api/review/layers/request')
    expect(off.queue.take()).toEqual({ kind: 'layers', ask: { kind: 'auto' } })
  })

  it('a named preset must be active', async () => {
    const { app, queue } = settingsApp({ presets: [mine], disabled: ['concept'] })
    expect((await post(app, '/api/review/layers/request', { preset: 'concept' })).status).toBe(400)
    expect((await post(app, '/api/review/layers/request', { preset: 'nope' })).status).toBe(400)
    expect(queue.take()).toBeNull()
    await post(app, '/api/review/layers/request', { preset: 'importance' })
    expect(queue.take()).toEqual({ kind: 'layers', ask: { kind: 'preset', id: 'importance' } })
  })

  it('a later ask replaces a parked one, and the poll carries the ask', async () => {
    const { app, queue } = settingsApp({ presets: [mine] })
    await post(app, '/api/review/layers/request', { preset: 'importance' })
    await post(app, '/api/review/layers/request', { preset: 'mine1' })
    expect(queue.layersRequest()).toBe('queued')
    const payload = (await (
      await app.request('/api/agent/poll', { headers: { 'x-diffo-agent': 'cli' } })
    ).json()) as { kind: string; prompt: string }
    expect(payload.kind).toBe('layers')
    expect(payload.prompt).toContain('picked the "Data and storage" preset')
  })

  it('a note for this change rides the ask, reaches the prompt, and is stamped on the post', async () => {
    const { app, review, queue } = settingsApp({ presets: [mine] })
    await post(app, '/api/review/layers/request', {
      preset: 'importance',
      note: '  start with the migration  ',
    })
    expect(queue.layersAsk()).toEqual({
      kind: 'preset',
      id: 'importance',
      note: 'start with the migration',
    })
    const payload = await pollResult(
      await app.request('/api/agent/poll', { headers: { 'x-diffo-agent': 'cli' } }),
    )
    expect(payload.prompt).toContain('the reviewer also asked: “start with the migration”')
    // The note is the reviewer's: the server stamps it, whatever the agent sends.
    await post(app, '/api/review/layers', {
      items: [{ title: 'A', files: ['app.ts'] }],
      preset: { id: 'importance' },
      note: 'the agent’s own',
    })
    expect(review.get().layers).toMatchObject({
      preset: { id: 'importance' },
      note: 'start with the migration',
    })
    // A post nobody asked for keeps it; an ask without one clears it.
    await post(app, '/api/review/layers', {
      items: [{ title: 'A', files: ['app.ts'] }],
      preset: { id: 'importance' },
    })
    expect(review.get().layers?.note).toBe('start with the migration')
    await post(app, '/api/review/layers/request', { preset: 'importance' })
    await pollResult(await app.request('/api/agent/poll', { headers: { 'x-diffo-agent': 'cli' } }))
    await post(app, '/api/review/layers', {
      items: [{ title: 'A', files: ['app.ts'] }],
      preset: { id: 'importance' },
    })
    expect(review.get().layers?.note).toBeUndefined()
  })

  it('"add" is not a new split: the layers ride the prompt as they stand, and keep their preset and note', async () => {
    const { app, review, queue } = settingsApp({ presets: [mine] })
    const agentPoll = async () =>
      pollResult(await app.request('/api/agent/poll', { headers: { 'x-diffo-agent': 'cli' } }))
    // No layers yet: nothing to add to, so it is an ordinary ask.
    await post(app, '/api/review/layers/request', { add: true })
    expect(queue.layersAsk()).toEqual({ kind: 'auto' })
    await post(app, '/api/review/layers/request', { preset: 'importance', note: 'tests last' })
    await agentPoll()
    await post(app, '/api/review/layers', {
      items: [{ title: 'Contract', summary: 'What callers see.', files: ['app.ts'] }],
      preset: { id: 'importance' },
    })
    await post(app, '/api/review/layers/request', { add: true, preset: 'mine1', note: 'ignored' })
    expect(queue.layersAsk()).toEqual({ kind: 'add' })
    const payload = await agentPoll()
    expect(payload.kind).toBe('layers')
    expect(payload.prompt).toContain('add what is outside the layers')
    expect(payload.prompt).toContain('This is not a new split')
    // The layers as posted, without the server's ids, and no preset to choose.
    expect(payload.prompt).toContain(
      '{"preset":{"id":"importance"},"layers":[{"title":"Contract","files":["app.ts"],"summary":"What callers see."}]}',
    )
    expect(payload.prompt).not.toContain('yours to pick')
    // Whatever the agent sends, the layers follow what they did.
    await post(app, '/api/review/layers', {
      items: [
        { title: 'Contract', summary: 'What callers see.', files: ['app.ts'] },
        { title: 'Later', files: ['other.ts'] },
      ],
      preset: { id: 'concept' },
    })
    expect(review.get().layers).toMatchObject({ preset: { id: 'importance' }, note: 'tests last' })
    expect(review.get().layers?.items).toHaveLength(2)
  })

  it('layers by the reviewer’s own words alone need the words, and follow no preset', async () => {
    const { app, review, queue } = settingsApp({ presets: [mine] })
    expect((await post(app, '/api/review/layers/request', { preset: null })).status).toBe(400)
    expect(
      (await post(app, '/api/review/layers/request', { preset: null, note: '  ' })).status,
    ).toBe(400)
    expect(queue.take()).toBeNull()
    await post(app, '/api/review/layers/request', { preset: null, note: 'only the database' })
    expect(queue.layersAsk()).toEqual({ kind: 'own', note: 'only the database' })
    const payload = await pollResult(
      await app.request('/api/agent/poll', { headers: { 'x-diffo-agent': 'cli' } }),
    )
    expect(payload.prompt).toContain('“only the database”')
    expect(payload.prompt).toContain('Post without a "preset"')
    // A preset the agent names anyway is not recorded: none was asked for.
    await post(app, '/api/review/layers', {
      items: [{ title: 'A', files: ['app.ts'] }],
      preset: { id: 'importance' },
    })
    expect(review.get().layers?.preset).toBeUndefined()
    expect(review.get().layers?.note).toBe('only the database')
  })

  it('a suggestion may name a preset that is on; one that is not is dropped, and the ack says so', async () => {
    const { app, review } = settingsApp({ presets: [mine], disabled: ['importance'] })
    const ok = await post(app, '/api/review/layers', {
      suggest: true,
      reason: 'mostly plumbing',
      preset: 'concept',
    })
    expect(await ok.json()).toEqual({ suggested: true })
    expect(review.get().layersSuggested).toEqual({ reason: 'mostly plumbing', preset: 'concept' })
    const off = await post(app, '/api/review/layers', { suggest: true, preset: 'importance' })
    expect(await off.json()).toEqual({
      suggested: true,
      note: 'no active layers preset "importance": suggested without one',
    })
    expect(review.get().layersSuggested).toEqual({})
  })

  it('a post records the preset it follows, as the agent sent it', async () => {
    const { app, review } = settingsApp({ presets: [mine] })
    const res = await post(app, '/api/review/layers', {
      items: [{ title: 'A', files: ['app.ts'] }],
      preset: { id: 'importance', picked: true, why: 'large feature' },
    })
    expect(res.status).toBe(200)
    expect(review.get().layers?.preset).toEqual({
      id: 'importance',
      picked: true,
      why: 'large feature',
    })
    // A bad preset is refused like a bad layer.
    expect(
      (
        await post(app, '/api/review/layers', {
          items: [{ title: 'A', files: ['app.ts'] }],
          preset: { id: 'has space' },
        })
      ).status,
    ).toBe(400)
  })

  it('a post naming a preset the reviewer does not have is kept, following none, and the ack says so', async () => {
    const { app, review } = settingsApp({ presets: [mine], disabled: ['importance'] })
    const gone = await post(app, '/api/review/layers', {
      items: [{ title: 'A', files: ['app.ts'] }],
      preset: { id: 'nope' },
    })
    expect(gone.status).toBe(200)
    expect((await gone.json()).note).toBe('no layers preset "nope": posted as following none')
    expect(review.get().layers?.items).toHaveLength(1)
    expect(review.get().layers?.preset).toBeUndefined()
    // One that is only switched off still has a name: it is recorded.
    const off = await post(app, '/api/review/layers', {
      items: [{ title: 'A', files: ['app.ts'] }],
      preset: { id: 'importance' },
    })
    expect((await off.json()).note).toBeUndefined()
    expect(review.get().layers?.preset).toEqual({ id: 'importance' })
  })

  it('a new conversation clears a preset’s messages; deleting the preset deletes them too', async () => {
    const { app, queue } = settingsApp({ presets: [mine] })
    const thread = async () =>
      (
        (await (await app.request('/api/presets/mine1/thread')).json()) as {
          thread: { messages: unknown[] }
        }
      ).thread.messages
    await post(app, '/api/presets/mine1/messages', { text: 'tests first' })
    expect(await thread()).toHaveLength(1)
    expect(queue.take()).toEqual({ kind: 'preset', id: 'mine1' })
    // Cleared: the messages go, the parked message with them, the preset stays.
    const cleared = await app.request('/api/presets/mine1/thread', { method: 'DELETE' })
    expect(await cleared.json()).toMatchObject({ cleared: true, thread: { messages: [] } })
    expect(await thread()).toHaveLength(0)
    expect(queue.take()).toBeNull()
    const list = (await (await app.request('/api/presets')).json()) as {
      presets: Array<{ id: string }>
    }
    expect(list.presets.map((p) => p.id)).toContain('mine1')
    expect(
      await (await app.request('/api/presets/mine1/thread', { method: 'DELETE' })).json(),
    ).toMatchObject({ cleared: false })
    // Deleted from the dialog (a settings save without it): its conversation goes with it.
    await post(app, '/api/presets/mine1/messages', { text: 'again' })
    const saved = await app.request('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ layersPresets: { presets: [], disabled: [], default: 'agent' } }),
    })
    expect(saved.status).toBe(200)
    expect(await thread()).toHaveLength(0)
    expect(queue.take()).toBeNull()
  })

  it('the reviewer removes the outline: the layers go, and an ask on its way goes with them', async () => {
    const { app, review, queue } = settingsApp({ presets: [mine] })
    await post(app, '/api/review/layers', {
      items: [{ title: 'A', files: ['app.ts'] }],
      preset: { id: 'importance' },
    })
    expect(review.get().layers?.items).toHaveLength(1)
    await post(app, '/api/review/layers/request', {})
    expect(queue.layersRequest()).toBe('queued')
    const removed = await app.request('/api/review/layers', { method: 'DELETE' })
    expect(await removed.json()).toEqual({ removed: true })
    expect(review.get().layers).toBeUndefined()
    expect(queue.layersRequest()).toBeNull()
    // Nothing to remove the second time; it is not an error.
    const again = await app.request('/api/review/layers', { method: 'DELETE' })
    expect(await again.json()).toEqual({ removed: false })
  })

  it('the reviewer talks to the agent about a preset; the agent answers, edits, and the edit can be undone', async () => {
    const { app, queue } = settingsApp({ presets: [mine] })
    const list = (await (await app.request('/api/presets')).json()) as {
      presets: Array<{ id: string; on: boolean; builtIn: boolean }>
      default: string
    }
    expect(list.presets.map((p) => p.id)).toEqual(['concept', 'importance', 'mine1'])
    expect(list.default).toBe('agent')
    // The reviewer's message is parked for the agent's next poll.
    expect((await post(app, '/api/presets/mine1/messages', { text: '  ' })).status).toBe(400)
    const sent = await post(app, '/api/presets/mine1/messages', { text: ' tests first ' })
    expect(sent.status).toBe(200)
    expect(queue.take()).toEqual({ kind: 'preset', id: 'mine1' })
    const payload = (await (
      await app.request('/api/agent/poll', { headers: { 'x-diffo-agent': 'cli' } })
    ).json()) as { kind: string; prompt: string; next_step: string }
    expect(payload.kind).toBe('preset')
    expect(payload.prompt).toContain('- Reviewer: tests first')
    expect(payload.next_step).toContain('diffo preset update')
    expect(queue.take()).toBeNull()
    // The agent's edit: only the fields it sends change; the message carries the
    // change and the values before.
    expect((await post(app, '/api/presets/mine1', { fields: {} })).status).toBe(400)
    expect((await post(app, '/api/presets/concept', { fields: { name: 'x' } })).status).toBe(400)
    const edited = await post(app, '/api/presets/mine1', {
      fields: { instructions: 'Tests first, then type files whole.' },
      message: 'Tests now lead.',
    })
    expect(edited.status).toBe(200)
    const body = (await edited.json()) as {
      preset: { instructions: string; name: string }
      thread: { messages: Array<{ author: string; text: string; change?: unknown }> }
    }
    expect(body.preset).toMatchObject({
      name: 'Data and storage',
      instructions: 'Tests first, then type files whole.',
    })
    expect(body.thread.messages.map((m) => m.author)).toEqual(['reviewer', 'agent'])
    expect(body.thread.messages[1]).toMatchObject({
      text: 'Tests now lead.',
      change: { fields: ['instructions'], before: { instructions: 'Type files whole.' } },
    })
    // A preset nobody has yet is made from the fields, with a name at least.
    expect((await post(app, '/api/presets/new1', { fields: { blurb: 'b' } })).status).toBe(400)
    const made = await post(app, '/api/presets/new1', {
      fields: { name: 'API and disk', instructions: 'Routes first.' },
      message: 'Made it.',
    })
    expect(made.status).toBe(200)
    expect(
      ((await made.json()) as { thread: { messages: Array<{ change?: { created?: boolean } }> } })
        .thread.messages[0]?.change?.created,
    ).toBe(true)
    const settings = (await (await app.request('/api/settings')).json()) as {
      layersPresets: { presets: Array<{ id: string; name: string }> }
    }
    expect(settings.layersPresets.presets.map((p) => p.name)).toEqual([
      'Data and storage',
      'API and disk',
    ])
    // The agent's plain reply changes nothing.
    const replied = await post(app, '/api/presets/mine1/messages', {
      author: 'agent',
      text: 'Sure?',
    })
    expect(replied.status).toBe(200)
    expect(queue.take()).toBeNull()
    const thread = (await (await app.request('/api/presets/mine1/thread')).json()) as {
      thread: { messages: Array<{ author: string }> }
    }
    expect(thread.thread.messages.map((m) => m.author)).toEqual(['reviewer', 'agent', 'agent'])
  })

  it('a copy the agent makes of a built-in is answered in the built-in’s conversation too', async () => {
    const { app } = settingsApp({ presets: [mine] })
    const thread = async (id: string) =>
      (
        (await (await app.request(`/api/presets/${id}/thread`)).json()) as {
          thread: { messages: Array<{ author: string; text: string }> }
        }
      ).thread.messages
    // A preset made with no built-in waiting says nothing anywhere else.
    await post(app, '/api/presets/solo', { fields: { name: 'Solo' }, message: 'Made it.' })
    expect(await thread('importance')).toEqual([])
    // The reviewer asks for a change to a built-in; the agent can only copy it.
    await post(app, '/api/presets/importance/messages', { text: 'make the budget 80 lines' })
    const made = await post(app, '/api/presets/importance-80', {
      fields: { name: 'Importance, 80 lines', instructions: 'As Importance, in 80 lines.' },
      message: 'A copy with the smaller budget.',
    })
    expect(made.status).toBe(200)
    expect((await thread('importance')).map((m) => [m.author, m.text])).toEqual([
      ['reviewer', 'make the budget 80 lines'],
      [
        'agent',
        'A copy with the smaller budget.\n\nThe copy is “Importance, 80 lines”, under your presets.',
      ],
    ])
    // The copy's own conversation has the agent's line, once; a later edit
    // of the copy is not said again in the built-in's.
    expect((await thread('importance-80')).map((m) => m.text)).toEqual([
      'A copy with the smaller budget.',
    ])
    await post(app, '/api/presets/importance-80', { fields: { blurb: 'short' }, message: 'x' })
    expect(await thread('importance')).toHaveLength(2)
  })

  it('the reviewer’s first word about a new preset makes it: empty and offered nowhere until the agent writes it', async () => {
    const { app } = settingsApp({ presets: [mine] })
    const list = async () =>
      (
        (await (await app.request('/api/presets')).json()) as {
          presets: Array<{ id: string; name: string; on: boolean }>
        }
      ).presets
    const thread = async () =>
      (
        (await (await app.request('/api/presets/new-a/thread')).json()) as {
          thread: { messages: Array<{ author: string; change?: { created?: boolean } }> }
        }
      ).thread.messages
    expect((await post(app, '/api/presets/new-a/messages', { text: 'only the API' })).status).toBe(
      200,
    )
    // A real preset from now on, so the conversation has a card to live on.
    expect((await list()).find((p) => p.id === 'new-a')).toEqual(
      expect.objectContaining({ name: 'New preset', on: false }),
    )
    // Empty, it cannot be asked for, and a second message starts nothing new.
    expect((await post(app, '/api/review/layers/request', { preset: 'new-a' })).status).toBe(400)
    await post(app, '/api/presets/new-a/messages', { text: 'and what is written to disk' })
    expect((await list()).filter((p) => p.name === 'New preset')).toHaveLength(1)
    // More started before the first is named are numbered, to tell them apart.
    await post(app, '/api/presets/new-b/messages', { text: 'the database' })
    await post(app, '/api/presets/new-c/messages', { text: 'the UI' })
    expect((await list()).slice(-3).map((p) => p.name)).toEqual([
      'New preset',
      'New preset (1)',
      'New preset (2)',
    ])
    const payload = (await (
      await app.request('/api/agent/poll', { headers: { 'x-diffo-agent': 'cli' } })
    ).json()) as { prompt: string }
    expect(payload.prompt).toContain('is new and still empty')
    expect(payload.prompt).toContain('- Reviewer: only the API')
    // The agent writing it is making it: nothing before it to undo, and now it is offered.
    const made = await post(app, '/api/presets/new-a', {
      fields: { name: 'API and disk', instructions: 'Routes first.' },
      message: 'Made it.',
    })
    expect(made.status).toBe(200)
    expect((await thread()).at(-1)?.change).toMatchObject({ created: true, before: {} })
    expect((await list()).find((p) => p.id === 'new-a')).toEqual(
      expect.objectContaining({ name: 'API and disk', on: true }),
    )
    // Deleted, it takes its conversation with it.
    const put = await app.request('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        layersPresets: { presets: [{ ...mine }], disabled: [], default: 'agent' },
      }),
    })
    expect(put.status).toBe(200)
    expect(await thread()).toEqual([])
    expect((await list()).map((p) => p.id)).not.toContain('new-b')
    // An agent answering late does not bring a deleted preset back, with an
    // edit or with words.
    const late = await post(app, '/api/presets/new-b', {
      fields: { name: 'Database', instructions: 'Tables first.' },
      message: 'Made it.',
    })
    expect(late.status).toBe(400)
    expect(((await late.json()) as { error: string }).error).toContain('deleted this preset')
    expect(
      (await post(app, '/api/presets/new-b/messages', { author: 'agent', text: 'Which tables?' }))
        .status,
    ).toBe(400)
    expect((await list()).map((p) => p.id)).not.toContain('new-b')
    // A preset nobody ever had can still be made by the agent: a copy of a built-in.
    expect(
      (await post(app, '/api/presets/copy-1', { fields: { name: 'Concept (mine)' } })).status,
    ).toBe(200)
  })
})

describe('review API — artifacts', () => {
  const art = '```artifact title="Timeline" size=s\n<svg></svg>\n```'

  it('refuses an agent post whose artifact the reviewer would see broken', async () => {
    const { app } = setup()
    const res = await post(app, '/api/review/threads', {
      author: 'agent',
      text: 'look:\n\n```artifact\n<p>x</p>\n```',
    })
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: string }).error).toMatch(/needs a title/)
  })

  it('queues a broken agent artifact for the next poll, once per issue', async () => {
    const { app, review } = setup()
    const created = await post(app, '/api/review/threads', {
      author: 'agent',
      text: `guide\n\n${art}`,
    })
    const thread = (await created.json()) as ReviewThread
    const owner = { kind: 'message', threadId: thread.id, messageId: thread.messages[0]!.id }
    const report = {
      owner,
      index: 0,
      title: 'ignored',
      view: 'card',
      issues: ['TypeError: x is undefined'],
    }
    const first = await post(app, '/api/review/artifacts/issues', report)
    expect(await first.json()).toEqual({ queued: true })
    const again = await post(app, '/api/review/artifacts/issues', report)
    expect(await again.json()).toEqual({ queued: false })

    const polled = await pollResult(
      await app.request('/api/agent/poll', { headers: { 'x-diffo-agent': 'cli' } }),
    )
    expect(polled.kind).toBe('artifacts')
    expect(polled.prompt).toContain('"Timeline" in your guide')
    expect(polled.prompt).toContain('TypeError: x is undefined')
    expect(polled.prompt).toContain(`reply ${thread.id}`)
    expect(polled.next_step).toMatch(/fixed version/)
    expect(review.get().threads).toHaveLength(1)

    const replied = await post(app, `/api/review/threads/${thread.id}/messages`, {
      author: 'agent',
      text: `fixed\n\n${art}`,
    })
    const reply = ((await replied.json()) as { thread: ReviewThread }).thread.messages.at(-1)!
    await post(app, '/api/review/artifacts/issues', {
      owner: { kind: 'message', threadId: thread.id, messageId: reply.id },
      index: 0,
      issues: ['still broken'],
    })
    const again2 = await pollResult(
      await app.request('/api/agent/poll', { headers: { 'x-diffo-agent': 'cli' } }),
    )
    expect(again2.prompt).toContain('your reply under the guide')
  })

  it('takes reports only for artifacts the agent wrote', async () => {
    const { app } = setup()
    const created = await post(app, '/api/review/threads', {
      anchor: { kind: 'changeset' },
      text: art,
    })
    const thread = (await created.json()) as ReviewThread
    const owner = { kind: 'message', threadId: thread.id, messageId: thread.messages[0]!.id }
    const res = await post(app, '/api/review/artifacts/issues', {
      owner,
      index: 0,
      issues: ['boom'],
    })
    expect(res.status).toBe(404)
    const bad = await post(app, '/api/review/artifacts/issues', { owner, index: 0 })
    expect(bad.status).toBe(400)
  })

  it('reports a layer summary artifact by its layer', async () => {
    const { app, review } = setup()
    await post(app, '/api/review/layers', {
      items: [{ title: 'Parser', summary: `the parser\n\n${art}`, files: ['app.ts'] }],
    })
    const layerId = review.get().layers!.items[0]!.id
    expect(review.get().layers!.items[0]!.summary).toContain('<svg></svg>')
    const res = await post(app, '/api/review/artifacts/issues', {
      owner: { kind: 'layer', layerId },
      index: 0,
      issues: ['rendered blank'],
    })
    expect(await res.json()).toEqual({ queued: true })
    const polled = await pollResult(
      await app.request('/api/agent/poll', { headers: { 'x-diffo-agent': 'cli' } }),
    )
    expect(polled.prompt).toContain('the summary of layer "Parser"')
    expect(polled.prompt).toContain('layers --stdin')
  })
})
