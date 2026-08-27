import type { Coverage } from '../shared/review.js'

export type Presence = 'waiting' | 'listening' | 'working'

export type PresenceReason =
  | 'no-agent'
  | 'polling'
  | 'delivered'
  | 'stalled'
  | 'replied'
  | 'ended'
  | 'disconnected'

export interface PresenceDetail {
  state: Presence
  reason: PresenceReason
  /** Epoch ms when this (state, reason) pair began. */
  since: number
}

export const STALL_AFTER_MS = 5 * 60_000

export const REPLY_GRACE_MS = 90_000

export const GRACE_CHECK_MS = 5_000

export const SESSION_GRACE_CAP_MS = 10 * 60_000

/** A re-poll within this window of a delivery reads as "hasn't started yet". */
export const BATCH_SETTLE_MS = 2_000

export type BatchCloseReason = 'repoll' | 'ended' | 'gone'

export interface BatchClosed {
  threadIds: string[]
  unanswered: string[]
  /** Epoch ms. */
  deliveredAt: number
  closedAt: number
  reason: BatchCloseReason
}

/** Signal 0 probes existence without touching the process; EPERM still proves it exists. */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

export type AttachOutcome = 'data' | 'superseded' | 'ended' | 'gone'

export type Snapshot =
  | { kind: 'threads'; threadIds: string[] }
  | { kind: 'finish'; coverage: Coverage; absorbedThreadIds: string[] }
  | { kind: 'cleared' }

interface ScopePending {
  threads: Set<string>
  finish: Coverage | null
  /** The reviewer started the review over — the agent is owed a heads-up (and
   * a chance to post a fresh guide). Rides behind real feedback: take() only
   * surfaces it once nothing else is pending. */
  cleared: boolean
}

export class DeliveryQueue {
  private buckets = new Map<string, ScopePending>()
  private scope = ''
  private waiter: ((outcome: AttachOutcome) => void) | null = null
  private awaitingReply = false
  /** Thread id -> epoch ms it was delivered. */
  private deliveredAt = new Map<string, number>()
  private listeners = new Set<(presence: Presence) => void>()
  private stalled = false
  private stallTimer: ReturnType<typeof setTimeout> | null = null
  private betweenPolls = false
  private graceTimer: ReturnType<typeof setTimeout> | null = null
  private lastDetach: 'ended' | 'disconnected' | null = null
  private since = Date.now()
  private lastDetail: { state: Presence; reason: PresenceReason } = {
    state: 'waiting',
    reason: 'no-agent',
  }

  private owner: number | null = null

  private batch: { threadIds: string[]; deliveredAt: number; sawReply: boolean } | null = null
  private batchWatch: ReturnType<typeof setInterval> | null = null
  private waiterWatch: ReturnType<typeof setInterval> | null = null
  private batchListeners = new Set<(closed: BatchClosed) => void>()

  constructor(
    private stallAfterMs: number = STALL_AFTER_MS,
    private replyGraceMs: number = REPLY_GRACE_MS,
    private liveness: {
      isAlive?: (pid: number) => boolean
      checkEveryMs?: number
      capMs?: number
    } = {},
    private batchSettleMs: number = BATCH_SETTLE_MS,
  ) {}

  onBatchClosed(listener: (closed: BatchClosed) => void): () => void {
    this.batchListeners.add(listener)
    return () => this.batchListeners.delete(listener)
  }

  private closeBatch(reason: BatchCloseReason): void {
    const batch = this.batch
    if (!batch) return
    const closed: BatchClosed = {
      threadIds: batch.threadIds,
      // Whatever is still on the clock never got a reply.
      unanswered: [...this.deliveredAt.keys()],
      deliveredAt: batch.deliveredAt,
      closedAt: Date.now(),
      reason,
    }
    this.batch = null
    this.deliveredAt.clear()
    this.awaitingReply = false
    this.stalled = false
    this.clearStall()
    this.clearBatchWatch()
    for (const listener of this.batchListeners) listener(closed)
  }

  private armBatchWatch(): void {
    this.clearBatchWatch()
    const isAlive = this.liveness.isAlive ?? pidAlive
    const timer = setInterval(() => {
      if (!this.batch) return this.clearBatchWatch()
      const pid = this.owner
      if (pid === null || isAlive(pid)) return
      this.closeBatch('gone')
      this.notify()
    }, this.liveness.checkEveryMs ?? GRACE_CHECK_MS)
    timer.unref?.()
    this.batchWatch = timer
  }

  private clearBatchWatch(): void {
    if (this.batchWatch !== null) clearInterval(this.batchWatch)
    this.batchWatch = null
  }

  private static clean(pid: number | null): number | null {
    return pid !== null && Number.isInteger(pid) && pid > 1 ? pid : null
  }

  private ownerConnected(): boolean {
    if (this.owner === null) return false
    if (this.waiter === null && this.batch === null) return false
    const isAlive = this.liveness.isAlive ?? pidAlive
    return isAlive(this.owner)
  }

  ownerPid(): number | null {
    return this.ownerConnected() ? this.owner : null
  }

  /**
   * A poll attaches for its session; the newest poll always carries the review.
   * Returns the pid of a still-live session it took the review from, so both
   * sides can say a hand-off happened. Null when the review was free.
   */
  claimSession(pid: number | null): number | null {
    const claimant = DeliveryQueue.clean(pid)
    const previous = this.ownerConnected() ? this.owner : null
    this.owner = claimant
    return previous !== null && previous !== claimant ? previous : null
  }

  /**
   * A non-poll verb (a `reply`) named its session. It may adopt an unowned
   * review, but never take one off the session that holds it.
   */
  noteSession(pid: number | null): void {
    const caller = DeliveryQueue.clean(pid)
    if (caller === null) return
    if (this.owner === null) this.owner = caller
  }

  private bucket(): ScopePending {
    let bucket = this.buckets.get(this.scope)
    if (!bucket) {
      bucket = { threads: new Set(), finish: null, cleared: false }
      this.buckets.set(this.scope, bucket)
    }
    return bucket
  }

  rescope(scope: string): void {
    if (scope === this.scope) return
    this.scope = scope
    if (this.hasPending() && this.waiter !== null) this.wake()
    else this.notify()
  }

  presence(): Presence {
    // 'working' outranks 'listening': an agent that re-polls before answering is
    // still holding the reviewer's feedback, and that is the more useful fact.
    // A stall does NOT drop out of 'working' — a slow agent is indistinguishable
    // from a dead one, so `reason`/`since` carry how long it has been quiet.
    if (this.awaitingReply) return 'working'
    if (this.waiter) return 'listening'
    if (this.betweenPolls) return 'working'
    return 'waiting'
  }

  presenceDetail(): PresenceDetail {
    return { state: this.presence(), reason: this.reason(), since: this.since }
  }

  private reason(): PresenceReason {
    if (this.awaitingReply) return this.stalled ? 'stalled' : 'delivered'
    if (this.waiter) return 'polling'
    if (this.betweenPolls) return 'replied'
    return this.lastDetach ?? 'no-agent'
  }

  hasListener(): boolean {
    return this.waiter !== null
  }

  deliveredThreadIds(): string[] {
    return [...this.deliveredAt.keys()]
  }

  currentBatch(): { threadIds: string[]; answered: string[] } | null {
    if (!this.batch) return null
    // A re-poll mid-batch replaces `batch.threadIds` with the newest delivery, so
    // union in whatever is still on the clock — the older threads are still owed.
    const ids = new Set(this.batch.threadIds)
    for (const id of this.deliveredAt.keys()) ids.add(id)
    return {
      threadIds: [...ids],
      answered: [...ids].filter((id) => !this.deliveredAt.has(id)),
    }
  }

  queuedThreadIds(): string[] {
    return [...(this.buckets.get(this.scope)?.threads ?? [])]
  }

  subscribe(listener: (presence: Presence) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private notify(): void {
    const state = this.presence()
    const reason = this.reason()
    const prev = this.lastDetail
    // `since` marks when this (state, reason) began, so it must NOT move on a repeat.
    if (prev.state !== state || prev.reason !== reason) {
      this.since = Date.now()
      this.lastDetail = { state, reason }
    }
    for (const listener of this.listeners) listener(state)
  }

  private armStall(): void {
    this.clearStall()
    const timer = setTimeout(() => {
      this.stallTimer = null
      if (!this.awaitingReply || this.stalled) return
      this.stalled = true
      this.notify()
    }, this.stallAfterMs)
    timer.unref?.()
    this.stallTimer = timer
  }

  private clearStall(): void {
    if (this.stallTimer !== null) clearTimeout(this.stallTimer)
    this.stallTimer = null
  }

  private armGrace(): void {
    this.clearGrace()
    this.betweenPolls = true
    const drop = () => {
      this.graceTimer = null
      if (!this.betweenPolls) return
      this.betweenPolls = false
      this.notify()
    }
    const pid = this.owner
    if (pid === null) {
      const timer = setTimeout(drop, this.replyGraceMs)
      timer.unref?.()
      this.graceTimer = timer
      return
    }
    const isAlive = this.liveness.isAlive ?? pidAlive
    const capMs = this.liveness.capMs ?? SESSION_GRACE_CAP_MS
    const startedAt = Date.now()
    const timer = setInterval(() => {
      if (!this.betweenPolls) {
        this.clearGrace()
        return
      }
      if (!isAlive(pid) || Date.now() - startedAt >= capMs) {
        clearInterval(timer)
        drop()
      }
    }, this.liveness.checkEveryMs ?? GRACE_CHECK_MS)
    timer.unref?.()
    this.graceTimer = timer
  }

  private clearGrace(): void {
    // Node returns the same Timeout type for both; clearInterval stops either.
    if (this.graceTimer !== null) clearInterval(this.graceTimer)
    this.graceTimer = null
    this.betweenPolls = false
  }

  enqueueThreads(threadIds: string[]): void {
    const bucket = this.bucket()
    for (const id of threadIds) bucket.threads.add(id)
    const queued = this.waiter === null
    this.wake()
    if (queued) this.notify()
  }

  enqueueFinish(coverage: Coverage): void {
    this.bucket().finish = coverage
    this.wake()
  }

  /** The reviewer cleared the review. A boolean, not a queue: clearing twice
   * before a poll still owes exactly one heads-up. */
  enqueueCleared(): void {
    this.bucket().cleared = true
    const queued = this.waiter === null
    this.wake()
    if (queued) this.notify()
  }

  drop(threadId: string): void {
    for (const bucket of this.buckets.values()) bucket.threads.delete(threadId)
    this.deliveredAt.delete(threadId)
    if (this.batch) this.batch.threadIds = this.batch.threadIds.filter((id) => id !== threadId)
    this.notify()
  }

  /**
   * Attach a poll. Resolves 'data' when there is feedback to take (possibly
   * immediately), 'superseded' when a newer poll replaces this one, 'ended' on
   * `diffo end`, or 'gone' when the agent's session dies while this poll waits.
   */
  attach(onAbort?: (detach: () => void) => void): Promise<AttachOutcome> {
    this.releaseWaiter('superseded')
    this.clearGrace()
    if (this.batch !== null) {
      const worked =
        this.batch.sawReply || Date.now() - this.batch.deliveredAt >= this.batchSettleMs
      if (worked) this.closeBatch('repoll')
    }
    if (this.hasPending()) return Promise.resolve('data')
    return new Promise((resolve) => {
      const waiter = (outcome: AttachOutcome) => resolve(outcome)
      this.waiter = waiter
      this.lastDetach = null
      this.armWaiterWatch()
      this.notify()
      onAbort?.(() => {
        if (this.waiter === waiter) {
          this.releaseWaiter(null)
          this.lastDetach = 'disconnected'
          this.notify()
        }
      })
    })
  }

  private releaseWaiter(outcome: AttachOutcome | null): void {
    const waiter = this.waiter
    this.waiter = null
    this.clearWaiterWatch()
    if (waiter && outcome !== null) waiter(outcome)
  }

  private armWaiterWatch(): void {
    this.clearWaiterWatch()
    const isAlive = this.liveness.isAlive ?? pidAlive
    const timer = setInterval(() => {
      if (this.waiter === null) return this.clearWaiterWatch()
      const pid = this.owner
      if (pid === null || isAlive(pid)) return
      this.releaseWaiter('gone')
      this.lastDetach = 'disconnected'
      this.notify()
    }, this.liveness.checkEveryMs ?? GRACE_CHECK_MS)
    timer.unref?.()
    this.waiterWatch = timer
  }

  private clearWaiterWatch(): void {
    if (this.waiterWatch !== null) clearInterval(this.waiterWatch)
    this.waiterWatch = null
  }

  private hasPending(): boolean {
    const bucket = this.buckets.get(this.scope)
    return (
      bucket !== undefined && (bucket.threads.size > 0 || bucket.finish !== null || bucket.cleared)
    )
  }

  private wake(): void {
    if (this.waiter === null) return
    this.releaseWaiter('data')
  }

  /**
   * Peek at everything pending WITHOUT removing it. A pooled Finish wins: its
   * prompt already carries every sent thread, so per-thread items are absorbed.
   */
  take(): Snapshot | null {
    const bucket = this.buckets.get(this.scope)
    if (!bucket) return null
    if (bucket.finish !== null) {
      return {
        kind: 'finish',
        coverage: bucket.finish,
        absorbedThreadIds: [...bucket.threads],
      }
    }
    if (bucket.threads.size > 0) return { kind: 'threads', threadIds: [...bucket.threads] }
    // Real feedback outranks the heads-up: a cleared notice only surfaces once
    // nothing else is owed, and survives in the bucket until then.
    if (bucket.cleared) return { kind: 'cleared' }
    return null
  }

  /** The poll response for this snapshot was fully written — NOW it counts as
   * delivered. Clears exactly what the snapshot covered. */
  confirm(snapshot: Snapshot, deliveredThreadIds: string[]): void {
    if (snapshot.kind === 'cleared') {
      // No batch, no reply owed: the agent may post a guide and re-poll, which
      // is what the grace window already models.
      const bucket = this.buckets.get(this.scope)
      if (bucket) bucket.cleared = false
      this.armGrace()
      this.notify()
      return
    }
    for (const bucket of this.buckets.values()) {
      if (snapshot.kind === 'finish') {
        if (bucket.finish === snapshot.coverage) bucket.finish = null
        for (const id of snapshot.absorbedThreadIds) bucket.threads.delete(id)
      } else {
        for (const id of snapshot.threadIds) bucket.threads.delete(id)
      }
    }
    const now = Date.now()
    for (const id of deliveredThreadIds) this.deliveredAt.set(id, now)
    this.awaitingReply = true
    this.batch = { threadIds: [...deliveredThreadIds], deliveredAt: now, sawReply: false }
    this.armBatchWatch()
    this.stalled = false
    this.armStall()
    this.notify()
  }

  /** The agent replied on a thread. Returns how long since that thread's feedback
   * was delivered, or null when the reply wasn't an answer to a delivery. */
  agentReplied(threadId: string): number | null {
    const at = this.deliveredAt.get(threadId)
    this.deliveredAt.delete(threadId)
    if (this.batch) this.batch.sawReply = true
    if (this.deliveredAt.size > 0) {
      if (this.awaitingReply) {
        this.stalled = false
        this.armStall()
        this.notify()
      }
    } else if (this.awaitingReply || this.stalled || this.betweenPolls) {
      this.awaitingReply = false
      this.stalled = false
      this.clearStall()
      this.armGrace()
      this.notify()
    }
    return at === undefined ? null : Date.now() - at
  }

  end(sessionPid: number | null = null): boolean {
    const caller = DeliveryQueue.clean(sessionPid)
    if (caller !== null && caller !== this.owner && this.ownerConnected()) {
      return false
    }
    this.owner = null
    this.releaseWaiter('ended')
    this.closeBatch('ended')
    this.awaitingReply = false
    this.stalled = false
    this.clearStall()
    this.clearGrace()
    this.deliveredAt.clear()
    this.lastDetach = 'ended'
    this.notify()
    return true
  }
}
