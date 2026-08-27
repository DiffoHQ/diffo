import { describe, expect, it } from 'vitest'
import { DeliveryQueue } from './delivery.js'

describe('DeliveryQueue', () => {
  it('starts waiting, with nothing pending', () => {
    const q = new DeliveryQueue()
    expect(q.presence()).toBe('waiting')
    expect(q.hasListener()).toBe(false)
    expect(q.take()).toBeNull()
  })

  it('attach resolves immediately when feedback is already queued', async () => {
    const q = new DeliveryQueue()
    q.enqueueThreads(['t1'])
    expect(await q.attach()).toBe('data')
    expect(q.presence()).toBe('waiting')
  })

  it('enqueue wakes a waiting attach; presence walks waiting → listening → working', async () => {
    const q = new DeliveryQueue()
    const states: string[] = []
    q.subscribe((s) => states.push(s))
    const attached = q.attach()
    expect(q.presence()).toBe('listening')
    q.enqueueThreads(['t1'])
    expect(await attached).toBe('data')
    const snapshot = q.take()!
    q.confirm(snapshot, ['t1'])
    expect(q.presence()).toBe('working')
    expect(states).toEqual(['listening', 'working'])
  })

  it('take does NOT deliver — only confirm does, and only what the snapshot covered', async () => {
    const q = new DeliveryQueue()
    q.enqueueThreads(['t1'])
    const snapshot = q.take()!
    expect(q.take()).toEqual(snapshot)

    q.enqueueThreads(['t2'])
    q.confirm(snapshot, ['t1'])
    expect(q.take()).toMatchObject({ kind: 'threads', threadIds: ['t2'] })
  })

  it('a pooled finish wins the snapshot and confirm clears the absorbed threads', () => {
    const q = new DeliveryQueue()
    q.enqueueThreads(['t1', 't2'])
    q.enqueueFinish({ viewedHunks: 1, totalHunks: 2, skippedFiles: [] })
    const snapshot = q.take()!
    expect(snapshot.kind).toBe('finish')
    q.confirm(snapshot, ['t1', 't2'])
    expect(q.take()).toBeNull()
  })

  it('a cleared notice wakes a waiting attach and is consumed by its confirm', async () => {
    const q = new DeliveryQueue()
    const attached = q.attach()
    q.enqueueCleared()
    expect(await attached).toBe('data')
    const snapshot = q.take()!
    expect(snapshot).toEqual({ kind: 'cleared' })
    q.confirm(snapshot, [])
    expect(q.take()).toBeNull()
    // No reply is owed for a heads-up: the agent parks in the re-poll grace,
    // never in an awaiting-reply batch that would read as stalled.
    expect(q.presence()).toBe('working')
    expect(q.currentBatch()).toBeNull()
  })

  it('real feedback outranks the heads-up, which survives until its own turn', () => {
    const q = new DeliveryQueue()
    q.enqueueCleared()
    q.enqueueThreads(['t1'])
    const first = q.take()!
    expect(first).toMatchObject({ kind: 'threads', threadIds: ['t1'] })
    q.confirm(first, ['t1'])
    expect(q.take()).toEqual({ kind: 'cleared' })
  })

  it('clearing twice before a poll still owes exactly one heads-up', () => {
    const q = new DeliveryQueue()
    q.enqueueCleared()
    q.enqueueCleared()
    const snapshot = q.take()!
    q.confirm(snapshot, [])
    expect(q.take()).toBeNull()
  })

  it('a cleared notice is scoped — a branch switch parks it like any feedback', () => {
    const q = new DeliveryQueue()
    q.enqueueCleared()
    q.rescope('other')
    expect(q.take()).toBeNull()
    q.rescope('')
    expect(q.take()).toEqual({ kind: 'cleared' })
  })

  it('a newer attach supersedes the old one', async () => {
    const q = new DeliveryQueue()
    const first = q.attach()
    const second = q.attach()
    expect(await first).toBe('superseded')
    q.enqueueThreads(['t1'])
    expect(await second).toBe('data')
  })

  it('an aborted listener goes back to waiting without resolving', async () => {
    const q = new DeliveryQueue()
    let detach: (() => void) | null = null
    let resolved = false
    void q.attach((d) => (detach = d)).then(() => (resolved = true))
    await Promise.resolve()
    expect(q.presence()).toBe('listening')
    detach!()
    expect(q.presence()).toBe('waiting')
    q.enqueueThreads(['t1'])
    await Promise.resolve()
    expect(resolved).toBe(false)
    expect(q.take()).toMatchObject({ threadIds: ['t1'] })
  })

  it('agentReplied returns the reviewer-perceived wait; working parks in the re-poll grace', async () => {
    const q = new DeliveryQueue(5 * 60_000, 10)
    q.enqueueThreads(['t1'])
    const snapshot = q.take()!
    q.confirm(snapshot, ['t1'])
    expect(q.presence()).toBe('working')
    const waited = q.agentReplied('t1')
    expect(typeof waited).toBe('number')
    expect(waited!).toBeGreaterThanOrEqual(0)
    expect(q.presence()).toBe('working')
    expect(q.presenceDetail().reason).toBe('replied')
    await new Promise((r) => setTimeout(r, 30))
    expect(q.presence()).toBe('waiting')
    expect(q.agentReplied('t1')).toBeNull()
    expect(q.agentReplied('never-delivered')).toBeNull()
  })

  it("deliveredThreadIds names exactly the threads in the agent's hands", () => {
    const q = new DeliveryQueue()
    expect(q.deliveredThreadIds()).toEqual([])
    q.enqueueThreads(['t1', 't2'])
    q.confirm(q.take()!, ['t1', 't2'])
    expect(q.deliveredThreadIds().sort()).toEqual(['t1', 't2'])
    q.agentReplied('t1')
    expect(q.deliveredThreadIds()).toEqual(['t2'])
    q.end()
    expect(q.deliveredThreadIds()).toEqual([])
  })

  it('a mid-batch reply keeps working — the agent still owes answers', () => {
    const q = new DeliveryQueue()
    q.enqueueThreads(['t1', 't2'])
    q.confirm(q.take()!, ['t1', 't2'])
    q.agentReplied('t1')
    expect(q.presence()).toBe('working')
    expect(q.presenceDetail().reason).toBe('delivered')
    q.agentReplied('t2')
    expect(q.presenceDetail().reason).toBe('replied')
  })

  it('a known session pid makes the grace a real check: dead process drops at once', async () => {
    let alive = true
    const q = new DeliveryQueue(5 * 60_000, 5 * 60_000, {
      isAlive: () => alive,
      checkEveryMs: 5,
      capMs: 60_000,
    })
    q.claimSession(4242)
    q.enqueueThreads(['t1'])
    q.confirm(q.take()!, ['t1'])
    q.agentReplied('t1')
    await new Promise((r) => setTimeout(r, 25))
    expect(q.presence()).toBe('working')
    alive = false
    await new Promise((r) => setTimeout(r, 25))
    expect(q.presence()).toBe('waiting')
  })

  it('even a live session decays at the cap — an abandoned app is not an agent', async () => {
    const q = new DeliveryQueue(5 * 60_000, 5 * 60_000, {
      isAlive: () => true,
      checkEveryMs: 5,
      capMs: 20,
    })
    q.claimSession(4242)
    q.enqueueThreads(['t1'])
    q.confirm(q.take()!, ['t1'])
    q.agentReplied('t1')
    await new Promise((r) => setTimeout(r, 60))
    expect(q.presence()).toBe('waiting')
  })

  it('a poll that cannot name its session clears the stale pid (fixed grace returns)', async () => {
    const q = new DeliveryQueue(5 * 60_000, 10, {
      isAlive: () => true,
      checkEveryMs: 5,
      capMs: 60_000,
    })
    q.claimSession(4242)
    q.claimSession(null)
    q.enqueueThreads(['t1'])
    q.confirm(q.take()!, ['t1'])
    q.agentReplied('t1')
    await new Promise((r) => setTimeout(r, 40))
    expect(q.presence()).toBe('waiting')
  })

  it('the re-poll ends the grace: reply → attach → listening', () => {
    const q = new DeliveryQueue()
    q.enqueueThreads(['t1'])
    q.confirm(q.take()!, ['t1'])
    q.agentReplied('t1')
    expect(q.presence()).toBe('working')
    void q.attach()
    expect(q.presence()).toBe('listening')
    expect(q.presenceDetail().reason).toBe('polling')
  })

  it('queuedThreadIds is the line in send order, and confirm clears exactly what was taken', () => {
    const q = new DeliveryQueue()
    expect(q.queuedThreadIds()).toEqual([])
    q.enqueueThreads(['t1'])
    q.enqueueThreads(['t2', 't3'])
    expect(q.queuedThreadIds()).toEqual(['t1', 't2', 't3'])

    const snapshot = q.take()!
    q.enqueueThreads(['t4'])
    q.confirm(snapshot, ['t1', 't2', 't3'])
    expect(q.queuedThreadIds()).toEqual(['t4'])
    expect(q.deliveredThreadIds().sort()).toEqual(['t1', 't2', 't3'])
  })

  it('queuedThreadIds is scoped — parked feedback on another branch is not in line', () => {
    const q = new DeliveryQueue()
    q.rescope('main')
    q.enqueueThreads(['t1'])
    q.rescope('feature')
    expect(q.queuedThreadIds()).toEqual([])
    q.rescope('main')
    expect(q.queuedThreadIds()).toEqual(['t1'])
  })

  it('a queued send announces itself; an instant handoff stays quiet until confirm', async () => {
    const q = new DeliveryQueue()
    let notified = 0
    q.subscribe(() => notified++)
    q.enqueueThreads(['t1'])
    expect(notified).toBe(1)
    q.drop('t1')
    expect(notified).toBe(2)

    const attached = q.attach()
    expect(notified).toBe(3)
    q.enqueueThreads(['t2'])
    expect(await attached).toBe('data')
    expect(notified).toBe(3)
    q.confirm(q.take()!, ['t2'])
    expect(notified).toBe(4)
  })

  it('drop removes a deleted thread from the queue and the reply clock', () => {
    const q = new DeliveryQueue()
    q.enqueueThreads(['t1', 't2'])
    q.drop('t1')
    expect(q.take()).toMatchObject({ threadIds: ['t2'] })
  })

  it('a rescope parks queued feedback instead of letting a poll destroy it', async () => {
    const q = new DeliveryQueue()
    q.rescope('main')
    q.enqueueThreads(['t1'])
    q.rescope('feature')
    expect(q.take()).toBeNull()
    const attached = q.attach()
    expect(q.presence()).toBe('listening')
    q.enqueueThreads(['f1'])
    expect(await attached).toBe('data')
    expect(q.take()).toMatchObject({ kind: 'threads', threadIds: ['f1'] })
    q.confirm(q.take()!, ['f1'])
    q.rescope('main')
    expect(q.take()).toMatchObject({ kind: 'threads', threadIds: ['t1'] })
  })

  it('returning to a branch with parked feedback wakes an attached poll', async () => {
    const q = new DeliveryQueue()
    q.rescope('main')
    q.enqueueFinish({ viewedHunks: 1, totalHunks: 1, skippedFiles: [] })
    q.rescope('feature')
    const attached = q.attach()
    expect(q.presence()).toBe('listening')
    q.rescope('main')
    expect(await attached).toBe('data')
    expect(q.take()).toMatchObject({ kind: 'finish' })
  })

  it('a rescoped-away drop still removes the thread from its parked bucket', () => {
    const q = new DeliveryQueue()
    q.rescope('main')
    q.enqueueThreads(['t1', 't2'])
    q.rescope('feature')
    q.drop('t1')
    q.rescope('main')
    expect(q.take()).toMatchObject({ threadIds: ['t2'] })
  })

  it('end releases the waiter, clears working, and keeps queued feedback', async () => {
    const q = new DeliveryQueue()
    const attached = q.attach()
    q.end()
    expect(await attached).toBe('ended')
    expect(q.presence()).toBe('waiting')

    q.enqueueThreads(['t1'])
    q.confirm(q.take()!, ['t1'])
    expect(q.presence()).toBe('working')
    q.end()
    expect(q.presence()).toBe('waiting')
    q.enqueueThreads(['t2'])
    expect(q.take()).toMatchObject({ threadIds: ['t2'] })
  })
})

describe('DeliveryQueue presence honesty', () => {
  it("a re-poll before replying stays 'working' — listening no longer masks it", async () => {
    const q = new DeliveryQueue()
    q.enqueueThreads(['t1'])
    q.confirm(q.take()!, ['t1'])
    expect(q.presence()).toBe('working')

    void q.attach()
    expect(q.presence()).toBe('working')
    expect(q.presenceDetail().reason).toBe('delivered')

    q.agentReplied('t1')
    expect(q.presence()).toBe('listening')
    expect(q.presenceDetail().reason).toBe('polling')
  })

  it('an unanswered delivery is reported, not acted on — the agent still has it', async () => {
    const q = new DeliveryQueue(10)
    q.enqueueThreads(['t1'])
    q.confirm(q.take()!, ['t1'])
    expect(q.presenceDetail().reason).toBe('delivered')

    await new Promise((r) => setTimeout(r, 30))
    expect(q.presence()).toBe('working')
    expect(q.presenceDetail().reason).toBe('stalled')
  })

  it('a stalled delivery is concluded by the reply, however late', async () => {
    const q = new DeliveryQueue(10, 10)
    q.enqueueThreads(['t1'])
    q.confirm(q.take()!, ['t1'])
    await new Promise((r) => setTimeout(r, 30))
    expect(q.presenceDetail().reason).toBe('stalled')

    q.agentReplied('t1')
    expect(q.presence()).toBe('working')
    expect(q.presenceDetail().reason).toBe('replied')
    await new Promise((r) => setTimeout(r, 30))
    expect(q.presence()).toBe('waiting')
    expect(q.presenceDetail().reason).toBe('no-agent')
  })

  it('a fresh delivery un-stalls and restarts the clock', async () => {
    const q = new DeliveryQueue(30)
    q.enqueueThreads(['t1'])
    q.confirm(q.take()!, ['t1'])
    await new Promise((r) => setTimeout(r, 50))
    expect(q.presenceDetail().reason).toBe('stalled')

    q.enqueueThreads(['t2'])
    q.confirm(q.take()!, ['t2'])
    expect(q.presence()).toBe('working')
    expect(q.presenceDetail().reason).toBe('delivered')
  })

  it('reason separates a polite end from a poll that died', async () => {
    const ended = new DeliveryQueue()
    void ended.attach()
    ended.end()
    expect(ended.presenceDetail()).toMatchObject({ state: 'waiting', reason: 'ended' })

    const dropped = new DeliveryQueue()
    let detach = () => {}
    void dropped.attach((d) => {
      detach = d
    })
    expect(dropped.presenceDetail().reason).toBe('polling')
    detach()
    expect(dropped.presenceDetail()).toMatchObject({ state: 'waiting', reason: 'disconnected' })

    void dropped.attach()
    expect(dropped.presenceDetail().reason).toBe('polling')
  })

  it('since marks when the current state began, and does not move on a repeat', async () => {
    const q = new DeliveryQueue()
    const first = q.presenceDetail().since
    await new Promise((r) => setTimeout(r, 5))
    q.enqueueThreads(['t1'])
    expect(q.presenceDetail().since).toBe(first)

    q.confirm(q.take()!, ['t1'])
    expect(q.presenceDetail().since).toBeGreaterThanOrEqual(first)
    expect(q.presenceDetail().state).toBe('working')
  })
})

describe('DeliveryQueue batch boundary', () => {
  const eager = () => new DeliveryQueue(5 * 60_000, 5 * 60_000, {}, 0)

  const closes = (q: DeliveryQueue) => {
    const seen: Parameters<Parameters<DeliveryQueue['onBatchClosed']>[0]>[0][] = []
    q.onBatchClosed((c) => seen.push(c))
    return seen
  }

  it("the agent's next poll closes the batch and names what it never answered", async () => {
    const q = eager()
    const closed = closes(q)
    q.enqueueThreads(['t1', 't2', 't3'])
    q.confirm(q.take()!, ['t1', 't2', 't3'])
    q.agentReplied('t2')
    expect(q.deliveredThreadIds()).toEqual(['t1', 't3'])

    void q.attach()
    expect(closed).toHaveLength(1)
    expect(closed[0]!.reason).toBe('repoll')
    expect(closed[0]!.threadIds).toEqual(['t1', 't2', 't3'])
    expect(closed[0]!.unanswered).toEqual(['t1', 't3'])
    expect(q.deliveredThreadIds()).toEqual([])
    expect(closed[0]!.closedAt).toBeGreaterThanOrEqual(closed[0]!.deliveredAt)
  })

  it('currentBatch is the flight, not the ledger: fills as replies land, gone when the poll closes it', () => {
    const q = eager()
    expect(q.currentBatch()).toBeNull()
    q.enqueueThreads(['t1', 't2'])
    q.confirm(q.take()!, ['t1', 't2'])
    expect(q.currentBatch()).toEqual({ threadIds: ['t1', 't2'], answered: [] })
    q.agentReplied('t1')
    expect(q.currentBatch()).toEqual({ threadIds: ['t1', 't2'], answered: ['t1'] })
    q.agentReplied('t2')
    expect(q.currentBatch()).toEqual({ threadIds: ['t1', 't2'], answered: ['t1', 't2'] })
    void q.attach()
    expect(q.currentBatch()).toBeNull()
  })

  it('a no-work re-poll that picks up more keeps the older threads in the flight', () => {
    const q = new DeliveryQueue(5 * 60_000, 5 * 60_000, {}, 60_000)
    q.enqueueThreads(['t1', 't2'])
    q.confirm(q.take()!, ['t1', 't2'])
    q.enqueueThreads(['t3'])
    void q.attach()
    const snapshot = q.take()
    if (snapshot) q.confirm(snapshot, ['t3'])
    const batch = q.currentBatch()!
    expect(new Set(batch.threadIds)).toEqual(new Set(['t1', 't2', 't3']))
    expect(batch.answered).toEqual([])
  })

  it('a re-attach with nothing to show for itself is not a finished batch', async () => {
    const q = new DeliveryQueue(5 * 60_000, 5 * 60_000, {}, 60_000)
    const closed = closes(q)
    q.enqueueThreads(['t1'])
    q.confirm(q.take()!, ['t1'])
    void q.attach()
    expect(closed).toHaveLength(0)
    expect(q.deliveredThreadIds()).toEqual(['t1'])
  })

  it('a reply beats the clock — proof of work closes the batch however fast', async () => {
    const q = new DeliveryQueue(5 * 60_000, 5 * 60_000, {}, 60_000)
    const closed = closes(q)
    q.enqueueThreads(['t1', 't2'])
    q.confirm(q.take()!, ['t1', 't2'])
    q.agentReplied('t1')
    void q.attach()
    expect(closed).toHaveLength(1)
    expect(closed[0]!.unanswered).toEqual(['t2'])
  })

  it('`diffo end` closes the batch it was holding', () => {
    const q = eager()
    const closed = closes(q)
    q.enqueueThreads(['t1'])
    q.confirm(q.take()!, ['t1'])
    q.end()
    expect(closed).toHaveLength(1)
    expect(closed[0]!.reason).toBe('ended')
    expect(closed[0]!.unanswered).toEqual(['t1'])
  })

  it('a session that dies holding a batch closes it — the forever-typing case', async () => {
    let alive = true
    const q = new DeliveryQueue(5 * 60_000, 5 * 60_000, { isAlive: () => alive, checkEveryMs: 5 })
    const closed = closes(q)
    q.claimSession(4242)
    q.enqueueThreads(['t1'])
    q.confirm(q.take()!, ['t1'])
    await new Promise((r) => setTimeout(r, 25))
    expect(closed).toHaveLength(0)
    alive = false
    await new Promise((r) => setTimeout(r, 25))
    expect(closed).toHaveLength(1)
    expect(closed[0]!.reason).toBe('gone')
    expect(closed[0]!.unanswered).toEqual(['t1'])
    expect(q.presence()).toBe('waiting')
  })

  it('a thread deleted mid-batch is not reported unanswered', () => {
    const q = eager()
    const closed = closes(q)
    q.enqueueThreads(['t1', 't2'])
    q.confirm(q.take()!, ['t1', 't2'])
    q.drop('t2')
    void q.attach()
    expect(closed[0]!.threadIds).toEqual(['t1'])
    expect(closed[0]!.unanswered).toEqual(['t1'])
  })

  it('every thread answered still waits for the re-poll — code edits land after replies', () => {
    const q = eager()
    const closed = closes(q)
    q.enqueueThreads(['t1'])
    q.confirm(q.take()!, ['t1'])
    q.agentReplied('t1')
    expect(closed).toHaveLength(0)
    void q.attach()
    expect(closed).toHaveLength(1)
    expect(closed[0]!.unanswered).toEqual([])
  })

  it('a poll with no batch outstanding closes nothing', async () => {
    const q = eager()
    const closed = closes(q)
    void q.attach()
    q.enqueueThreads(['t1'])
    expect(closed).toHaveLength(0)
  })
})

describe('DeliveryQueue — a listening poll whose session died', () => {
  const watched = (alive: () => boolean) =>
    new DeliveryQueue(5 * 60_000, 5 * 60_000, { isAlive: alive, checkEveryMs: 5 })

  it("releases the waiter as 'gone' and stops reading as listening", async () => {
    let alive = true
    const q = watched(() => alive)
    q.claimSession(4242)
    const attached = q.attach()
    await new Promise((r) => setTimeout(r, 15))
    expect(q.presence()).toBe('listening')

    alive = false
    expect(await attached).toBe('gone')
    expect(q.presence()).toBe('waiting')
    expect(q.hasListener()).toBe(false)
  })

  it('leaves a live session attached however long it waits', async () => {
    const q = watched(() => true)
    q.claimSession(4242)
    let outcome: string | null = null
    void q.attach().then((o) => (outcome = o))
    await new Promise((r) => setTimeout(r, 40))
    expect(outcome).toBeNull()
    expect(q.presence()).toBe('listening')
  })

  it('never probes when the session is unknown — the fixed windows still apply', async () => {
    let probes = 0
    const q = new DeliveryQueue(5 * 60_000, 5 * 60_000, {
      isAlive: () => {
        probes++
        return false
      },
      checkEveryMs: 5,
    })
    q.claimSession(null)
    let outcome: string | null = null
    void q.attach().then((o) => (outcome = o))
    await new Promise((r) => setTimeout(r, 40))
    expect(probes).toBe(0)
    expect(outcome).toBeNull()
    expect(q.presence()).toBe('listening')
  })

  it('stops watching once the poll is released, whatever released it', async () => {
    let probes = 0
    const q = new DeliveryQueue(5 * 60_000, 5 * 60_000, {
      isAlive: () => {
        probes++
        return true
      },
      checkEveryMs: 5,
    })
    q.claimSession(4242)
    void q.attach()
    await new Promise((r) => setTimeout(r, 20))
    expect(probes).toBeGreaterThan(0)
    q.end()
    const after = probes
    await new Promise((r) => setTimeout(r, 30))
    expect(probes).toBe(after)
  })
})

describe('DeliveryQueue — two sessions, one review', () => {
  const shared = (dead: Set<number> = new Set()) =>
    new DeliveryQueue(5 * 60_000, 5 * 60_000, {
      isAlive: (pid) => !dead.has(pid),
      checkEveryMs: 5,
    })

  it('lets the second session attach, and names who it took the review from', async () => {
    const q = shared()
    expect(q.claimSession(111)).toBeNull()
    void q.attach()
    await new Promise((r) => setTimeout(r, 10))
    expect(q.claimSession(222)).toBe(111)
    expect(q.ownerPid()).toBe(222)
  })

  it('releases the previous session as superseded rather than leaving it hanging', async () => {
    const q = shared()
    q.claimSession(111)
    let outcome: string | null = null
    void q.attach().then((o) => (outcome = o))
    await new Promise((r) => setTimeout(r, 10))

    q.claimSession(222)
    void q.attach()
    await new Promise((r) => setTimeout(r, 10))
    expect(outcome).toBe('superseded')
  })

  it('says nothing about a session that was never connected', () => {
    const q = shared()
    q.claimSession(111)
    expect(q.claimSession(222)).toBeNull()
  })

  it('says nothing about a hand-off from a dead session', async () => {
    const dead = new Set<number>()
    const q = shared(dead)
    q.claimSession(111)
    void q.attach()
    await new Promise((r) => setTimeout(r, 10))
    dead.add(111)
    expect(q.claimSession(222)).toBeNull()
  })

  it('reports nothing when the SAME session re-polls', async () => {
    const q = shared()
    q.claimSession(111)
    const first = q.attach()
    await new Promise((r) => setTimeout(r, 10))
    expect(q.claimSession(111)).toBeNull()
    void q.attach()
    expect(await first).toBe('superseded')
  })

  it("ignores a non-owner's reply instead of retargeting the liveness watch", async () => {
    const dead = new Set<number>()
    const q = shared(dead)
    q.claimSession(111)
    let outcome: string | null = null
    void q.attach().then((o) => (outcome = o))
    await new Promise((r) => setTimeout(r, 10))

    q.noteSession(222)
    dead.add(222)
    await new Promise((r) => setTimeout(r, 20))
    expect(outcome).toBeNull()
    expect(q.ownerPid()).toBe(111)
  })

  it("refuses a non-owner's end, leaving the attached session alone", async () => {
    const q = shared()
    q.claimSession(111)
    let outcome: string | null = null
    void q.attach().then((o) => (outcome = o))
    await new Promise((r) => setTimeout(r, 10))

    expect(q.end(222)).toBe(false)
    await new Promise((r) => setTimeout(r, 10))
    expect(outcome).toBeNull()
    expect(q.presence()).toBe('listening')

    expect(q.end(111)).toBe(true)
    await new Promise((r) => setTimeout(r, 10))
    expect(outcome).toBe('ended')
    expect(q.ownerPid()).toBeNull()
  })

  it('lets any session end the review once nobody is connected', () => {
    const q = shared()
    q.claimSession(111)
    expect(q.end(222)).toBe(true)
  })

  it('reports nothing when the session cannot be named', () => {
    const q = shared()
    expect(q.claimSession(null)).toBeNull()
    expect(q.ownerPid()).toBeNull()
  })
})
