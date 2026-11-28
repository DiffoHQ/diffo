import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { REVIEWER_LIMITS, type ReviewThread, undeliveredThreadIds } from '../shared/review.js'
import { BUILT_IN_ROLES } from '../shared/roles.js'
import { DiffoDb } from './db.js'
import { DeliveryQueue } from './delivery.js'
import { createApp, type PrContext } from './index.js'
import { ReviewStore } from './review.js'
import { parseHubSnapshot } from './reviewers.js'
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
  const dir = mkdtempSync(join(tmpdir(), 'diffo-reviewer-api-'))
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

function setup(
  options: {
    pr?: boolean
    pollMaxMs?: number
    reviewerStartMs?: number
    graceMs?: number
    /** The stall window: how long a delivered thread may sit with no reply
     * before the author agent is reminded of it. */
    stallMs?: number
    /** Reminders before a thread reads "no answer". */
    reminderMax?: number
  } = {},
) {
  const root = tempRepo()
  const dbDir = `${root}-db`
  cleanups.push(() => rmSync(dbDir, { recursive: true, force: true }))
  const store = new ChangesetStore(root, { kind: 'working-tree' })
  const review = new ReviewStore(root, new DiffoDb(join(dbDir, 'diffo.db')), {
    kind: 'working-tree',
  })
  const queue = new DeliveryQueue(
    options.stallMs,
    undefined,
    {},
    {
      ...(options.reminderMax !== undefined ? { reminderMax: options.reminderMax } : {}),
    },
  )
  const settings = new Map<string, string>()
  const app = createApp(
    {
      root,
      spec: { kind: 'working-tree' },
      clientDir: '/nope',
      pollHeartbeatMs: 10,
      // Finished reviewers stop at once unless a test is about the grace.
      reviewerGraceMs: options.graceMs ?? 0,
      // New reviewers are named in this order, so a test can say who joined.
      reviewerNames: ['juno', 'remy', 'iris', 'otto'],
      uiSettings: {
        get: (key) => settings.get(key) ?? null,
        set: (key, value) => void settings.set(key, value),
      },
      ...(options.reviewerStartMs !== undefined
        ? { reviewerStartMs: options.reviewerStartMs }
        : {}),
      ...(options.pollMaxMs !== undefined ? { pollMaxMs: options.pollMaxMs } : {}),
      ...(options.pr
        ? {
            pr: {
              ref: { host: 'github.com', owner: 'o', repo: 'r', number: 1 },
              forge: {},
              mainRepo: root,
              baseBranch: 'main',
            } as unknown as PrContext,
          }
        : {}),
    },
    store,
    review,
    queue,
  )
  return { root, store, review, queue, app, settings }
}

type App = ReturnType<typeof setup>['app']

/** What the CLI sends: the header that marks a real CLI caller. */
const CLI = { 'Content-Type': 'application/json', 'x-diffo-agent': 'cli' }

const cli = (app: App, path: string, body?: unknown, pid?: number) =>
  app.request(path, {
    method: 'POST',
    headers: { ...CLI, ...(pid !== undefined ? { 'x-diffo-session-pid': String(pid) } : {}) },
    body: JSON.stringify(body ?? {}),
  })

/** The browser: no CLI header. */
const page = (app: App, path: string, body?: unknown, method = 'POST') =>
  app.request(path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  })

const error = async (res: Response) => ((await res.json()) as { error: string }).error

async function comment(app: App, as: string, text = 'this is wrong', line: number | null = 2) {
  const res = await cli(app, '/api/review/threads', { as, file: 'app.ts', line, text })
  expect(res.status).toBe(200)
  return ((await res.json()) as { thread: ReviewThread }).thread
}

const reviewerReply = (app: App, id: string, as: string, text = 'still wrong') =>
  cli(app, `/api/review/threads/${id}/messages`, { as, text })

const authorReply = (app: App, id: string, text = 'fixed', more = false) =>
  cli(app, `/api/review/threads/${id}/messages`, {
    author: 'agent',
    text,
    ...(more ? { more: true } : {}),
  })

const reviewerPoll = async (app: App, as: string) => {
  const res = await app.request(`/api/reviewer/poll?as=${as}`, { headers: CLI })
  expect(res.status).toBe(200)
  return JSON.parse((await res.text()).trim()) as Record<string, unknown> & {
    threads?: Record<string, unknown>[]
    counts?: Record<string, number>
    needs_human?: { threadId: string }[]
  }
}

const authorPoll = async (app: App) => {
  const res = await app.request('/api/agent/poll', { headers: CLI })
  return JSON.parse((await res.text()).trim()) as {
    kind: string
    threadIds: string[]
    prompt: string
    next_step: string
  }
}

/** The page's stream, read until the first `reviewers` event that passes. */
async function reviewersEvent(
  app: App,
  passes: (detail: {
    seats: { name: string; state: string; activity?: { kind: string; text: string }[] }[]
    starting: string[]
  }) => boolean,
) {
  const res = await app.request('/api/events')
  const reader = res.body!.getReader()
  const decoder = new TextDecoder()
  let text = ''
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) throw new Error('the event stream ended')
      text += decoder.decode(value, { stream: true })
      for (const block of text.split('\n\n')) {
        if (!block.includes('event: reviewers')) continue
        const data = /^data: (.*)$/m.exec(block)?.[1]
        if (!data) continue
        const detail = JSON.parse(data) as Parameters<typeof passes>[0]
        if (passes(detail)) return detail
      }
    }
  } finally {
    await reader.cancel()
  }
}

/** One round: the reviewer agent's word, then the author agent's answer. */
async function round(app: App, id: string, as: string) {
  expect((await reviewerReply(app, id, as)).status).toBe(200)
  expect((await authorReply(app, id)).status).toBe(200)
}

const tick = () => new Promise((r) => setTimeout(r, 30))

describe('reviewer agents — a thread the author agent leaves unanswered', () => {
  it('is handed to the author again as a reminder, flagged, while its reviewer keeps waiting', async () => {
    const { app, review } = setup({ stallMs: 40 })
    const thread = await comment(app, 'codex')
    expect((await authorPoll(app)).threadIds).toEqual([thread.id])

    const waiting = reviewerPoll(app, 'codex')
    let settled = false
    void waiting.then(() => {
      settled = true
    })
    // The author listens on without a word: nothing closes, and once the
    // stall window passes the thread comes back, in full.
    const again = await authorPoll(app)
    expect(again.kind).toBe('reminder')
    expect(again.threadIds).toEqual([thread.id])
    expect(again.prompt).toMatch(/YOU NEVER ANSWERED THIS/)
    expect(again.prompt).toMatch(/HANDED TO YOU AGAIN.*reviewer agent codex is still waiting/)
    expect(again.next_step).toMatch(/shown to the reviewer as "no answer"/)
    await tick()
    // Never "no answer" on the page, and the reviewer has not been sent away.
    expect(review.get().threads[0]!.unanswered).toBeUndefined()
    expect(settled).toBe(false)

    await authorReply(app, thread.id)
    const payload = await waiting
    expect(payload.status).toBe('feedback')
    expect(payload.threads).toHaveLength(1)
  })

  it('is reminded when the author edited the line and never replied', async () => {
    const { app, review } = setup({ stallMs: 40 })
    const thread = await comment(app, 'codex')
    expect((await authorPoll(app)).threadIds).toEqual([thread.id])
    // The author changed the commented hunk: the thread reads addressed, with
    // nothing said to its reviewer.
    review.reconcile(new Set())
    expect(review.get().threads[0]!.state).toBe('addressed')

    const again = await authorPoll(app)
    expect(again.kind).toBe('reminder')
    expect(again.threadIds).toEqual([thread.id])
    await tick()
    expect(review.get().threads[0]!.unanswered).toBeUndefined()
  })

  it('gives up after the last reminder, and tells the reviewer why it is leaving', async () => {
    const { app, review } = setup({ stallMs: 25, reminderMax: 2, pollMaxMs: 200 })
    const thread = await comment(app, 'codex')
    expect((await authorPoll(app)).threadIds).toEqual([thread.id])
    for (let i = 0; i < 2; i++) expect((await authorPoll(app)).kind).toBe('reminder')
    // The next poll finds nothing: the thread is marked, not handed over.
    expect((await authorPoll(app)) as unknown as { status: string }).toMatchObject({
      status: 'timeout',
    })
    expect(review.get().threads[0]!.unanswered).toBe(true)

    const payload = await reviewerPoll(app, 'codex')
    expect(payload.status).toBe('idle')
    expect(payload.counts).toMatchObject({ unanswered: 1, waiting: 0 })
    expect(payload.next_step).toMatch(/more than once and never answered/)
    expect(payload.next_step).toMatch(/Do not repeat or summarize what you found/)
  })

  it('counts from the last answer: a new round gets its own reminders', async () => {
    const { app, review } = setup({ stallMs: 25, reminderMax: 2 })
    const thread = await comment(app, 'codex')
    await authorPoll(app)
    for (let i = 0; i < 2; i++) expect((await authorPoll(app)).kind).toBe('reminder')
    await authorReply(app, thread.id)
    await reviewerPoll(app, 'codex')
    await reviewerReply(app, thread.id, 'codex')
    expect((await authorPoll(app)).kind).toBe('threads')
    for (let i = 0; i < 2; i++) expect((await authorPoll(app)).kind).toBe('reminder')
    expect(review.get().threads[0]!.unanswered).toBeUndefined()
  })

  it("the human's own thread is reminded the same way, then reads no answer", async () => {
    const { app, review } = setup({ stallMs: 25, reminderMax: 1, pollMaxMs: 150 })
    const mine = (await (
      await page(app, '/api/review/threads', {
        anchor: { kind: 'changeset' },
        text: 'why?',
      })
    ).json()) as ReviewThread
    await page(app, `/api/review/threads/${mine.id}/send`)
    expect((await authorPoll(app)).threadIds).toEqual([mine.id])
    const again = await authorPoll(app)
    expect(again.kind).toBe('reminder')
    expect(again.threadIds).toEqual([mine.id])
    expect(review.get().threads[0]!.unanswered).toBeUndefined()
    expect((await authorPoll(app)) as unknown as { status: string }).toMatchObject({
      status: 'timeout',
    })
    expect(review.get().threads[0]!.unanswered).toBe(true)
  })

  it('a thread its reviewer closed is never reminded', async () => {
    const { app, queue } = setup({ stallMs: 25, pollMaxMs: 120 })
    const thread = await comment(app, 'codex')
    expect((await authorPoll(app)).threadIds).toEqual([thread.id])
    expect(
      (await cli(app, `/api/review/threads/${thread.id}/state`, { as: 'codex', state: 'resolved' }))
        .status,
    ).toBe(200)
    expect(queue.deliveredThreadIds()).toEqual([])
    expect((await authorPoll(app)) as unknown as { status: string }).toMatchObject({
      status: 'timeout',
    })
  })
})

describe('reviewer agents — joining', () => {
  it('seats the reviewer and tells it what is under review and what is already said', async () => {
    const { app, review } = setup()
    await page(app, '/api/review/threads', { anchor: { kind: 'changeset' }, text: 'why 42?' })
    const res = await cli(app, '/api/reviewer/join', { as: 'Codex' })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      as: string
      rejoined: boolean
      review: { read_with: string; files: { path: string; lines: string[] }[] }
      threads: { by: string; text: string }[]
      limits: { rounds_per_thread: number }
    }
    expect(body.as).toBe('codex')
    expect(body.rejoined).toBe(false)
    expect(body.review.read_with).toContain('diff --as codex')
    expect(body.review.files).toEqual([{ path: 'app.ts', status: 'modified', lines: ['1-2'] }])
    expect(body.threads).toEqual([
      expect.objectContaining({ by: 'human reviewer', text: 'why 42?' }),
    ])
    expect(body.limits).toEqual({ rounds_per_thread: REVIEWER_LIMITS.rounds })
    expect(review.get().reviewers?.map((r) => r.name)).toEqual(['codex'])

    const again = await cli(app, '/api/reviewer/join', { as: 'codex' })
    expect(((await again.json()) as { rejoined: boolean }).rejoined).toBe(true)
    expect(review.get().reviewers).toHaveLength(1)
  })

  it('refuses a name that is not one, or that the review already means', async () => {
    const { app, review } = setup()
    for (const as of ['', 'two words', 'x'.repeat(25), 'you', 'reviewer', 'agent', 'author']) {
      const res = await cli(app, '/api/reviewer/join', { as })
      expect(res.status, as).toBe(400)
    }
    expect(await error(await cli(app, '/api/reviewer/join', { as: 'github' }))).toMatch(/taken/)
    expect(review.get().reviewers).toBeUndefined()
  })

  it('is refused on a pull-request review, for every reviewer command', async () => {
    const { app } = setup({ pr: true })
    const join = await cli(app, '/api/reviewer/join', { as: 'codex' })
    expect(join.status).toBe(400)
    expect(await error(join)).toMatch(/branch and working-tree reviews only/)
    expect((await cli(app, '/api/review/threads', { as: 'codex', text: 'x' })).status).toBe(400)
    expect((await app.request('/api/reviewer/poll?as=codex', { headers: CLI })).status).toBe(400)
  })

  it('answers only the CLI: a page cannot speak as a reviewer agent', async () => {
    const { app, review } = setup()
    expect((await page(app, '/api/reviewer/join', { as: 'codex' })).status).toBe(403)
    expect((await page(app, '/api/review/threads', { as: 'codex', text: 'x' })).status).toBe(403)
    expect((await app.request('/api/reviewer/poll?as=codex')).status).toBe(403)
    expect(review.get().threads).toHaveLength(0)
  })

  it('keeps one live session per name', async () => {
    const { app } = setup()
    // This test's own process stands in for a live session.
    expect((await cli(app, '/api/reviewer/join', { as: 'codex' }, process.pid)).status).toBe(200)
    const taken = await cli(app, '/api/reviewer/join', { as: 'codex' }, process.ppid)
    expect(taken.status).toBe(409)
    expect(await error(taken)).toMatch(/pick a different name/)
    // The same session again, and another name, are both fine.
    expect((await cli(app, '/api/reviewer/join', { as: 'codex' }, process.pid)).status).toBe(200)
    expect((await cli(app, '/api/reviewer/join', { as: 'gemini' }, process.ppid)).status).toBe(200)
  })
})

describe('reviewer agents — comments reach the author agent', () => {
  it('opens a named thread on the line and hands it over with no Send', async () => {
    const { app, review, queue } = setup()
    const thread = await comment(app, 'codex', 'magic number')
    expect(thread.anchor).toMatchObject({ kind: 'hunk', path: 'app.ts', side: 'new', line: 2 })
    expect(thread.messages[0]).toMatchObject({
      author: 'reviewer',
      by: 'codex',
      text: 'magic number',
    })
    expect(thread.state).toBe('sent')
    expect(queue.queuedThreadIds()).toEqual([thread.id])
    // Commenting without a join still takes a seat.
    expect(review.get().reviewers?.map((r) => r.name)).toEqual(['codex'])

    const delivered = await authorPoll(app)
    expect(delivered.threadIds).toEqual([thread.id])
    expect(delivered.prompt).toContain('[from reviewer agent codex]')
    expect(delivered.prompt).toContain('- reviewer agent codex: magic number')
    expect(delivered.prompt).toContain('## Comments from a reviewer agent')
  })

  it('falls back from a line outside the diff to the file, and from an unknown file to the change', async () => {
    const { app } = setup()
    const onFile = await cli(app, '/api/review/threads', {
      as: 'codex',
      file: 'app.ts',
      line: 99,
      text: 'x',
    })
    expect(((await onFile.json()) as { anchored: string }).anchored).toBe('file')
    const onChange = await cli(app, '/api/review/threads', {
      as: 'codex',
      file: 'nope.ts',
      text: 'x',
    })
    expect(((await onChange.json()) as { anchored: string }).anchored).toBe('changeset')
  })

  it("leaves the human's own threads as they were: open until Send", async () => {
    const { app, queue } = setup()
    const res = await page(app, '/api/review/threads', {
      anchor: { kind: 'changeset' },
      text: 'mine',
    })
    const thread = (await res.json()) as ReviewThread
    expect(thread.state).toBe('open')
    expect(thread.messages[0]!.by).toBeUndefined()
    expect(queue.queuedThreadIds()).toEqual([])
  })

  it('survives a restart: a reviewer comment nobody collected is still owed to the author', async () => {
    const { app, review } = setup()
    const thread = await comment(app, 'codex')
    expect(undeliveredThreadIds(review.get().threads)).toEqual([thread.id])
  })

  it("the human's edit never rewrites a reviewer agent's message", async () => {
    const { app } = setup()
    const thread = await comment(app, 'codex')
    const res = await page(
      app,
      `/api/review/threads/${thread.id}/messages/${thread.messages[0]!.id}`,
      { text: 'rewritten' },
      'PATCH',
    )
    expect(res.status).toBe(400)
    expect(await error(res)).toMatch(/only your own messages/)
  })
})

describe('reviewer agents — replies', () => {
  it('a reviewer agent writes only in a thread it opened', async () => {
    const { app } = setup()
    const theirs = await comment(app, 'gemini')
    const mine = (await (
      await page(app, '/api/review/threads', { anchor: { kind: 'changeset' }, text: 'human' })
    ).json()) as ReviewThread
    await authorReply(app, theirs.id)
    for (const id of [theirs.id, mine.id]) {
      const res = await reviewerReply(app, id, 'codex')
      expect(res.status).toBe(403)
      expect(await error(res)).toMatch(/did not open this thread/)
    }
    expect((await reviewerReply(app, 'no-such-thread', 'codex')).status).toBe(404)
  })

  it('takes turns: one message, then the answer', async () => {
    const { app, queue } = setup()
    const thread = await comment(app, 'codex')
    const early = await reviewerReply(app, thread.id, 'codex')
    expect(early.status).toBe(409)
    expect(await error(early)).toMatch(/you spoke last/)
    await authorPoll(app)
    await authorReply(app, thread.id)
    const reply = await reviewerReply(app, thread.id, 'codex', 'not quite')
    expect(reply.status).toBe(200)
    const body = (await reply.json()) as { thread: ReviewThread; roundsLeft: number }
    expect(body.thread.messages.at(-1)).toMatchObject({ author: 'reviewer', by: 'codex' })
    expect(body.roundsLeft).toBe(REVIEWER_LIMITS.rounds - 2)
    // Straight back to the author agent.
    expect(queue.queuedThreadIds()).toEqual([thread.id])
  })

  it('never hands over a line the human is still holding', async () => {
    const { app, queue } = setup()
    const thread = await comment(app, 'codex')
    await authorPoll(app)
    await authorReply(app, thread.id)
    // The human writes in the thread and keeps it: a plain Reply, not Send.
    const held = await page(app, `/api/review/threads/${thread.id}/messages`, {
      text: 'my unsent thought',
      deliver: false,
    })
    expect(held.status).toBe(200)
    const reply = await reviewerReply(app, thread.id, 'codex', 'not quite')
    expect(reply.status).toBe(409)
    expect(await error(reply)).toMatch(/has not sent it yet/)
    expect(queue.queuedThreadIds()).toEqual([])
  })

  it('a thread the human reopened is theirs until they send it again', async () => {
    const { app } = setup({ pollMaxMs: 60 })
    const thread = await comment(app, 'codex')
    await authorPoll(app)
    await authorReply(app, thread.id)
    await reviewerPoll(app, 'codex')
    await cli(app, `/api/review/threads/${thread.id}/state`, { state: 'resolved', as: 'codex' })
    await page(app, `/api/review/threads/${thread.id}/state`, { state: 'open' })
    // Reopened with nothing said: not the reviewer's move, and not its to close.
    // It keeps waiting, since the human's words are on the way.
    const held = await reviewerPoll(app, 'codex')
    expect(held).toMatchObject({ status: 'timeout', still_waiting: 1 })
    const close = await cli(app, `/api/review/threads/${thread.id}/state`, {
      state: 'resolved',
      as: 'codex',
    })
    expect(close.status).toBe(409)
    expect(await error(close)).toMatch(/reopened/)
    // The human's unsent reply in it is not news for the reviewer either.
    await page(app, `/api/review/threads/${thread.id}/messages`, {
      text: 'why did you close this?',
      deliver: false,
    })
    expect(await reviewerPoll(app, 'codex')).toMatchObject({ status: 'timeout', still_waiting: 1 })
    const reply = await reviewerReply(app, thread.id, 'codex', 'because')
    expect(reply.status).toBe(409)
    // Sent: now it reaches the reviewer.
    await page(app, `/api/review/threads/${thread.id}/send`)
    const news = (await reviewerPoll(app, 'codex')) as { status: string; threads: unknown[] }
    expect(news.status).toBe('feedback')
    expect(news.threads).toHaveLength(1)
  })
})

describe('reviewer agents — the reviewer inbox', () => {
  it("returns the author agent's answer on a thread it opened, once", async () => {
    const { app, review } = setup()
    const thread = await comment(app, 'codex', 'magic number')
    const waiting = reviewerPoll(app, 'codex')
    await tick()
    await authorReply(app, thread.id, 'named it ANSWER')
    const payload = await waiting
    expect(payload.status).toBe('feedback')
    expect(payload.threads).toEqual([
      {
        threadId: thread.id,
        where: 'app.ts:2 (new side)',
        code_changed: false,
        rounds: 1,
        rounds_left: REVIEWER_LIMITS.rounds - 1,
        you_said: 'magic number',
        messages: [{ from: 'author agent', text: 'named it ANSWER' }],
      },
    ])
    expect(payload.next_step).toContain('resolve <threadId> --as codex')
    expect(review.get().threads[0]!.reviewerSeenAt).toBeDefined()
    // Handed over once: with the answer in hand and no reply, nothing waits.
    const next = await reviewerPoll(app, 'codex')
    expect(next.status).toBe('idle')
    expect(next.your_move).toEqual([{ threadId: thread.id, where: 'app.ts:2 (new side)' }])
  })

  it("carries the human's reply too, and says when the commented code changed", async () => {
    const { app, review, root, store } = setup()
    const thread = await comment(app, 'codex')
    writeFileSync(join(root, 'app.ts'), 'const a = 1\nconst b = ANSWER\n')
    await store.refresh()
    review.reconcile(new Set(store.get().files.flatMap((f) => f.hunks.map((h) => h.id))))
    await authorReply(app, thread.id, 'fixed')
    await page(app, `/api/review/threads/${thread.id}/messages`, { text: 'good catch, both' })
    const payload = await reviewerPoll(app, 'codex')
    const [entry] = payload.threads as Record<string, unknown>[]
    expect(entry!.code_changed).toBe(true)
    expect(entry!.messages).toEqual([
      { from: 'author agent', text: 'fixed' },
      { from: 'human reviewer', text: 'good catch, both' },
    ])
  })

  it('is one inbox per name: another reviewer never sees these answers', async () => {
    const { app } = setup()
    const thread = await comment(app, 'codex')
    await comment(app, 'gemini')
    await authorReply(app, thread.id)
    const gemini = reviewerPoll(app, 'gemini')
    await tick()
    let settled = false
    void gemini.then(() => {
      settled = true
    })
    await tick()
    expect(settled).toBe(false)
    expect((await reviewerPoll(app, 'codex')).status).toBe('feedback')
    // A newer poll under the same name releases the waiting one.
    const second = reviewerPoll(app, 'gemini')
    expect((await gemini).status).toBe('superseded')
    void second
  })

  it('waits for the real answer behind an interim one', async () => {
    const { app } = setup()
    const thread = await comment(app, 'codex')
    const waiting = reviewerPoll(app, 'codex')
    let settled = false
    void waiting.then(() => {
      settled = true
    })
    await authorReply(app, thread.id, 'looking into it', true)
    await tick()
    expect(settled).toBe(false)
    await authorReply(app, thread.id, 'fixed')
    const payload = await waiting
    expect((payload.threads as { messages: unknown[] }[])[0]!.messages).toHaveLength(2)
  })

  it('says at once when nothing of the reviewer waits on an answer', async () => {
    const { app } = setup()
    const none = await reviewerPoll(app, 'codex')
    expect(none.status).toBe('idle')
    expect(none.next_step).toMatch(/opened no thread/)
    const thread = await comment(app, 'codex')
    await authorReply(app, thread.id)
    await reviewerPoll(app, 'codex')
    await cli(app, `/api/review/threads/${thread.id}/state`, { state: 'resolved', as: 'codex' })
    const done = await reviewerPoll(app, 'codex')
    expect(done.status).toBe('idle')
    expect(done.counts).toMatchObject({ opened: 1, resolved: 1, waiting: 0 })
    expect(done.threads).toBeUndefined()
    expect(done.next_step).toMatch(/Stop polling/)
  })

  it('times out with nothing lost', async () => {
    const { app } = setup({ pollMaxMs: 40 })
    await comment(app, 'codex')
    const payload = await reviewerPoll(app, 'codex')
    expect(payload.status).toBe('timeout')
    expect(payload.still_waiting).toBe(1)
  })

  it("never touches the author agent's session: no claim, no batch, no presence", async () => {
    const { app, queue } = setup()
    const thread = await comment(app, 'codex')
    // The author agent holds the thread: delivered, batch open, on the clock.
    await (
      await app.request('/api/agent/poll', {
        headers: { ...CLI, 'x-diffo-session-pid': String(process.pid) },
      })
    ).text()
    const before = {
      presence: queue.presenceDetail(),
      delivered: queue.deliveredThreadIds(),
      batch: queue.currentBatch(),
      queued: queue.queuedThreadIds(),
    }
    expect(before.presence.state).toBe('working')
    expect(before.delivered).toEqual([thread.id])

    const waiting = app.request('/api/reviewer/poll?as=codex', {
      headers: { ...CLI, 'x-diffo-session-pid': '999999' },
    })
    await tick()
    expect({
      presence: queue.presenceDetail(),
      delivered: queue.deliveredThreadIds(),
      batch: queue.currentBatch(),
      queued: queue.queuedThreadIds(),
    }).toEqual(before)
    expect(queue.hasListener()).toBe(false)

    await authorReply(app, thread.id)
    await waiting
    // The reviewer's poll came and went; the author's batch is the author's.
    expect(queue.currentBatch()).toEqual({ threadIds: [thread.id], answered: [thread.id] })
    expect(queue.presenceDetail().reason).toBe('replied')
  })
})

describe('reviewer agents — asking the human to decide', () => {
  it("a reviewer agent's --ask stops its thread for the human, and the author agent is not handed it", async () => {
    const { app, review } = setup()
    const thread = await comment(app, 'codex')
    await authorReply(app, thread.id, 'kept it on purpose')
    await reviewerPoll(app, 'codex')
    const res = await cli(app, `/api/review/threads/${thread.id}/messages`, {
      as: 'codex',
      text: 'public or internal? I would keep it internal',
      ask: true,
    })
    expect(res.status).toBe(200)
    const asked = review.get().threads[0]!
    expect(asked.needsYou).toBe('reviewer')
    expect(((await res.json()) as { delivered: boolean }).delivered).toBe(false)
    expect(undeliveredThreadIds(review.get().threads)).toEqual([])
    // Neither agent writes in it until the human does.
    expect(await error(await authorReply(app, thread.id, 'ok'))).toMatch(
      /asked the human reviewer to decide/,
    )
    // Their word hands it back, and both agents hear it.
    await page(app, `/api/review/threads/${thread.id}/messages`, { text: 'keep it internal' })
    const back = review.get().threads[0]!
    expect(back.needsYou).toBeUndefined()
  })

  it("the author agent's --ask works only in a reviewer agent's thread", async () => {
    const { app, review } = setup()
    const thread = await comment(app, 'codex')
    const asked = await cli(app, `/api/review/threads/${thread.id}/messages`, {
      author: 'agent',
      text: 'this changes what users see; your call',
      ask: true,
    })
    expect(asked.status).toBe(200)
    expect(review.get().threads[0]).toMatchObject({ needsYou: 'author' })
    const mine = await page(app, '/api/review/threads', {
      anchor: { kind: 'changeset' },
      text: 'why?',
    })
    const own = ((await mine.json()) as ReviewThread).id
    const refused = await cli(app, `/api/review/threads/${own}/messages`, {
      author: 'agent',
      text: 'because',
      ask: true,
    })
    expect(refused.status).toBe(400)
    expect(await error(refused)).toMatch(/already reaches them/)
  })

  it("the author agent's --ask on a resolved thread is refused, and it stays closed", async () => {
    const { app, review } = setup()
    const thread = await comment(app, 'codex')
    await cli(app, `/api/review/threads/${thread.id}/state`, { state: 'resolved', as: 'codex' })
    const asked = await cli(app, `/api/review/threads/${thread.id}/messages`, {
      author: 'agent',
      text: 'your call',
      ask: true,
    })
    expect(asked.status).toBe(409)
    expect(await error(asked)).toMatch(/resolved/)
    expect(review.get().threads[0]).toMatchObject({ state: 'resolved' })
    expect(review.get().threads[0]!.needsYou).toBeUndefined()
  })

  it('a reviewer keeps listening while its thread waits on the human', async () => {
    const { app } = setup()
    const thread = await comment(app, 'codex')
    await authorReply(app, thread.id, 'kept it on purpose')
    await reviewerPoll(app, 'codex')
    await cli(app, `/api/review/threads/${thread.id}/messages`, {
      as: 'codex',
      text: 'your call',
      ask: true,
    })
    const waiting = reviewerPoll(app, 'codex')
    let settled = false
    void waiting.then(() => {
      settled = true
    })
    await tick()
    expect(settled).toBe(false)
    await page(app, `/api/review/threads/${thread.id}/messages`, { text: 'keep it' })
    const payload = await waiting
    expect(payload.status).toBe('feedback')
  })
})

describe('reviewer agents — after it finishes', () => {
  it('stays a short while once its threads are closed, so a message still reaches it', async () => {
    const { app } = setup({ graceMs: 60_000 })
    const thread = await comment(app, 'codex')
    await authorReply(app, thread.id)
    await reviewerPoll(app, 'codex')
    await cli(app, `/api/review/threads/${thread.id}/state`, { state: 'resolved', as: 'codex' })
    const lingering = reviewerPoll(app, 'codex')
    let settled = false
    void lingering.then(() => {
      settled = true
    })
    await tick()
    expect(settled).toBe(false)
    await page(app, '/api/reviewer/message', { name: 'codex', text: 'one more look at the cache?' })
    expect((await lingering).status).toBe('message')
  })

  it('then stops', async () => {
    const { app } = setup({ graceMs: 30 })
    const thread = await comment(app, 'codex')
    await authorReply(app, thread.id)
    await reviewerPoll(app, 'codex')
    await cli(app, `/api/review/threads/${thread.id}/state`, { state: 'resolved', as: 'codex' })
    const done = await reviewerPoll(app, 'codex')
    expect(done.status).toBe('idle')
    expect(done.next_step).toMatch(/Stop polling/)
  })
})

describe('reviewer agents — limits', () => {
  it(`stops a thread after ${REVIEWER_LIMITS.rounds} rounds and hands it to the human`, async () => {
    const { app, review, queue } = setup()
    const thread = await comment(app, 'codex')
    expect((await authorReply(app, thread.id)).status).toBe(200)
    for (let i = 1; i < REVIEWER_LIMITS.rounds; i++) {
      expect(review.get().threads[0]!.needsYou).toBeUndefined()
      await round(app, thread.id, 'codex')
    }
    expect(review.get().threads[0]!.needsYou).toBe('rounds')

    // A fourth round is refused, from either agent, and so is closing it.
    const fourth = await reviewerReply(app, thread.id, 'codex')
    expect(fourth.status).toBe(409)
    expect(await error(fourth)).toMatch(/reached 3 rounds.*waits for the human/)
    const author = await authorReply(app, thread.id, 'one more thing')
    expect(author.status).toBe(409)
    expect(await error(author)).toMatch(/waits for the human/)
    const close = await cli(app, `/api/review/threads/${thread.id}/state`, {
      state: 'resolved',
      as: 'codex',
    })
    expect(close.status).toBe(409)
    expect(review.get().threads[0]!.messages).toHaveLength(REVIEWER_LIMITS.rounds * 2)

    // Neither agent is handed it: the author owes nothing, the reviewer is
    // told once that it stopped and gets no words from it.
    expect(undeliveredThreadIds(review.get().threads)).toEqual([])
    const told = await reviewerPoll(app, 'codex')
    expect(told.threads).toEqual([])
    expect(told.needs_human).toEqual([
      {
        threadId: thread.id,
        where: 'app.ts:2 (new side)',
        // The answers it had not read ride along: the human's word, later,
        // must not skip them.
        messages: Array.from({ length: REVIEWER_LIMITS.rounds }, () => ({
          from: 'author agent',
          text: 'fixed',
        })),
      },
    ])
    // It keeps listening: the thread is the human's now, and their word comes back to it.
    const held = reviewerPoll(app, 'codex')
    let settled = false
    void held.then(() => {
      settled = true
    })
    await tick()
    expect(settled).toBe(false)

    // The human's reply takes it back: both agents may write again.
    queue.drop(thread.id)
    const human = await page(app, `/api/review/threads/${thread.id}/messages`, {
      text: 'add the jitter',
    })
    expect(human.status).toBe(200)
    expect(review.get().threads[0]!.needsYou).toBeUndefined()
    expect((await held).status).toBe('feedback')
    expect(queue.queuedThreadIds()).toEqual([thread.id])
    // What the reviewer has read is kept as a time: an answer in the very
    // millisecond it read through would count as read. Real agents are never
    // that quick; this test is, so it waits a beat.
    await tick()
    expect((await authorReply(app, thread.id, 'added')).status).toBe(200)
    const after = await reviewerPoll(app, 'codex')
    expect((after.threads as { rounds: number }[])[0]!.rounds).toBe(0)
    expect((await reviewerReply(app, thread.id, 'codex', 'thanks')).status).toBe(200)
  })

  it('an interim answer does not close the last round; the real one does', async () => {
    const { app, review } = setup()
    const thread = await comment(app, 'codex')
    await authorReply(app, thread.id)
    for (let i = 2; i < REVIEWER_LIMITS.rounds; i++) await round(app, thread.id, 'codex')
    await reviewerReply(app, thread.id, 'codex')
    await authorReply(app, thread.id, 'checking', true)
    expect(review.get().threads[0]!.needsYou).toBeUndefined()
    expect((await authorReply(app, thread.id, 'done')).status).toBe(200)
    expect(review.get().threads[0]!.needsYou).toBe('rounds')
  })

  it("the human's resolve settles a stopped thread", async () => {
    const { app, review } = setup()
    const thread = await comment(app, 'codex')
    await authorReply(app, thread.id)
    for (let i = 1; i < REVIEWER_LIMITS.rounds; i++) await round(app, thread.id, 'codex')
    const res = await page(app, `/api/review/threads/${thread.id}/state`, { state: 'resolved' })
    expect(res.status).toBe(200)
    const settled = review.get().threads[0]!
    expect(settled.state).toBe('resolved')
    expect(settled.needsYou).toBeUndefined()
    expect(settled.resolvedBy).toBeUndefined()
  })

  it('puts no cap on how many threads a reviewer opens: the brief carries that', async () => {
    const { app, review } = setup()
    for (let i = 0; i < 20; i++) await comment(app, 'codex', `finding ${i}`)
    expect(review.get().threads).toHaveLength(20)
  })
})

describe('reviewer agents — who may close a thread', () => {
  it('a reviewer agent closes a thread it opened, and the review says who', async () => {
    const { app, review } = setup()
    const thread = await comment(app, 'codex')
    await authorReply(app, thread.id)
    const res = await cli(app, `/api/review/threads/${thread.id}/state`, {
      state: 'resolved',
      as: 'codex',
    })
    expect(res.status).toBe(200)
    expect(review.get().threads[0]).toMatchObject({ state: 'resolved', resolvedBy: 'codex' })
  })

  it('closing before the author agent was handed it takes it out of the hand-over', async () => {
    const { app, queue } = setup()
    const thread = await comment(app, 'codex')
    expect(queue.queuedThreadIds()).toEqual([thread.id])
    await cli(app, `/api/review/threads/${thread.id}/state`, { state: 'resolved', as: 'codex' })
    expect(queue.queuedThreadIds()).toEqual([])
  })

  it("a reviewer agent cannot close someone else's thread, nor reopen any", async () => {
    const { app, review } = setup()
    const human = (await (
      await page(app, '/api/review/threads', { anchor: { kind: 'changeset' }, text: 'human' })
    ).json()) as ReviewThread
    const other = await comment(app, 'gemini')
    const agents = (await (
      await cli(app, '/api/review/threads', { author: 'agent', text: 'a guide' })
    ).json()) as ReviewThread
    for (const id of [human.id, other.id, agents.id]) {
      const res = await cli(app, `/api/review/threads/${id}/state`, {
        state: 'resolved',
        as: 'codex',
      })
      expect(res.status).toBe(403)
      expect(await error(res)).toMatch(/closes only threads it opened/)
    }
    expect(review.get().threads.every((t) => t.state !== 'resolved')).toBe(true)

    const mine = await comment(app, 'codex')
    await page(app, `/api/review/threads/${mine.id}/state`, { state: 'resolved' })
    const reopen = await cli(app, `/api/review/threads/${mine.id}/state`, {
      state: 'open',
      as: 'codex',
    })
    expect(reopen.status).toBe(403)
  })

  it('the author agent closes none', async () => {
    const { app, review } = setup()
    const thread = await comment(app, 'codex')
    const res = await cli(app, `/api/review/threads/${thread.id}/state`, {
      state: 'resolved',
      author: 'agent',
    })
    expect(res.status).toBe(403)
    expect(review.get().threads[0]!.state).toBe('sent')
  })

  it('the human closes and reopens any, and a reopen drops who closed it', async () => {
    const { app, review } = setup()
    const thread = await comment(app, 'codex')
    await cli(app, `/api/review/threads/${thread.id}/state`, { state: 'resolved', as: 'codex' })
    const reopened = await page(app, `/api/review/threads/${thread.id}/state`, { state: 'open' })
    expect(reopened.status).toBe(200)
    expect(review.get().threads[0]).toMatchObject({ state: 'open' })
    expect(review.get().threads[0]!.resolvedBy).toBeUndefined()
    const closed = await page(app, `/api/review/threads/${thread.id}/state`, { state: 'resolved' })
    expect(closed.status).toBe(200)
  })
})

describe('reviewer agents — roles', () => {
  const join = async (app: App, body: unknown) => {
    const res = await cli(app, '/api/reviewer/join', body)
    return { status: res.status, body: (await res.json()) as Record<string, unknown> }
  }

  it('a role is what it looks for: Diffo gives it a name of its own, and the join hands it the focus', async () => {
    const { app, review } = setup()
    const { status, body } = await join(app, { role: 'security' })
    expect(status).toBe(200)
    expect(body.as).toBe('juno')
    expect(body.role).toMatchObject({ id: 'security', name: 'Security' })
    expect((body.role as { focus: string }).focus).toMatch(/Untrusted input/)
    const brief = (body.how_to_review as string[]).join(' ')
    expect(brief).toMatch(/Comment only on what you can show/)
    expect(brief).toMatch(/Comment only on what matters/)
    expect(brief).toMatch(/There is no quota, in either direction/)
    expect(brief).toMatch(/Stay inside your role's focus/)
    expect(review.get().reviewers).toEqual([
      expect.objectContaining({ name: 'juno', role: 'security' }),
    ])
    // A second one in the same role is a second reviewer, not the first one's seat.
    const second = await join(app, { role: 'security' })
    expect(second.body).toMatchObject({ as: 'remy', rejoined: false })
  })

  it('never gives a name the review has had: not a deleted one, not one on a thread', async () => {
    const { app } = setup()
    await comment(app, 'iris')
    expect((await join(app, { role: 'tests' })).body.as).toBe('juno')
    await page(app, '/api/reviewer/seat?name=juno', undefined, 'DELETE')
    expect((await join(app, { role: 'tests' })).body.as).toBe('remy')
    expect((await join(app, { role: 'tests' })).body.as).toBe('otto')
  })

  it('a name and a role are separate, and a seat with neither a role nor a name is refused', async () => {
    const { app, review } = setup()
    const named = await join(app, { as: 'codex', role: 'tests' })
    expect(named.body.as).toBe('codex')
    expect((named.body.role as { id: string }).id).toBe('tests')
    // No role: the general one, the reviewer that reads for anything that bites.
    const plain = await join(app, { as: 'gemini' })
    expect((plain.body.role as { id: string }).id).toBe('general')
    expect(review.get().reviewers?.map((r) => [r.name, r.role])).toEqual([
      ['codex', 'tests'],
      ['gemini', undefined],
    ])
    // Joining again keeps the role; naming another changes it.
    expect(((await join(app, { as: 'codex' })).body.role as { id: string }).id).toBe('tests')
    expect(
      ((await join(app, { as: 'codex', role: 'security' })).body.role as { id: string }).id,
    ).toBe('security')
    expect((await join(app, {})).status).toBe(400)
  })

  it('refuses a role nobody has, naming the ones there are', async () => {
    const { app, review } = setup()
    const { status, body } = await join(app, { role: 'perf' })
    expect(status).toBe(400)
    expect(body.error).toBe(
      `no reviewer role "perf"; the roles are ${BUILT_IN_ROLES.map((r) => r.id).join(', ')}`,
    )
    expect(review.get().reviewers).toBeUndefined()
  })

  it('the quick picks are active, the rest wait in the library, and the human moves them', async () => {
    const { app, settings } = setup()
    const list = async () =>
      ((await (await app.request('/api/reviewer/roles')).json()) as { active: string[] }).active
    expect(await list()).toEqual([
      'general',
      'blast-radius',
      'ai-slop',
      'simplicity',
      'comments',
      'errors',
    ])
    const move = (id: string, active: unknown, from = page) =>
      from(app, `/api/reviewer/roles/${id}/active`, { active }, 'PUT')
    expect((await move('tests', true)).status).toBe(200)
    expect((await move('comments', false)).status).toBe(200)
    expect(await list()).toEqual([
      'general',
      'blast-radius',
      'ai-slop',
      'simplicity',
      'errors',
      'tests',
    ])
    expect(JSON.parse(settings.get('reviewerRolesActive')!)).toEqual({
      on: ['tests'],
      off: ['comments'],
    })
    expect((await move('nobody', true)).status).toBe(404)
    expect((await move('tests', 'yes')).status).toBe(400)
    const fromCli = await app.request('/api/reviewer/roles/tests/active', {
      method: 'PUT',
      headers: CLI,
      body: JSON.stringify({ active: false }),
    })
    expect(fromCli.status).toBe(403)
    // A role in the library can still be joined in: active is only the picker.
    expect((await cli(app, '/api/reviewer/join', { role: 'docs' })).status).toBe(200)
  })

  it("the reviewer's own roles are saved for every review and can be joined in", async () => {
    const { app, settings } = setup()
    const put = (roles: unknown) =>
      app.request('/api/reviewer/roles', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ roles }),
      })
    const perf = { id: 'perf', name: 'Performance', blurb: '', focus: 'A query inside a loop.' }
    expect((await put([{ ...perf, id: 'agent' }])).status).toBe(400)
    const saved = await put([perf])
    expect(saved.status).toBe(200)
    expect(((await saved.json()) as { roles: { id: string }[] }).roles.map((r) => r.id)).toEqual([
      ...BUILT_IN_ROLES.map((r) => r.id),
      'perf',
    ])
    expect(JSON.parse(settings.get('reviewerRoles')!)).toEqual([perf])
    const listed = (await (await app.request('/api/reviewer/roles')).json()) as {
      roles: { id: string; builtIn?: boolean }[]
      default: string
    }
    expect(listed.default).toBe('general')
    expect(listed.roles.at(-1)).toEqual(perf)
    const joined = await join(app, { role: 'perf' })
    expect(joined.body.role).toEqual({
      id: 'perf',
      name: 'Performance',
      focus: 'A query inside a loop.',
    })
    // A stored blob that no longer parses is no roles of their own, not a broken review.
    settings.set('reviewerRoles', '{not json')
    expect((await app.request('/api/reviewer/roles')).status).toBe(200)
  })
})

describe('reviewer agents — watching one work', () => {
  it('logs what a reviewer does, and its own word on what it is reading', async () => {
    const { app } = setup()
    await cli(app, '/api/reviewer/join', { role: 'security' })
    const said = await cli(app, '/api/reviewer/progress', {
      as: 'juno',
      text: '  reading the\n upload routes ',
    })
    expect(said.status).toBe(200)
    const thread = await comment(app, 'juno')
    await authorPoll(app)
    await authorReply(app, thread.id)
    await reviewerPoll(app, 'juno')
    await cli(app, `/api/review/threads/${thread.id}/state`, { state: 'resolved', as: 'juno' })
    await reviewerPoll(app, 'juno')
    const detail = await reviewersEvent(app, (d) => d.seats.some((s) => s.name === 'juno'))
    const log = detail.seats.find((s) => s.name === 'juno')!.activity!
    expect(log.map((e) => e.kind)).toEqual([
      'joined',
      'doing',
      'commented',
      'answered',
      'closed',
      'done',
    ])
    expect(log[0]!.text).toBe('joined as Security reviewer')
    expect(log[1]!.text).toBe('reading the upload routes')
    expect(log[2]!.text).toMatch(/^commented on /)
    expect(log.at(-1)!.text).toBe('finished its review')
  })

  it('a progress line is the CLI’s, needs words, and never reaches the author agent', async () => {
    const { app, queue } = setup()
    expect((await page(app, '/api/reviewer/progress', { as: 'codex', text: 'hi' })).status).toBe(
      403,
    )
    expect((await cli(app, '/api/reviewer/progress', { as: 'codex', text: '  ' })).status).toBe(400)
    expect(
      (await cli(app, '/api/reviewer/progress', { as: 'codex', text: 'reading' })).status,
    ).toBe(200)
    expect(queue.take()).toBeNull()
  })
})

describe('reviewer agents — the human writes to one', () => {
  it('wakes a held poll with the message, ahead of anything else', async () => {
    const { app } = setup()
    await comment(app, 'codex')
    const held = app.request('/api/reviewer/poll?as=codex', { headers: CLI })
    await tick()
    const sent = await page(app, '/api/reviewer/message', {
      name: 'codex',
      text: '  also look at the retry loop ',
    })
    expect(sent.status).toBe(200)
    expect(await sent.json()).toEqual({ ok: true, listening: true })
    const got = JSON.parse((await (await held).text()).trim()) as {
      status: string
      from: string
      messages: { text: string }[]
      still_waiting: number
      next_step: string
    }
    expect(got.status).toBe('message')
    expect(got.from).toBe('human reviewer')
    expect(got.messages.map((m) => m.text)).toEqual(['also look at the retry loop'])
    expect(got.still_waiting).toBe(1)
    expect(got.next_step).toMatch(/stop when they say stop/)
    // Handed once: its next word carries nothing.
    const next = await cli(app, '/api/reviewer/progress', { as: 'codex', text: 'reading' })
    expect(await next.json()).toEqual({ ok: true })
  })

  it('rides back on a progress line, and the log shows both sides', async () => {
    const { app } = setup()
    await cli(app, '/api/reviewer/join', { as: 'codex' })
    const sent = await page(app, '/api/reviewer/message', { name: 'codex', text: 'stop, thanks' })
    expect(await sent.json()).toEqual({ ok: true, listening: false })
    const said = await cli(app, '/api/reviewer/progress', { as: 'codex', text: 'reading' })
    const body = (await said.json()) as { messages: { text: string }[]; next_step: string }
    expect(body.messages.map((m) => m.text)).toEqual(['stop, thanks'])
    expect(body.next_step).toMatch(/do not poll again/)
    // Read once: the next line carries nothing.
    const again = await cli(app, '/api/reviewer/progress', { as: 'codex', text: 'stopping' })
    expect(await again.json()).toEqual({ ok: true })
    const detail = await reviewersEvent(app, (d) =>
      d.seats.some((s) => s.activity?.some((e) => e.kind === 'heard')),
    )
    const log = detail.seats.find((s) => s.name === 'codex')!.activity!
    expect(log.map((e) => e.kind)).toEqual(['joined', 'told', 'doing', 'heard', 'doing'])
    expect(log[1]!.text).toBe('stop, thanks')
  })

  it('the reviewer answers privately: into the conversation, never to the author agent', async () => {
    const { app, queue } = setup()
    await comment(app, 'codex')
    await authorPoll(app)
    await page(app, '/api/reviewer/message', { name: 'codex', text: 'why this one?' })
    const said = await cli(app, '/api/reviewer/chat', { as: 'codex', text: 'it can lose a write' })
    expect(said.status).toBe(200)
    expect(((await said.json()) as { next_step: string }).next_step).toMatch(/never sees it/)
    const detail = await reviewersEvent(app, (d) =>
      d.seats.some((s) => (s as { chat?: unknown[] }).chat?.length === 2),
    )
    const seat = detail.seats.find((s) => s.name === 'codex') as unknown as {
      chat: { from: string; text: string }[]
      activity: { kind: string }[]
    }
    expect(seat.chat.map((m) => [m.from, m.text])).toEqual([
      ['you', 'why this one?'],
      ['agent', 'it can lose a write'],
    ])
    expect(seat.activity.at(-1)!.kind).toBe('said')
    // Nothing of it is queued for the author agent.
    expect(queue.take()).toBeNull()
    // Only a reviewer answers this way, and only in words.
    expect((await page(app, '/api/reviewer/chat', { as: 'codex', text: 'hi' })).status).toBe(403)
    expect((await cli(app, '/api/reviewer/chat', { as: 'codex', text: '  ' })).status).toBe(400)
  })

  it('is the human’s to do, to a reviewer in this review, in words', async () => {
    const { app } = setup()
    await cli(app, '/api/reviewer/join', { as: 'codex' })
    const byAgent = await cli(app, '/api/reviewer/message', { name: 'codex', text: 'hi' })
    expect(byAgent.status).toBe(403)
    expect((await page(app, '/api/reviewer/message', { name: 'codex', text: ' ' })).status).toBe(
      400,
    )
    expect(
      (await page(app, '/api/reviewer/message', { name: 'codex', text: 'x'.repeat(2001) })).status,
    ).toBe(400)
    expect((await page(app, '/api/reviewer/message', { name: 'nobody', text: 'hi' })).status).toBe(
      404,
    )
  })
})

describe('reviewer agents — what outlives a restart', () => {
  it('keeps each reviewer’s log, its unread messages, and who was removed', async () => {
    const first = setup()
    await cli(first.app, '/api/reviewer/join', { as: 'codex' })
    await cli(first.app, '/api/reviewer/join', { as: 'gemini' })
    await cli(first.app, '/api/reviewer/progress', { as: 'codex', text: 'reading app.ts' })
    await page(first.app, '/api/reviewer/message', { name: 'codex', text: 'look at the loop' })
    await cli(first.app, '/api/reviewer/chat', { as: 'codex', text: 'on it' })
    await page(first.app, '/api/reviewer/seat?name=gemini', undefined, 'DELETE')
    // The same review, served again: a new app over the same store.
    const again = createApp(
      { root: first.root, spec: { kind: 'working-tree' }, clientDir: '/nope', pollHeartbeatMs: 10 },
      first.store,
      first.review,
      new DeliveryQueue(),
    )
    const detail = await reviewersEvent(again, (d) => d.seats.some((s) => s.name === 'codex'))
    const log = detail.seats.find((s) => s.name === 'codex')!.activity!
    expect(log.map((e) => e.kind)).toEqual(['joined', 'doing', 'told', 'said'])
    const chat = (detail.seats.find((s) => s.name === 'codex') as unknown as { chat: unknown[] })
      .chat
    expect(chat).toHaveLength(2)
    const said = await cli(again, '/api/reviewer/progress', { as: 'codex', text: 'back' })
    expect(((await said.json()) as { messages: { text: string }[] }).messages[0]!.text).toBe(
      'look at the loop',
    )
    const refused = await cli(again, '/api/review/threads', { as: 'gemini', text: 'hi' })
    expect(refused.status).toBe(403)
  })

  it('each branch keeps its own: a checkout swaps them with the review', async () => {
    const { app, review } = setup()
    const home = review.scope.branch
    const chatOf = async (name: string) => {
      const detail = await reviewersEvent(app, () => true)
      const seat = detail.seats.find((s) => s.name === name) as unknown as
        | { chat: unknown[] }
        | undefined
      return seat?.chat ?? []
    }
    await cli(app, '/api/reviewer/join', { as: 'codex' })
    await page(app, '/api/reviewer/message', { name: 'codex', text: 'on the first branch' })
    review.rescope('feature-b')
    await cli(app, '/api/reviewer/join', { as: 'codex' })
    expect(await chatOf('codex')).toEqual([])
    // Nothing of the first branch is waiting for the second's reviewer.
    const said = await cli(app, '/api/reviewer/progress', { as: 'codex', text: 'reading' })
    expect(await said.json()).toEqual({ ok: true })
    review.rescope(home)
    expect(await chatOf('codex')).toHaveLength(1)
  })

  it("a new round never hands a running reviewer's name to a new one", async () => {
    const { app } = setup()
    const first = (await (await cli(app, '/api/reviewer/join', { role: 'general' })).json()) as {
      as: string
    }
    await page(app, '/api/review/threads', undefined, 'DELETE')
    const second = (await (await cli(app, '/api/reviewer/join', { role: 'general' })).json()) as {
      as: string
    }
    expect(second.as).not.toBe(first.as)
  })

  it('a poll held across a checkout is released, never answered from the other branch', async () => {
    const { app, review } = setup()
    const thread = await comment(app, 'codex')
    const home = review.scope.branch
    const waiting = reviewerPoll(app, 'codex')
    await tick()
    review.rescope('feature-b')
    const payload = await waiting
    expect(payload.status).toBe('moved')
    expect(payload.message).toContain(`your threads on "${home}"`)
    review.rescope(home)
    await authorReply(app, thread.id, 'fixed')
    expect((await reviewerPoll(app, 'codex')).status).toBe('feedback')
  })

  it('a new round forgets them, with the seats', async () => {
    const { app, review } = setup()
    await cli(app, '/api/reviewer/join', { as: 'codex' })
    await cli(app, '/api/reviewer/progress', { as: 'codex', text: 'reading' })
    await page(app, '/api/review/threads', undefined, 'DELETE')
    expect(JSON.parse(review.loadReviewerHub()!)).toEqual({
      logs: {},
      notes: {},
      chats: {},
      removed: [],
      stopped: [],
      coverage: {},
    })
  })

  it('a removal outlives a new round: only a join brings it back', async () => {
    const { app } = setup()
    await comment(app, 'codex')
    await page(app, '/api/reviewer/seat?name=codex', undefined, 'DELETE')
    await page(app, '/api/review/threads', undefined, 'DELETE')
    expect((await cli(app, '/api/review/threads', { as: 'codex', text: 'back' })).status).toBe(403)
  })
})

describe('reviewer agents — stopping one', () => {
  it('ends its session and keeps it: its seat, log and conversation stay', async () => {
    const { app, review } = setup()
    const thread = await comment(app, 'codex')
    await page(app, '/api/reviewer/message', { name: 'codex', text: 'look at the cache' })
    await reviewerPoll(app, 'codex')
    // Held waiting on an answer: the stop releases it, and says why.
    const held = reviewerPoll(app, 'codex')
    await tick()
    expect((await page(app, '/api/reviewer/stop?name=codex')).status).toBe(200)
    expect(await held).toMatchObject({ status: 'stopped' })
    const again = await app.request('/api/reviewer/poll?as=codex', { headers: CLI })
    expect(again.status).toBe(403)
    const refused = await reviewerReply(app, thread.id, 'codex')
    expect(refused.status).toBe(403)
    expect(await error(refused)).toMatch(/stopped reviewer agent "codex"/)
    expect(review.get().reviewers?.map((r) => r.name)).toEqual(['codex'])
    const detail = await reviewersEvent(app, (d) => d.seats.some((x) => x.state === 'stopped'))
    const seat = detail.seats[0] as { activity?: { kind: string }[]; chat?: unknown[] }
    expect(seat.activity?.at(-1)?.kind).toBe('stopped')
    expect(seat.chat).toHaveLength(1)
  })

  it('is the page’s, and a join under its name brings it back', async () => {
    const { app } = setup()
    await comment(app, 'codex')
    expect((await cli(app, '/api/reviewer/stop?name=codex')).status).toBe(403)
    expect((await page(app, '/api/reviewer/stop?name=nobody')).status).toBe(404)
    await page(app, '/api/reviewer/stop?name=codex')
    expect((await cli(app, '/api/reviewer/join', { as: 'codex' })).status).toBe(200)
    expect((await cli(app, '/api/review/threads', { as: 'codex', text: 'back' })).status).toBe(200)
  })
})

describe('reviewer agents — removing one', () => {
  it('the page deletes them all at once; their threads stay, and the CLI may not', async () => {
    const { app, review } = setup()
    const thread = await comment(app, 'codex')
    await cli(app, '/api/reviewer/join', { as: 'gemini' })
    expect(
      (await app.request('/api/reviewer/seats', { method: 'DELETE', headers: CLI })).status,
    ).toBe(403)
    const res = await page(app, '/api/reviewer/seats', undefined, 'DELETE')
    expect(await res.json()).toEqual({ removed: 2 })
    expect(review.get().reviewers ?? []).toEqual([])
    expect(review.get().threads.map((t) => t.id)).toEqual([thread.id])
    // Their next command is refused, as after a Delete.
    expect((await cli(app, '/api/reviewer/progress', { as: 'codex', text: 'x' })).status).toBe(403)
  })

  it('takes it out of the review, releases its poll, and keeps its threads', async () => {
    const { app, review } = setup()
    const thread = await comment(app, 'codex')
    await comment(app, 'gemini')
    // Waiting on an answer when the human removes it.
    const held = app.request('/api/reviewer/poll?as=codex', { headers: CLI })
    await tick()
    const removed = await page(app, '/api/reviewer/seat?name=codex', undefined, 'DELETE')
    expect(removed.status).toBe(200)
    expect(await removed.json()).toEqual({ removed: true })
    const told = JSON.parse((await (await held).text()).trim()) as {
      status: string
      message: string
    }
    expect(told.status).toBe('removed')
    expect(told.message).toMatch(/tell the user you were removed/)
    expect(review.get().reviewers?.map((r) => r.name)).toEqual(['gemini'])
    expect(review.get().threads.some((t) => t.id === thread.id)).toBe(true)
    // Whatever it runs next is refused, so a sub-agent still going cannot walk back in.
    const again = await cli(app, '/api/review/threads', { as: 'codex', text: 'one more' })
    expect(again.status).toBe(403)
    expect(await error(again)).toMatch(/removed reviewer agent "codex"/)
    expect((await app.request('/api/reviewer/poll?as=codex', { headers: CLI })).status).toBe(403)
    expect(review.get().reviewers?.map((r) => r.name)).toEqual(['gemini'])
    // A join is the way back in: the human brought it in again.
    expect((await cli(app, '/api/reviewer/join', { as: 'codex' })).status).toBe(200)
    expect(review.get().reviewers?.map((r) => r.name)).toEqual(['gemini', 'codex'])
  })

  it('is the human’s to do: no agent removes a reviewer, and a stranger is no removal', async () => {
    const { app, review } = setup()
    await comment(app, 'codex')
    const byAgent = await app.request('/api/reviewer/seat?name=codex', {
      method: 'DELETE',
      headers: CLI,
    })
    expect(byAgent.status).toBe(403)
    expect(review.get().reviewers?.map((r) => r.name)).toEqual(['codex'])
    const nobody = await page(app, '/api/reviewer/seat?name=nobody', undefined, 'DELETE')
    expect(await nobody.json()).toEqual({ removed: false })
  })

  it('each reviewer keeps the colour it was given, and a freed one is used again', async () => {
    const { app, review } = setup()
    for (const name of ['a', 'b', 'c']) await cli(app, '/api/reviewer/join', { as: name })
    const hues = () =>
      Object.fromEntries((review.get().reviewers ?? []).map((r) => [r.name, r.hue]))
    expect(hues()).toEqual({ a: 1, b: 2, c: 3 })
    await page(app, '/api/reviewer/seat?name=a', undefined, 'DELETE')
    expect(hues()).toEqual({ b: 2, c: 3 })
    await cli(app, '/api/reviewer/join', { as: 'd' })
    expect(hues()).toEqual({ b: 2, c: 3, d: 1 })
  })
})

describe('reviewer agents — bringing one in', () => {
  it('several roles in one ask start one reviewer each, or none when one is unknown', async () => {
    const { app } = setup()
    for (const roles of [[], ['security', 7], undefined]) {
      expect((await page(app, '/api/reviewer/request', { roles })).status).toBe(400)
    }
    const bad = await page(app, '/api/reviewer/request', { roles: ['security', 'nope'] })
    expect(bad.status).toBe(400)
    const none = await reviewersEvent(app, () => true)
    expect(none.starting).toEqual([])
    const asked = await page(app, '/api/reviewer/request', {
      roles: ['security', 'tests', 'security'],
    })
    expect(asked.status).toBe(200)
    expect(((await asked.json()) as { roles: string[] }).roles).toEqual(['security', 'tests'])
    const payload = await authorPoll(app)
    expect(payload.kind).toBe('reviewers')
    expect(payload.prompt).toContain('asked you to bring 2 reviewer agents into this review')
    const waiting = await reviewersEvent(app, () => true)
    expect(waiting.starting).toEqual(['security', 'tests'])
  })

  it('the invite is one line that carries the command and the role', async () => {
    const { app, root } = setup()
    const res = await app.request('/api/reviewer/invite?role=security')
    expect(res.status).toBe(200)
    const { ask, role } = (await res.json()) as { ask: string; role: string }
    expect(role).toBe('security')
    expect(ask).toContain('as its Security reviewer')
    expect(ask).toContain('join --role security`')
    expect(ask).toContain(root.split('/').at(-1)!)
    expect(ask).toMatch(/you never edit the code/)
    // No role asked: the general reviewer.
    const plain = (await (await app.request('/api/reviewer/invite')).json()) as { ask: string }
    expect(plain.ask).toContain('join --role general`')
    expect((await app.request('/api/reviewer/invite?role=nope')).status).toBe(400)
  })

  it('asking the agent to start one rides its poll, with the line to hand over unchanged', async () => {
    const { app, queue } = setup()
    const asked = await page(app, '/api/reviewer/request', { roles: ['security'] })
    expect(asked.status).toBe(200)
    // Twice before a poll is one ask.
    await page(app, '/api/reviewer/request', { roles: ['security'] })
    await page(app, '/api/reviewer/request', { roles: ['tests'] })
    const { ask } = (await (await app.request('/api/reviewer/invite?role=security')).json()) as {
      ask: string
    }
    const payload = await authorPoll(app)
    expect(payload.kind).toBe('reviewers')
    expect(payload.threadIds).toEqual([])
    expect(payload.prompt).toContain('asked you to bring 2 reviewer agents into this review')
    expect(payload.prompt).toContain(ask)
    expect(payload.prompt).toContain('join --role tests`')
    expect(payload.prompt).toMatch(/Run it in the background/)
    expect(payload.prompt).toMatch(/Hand it the line unchanged/)
    expect(payload.prompt).toMatch(/a reviewer you brief is not a second opinion/)
    expect(payload.prompt).toMatch(/Do not review your own change in its place/)
    expect(payload.next_step).toMatch(/Start each reviewer agent/)
    // Delivered once; the agent owes no reply for it and is back between polls.
    expect(queue.take()).toBeNull()
    expect(queue.presenceDetail()).toMatchObject({ state: 'working', reason: 'replied' })
  })

  it("waits behind the reviewer's threads, and ahead of a layers request", async () => {
    const { app, queue } = setup()
    queue.enqueueLayers()
    await page(app, '/api/reviewer/request', { roles: ['security'] })
    expect(queue.take()?.kind).toBe('reviewers')
    const mine = (await (
      await page(app, '/api/review/threads', { anchor: { kind: 'changeset' }, text: 'x' })
    ).json()) as ReviewThread
    await page(app, `/api/review/threads/${mine.id}/send`)
    expect(queue.take()?.kind).toBe('threads')
  })

  it('shows the reviewer as on its way until one joins in that role', async () => {
    const { app } = setup()
    await page(app, '/api/reviewer/request', { roles: ['security'] })
    const waiting = await reviewersEvent(app, (d) => d.starting.length > 0)
    expect(waiting).toEqual({ seats: [], starting: ['security'] })
    // Another role joining leaves it waiting; its own role ends the wait.
    await cli(app, '/api/reviewer/join', { role: 'tests' })
    expect((await reviewersEvent(app, (d) => d.seats.length === 1)).starting).toEqual(['security'])
    await cli(app, '/api/reviewer/join', { role: 'security' })
    const here = await reviewersEvent(app, (d) => d.seats.length === 2)
    expect(here.starting).toEqual([])
    expect(here.seats.map((s) => [s.name, s.state])).toEqual([
      ['juno', 'active'],
      ['remy', 'active'],
    ])
  })

  it('stops saying it is on its way when nobody joins', async () => {
    const { app } = setup({ reviewerStartMs: 30 })
    await page(app, '/api/reviewer/request', { roles: ['security'] })
    expect((await reviewersEvent(app, () => true)).starting).toEqual(['security'])
    await new Promise((r) => setTimeout(r, 60))
    expect((await reviewersEvent(app, () => true)).starting).toEqual([])
  })

  it('has no place in a pull-request review', async () => {
    const { app, queue } = setup({ pr: true })
    expect((await page(app, '/api/reviewer/request', { roles: ['security'] })).status).toBe(400)
    expect((await app.request('/api/reviewer/invite?role=security')).status).toBe(400)
    expect(queue.take()).toBeNull()
  })
})

describe('reviewer agents — sets', () => {
  const offer = async (app: App) =>
    (await (await app.request('/api/reviewer/roles')).json()) as {
      sets: { id: string; name: string; roles: string[]; builtIn?: true }[]
      defaultSet: string
    }
  const put = (app: App, path: string, body: unknown) => page(app, path, body, 'PUT')

  it('offers the built-in sets with the roles, and opens on the agent’s pick by default', async () => {
    const { app } = setup()
    const { sets, defaultSet } = await offer(app)
    expect(sets.map((s) => s.id)).toEqual([
      'agent-written',
      'refactor',
      'new-api',
      'ui-change',
      'data',
      'release',
    ])
    expect(sets.every((s) => s.builtIn)).toBe(true)
    expect(defaultSet).toBe('agent')
  })

  it('keeps sets of the human’s own, named by the server, and a default among them', async () => {
    const { app } = setup()
    const saved = await put(app, '/api/reviewer/sets', {
      sets: [{ name: 'Auth changes', when: 'Login.', roles: ['security', 'errors'] }],
    })
    expect(saved.status).toBe(200)
    expect((await offer(app)).sets.at(-1)).toEqual({
      id: 'auth-changes',
      name: 'Auth changes',
      when: 'Login.',
      roles: ['security', 'errors'],
    })
    expect((await put(app, '/api/reviewer/sets/default', { id: 'auth-changes' })).status).toBe(200)
    expect((await offer(app)).defaultSet).toBe('auth-changes')
    expect((await put(app, '/api/reviewer/sets/default', { id: 'nope' })).status).toBe(400)
    // Deleting the default set goes back to the agent's pick.
    await put(app, '/api/reviewer/sets', { sets: [] })
    expect((await offer(app)).defaultSet).toBe('agent')
  })

  it('refuses a set that names no real agent, and anything from the CLI', async () => {
    const { app } = setup()
    const bad = await put(app, '/api/reviewer/sets', { sets: [{ name: 'X', roles: ['nope'] }] })
    expect(bad.status).toBe(400)
    expect(await error(bad)).toMatch(/"nope", which is not a reviewer agent/)
    const fromCli = (path: string, body: unknown) =>
      app.request(path, { method: 'PUT', headers: CLI, body: JSON.stringify(body) })
    expect((await fromCli('/api/reviewer/sets', { sets: [] })).status).toBe(403)
    expect((await fromCli('/api/reviewer/sets/default', { id: 'refactor' })).status).toBe(403)
  })

  it('a set outlives a role of the human’s it named', async () => {
    const { app } = setup()
    await put(app, '/api/reviewer/roles', {
      roles: [{ id: 'perf', name: 'Performance', blurb: 'slow', focus: 'Loops.' }],
    })
    await put(app, '/api/reviewer/sets', {
      sets: [{ name: 'Hot path', roles: ['perf', 'general'] }],
    })
    await put(app, '/api/reviewer/roles', { roles: [] })
    expect((await offer(app)).sets.at(-1)).toMatchObject({ id: 'hot-path', roles: ['general'] })
  })

  it('the author agent says which set fits, and starts nobody', async () => {
    const { app, review, queue } = setup()
    const res = await cli(app, '/api/reviewer/pick', {
      set: 'refactor',
      reason: '  moves the retry logic  ',
    })
    expect(await res.json()).toEqual({
      picked: true,
      set: 'refactor',
      roles: ['blast-radius', 'simplicity', 'tests'],
    })
    expect(review.get().reviewerSet).toEqual({ set: 'refactor', reason: 'moves the retry logic' })
    // Not an offer, and nothing started.
    expect(review.get().reviewerSuggested).toBeUndefined()
    expect(queue.take()).toBeNull()
    expect(review.get().reviewers).toBeUndefined()
  })

  it('a pick is the CLI’s to make, for a set there is, off a pull request', async () => {
    const { app, review } = setup()
    expect((await page(app, '/api/reviewer/pick', { set: 'refactor' })).status).toBe(403)
    const unknown = await cli(app, '/api/reviewer/pick', { set: 'nope' })
    expect(unknown.status).toBe(400)
    expect(await error(unknown)).toMatch(/the sets are agent-written, refactor, /)
    expect(review.get().reviewerSet).toBeUndefined()
    const onPr = setup({ pr: true })
    expect((await cli(onPr.app, '/api/reviewer/pick', { set: 'refactor' })).status).toBe(400)
  })
})

describe('reviewer agents — the author agent may suggest one', () => {
  const suggest = (app: App, body: unknown) => cli(app, '/api/reviewer/suggest', body)

  it('records the role and the reason as an offer, and starts nothing', async () => {
    const { app, review, queue } = setup()
    const res = await suggest(app, { role: 'security', reason: '  builds a shell command  ' })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ suggested: true, role: 'security' })
    expect(review.get().reviewerSuggested).toEqual({
      role: 'security',
      reason: 'builds a shell command',
    })
    expect(queue.take()).toBeNull()
    expect(review.get().reviewers).toBeUndefined()
    // No role: the general reviewer. A newer suggestion replaces the last.
    await suggest(app, {})
    expect(review.get().reviewerSuggested).toEqual({ role: 'general' })
  })

  it('is the CLI’s to make, for a role there is, off a pull request', async () => {
    const { app, review } = setup()
    expect((await page(app, '/api/reviewer/suggest', { role: 'security' })).status).toBe(403)
    const unknown = await suggest(app, { role: 'perf' })
    expect(unknown.status).toBe(400)
    expect(await error(unknown)).toMatch(/the roles are general, blast-radius, ai-slop, /)
    expect(review.get().reviewerSuggested).toBeUndefined()
    const onPr = setup({ pr: true })
    expect((await suggest(onPr.app, { role: 'security' })).status).toBe(400)
  })

  it('says so when a reviewer in that role is already here', async () => {
    const { app, review } = setup()
    await cli(app, '/api/reviewer/join', { role: 'security' })
    const res = await suggest(app, { role: 'security' })
    expect(await res.json()).toEqual({ suggested: false, role: 'security' })
    expect(review.get().reviewerSuggested).toBeUndefined()
  })

  it('goes when the human acts on it, passes, or a reviewer joins in that role', async () => {
    const { app, review } = setup()
    const standing = () => review.get().reviewerSuggested
    await suggest(app, { role: 'security' })
    // Another role started or joined leaves the suggestion standing.
    await page(app, '/api/reviewer/request', { roles: ['tests'] })
    await cli(app, '/api/reviewer/join', { role: 'tests' })
    expect(standing()).toEqual({ role: 'security' })
    await page(app, '/api/reviewer/request', { roles: ['security'] })
    expect(standing()).toBeUndefined()

    await suggest(app, { role: 'simplicity' })
    const passed = await app.request('/api/reviewer/suggestion', { method: 'DELETE' })
    expect(await passed.json()).toEqual({ cleared: true })
    expect(standing()).toBeUndefined()

    await suggest(app, { role: 'simplicity' })
    await cli(app, '/api/reviewer/join', { role: 'simplicity' })
    expect(standing()).toBeUndefined()
  })
})

describe('reviewer agents — coverage', () => {
  const join = async (app: App) =>
    ((await (await cli(app, '/api/reviewer/join', { role: 'general' })).json()) as { as: string })
      .as

  it('serves the diff the human reads, and counts the files fetched', async () => {
    const { app, review } = setup()
    const name = await join(app)
    const res = await cli(app, '/api/reviewer/diff', { as: name, files: ['app.ts', 'gone.ts'] })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { patch: string; files: number; missing?: string[] }
    expect(body.files).toBe(1)
    expect(body.missing).toEqual(['gone.ts'])
    expect(body.patch).toContain('+++ b/app.ts')
    expect(body.patch).toContain('-const b = 2')
    expect(body.patch).toContain('+const b = 42')
    expect(parseHubSnapshot(review.loadReviewerHub()).coverage[name]).toEqual({
      fetched: ['app.ts'],
    })
  })

  it('takes its own word on what it skipped, and refuses a file not in the change', async () => {
    const { app, review } = setup()
    const name = await join(app)
    const bad = await cli(app, '/api/reviewer/coverage', { as: name, skipped: ['nope.ts'] })
    expect(bad.status).toBe(400)
    const ok = await cli(app, '/api/reviewer/coverage', { as: name, skipped: ['app.ts'] })
    expect(await ok.json()).toEqual({ ok: true, read: 0, of: 1 })
    expect(parseHubSnapshot(review.loadReviewerHub()).coverage[name]?.reported?.skipped).toEqual([
      'app.ts',
    ])
  })

  it('its account, with nothing of its own open, is the end of its review', async () => {
    const { app, review } = setup()
    const name = await join(app)
    await cli(app, '/api/reviewer/coverage', { as: name, skipped: [] })
    const log = parseHubSnapshot(review.loadReviewerHub()).logs[name]!
    expect(log.at(-1)).toMatchObject({ kind: 'done', text: 'finished its review' })
    // Said twice, it finishes once.
    await cli(app, '/api/reviewer/coverage', { as: name, skipped: [] })
    expect(
      parseHubSnapshot(review.loadReviewerHub()).logs[name]!.filter((e) => e.kind === 'done'),
    ).toHaveLength(1)
  })

  it('an account given while a thread of its own still waits is not a finish', async () => {
    const { app, review } = setup()
    const name = await join(app)
    await comment(app, name)
    await cli(app, '/api/reviewer/coverage', { as: name, skipped: [] })
    const log = parseHubSnapshot(review.loadReviewerHub()).logs[name]!
    expect(log.some((e) => e.kind === 'done')).toBe(false)
  })

  it('the join points the reviewer at diffo diff', async () => {
    const { app } = setup()
    const res = await cli(app, '/api/reviewer/join', { role: 'general' })
    const body = (await res.json()) as { as: string; review: { read_with: string } }
    expect(body.review.read_with).toContain(`diff --as ${body.as}`)
  })

  it('only the CLI reads through a reviewer name', async () => {
    const { app } = setup()
    const name = await join(app)
    const res = await page(app, '/api/reviewer/diff', { as: name })
    expect(res.status).toBe(403)
  })
})

describe('reviewer agents — what it is handed is never skipped', () => {
  it("the author agent's --ask reaches it with the question, then the human's answer", async () => {
    const { app } = setup()
    const thread = await comment(app, 'codex', 'drop the cache?')
    await tick()
    await cli(app, `/api/review/threads/${thread.id}/messages`, {
      author: 'agent',
      text: 'keeping it is a product call',
      ask: true,
    })
    const told = await reviewerPoll(app, 'codex')
    expect(told.needs_human).toEqual([
      {
        threadId: thread.id,
        where: 'app.ts:2 (new side)',
        messages: [{ from: 'author agent', text: 'keeping it is a product call' }],
      },
    ])
    await tick()
    await page(app, `/api/review/threads/${thread.id}/messages`, { text: 'keep it' })
    const answer = await reviewerPoll(app, 'codex')
    expect((answer.threads as { messages: { text: string }[] }[])[0]!.messages).toEqual([
      { from: 'human reviewer', text: 'keep it' },
    ])
  })

  it("the human's edit of words it was handed reaches it again", async () => {
    const { app, review } = setup()
    const thread = await comment(app, 'codex', 'magic number')
    await tick()
    const said = await page(app, `/api/review/threads/${thread.id}/messages`, { text: 'use X' })
    const messageId = ((await said.json()) as { thread: ReviewThread }).thread.messages.at(-1)!.id
    const first = await reviewerPoll(app, 'codex')
    expect((first.threads as { messages: { text: string }[] }[])[0]!.messages).toEqual([
      { from: 'human reviewer', text: 'use X' },
    ])
    await page(
      app,
      `/api/review/threads/${thread.id}/messages/${messageId}`,
      { text: 'use Y' },
      'PATCH',
    )
    expect(review.get().threads[0]!.reviewerSeenAt).toBe(thread.messages[0]!.at)
    const again = await reviewerPoll(app, 'codex')
    expect((again.threads as { messages: { text: string }[] }[])[0]!.messages).toEqual([
      { from: 'human reviewer', text: 'use Y' },
    ])
  })
})
