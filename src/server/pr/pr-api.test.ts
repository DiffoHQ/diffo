import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { FixtureForge, fixturePr } from '../../forge/fixture.js'
import { threadsFromGithub } from '../../forge/github/map.js'
import type { ImportedThread, PrRef } from '../../forge/types.js'
import type { ReviewThread } from '../../shared/review.js'
import { DiffoDb } from '../db.js'
import { DeliveryQueue } from '../delivery.js'
import { createApp } from '../index.js'
import { ReviewStore } from '../review.js'
import { ChangesetStore } from '../store.js'
import { PrPuller } from './puller.js'

// The review API over a pull request: public drafts, queued resolves, replies
// for GitHub, and the two-legged Finish — all against the fixture forge.

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

/** A repo whose working tree differs from HEAD on one line — the diff any PR
 * test needs, without a worktree: the API does not care where the root is. */
function tempRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'diffo-pr-api-'))
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

const REF: PrRef = { host: 'github.com', owner: 'acme', repo: 'widgets', number: 482 }

const jonas = { login: 'jonas', avatarUrl: '' }
const imported: ImportedThread[] = [
  {
    kind: 'inline',
    id: 'T_existing',
    resolved: false,
    outdated: false,
    path: 'app.ts',
    line: 2,
    startLine: null,
    side: 'RIGHT',
    comments: [
      { id: 'C1', user: jonas, body: 'why 42?', at: '2026-09-20T12:00:00Z', url: 'https://x/c1' },
    ],
  },
  {
    kind: 'comment',
    id: 'IC1',
    comments: [
      { id: 'IC1', user: jonas, body: 'looks reasonable overall', at: '2026-09-20T13:00:00Z' },
    ],
  },
]

function setup(over: { isAuthor?: boolean } = {}) {
  const root = tempRepo()
  const dbDir = `${root}-db`
  cleanups.push(() => rmSync(dbDir, { recursive: true, force: true }))
  const db = new DiffoDb(join(dbDir, 'diffo.db'))
  cleanups.push(() => db.close())
  const spec = { kind: 'working-tree' as const }
  const store = new ChangesetStore(root, spec)
  const review = new ReviewStore(root, db, spec)
  const queue = new DeliveryQueue()
  const pr = fixturePr({
    viewer: { login: 'reviewer-x', isAuthor: over.isAuthor === true, pendingReviewId: null },
  })
  const forge = new FixtureForge(pr, structuredClone(imported))
  // Prime the PR block and the conversation the way the puller's first tick does.
  store.setPr(pr)
  review.importGithubThreads(threadsFromGithub(pr, forge.threads, store.get().files))
  const app = createApp(
    {
      root,
      spec,
      clientDir: '/nope',
      pr: {
        ref: REF,
        forge,
        mainRepo: root,
        refresh: async () => {
          const { pr: fresh, threads: imported } = await forge.fetchPr(REF)
          store.setPr(fresh)
          review.importGithubThreads(threadsFromGithub(fresh, imported, store.get().files))
        },
      },
    },
    store,
    review,
    queue,
  )
  return { root, db, store, review, queue, forge, app }
}

async function post(app: ReturnType<typeof setup>['app'], path: string, body?: unknown) {
  return app.request(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

const threads = async (app: ReturnType<typeof setup>['app']) =>
  ((await (await app.request('/api/review')).json()) as { threads: ReviewThread[] }).threads

describe('a pull request in the review API', () => {
  it('imports the description and the conversation as public threads, description first', async () => {
    const { app } = setup()
    const list = await threads(app)
    expect(list.map((t) => t.id)).toEqual(['gh:description:PR_kwDO_482', 'gh:IC1', 'gh:T_existing'])
    expect(list.every((t) => t.audience === 'pr')).toBe(true)
    expect(list[0]!.messages[0]!.author).toBe('github')
    expect(list[2]!.anchor).toMatchObject({ kind: 'hunk', path: 'app.ts', side: 'new', line: 2 })
  })

  it('a public draft is a thread with no intent that Send refuses and Finish previews', async () => {
    const { app, store } = setup()
    const hunk = store.get().files[0]!.hunks[0]!
    const res = await post(app, '/api/review/threads', {
      anchor: { kind: 'hunk', hunkId: hunk.id, path: 'app.ts', side: 'new', line: 2 },
      text: 'consider a named constant',
      intent: 'fix',
      audience: 'pr',
    })
    const draft = (await res.json()) as ReviewThread
    expect(draft.audience).toBe('pr')
    expect(draft.intent).toBeUndefined()
    expect(draft.state).toBe('open')
    const send = await post(app, `/api/review/threads/${draft.id}/send`)
    expect(send.status).toBe(400)
    const preview = (await (
      await post(app, '/api/review/finish/preview', { coverage: { viewedHunks: 1, totalHunks: 1 } })
    ).json()) as {
      outgoing: unknown[]
      public: { drafts: { id: string; downgraded: boolean }[]; canApprove: boolean }
    }
    expect(preview.outgoing).toEqual([])
    expect(preview.public.drafts).toEqual([
      {
        id: draft.id,
        anchor: 'app.ts:2 (new side)',
        text: 'consider a named constant',
        downgraded: false,
        conversation: false,
      },
    ])
    expect(preview.public.canApprove).toBe(true)
  })

  it('a private thread on the same PR still goes to the agent', async () => {
    const { app, queue } = setup()
    const res = await post(app, '/api/review/threads', {
      anchor: { kind: 'changeset' },
      text: 'is the retry loop tested?',
      intent: 'question',
    })
    const thread = (await res.json()) as ReviewThread
    expect(thread.audience).toBeUndefined()
    await post(app, `/api/review/threads/${thread.id}/send`)
    expect(queue.queuedThreadIds()).toEqual([thread.id])
  })

  it('a reply on an imported thread is held for GitHub, never delivered to the agent', async () => {
    const { app, queue } = setup()
    const res = await post(app, '/api/review/threads/gh:T_existing/messages', {
      text: 'because jitter',
    })
    const { thread, delivered } = (await res.json()) as { thread: ReviewThread; delivered: boolean }
    expect(delivered).toBe(false)
    expect(thread.messages.at(-1)).toMatchObject({ author: 'reviewer', text: 'because jitter' })
    expect(thread.messages.at(-1)!.github).toBeUndefined()
    expect(thread.withheld).toBeUndefined()
    expect(queue.queuedThreadIds()).toEqual([])
  })

  it('a draft or an unposted reply can be edited; a comment GitHub holds cannot', async () => {
    const { app, store } = setup()
    const hunk = store.get().files[0]!.hunks[0]!
    const draft = (await (
      await post(app, '/api/review/threads', {
        anchor: { kind: 'hunk', hunkId: hunk.id, path: 'app.ts', side: 'new', line: 2 },
        text: 'first wording',
        audience: 'pr',
      })
    ).json()) as ReviewThread
    const edit = (threadId: string, messageId: string, text: string) =>
      app.request(`/api/review/threads/${threadId}/messages/${messageId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      })
    let res = await edit(draft.id, draft.messages[0]!.id, 'second wording')
    expect(res.status).toBe(200)
    expect(((await res.json()) as { thread: ReviewThread }).thread.messages[0]!.text).toBe(
      'second wording',
    )
    // Posted to GitHub, the words are GitHub's to change.
    await post(app, '/api/review/finish', {
      coverage: { viewedHunks: 1, totalHunks: 1 },
      event: 'COMMENT',
    })
    const posted = (await threads(app)).find((t) => t.id === draft.id)!
    expect(posted.messages[0]!.github).toBeDefined()
    res = await edit(draft.id, posted.messages[0]!.id, 'third wording')
    expect(res.status).toBe(409)
    // An unposted reply on that same thread is still local, so still editable.
    const replied = (await (
      await post(app, `/api/review/threads/${draft.id}/messages`, { text: 'and one more' })
    ).json()) as { thread: ReviewThread }
    const reply = replied.thread.messages.at(-1)!
    res = await edit(draft.id, reply.id, 'and one more, reworded')
    expect(res.status).toBe(200)
  })

  it('resolving an imported thread is queued locally until Finish, and toggles back', async () => {
    const { app, forge } = setup()
    let res = await post(app, '/api/review/threads/gh:T_existing/state', { state: 'resolved' })
    let thread = (await res.json()) as ReviewThread
    expect(thread.state).toBe('resolved')
    expect(thread.queued).toEqual({ resolve: true })
    expect(forge.calls.map((c) => c.method)).not.toContain('setThreadResolved')
    res = await post(app, '/api/review/threads/gh:T_existing/state', { state: 'open' })
    thread = (await res.json()) as ReviewThread
    expect(thread.state).toBe('sent')
    expect(thread.queued).toBeUndefined()
  })

  it('Finish with an event posts drafts, replies and resolves, then submits, and notifies the agent', async () => {
    const { app, store, forge, queue } = setup()
    const hunk = store.get().files[0]!.hunks[0]!
    const draft = (await (
      await post(app, '/api/review/threads', {
        anchor: { kind: 'hunk', hunkId: hunk.id, path: 'app.ts', side: 'new', line: 2 },
        text: 'consider a named constant',
        audience: 'pr',
      })
    ).json()) as ReviewThread
    await post(app, '/api/review/threads', {
      anchor: { kind: 'changeset' },
      text: 'thanks for the thorough description',
      audience: 'pr',
    })
    await post(app, '/api/review/threads/gh:T_existing/messages', { text: 'because jitter' })
    await post(app, '/api/review/threads/gh:T_existing/state', { state: 'resolved' })
    // A private thread rides the agent leg as before.
    await post(app, '/api/review/threads', {
      anchor: { kind: 'changeset' },
      text: 'private note',
      intent: 'question',
    })

    const res = await post(app, '/api/review/finish', {
      coverage: { viewedHunks: 1, totalHunks: 1, note: 'One nit, otherwise good.' },
      event: 'REQUEST_CHANGES',
    })
    const body = (await res.json()) as {
      threads: ReviewThread[]
      public: { posted: number; resolved: number; submitted: boolean; failed?: unknown }
    }
    expect(body.public).toMatchObject({ posted: 3, resolved: 1, submitted: true })
    expect(body.public.failed).toBeUndefined()

    const methods = forge.calls.map((c) => c.method)
    expect(methods).toEqual([
      // the leg's own read of the PR: the pending review it holds is GitHub's word
      'getPr',
      'createPendingReview',
      'addReviewThread',
      'addPrComment',
      'replyToThread',
      'setThreadResolved',
      'submitReview',
      // the refresh the finish kicks off: one read for the PR and its conversation
      'fetchPr',
    ])
    const submit = forge.calls.find((c) => c.method === 'submitReview')!
    expect(submit.args[2]).toBe('REQUEST_CHANGES')
    expect(submit.args[3]).toBe('One nit, otherwise good.')
    const addThread = forge.calls.find((c) => c.method === 'addReviewThread')!
    expect(addThread.args[2]).toEqual({
      path: 'app.ts',
      body: 'consider a named constant',
      subjectType: 'LINE',
      line: 2,
      side: 'RIGHT',
    })

    // The draft is now on GitHub, with its ids; the closing note did not become a
    // local thread (it is the review body); the private note went to the agent.
    const posted = body.threads.find((t) => t.id === draft.id)!
    expect(posted.state).toBe('sent')
    expect(posted.github).toMatchObject({
      kind: 'inline',
      threadId: expect.stringMatching(/^PRRT_/),
    })
    expect(posted.messages[0]!.github).toMatchObject({
      id: expect.stringMatching(/^PRRC_/),
      user: { login: 'reviewer-x' },
    })
    expect(body.threads.some((t) => t.closingNote)).toBe(false)
    const privateNote = body.threads.find((t) => t.messages[0]?.text === 'private note')!
    expect(privateNote.state).toBe('sent')
    const existing = body.threads.find((t) => t.id === 'gh:T_existing')!
    expect(existing.queued).toBeUndefined()
    expect(existing.state).toBe('resolved')
    expect(existing.messages.at(-1)!.github?.id).toMatch(/^PRRC_/)

    // The agent's next poll carries the finish batch first, then the submitted notice.
    const first = JSON.parse(
      (
        await (await app.request('/api/agent/poll', { headers: { 'x-diffo-agent': 'cli' } })).text()
      ).trim(),
    ) as { kind: string; threadIds: string[] }
    expect(first.kind).toBe('finish')
    expect(first.threadIds).toEqual([privateNote.id])
    const second = JSON.parse(
      (
        await (await app.request('/api/agent/poll', { headers: { 'x-diffo-agent': 'cli' } })).text()
      ).trim(),
    ) as { kind: string; prompt: string }
    expect(second.kind).toBe('submitted')
    expect(second.prompt).toContain('requested changes, with 3 comments')
    expect(second.prompt).toContain('> One nit, otherwise good.')
    expect(queue.presence()).not.toBe('waiting')
  })

  it('Finish with no event leaves GitHub alone and runs the agent leg as always', async () => {
    const { app, forge } = setup()
    await post(app, '/api/review/threads', {
      anchor: { kind: 'changeset' },
      text: 'draft',
      audience: 'pr',
    })
    await post(app, '/api/review/threads', { anchor: { kind: 'changeset' }, text: 'for the agent' })
    const res = await post(app, '/api/review/finish', {
      coverage: { viewedHunks: 1, totalHunks: 1 },
    })
    const body = (await res.json()) as { threads: ReviewThread[]; public?: unknown }
    expect(body.public).toBeUndefined()
    expect(forge.calls).toEqual([])
    expect(body.threads.find((t) => t.messages[0]?.text === 'draft')!.state).toBe('open')
    expect(body.threads.find((t) => t.messages[0]?.text === 'for the agent')!.state).toBe('sent')
  })

  it('a failure midway records what posted and stops; the retry does not post twice', async () => {
    const { app, store, forge } = setup()
    const hunk = store.get().files[0]!.hunks[0]!
    await post(app, '/api/review/threads', {
      anchor: { kind: 'hunk', hunkId: hunk.id, path: 'app.ts', side: 'new', line: 2 },
      text: 'first',
      audience: 'pr',
    })
    await post(app, '/api/review/threads', {
      anchor: { kind: 'file', path: 'app.ts' },
      text: 'second',
      audience: 'pr',
    })
    // The first comment posts; the second call (the file comment) fails.
    const original = forge.addReviewThread.bind(forge)
    let calls = 0
    forge.addReviewThread = async (...args) => {
      calls++
      if (calls === 2) throw new Error('secondary rate limit')
      return original(...args)
    }
    let res = await post(app, '/api/review/finish', {
      coverage: { viewedHunks: 1, totalHunks: 1 },
      event: 'COMMENT',
    })
    let body = (await res.json()) as {
      threads: ReviewThread[]
      public: { posted: number; submitted: boolean; failed?: { step: string; message: string } }
    }
    expect(body.public.posted).toBe(1)
    expect(body.public.submitted).toBe(false)
    expect(body.public.failed?.message).toBe('secondary rate limit')
    expect(body.public.failed?.step).toContain('app.ts')
    expect(body.threads.find((t) => t.messages[0]?.text === 'first')!.state).toBe('sent')
    expect(body.threads.find((t) => t.messages[0]?.text === 'second')!.state).toBe('open')

    res = await post(app, '/api/review/finish', {
      coverage: { viewedHunks: 1, totalHunks: 1 },
      event: 'COMMENT',
    })
    body = (await res.json()) as typeof body
    expect(body.public).toMatchObject({ posted: 1, submitted: true })
    // One pending review for both runs, the first comment never re-sent: the
    // forge saw exactly two accepted thread posts (the failed call never reached it).
    expect(forge.calls.filter((c) => c.method === 'createPendingReview')).toHaveLength(1)
    expect(forge.calls.filter((c) => c.method === 'addReviewThread')).toHaveLength(2)
    expect(
      forge.threads.filter((t) => t.kind === 'inline').map((t) => t.comments[0]!.body),
    ).toEqual(['why 42?', 'first', 'second'])
  })

  it('approving your own pull request is refused by the forge and reported, not swallowed', async () => {
    const { app, review, queue } = setup({ isAuthor: true })
    const preview = (await (
      await post(app, '/api/review/finish/preview', { coverage: { viewedHunks: 1, totalHunks: 1 } })
    ).json()) as { public: { canApprove: boolean } }
    expect(preview.public.canApprove).toBe(false)
    // A private thread rides the agent leg — but only once the public leg went.
    const note = (await (
      await post(app, '/api/review/threads', {
        anchor: { kind: 'changeset' },
        text: 'private note',
        intent: 'question',
      })
    ).json()) as ReviewThread
    const res = await post(app, '/api/review/finish', {
      coverage: { viewedHunks: 1, totalHunks: 1 },
      event: 'APPROVE',
    })
    const body = (await res.json()) as {
      threads: ReviewThread[]
      prompt: string
      public: { failed?: { step: string } }
    }
    expect(body.public.failed?.step).toBe('submitting the review')
    // A refused submit with nothing else to post is still a failed finish:
    // nothing local is recorded and the agent hears nothing, so the retry is
    // the one finish batch it gets.
    expect(body.prompt).toBe('')
    expect(body.threads.find((t) => t.id === note.id)!.state).toBe('open')
    expect(review.get().lastFinish).toBeUndefined()
    expect(queue.take()).toBeNull()
  })

  it('a stale pending review id is dropped for what GitHub reports now', async () => {
    const { app, review, forge } = setup()
    // The reviewer submitted (or discarded) the review a failed run left
    // pending, on github.com: the stored id is dead, GitHub knows no pending review.
    review.setPr({ submissions: [], pendingReviewId: 'PRR_dead' })
    await post(app, '/api/review/threads', {
      anchor: { kind: 'changeset' },
      text: 'x',
      audience: 'pr',
    })
    // A body is something only a review carries, so one has to open.
    const res = await post(app, '/api/review/finish', {
      coverage: { viewedHunks: 1, totalHunks: 1, note: 'one comment' },
      event: 'COMMENT',
    })
    const body = (await res.json()) as { public: { submitted: boolean; reviewId: string } }
    expect(body.public.submitted).toBe(true)
    expect(body.public.reviewId).toMatch(/^PRR_/)
    expect(body.public.reviewId).not.toBe('PRR_dead')
    expect(forge.calls.filter((c) => c.method === 'createPendingReview')).toHaveLength(1)
    expect(forge.calls.find((c) => c.method === 'submitReview')!.args[1]).toBe(body.public.reviewId)
    expect(review.get().pr?.pendingReviewId).toBeUndefined()
  })

  it('a pending review GitHub already holds is used, not doubled', async () => {
    const { app, forge } = setup()
    forge.pr.viewer.pendingReviewId = 'PRR_on_github'
    await post(app, '/api/review/threads', {
      anchor: { kind: 'changeset' },
      text: 'x',
      audience: 'pr',
    })
    const res = await post(app, '/api/review/finish', {
      coverage: { viewedHunks: 1, totalHunks: 1 },
      event: 'COMMENT',
    })
    const body = (await res.json()) as { public: { submitted: boolean; reviewId: string } }
    expect(body.public).toMatchObject({ submitted: true, reviewId: 'PRR_on_github' })
    expect(forge.calls.map((c) => c.method)).not.toContain('createPendingReview')
  })

  it('a leg of only resolves opens no pending review and submits none', async () => {
    const { app, forge } = setup()
    await post(app, '/api/review/threads/gh:T_existing/state', { state: 'resolved' })
    const res = await post(app, '/api/review/finish', {
      coverage: { viewedHunks: 1, totalHunks: 1 },
      event: 'COMMENT',
    })
    const body = (await res.json()) as {
      threads: ReviewThread[]
      public: { resolved: number; submitted: boolean; reviewId: string | null; failed?: unknown }
    }
    expect(body.public).toMatchObject({ resolved: 1, submitted: false, reviewId: null })
    expect(body.public.failed).toBeUndefined()
    const methods = forge.calls.map((c) => c.method)
    expect(methods).toContain('setThreadResolved')
    expect(methods).not.toContain('createPendingReview')
    expect(methods).not.toContain('submitReview')
    const resolved = body.threads.find((t) => t.id === 'gh:T_existing')!
    expect(resolved.state).toBe('resolved')
    expect(resolved.queued).toBeUndefined()
    // A verdict, or a body, is something only a review can carry: then one opens.
    await post(app, '/api/review/threads/gh:T_existing/state', { state: 'open' })
    await post(app, '/api/review/finish', {
      coverage: { viewedHunks: 1, totalHunks: 1, note: 'reopening this one' },
      event: 'COMMENT',
    })
    expect(forge.calls.map((c) => c.method)).toContain('submitReview')
  })

  it('a draft of several messages posts once and becomes the one message GitHub holds', async () => {
    const { app, store, review, forge } = setup()
    const hunk = store.get().files[0]!.hunks[0]!
    const draft = (await (
      await post(app, '/api/review/threads', {
        anchor: { kind: 'hunk', hunkId: hunk.id, path: 'app.ts', side: 'new', line: 2 },
        text: 'first thought',
        audience: 'pr',
      })
    ).json()) as ReviewThread
    await post(app, `/api/review/threads/${draft.id}/messages`, { text: 'second thought' })
    let res = await post(app, '/api/review/finish', {
      coverage: { viewedHunks: 1, totalHunks: 1 },
      event: 'COMMENT',
    })
    let body = (await res.json()) as { threads: ReviewThread[]; public: { posted: number } }
    expect(body.public.posted).toBe(1)
    const addThread = forge.calls.find((c) => c.method === 'addReviewThread')!
    expect((addThread.args[2] as { body: string }).body).toBe('first thought\n\nsecond thought')
    const posted = body.threads.find((t) => t.id === draft.id)!
    expect(posted.messages).toHaveLength(1)
    expect(posted.messages[0]).toMatchObject({
      id: draft.messages[0]!.id,
      author: 'reviewer',
      text: 'first thought\n\nsecond thought',
      github: { id: expect.stringMatching(/^PRRC_/) },
    })
    // The puller's next import finds the same body under the same id: nothing
    // to add, nothing to rewrite.
    review.importGithubThreads(threadsFromGithub(forge.pr, forge.threads, store.get().files))
    const after = review.get().threads.find((t) => t.id === draft.id)!
    expect(after.messages.map((m) => m.text)).toEqual(['first thought\n\nsecond thought'])
    // The next finish owes GitHub nothing for this thread.
    res = await post(app, '/api/review/finish', {
      coverage: { viewedHunks: 1, totalHunks: 1 },
      event: 'COMMENT',
    })
    body = (await res.json()) as typeof body
    expect(body.public.posted).toBe(0)
    expect(forge.calls.map((c) => c.method)).not.toContain('replyToThread')
  })

  it('resolving a conversation comment is local: only inline threads resolve on GitHub', async () => {
    const { app, forge, review } = setup()
    const res = await post(app, '/api/review/threads/gh:IC1/state', { state: 'resolved' })
    const thread = (await res.json()) as ReviewThread
    expect(thread.state).toBe('resolved')
    expect(thread.queued).toBeUndefined()
    // A queue entry an earlier build left on a comment thread is settled here,
    // never sent: GitHub would refuse it at every retry.
    review.queueResolve('gh:description:PR_kwDO_482', true)
    expect(review.get().threads.find((t) => t.id === 'gh:description:PR_kwDO_482')!.queued).toEqual(
      {
        resolve: true,
      },
    )
    const finish = (await (
      await post(app, '/api/review/finish', {
        coverage: { viewedHunks: 1, totalHunks: 1 },
        event: 'COMMENT',
      })
    ).json()) as { threads: ReviewThread[]; public: { resolved: number; failed?: unknown } }
    expect(finish.public.failed).toBeUndefined()
    expect(finish.public.resolved).toBe(0)
    expect(forge.calls.map((c) => c.method)).not.toContain('setThreadResolved')
    const description = finish.threads.find((t) => t.id === 'gh:description:PR_kwDO_482')!
    expect(description.queued).toBeUndefined()
    expect(description.state).toBe('resolved')
  })

  it('a reply posted on a conversation comment does not come back as a thread of its own', async () => {
    const { app, store, forge, review } = setup()
    await post(app, '/api/review/threads/gh:IC1/messages', { text: 'agreed, thanks' })
    const finish = (await (
      await post(app, '/api/review/finish', {
        coverage: { viewedHunks: 1, totalHunks: 1 },
        event: 'COMMENT',
      })
    ).json()) as { public: { posted: number } }
    expect(finish.public.posted).toBe(1)
    const reply = forge.calls.find((c) => c.method === 'addPrComment')!
    expect(reply.args[2]).toBe('agreed, thanks')
    // The puller's next import sees the reply as a new issue comment on GitHub.
    review.importGithubThreads(threadsFromGithub(forge.pr, forge.threads, store.get().files))
    const list = review.get().threads
    expect(list.filter((t) => t.id.startsWith('gh:IC'))).toHaveLength(1)
    const original = list.find((t) => t.id === 'gh:IC1')!
    expect(original.messages.map((m) => m.text)).toEqual([
      'looks reasonable overall',
      'agreed, thanks',
    ])
    expect(original.messages[1]!.github?.id).toMatch(/^IC_/)
  })

  it('the puller advances the PR block and upserts new GitHub replies live', async () => {
    const { store, review, db, forge, root } = setup()
    const puller = new PrPuller({
      forge,
      ref: REF,
      mainRepo: root,
      worktree: root,
      store,
      review,
      db,
    })
    await puller.tick()
    const before = store.get().version
    forge.pr.title = 'Retry flaky uploads (with jitter)'
    const inline = forge.threads.find((t) => t.kind === 'inline')!
    if (inline.kind === 'inline') {
      inline.comments.push({
        id: 'C2',
        user: jonas,
        body: 'never mind',
        at: '2026-09-22T10:00:00Z',
      })
      inline.resolved = true
    }
    await puller.tick()
    expect(store.get().version).toBeGreaterThan(before)
    expect(store.get().pr?.title).toBe('Retry flaky uploads (with jitter)')
    const thread = review.get().threads.find((t) => t.id === 'gh:T_existing')!
    expect(thread.messages.map((m) => m.text)).toEqual(['why 42?', 'never mind'])
    expect(thread.state).toBe('resolved')
    // A closed PR stamps the landed offer and marks the worktree closed.
    forge.pr.state = 'merged'
    await puller.tick()
    expect(review.get().landed?.subject).toBe('Retry flaky uploads (with jitter)')
  })

  it('the puller says once that it cannot fetch, however many ticks it fails on', async () => {
    const { store, review, db, forge, root } = setup()
    const log: string[] = []
    // No remote here names the PR's repo, so the fetch the unseen head calls
    // for fails on every tick, while the forge itself keeps answering.
    const puller = new PrPuller({
      forge,
      ref: REF,
      mainRepo: root,
      worktree: root,
      store,
      review,
      db,
      log: (message) => log.push(message),
    })
    await puller.tick()
    await puller.tick()
    await puller.tick()
    expect(log.filter((l) => l.startsWith('could not fetch the pull request head'))).toHaveLength(1)
    expect(log[0]).toMatch(/no remote points at github\.com\/acme\/widgets/)
  })
})
