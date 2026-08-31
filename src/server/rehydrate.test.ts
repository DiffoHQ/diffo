import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Anchor, Coverage } from '../shared/review.js'
import type { ChangesetSpec } from '../shared/types.js'
import { DiffoDb } from './db.js'
import { DeliveryQueue } from './delivery.js'
import { rehydrateQueue } from './index.js'
import { ReviewStore } from './review.js'

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const fn of cleanups.splice(0)) fn()
})

const SPEC: ChangesetSpec = { kind: 'working-tree' }

const anchor = (hunkId = 'abc123'): Anchor => ({
  kind: 'hunk',
  hunkId,
  path: 'src/a.ts',
  side: 'new',
  line: 12,
})

const coverage = (): Coverage => ({
  viewedHunks: 1,
  totalHunks: 2,
  skippedFiles: [],
})

function makeReview() {
  const root = mkdtempSync(join(tmpdir(), 'diffo-rehydrate-'))
  const dbDir = `${root}-db`
  cleanups.push(() => rmSync(root, { recursive: true, force: true }))
  cleanups.push(() => rmSync(dbDir, { recursive: true, force: true }))
  const db = new DiffoDb(join(dbDir, 'diffo.db'))
  cleanups.push(() => db.close())
  return {
    store: new ReviewStore(root, db, SPEC),
    restart: () => new ReviewStore(root, db, SPEC),
  }
}

function afterRestart(restart: () => ReviewStore) {
  const queue = new DeliveryQueue()
  rehydrateQueue(restart(), queue)
  return queue
}

describe('rehydrateQueue — feedback outlives the process that queued it', () => {
  it('re-queues an Ask that nobody ever collected', () => {
    const { store, restart } = makeReview()
    const thread = store.createThread(anchor(), 'why the cast here?', null)
    store.send(thread.id)

    const queue = afterRestart(restart)
    expect(queue.queuedThreadIds()).toEqual([thread.id])
    expect(queue.take()).toEqual({ kind: 'threads', threadIds: [thread.id] })
  })

  it('leaves a thread the agent already answered alone', () => {
    const { store, restart } = makeReview()
    const thread = store.createThread(anchor(), 'why the cast here?', null)
    store.send(thread.id)
    store.addMessage(thread.id, 'agent', 'narrowing the union — dropped it')

    expect(afterRestart(restart).queuedThreadIds()).toEqual([])
  })

  it("re-queues the reviewer's follow-up on a thread the agent answered", () => {
    const { store, restart } = makeReview()
    const thread = store.createThread(anchor(), 'why the cast here?', null)
    store.send(thread.id)
    store.addMessage(thread.id, 'agent', 'narrowing the union — dropped it')
    store.addMessage(thread.id, 'reviewer', 'the other one too?')

    expect(afterRestart(restart).queuedThreadIds()).toEqual([thread.id])
  })

  it('leaves a thread the agent concluded without answering alone', () => {
    const { store, restart } = makeReview()
    const thread = store.createThread(anchor(), 'why the cast here?', null)
    store.send(thread.id)
    store.markUnanswered([thread.id])

    expect(afterRestart(restart).queuedThreadIds()).toEqual([])
  })

  it('re-queues a follow-up on an addressed thread', () => {
    const { store, restart } = makeReview()
    const thread = store.createThread(anchor(), 'this cast is load-bearing?', null)
    store.send(thread.id)
    store.reconcile(new Set())
    store.addMessage(thread.id, 'reviewer', 'same in the other branch of the if')

    expect(afterRestart(restart).queuedThreadIds()).toEqual([thread.id])
  })

  it('never re-queues an open or resolved thread', () => {
    const { store, restart } = makeReview()
    store.createThread(anchor('open-hunk'), 'not sent yet', null)
    const resolved = store.createThread(anchor('done-hunk'), 'sent then closed', null)
    store.send(resolved.id)
    store.setState(resolved.id, 'resolved')

    expect(afterRestart(restart).queuedThreadIds()).toEqual([])
  })

  it('re-queues a Finish batch that no poll ever carried away', () => {
    const { store, restart } = makeReview()
    store.createThread(anchor(), 'why the cast here?', null)
    store.finish()
    store.recordFinish(['abc123'], coverage())

    const snapshot = afterRestart(restart).take()
    expect(snapshot?.kind).toBe('finish')
    expect(snapshot).toMatchObject({ coverage: { viewedHunks: 1, totalHunks: 2 } })
  })

  it('leaves a Finish the agent already collected alone', () => {
    const { store, restart } = makeReview()
    const thread = store.createThread(anchor(), 'why the cast here?', null)
    store.finish()
    store.recordFinish(['abc123'], coverage())
    store.markFinishCollected()

    const snapshot = afterRestart(restart).take()
    expect(snapshot).toEqual({ kind: 'threads', threadIds: [thread.id] })
  })

  it('downgrades a promised follow-up to unanswered — no live batch is left to conclude it', () => {
    const { store, restart } = makeReview()
    const thread = store.createThread(anchor(), 'why the cast here?', null)
    store.send(thread.id)
    store.addMessage(thread.id, 'agent', 'digging in — back soon', false, undefined, true)

    const restarted = restart()
    const queue = new DeliveryQueue()
    rehydrateQueue(restarted, queue)
    const after = restarted.get().threads[0]!
    expect(after.unanswered).toBe(true)
    expect('awaitingFollowUp' in after).toBe(false)
    // Owed BY the agent, not by the reviewer — never re-queued for delivery.
    expect(queue.queuedThreadIds()).toEqual([])
  })

  it('holds nothing for a review with nothing outstanding', () => {
    const { store, restart } = makeReview()
    store.createThread(anchor(), 'still drafting this', null)

    const queue = afterRestart(restart)
    expect(queue.take()).toBeNull()
    expect(queue.hasListener()).toBe(false)
  })
})

describe('the line survives the restart that rebuilt it', () => {
  it('re-queues in the order the reviewer sent, not array order', async () => {
    const { store, restart } = makeReview()
    const first = store.createThread(anchor('h1'), 'sent first', null)
    const second = store.createThread(anchor('h2'), 'sent second', null)
    const third = store.createThread(anchor('h3'), 'sent third', null)

    store.send(third.id)
    await new Promise((r) => setTimeout(r, 5))
    store.send(first.id)
    await new Promise((r) => setTimeout(r, 5))
    store.send(second.id)

    expect(afterRestart(restart).queuedThreadIds()).toEqual([third.id, first.id, second.id])
  })

  it('a Finish stamps every thread it flushes', async () => {
    const { store, restart } = makeReview()
    const early = store.createThread(anchor('h1'), 'asked early', null)
    store.send(early.id)
    await new Promise((r) => setTimeout(r, 5))
    const late = store.createThread(anchor('h2'), 'swept up by Finish', null)
    store.finish()

    expect(afterRestart(restart).queuedThreadIds()).toEqual([early.id, late.id])
  })
})
