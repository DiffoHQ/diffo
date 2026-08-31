import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Anchor, Coverage } from '../shared/review.js'
import type { ChangesetSpec } from '../shared/types.js'
import { DiffoDb } from './db.js'
import { parseReview, ReviewStore } from './review.js'

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const fn of cleanups.splice(0)) fn()
})

function tempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'diffo-review-'))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

function makeStore(root: string): ReviewStore {
  const dbDir = `${root}-db`
  cleanups.push(() => rmSync(dbDir, { recursive: true, force: true }))
  return new ReviewStore(root, new DiffoDb(join(dbDir, 'diffo.db')), SPEC)
}

const SPEC: ChangesetSpec = { kind: 'working-tree' }

const hunkAnchor = (hunkId = 'abc123'): Anchor => ({
  kind: 'hunk',
  hunkId,
  path: 'src/a.ts',
  side: 'new',
  line: 12,
})

const coverage = (): Coverage => ({
  viewedHunks: 1,
  totalHunks: 1,
  viewedFiles: 1,
  totalFiles: 1,
  skippedFiles: [],
})

describe('ReviewStore', () => {
  it('persists threads in the DB and never writes into the worktree', () => {
    const root = tempRoot()
    const store = makeStore(root)

    const thread = store.createThread(hunkAnchor(), 'rename this', { codeContext: '+const x = 1' })
    expect(thread.state).toBe('open')
    expect(thread.messages).toHaveLength(1)
    expect(thread.messages[0]!.author).toBe('reviewer')

    expect(existsSync(join(root, '.diffo'))).toBe(false)

    const reread = makeStore(root)
    expect(reread.get().threads).toEqual([thread])
  })

  it('two repos in one DB never see each other', () => {
    const rootA = tempRoot()
    const rootB = tempRoot()
    const db = new DiffoDb(join(`${rootA}-db`, 'diffo.db'))
    cleanups.push(() => rmSync(`${rootA}-db`, { recursive: true, force: true }))
    const a = new ReviewStore(rootA, db, SPEC)
    const b = new ReviewStore(rootB, db, SPEC)
    a.createThread(hunkAnchor(), 'only in A', null)
    expect(b.get().threads).toEqual([])
    expect(new ReviewStore(rootB, db, SPEC).get().threads).toEqual([])
    expect(new ReviewStore(rootA, db, SPEC).get().threads).toHaveLength(1)
  })

  it('the same directory on two bases keeps two reviews', () => {
    const root = tempRoot()
    const db = new DiffoDb(join(`${root}-db`, 'diffo.db'))
    cleanups.push(() => rmSync(`${root}-db`, { recursive: true, force: true }))
    const working = new ReviewStore(root, db, { kind: 'working-tree' })
    const vsMain = new ReviewStore(root, db, { kind: 'branch', base: 'main' })
    working.createThread(hunkAnchor(), 'about my uncommitted work', null)
    expect(vsMain.get().threads).toEqual([])
    expect(new ReviewStore(root, db, { kind: 'working-tree' }).get().threads).toHaveLength(1)
  })

  it('a checkout swaps the review instead of dragging threads across', () => {
    const root = tempRoot()
    const db = new DiffoDb(join(`${root}-db`, 'diffo.db'))
    cleanups.push(() => rmSync(`${root}-db`, { recursive: true, force: true }))
    const store = new ReviewStore(root, db, SPEC)
    expect(store.scope.branch).toBe('')
    store.createThread(hunkAnchor(), 'about the first branch', null)

    let notified = -1
    store.subscribe((state) => {
      notified = state.threads.length
    })
    store.rescope('feature/x')
    expect(store.get().threads).toEqual([])
    expect(notified).toBe(0)

    store.createThread(hunkAnchor(), 'about feature/x', null)
    store.rescope('')
    expect(store.get().threads.map((t) => t.messages[0]!.text)).toEqual(['about the first branch'])
    store.rescope('feature/x')
    expect(store.get().threads.map((t) => t.messages[0]!.text)).toEqual(['about feature/x'])
  })

  it('reply, send, resolve walk the state machine', () => {
    const store = makeStore(tempRoot())
    const thread = store.createThread(hunkAnchor(), 'why this?', null)

    const replied = store.addMessage(thread.id, 'agent', 'because X')
    expect(replied!.messages.map((m) => m.author)).toEqual(['reviewer', 'agent'])

    expect(store.send(thread.id)!.state).toBe('sent')
    expect(store.send(thread.id)!.state).toBe('sent')

    expect(store.setState(thread.id, 'resolved')!.state).toBe('resolved')
    expect(store.addMessage('nope', 'reviewer', 'x')).toBeNull()
  })

  it('removeThread drops it for good and persists the removal', () => {
    const root = tempRoot()
    const store = makeStore(root)
    const keep = store.createThread(hunkAnchor('keep'), 'keep me', null)
    const noise = store.createThread(hunkAnchor('noise'), 'stray thought', null)

    expect(store.removeThread(noise.id)).toBe(true)
    expect(store.get().threads.map((t) => t.id)).toEqual([keep.id])
    expect(store.removeThread(noise.id)).toBe(false)
    expect(store.removeThread('never-existed')).toBe(false)

    expect(
      makeStore(root)
        .get()
        .threads.map((t) => t.id),
    ).toEqual([keep.id])
  })

  it('reset empties the review, returns the ids, and persists', () => {
    const root = tempRoot()
    const store = makeStore(root)
    const a = store.createThread(hunkAnchor('a'), 'one', null)
    const b = store.createThread(hunkAnchor('b'), 'two', null)

    expect(store.reset().sort()).toEqual([a.id, b.id].sort())
    expect(store.get().threads).toEqual([])
    expect(store.reset()).toEqual([])
    expect(makeStore(root).get().threads).toEqual([])
  })

  it('reset takes lastFinish and the landed marker too, but leaves seenHead', () => {
    const root = tempRoot()
    const store = makeStore(root)
    store.createThread(hunkAnchor(), 'old round', null)
    store.recordFinish(['h1'], coverage())
    store.noteHead('base')
    store.markLanded({ sha: 'landing', subject: 'ship it', at: new Date().toISOString() })

    store.reset()

    const state = makeStore(root).get()
    expect(state.threads).toEqual([])
    // A surviving lastFinish would carry dead hunk ids into the next review's
    // "since last review" lens; a surviving marker would re-offer the clearing.
    expect(state.lastFinish).toBeUndefined()
    expect(state.landed).toBeUndefined()
    expect(state.seenHead).toBe('base')
  })

  it('the landed marker and seenHead persist and clear on their own', () => {
    const root = tempRoot()
    const store = makeStore(root)
    store.noteHead('base')
    store.markLanded({ sha: 'landing', subject: 'ship it', at: '2026-08-22T00:00:00.000Z' })

    const reread = makeStore(root)
    expect(reread.get().seenHead).toBe('base')
    expect(reread.get().landed).toEqual({
      sha: 'landing',
      subject: 'ship it',
      at: '2026-08-22T00:00:00.000Z',
    })

    reread.clearLanded()
    expect(makeStore(root).get().landed).toBeUndefined()
    expect(makeStore(root).get().seenHead).toBe('base')
  })

  it('removeThread notifies subscribers', () => {
    const store = makeStore(tempRoot())
    const thread = store.createThread(hunkAnchor(), 'noise', null)
    let seen = -1
    store.subscribe((state) => {
      seen = state.threads.length
    })
    store.removeThread(thread.id)
    expect(seen).toBe(0)
  })

  it('annotateAgentReplies stamps the newest unstamped agent message only', () => {
    const root = tempRoot()
    const store = makeStore(root)
    const answered = store.createThread(hunkAnchor('h1'), 'why?', null)
    store.addMessage(answered.id, 'agent', 'because')
    const silent = store.createThread(hunkAnchor('h2'), 'fix this', null)

    store.annotateAgentReplies([answered.id, silent.id], 62_000)
    expect(store.get().threads[0]!.messages[1]!.durationMs).toBe(62_000)
    expect(store.get().threads[1]!.messages[0]!.durationMs).toBeUndefined()

    store.addMessage(answered.id, 'reviewer', 'and this?')
    store.addMessage(answered.id, 'agent', 'also because')
    store.annotateAgentReplies([answered.id], 5_000)
    const messages = store.get().threads[0]!.messages
    expect(messages[1]!.durationMs).toBe(62_000)
    expect(messages[3]!.durationMs).toBe(5_000)

    expect(makeStore(root).get().threads[0]!.messages[1]!.durationMs).toBe(62_000)
  })

  it('an agent thread persists with its voice', () => {
    const root = tempRoot()
    const store = makeStore(root)
    const thread = store.createThread(hunkAnchor(), 'name this', null, undefined, 'agent')
    expect(thread.messages[0]!.author).toBe('agent')

    const reread = makeStore(root).get().threads[0]!
    expect(reread.messages[0]!.author).toBe('agent')
  })

  it('finish flushes every open thread to sent, leaves the rest alone', () => {
    const store = makeStore(tempRoot())
    const a = store.createThread(hunkAnchor('h1'), 'one', null)
    const b = store.createThread(hunkAnchor('h2'), 'two', null)
    store.setState(b.id, 'resolved')

    const all = store.finish()
    expect(all.find((t) => t.id === a.id)!.state).toBe('sent')
    expect(all.find((t) => t.id === b.id)!.state).toBe('resolved')
  })

  it('reconcile: sent thread whose hunk vanished flips to addressed', () => {
    const store = makeStore(tempRoot())
    const thread = store.createThread(hunkAnchor('gone'), 'fix this', null)
    store.send(thread.id)

    store.reconcile(new Set(['other']))
    expect(store.get().threads[0]!.state).toBe('addressed')
  })

  it('reconcile: open thread gets codeChanged, cleared when the hunk returns', () => {
    const store = makeStore(tempRoot())
    store.createThread(hunkAnchor('h1'), 'note', null)

    store.reconcile(new Set([]))
    expect(store.get().threads[0]!.codeChanged).toBe(true)

    store.reconcile(new Set(['h1']))
    expect(store.get().threads[0]!.codeChanged).toBe(false)
  })

  it('reconcile ignores file/changeset anchors and notifies only on change', () => {
    const store = makeStore(tempRoot())
    store.createThread({ kind: 'file', path: 'a.ts' }, 'file note', null)
    store.createThread({ kind: 'changeset' }, 'overall', null)
    let pings = 0
    store.subscribe(() => pings++)

    store.reconcile(new Set(['whatever']))
    expect(pings).toBe(0)
    expect(store.get().threads.every((t) => !t.codeChanged)).toBe(true)
  })

  it('markUnanswered records the agent moving on, and persists it', () => {
    const root = tempRoot()
    const store = makeStore(root)
    const thread = store.createThread(hunkAnchor('h1'), 'why this?', null)
    store.send(thread.id)

    store.markUnanswered([thread.id])
    expect(store.get().threads[0]!.unanswered).toBe(true)
    expect(makeStore(root).get().threads[0]!.unanswered).toBe(true)
  })

  it('a resolved thread is never marked unanswered — the reviewer moved on first', () => {
    const store = makeStore(tempRoot())
    const thread = store.createThread(hunkAnchor('h1'), 'nit', null)
    store.setState(thread.id, 'resolved')

    store.markUnanswered([thread.id])
    expect(store.get().threads[0]!.unanswered).toBeUndefined()
  })

  it('anyone speaking un-strands the thread, and the flag leaves the JSON', () => {
    const store = makeStore(tempRoot())
    const thread = store.createThread(hunkAnchor('h1'), 'fix this', null)
    store.send(thread.id)
    store.markUnanswered([thread.id])

    store.addMessage(thread.id, 'agent', 'sorry — done now')
    expect(store.get().threads[0]!.unanswered).toBeUndefined()
    expect('unanswered' in store.get().threads[0]!).toBe(false)
  })

  it('resolving sheds the frozen diff but keeps the anchored lines — a follow-up needs them', () => {
    const store = makeStore(tempRoot())
    const anchored = { start: 0, end: 0, text: '+ const a = 1' }
    const thread = store.createThread(hunkAnchor('h1'), 'why this?', {
      codeContext: '+ const a = 1\n- const a = 2',
      anchored,
    })
    expect(store.get().threads[0]!.codeContext).not.toBeNull()
    expect(store.get().threads[0]!.anchored).toEqual(anchored)

    store.setState(thread.id, 'resolved')
    expect(store.get().threads[0]!.codeContext).toBeNull()
    expect(store.get().threads[0]!.anchored).toEqual(anchored)
    expect(store.get().threads[0]!.messages).toHaveLength(1)
  })

  it('a finish records where you left off, and overwrites rather than piling up', () => {
    const root = tempRoot()
    const store = makeStore(root)
    store.recordFinish(['h1', 'h2'], coverage())
    expect(store.get().lastFinish!.hunkIds).toEqual(['h1', 'h2'])

    store.recordFinish(['h3'], coverage())
    expect(store.get().lastFinish!.hunkIds).toEqual(['h3'])
    expect(makeStore(root).get().lastFinish!.hunkIds).toEqual(['h3'])
  })

  it('a collected finish is stamped once — a restart only owes an uncollected one', () => {
    const store = makeStore(tempRoot())
    store.recordFinish(['h1'], coverage())
    expect(store.get().lastFinish!.collectedAt).toBeUndefined()

    store.markFinishCollected()
    const at = store.get().lastFinish!.collectedAt
    expect(typeof at).toBe('string')
    store.markFinishCollected()
    expect(store.get().lastFinish!.collectedAt).toBe(at)

    store.recordFinish(['h2'], coverage())
    expect(store.get().lastFinish!.collectedAt).toBeUndefined()
  })

  it('clearUnanswered puts it back on the clock when it is redelivered', () => {
    const store = makeStore(tempRoot())
    const thread = store.createThread(hunkAnchor('h1'), 'fix this', null)
    store.send(thread.id)
    store.markUnanswered([thread.id])

    store.clearUnanswered([thread.id])
    expect(store.get().threads[0]!.unanswered).toBeUndefined()
    let pings = 0
    store.subscribe(() => pings++)
    store.clearUnanswered([thread.id])
    expect(pings).toBe(0)
  })

  it('a --more reply promises a follow-up; the next plain reply settles it', () => {
    const root = tempRoot()
    const store = makeStore(root)
    const thread = store.createThread(hunkAnchor('h1'), 'why this?', null)
    store.send(thread.id)

    store.addMessage(thread.id, 'agent', 'digging in — back soon', false, undefined, true)
    expect(store.get().threads[0]!.awaitingFollowUp).toBe(true)
    expect(makeStore(root).get().threads[0]!.awaitingFollowUp).toBe(true)

    store.addMessage(thread.id, 'agent', 'found it — fixed')
    expect('awaitingFollowUp' in store.get().threads[0]!).toBe(false)
  })

  it('a reviewer message leaves the promise standing — the agent still owes the ending', () => {
    const store = makeStore(tempRoot())
    const thread = store.createThread(hunkAnchor('h1'), 'why this?', null)
    store.send(thread.id)
    store.addMessage(thread.id, 'agent', 'checking', false, undefined, true)

    store.addMessage(thread.id, 'reviewer', 'also look at the other branch')
    expect(store.get().threads[0]!.awaitingFollowUp).toBe(true)
  })

  it('another --more renews the promise instead of settling it', () => {
    const store = makeStore(tempRoot())
    const thread = store.createThread(hunkAnchor('h1'), 'why this?', null)
    store.send(thread.id)
    store.addMessage(thread.id, 'agent', 'checking', false, undefined, true)
    store.addMessage(thread.id, 'agent', 'still checking', false, undefined, true)
    expect(store.get().threads[0]!.awaitingFollowUp).toBe(true)
  })

  it('markUnanswered settles the promise — moved on and follow-up coming cannot both be true', () => {
    const store = makeStore(tempRoot())
    const thread = store.createThread(hunkAnchor('h1'), 'why this?', null)
    store.send(thread.id)
    store.addMessage(thread.id, 'agent', 'checking', false, undefined, true)

    store.markUnanswered([thread.id])
    const after = store.get().threads[0]!
    expect(after.unanswered).toBe(true)
    expect('awaitingFollowUp' in after).toBe(false)
  })

  it('resolving settles the promise along with the thread', () => {
    const store = makeStore(tempRoot())
    const thread = store.createThread(hunkAnchor('h1'), 'why this?', null)
    store.send(thread.id)
    store.addMessage(thread.id, 'agent', 'checking', false, undefined, true)

    store.setState(thread.id, 'resolved')
    expect('awaitingFollowUp' in store.get().threads[0]!).toBe(false)
  })

  it('the follow-up lands after the interim reply, before raced reviewer words', async () => {
    const tick = () => new Promise((r) => setTimeout(r, 20))
    const store = makeStore(tempRoot())
    const thread = store.createThread(hunkAnchor('h1'), 'why this?', null)
    store.send(thread.id)
    const deliveredAt = Date.now()
    store.addMessage(thread.id, 'agent', 'interim', false, deliveredAt, true)
    await tick()
    store.addMessage(thread.id, 'reviewer', 'raced in meanwhile')

    store.addMessage(thread.id, 'agent', 'the real answer', false, deliveredAt)
    const texts = store.get().threads[0]!.messages.map((m) => m.text)
    expect(texts).toEqual(['why this?', 'interim', 'the real answer', 'raced in meanwhile'])
  })
})

describe('parseReview', () => {
  it('drops malformed threads, keeps valid ones', () => {
    const parsed = parseReview(
      JSON.stringify({
        threads: [
          {
            id: 'ok',
            state: 'open',
            anchor: { kind: 'changeset' },
            messages: [{ author: 'reviewer', text: 'hi' }],
          },
          { id: 'bad-state', state: 'wat', anchor: { kind: 'changeset' }, messages: [] },
          { id: 'bad-anchor', state: 'open', anchor: { kind: 'hunk' }, messages: [] },
          'not even an object',
        ],
      }),
    )
    expect(parsed!.threads.map((t) => t.id)).toEqual(['ok'])
  })

  it('a range anchor survives the round trip — endLine must not vanish on reload', () => {
    const stored = (endLine: unknown) =>
      JSON.stringify({
        threads: [
          {
            id: 't',
            state: 'open',
            anchor: { kind: 'hunk', hunkId: 'h', path: 'a.ts', side: 'new', line: 4, endLine },
            messages: [{ author: 'reviewer', text: 'hi' }],
          },
        ],
      })
    expect(parseReview(stored(9))!.threads[0]!.anchor).toEqual({
      kind: 'hunk',
      hunkId: 'h',
      path: 'a.ts',
      side: 'new',
      line: 4,
      endLine: 9,
    })
    // A span that doesn't extend past its start collapses back to a single line.
    for (const bad of [4, 3, 4.5, '9', null]) {
      const anchor = parseReview(stored(bad))!.threads[0]!.anchor
      expect(anchor).toEqual({ kind: 'hunk', hunkId: 'h', path: 'a.ts', side: 'new', line: 4 })
    }
  })

  it('anchored lines survive the round trip; a malformed record is dropped, not fatal', () => {
    const stored = (anchored: unknown) =>
      JSON.stringify({
        threads: [
          {
            id: 't',
            state: 'open',
            anchor: { kind: 'hunk', hunkId: 'h', path: 'a.ts', side: 'new', line: 4 },
            messages: [{ author: 'reviewer', text: 'hi' }],
            anchored,
          },
        ],
      })
    const good = { start: 1, end: 2, text: '+a\n+b' }
    expect(parseReview(stored(good))!.threads[0]!.anchored).toEqual(good)
    for (const bad of [
      { start: -1, end: 2, text: 'x' },
      { start: 3, end: 2, text: 'x' },
      { start: 0.5, end: 2, text: 'x' },
      { start: 0, end: 1 },
      'nope',
    ]) {
      const thread = parseReview(stored(bad))!.threads[0]!
      expect(thread.id).toBe('t')
      expect(thread.anchored).toBeUndefined()
    }
  })

  it('returns null for non-review JSON', () => {
    expect(parseReview('[]')).toBeNull()
    expect(parseReview('{"threads": 5}')).toBeNull()
    expect(parseReview('null')).toBeNull()
  })

  it('drops the retired role field on threads that still carry it', () => {
    const parsed = parseReview(
      JSON.stringify({
        threads: [
          {
            id: 'old-flag',
            state: 'open',
            anchor: { kind: 'file', path: 'a.ts' },
            role: 'flag',
            messages: [{ author: 'agent', text: 'name this' }],
          },
        ],
      }),
    )
    expect(parsed!.threads[0]!.messages[0]!.author).toBe('agent')
    expect('role' in parsed!.threads[0]!).toBe(false)
  })

  it('round-trips awaitingFollowUp; unanswered wins when a hand-edited file carries both', () => {
    const stored = (extra: Record<string, unknown>) =>
      JSON.stringify({
        threads: [
          {
            id: 't',
            state: 'sent',
            anchor: { kind: 'file', path: 'a.ts' },
            messages: [{ author: 'agent', text: 'checking' }],
            ...extra,
          },
        ],
      })
    expect(parseReview(stored({ awaitingFollowUp: true }))!.threads[0]!.awaitingFollowUp).toBe(true)
    const both = parseReview(stored({ awaitingFollowUp: true, unanswered: true }))!.threads[0]!
    expect(both.unanswered).toBe(true)
    expect('awaitingFollowUp' in both).toBe(false)
  })

  it('round-trips seenHead and the landed marker, and drops a sha-less marker', () => {
    const parsed = parseReview(
      JSON.stringify({
        threads: [],
        seenHead: 'base',
        landed: { sha: 'landing', subject: 'ship it', at: '2026-08-22T00:00:00.000Z' },
      }),
    )
    expect(parsed!.seenHead).toBe('base')
    expect(parsed!.landed).toEqual({
      sha: 'landing',
      subject: 'ship it',
      at: '2026-08-22T00:00:00.000Z',
    })

    // A marker that can't name its commit can't be checked against history.
    const broken = parseReview(JSON.stringify({ threads: [], landed: { subject: 'ship it' } }))
    expect(broken!.landed).toBeUndefined()
    // The caption and stamp time are recoverable; the sha is not negotiable.
    const bare = parseReview(JSON.stringify({ threads: [], landed: { sha: 'landing' } }))
    expect(bare!.landed).toMatchObject({ sha: 'landing', subject: '' })
  })

  it('migrates legacy suggestions into agent comment threads on their file', () => {
    const parsed = parseReview(
      JSON.stringify({
        threads: [],
        suggestions: [
          { id: 's-1', file: 'a.ts', line: 12, text: 'missing null check', at: '2026-01-01' },
          { file: 'b.ts', text: 'no id, still fine' },
          { text: 'no file — dropped' },
        ],
      }),
    )
    expect(parsed!.threads).toHaveLength(2)
    expect(parsed!.threads[0]).toMatchObject({
      id: 's-1',
      state: 'open',
      anchor: { kind: 'file', path: 'a.ts' },
      createdAt: '2026-01-01',
    })
    expect(parsed!.threads[0]!.messages[0]).toMatchObject({
      author: 'agent',
      text: 'missing null check',
    })
  })
})
