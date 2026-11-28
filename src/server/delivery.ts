import { type ArtifactReport, REPORT_ISSUES_MAX } from '../shared/artifacts.js'
import type { Coverage } from '../shared/review.js'

export type Presence = 'waiting' | 'listening' | 'working'

export type PresenceReason =
  | 'no-agent'
  | 'arriving'
  | 'polling'
  | 'delivered'
  | 'stalled'
  | 'replied'
  | 'repolling'
  | 'ended'
  | 'disconnected'

export interface PresenceDetail {
  state: Presence
  reason: PresenceReason
  /** Epoch ms when this (state, reason) pair began. */
  since: number
  /** A poll is attached right now, whatever the state: a `working` agent that
   * is also listening hears a new send mid-work; one that is not hears it
   * when it polls next. */
  listening: boolean
}

export const STALL_AFTER_MS = 5 * 60_000

export const REPLY_GRACE_MS = 90_000

export const GRACE_CHECK_MS = 5_000

export const SESSION_GRACE_CAP_MS = 10 * 60_000

/** How long an agent that opened the review (and has no session pid to watch)
 * is taken at its word that it is reading the change before its first poll.
 * Longer than a reply's grace: the guide is written from a cold read of the
 * whole changeset. */
export const ARRIVE_GRACE_MS = 5 * 60_000

/** An outline owed this long with no post reads as stalled: the reviewer gets
 * the reason and their button back instead of "Outlining…" for good. Shorter
 * than a reply's stall — an agent whose harness refused the post is told to
 * stop. Owed twice this long, the request lapses: a poll no longer ends it,
 * so the clock is the only thing that can. */
export const OUTLINE_STALL_MS = 3 * 60_000

/** How many times an owed thread is handed to the agent again (one per stall
 * window with no reply) before the review stops waiting on it and says "no
 * answer". */
export const REMINDER_MAX = 3

/** Edits in the working tree read as the agent at work and push the stall
 * clock back, but never past this from the clock's start: a tree that never
 * stops changing must not hold a reminder off for good. */
export const STALL_EDIT_CAP_MS = 15 * 60_000

/** While the agent is working a batch, new feedback is held this long after
 * the last send before it interrupts, so three quick Sends are one interrupt. */
export const COALESCE_MS = 8_000

/** The longest a held send waits, however many follow it. */
export const COALESCE_MAX_MS = 30_000

/** How long "answered" shows once the last owed reply lands under a poll that
 * is already listening. Without a poll the reply's grace window says it. */
export const REPLIED_MOMENT_MS = 3_000

/** Polls in a row that may end with nothing from the reviewer (timed out, or
 * cut off by the agent's harness) before the agent is told to stop and ask
 * the user whether to keep listening: an unattended agent re-polling all
 * night spends tokens on nobody. */
export const QUIET_POLL_LIMIT = 20

/**
 * Why threads left the agent's hands: every one got its reply (`answered`),
 * the reminders ran out on the ones named (`lapsed`: the rest of the batch
 * stays open), the agent detached (`ended`), or its session died (`gone`).
 * A new poll is never a reason: listening and being done are separate facts.
 */
export type BatchCloseReason = 'answered' | 'lapsed' | 'ended' | 'gone'

export interface BatchClosed {
  threadIds: string[]
  unanswered: string[]
  /** Epoch ms. */
  deliveredAt: number
  closedAt: number
  reason: BatchCloseReason
}

/** Signal 0 probes existence without touching the process; EPERM still proves it exists. */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/**
 * How a poll ends. `replaced` is `superseded` by the same session's own newer
 * poll; `reminder` is the stall clock running out on threads still owed.
 */
export type AttachOutcome = 'data' | 'superseded' | 'replaced' | 'ended' | 'gone' | 'reminder'

/** The knobs tests turn; production takes every default. */
export interface QueueTuning {
  outlineStallMs?: number
  coalesceMs?: number
  coalesceMaxMs?: number
  repliedMomentMs?: number
  reminderMax?: number
  editCapMs?: number
}

export type Snapshot =
  | { kind: 'threads'; threadIds: string[] }
  | { kind: 'finish'; coverage: Coverage; absorbedThreadIds: string[] }
  | { kind: 'layers'; ask: LayersAsk }
  | { kind: 'preset'; id: string }
  /** The reviewer wrote to the agent about a reviewer role: by role id, or a
   * new role's draft key. */
  | { kind: 'role'; id: string }
  | { kind: 'cleared' }
  | { kind: 'submitted'; submitted: Submitted }
  | { kind: 'artifacts'; reports: ArtifactReport[] }
  /** The reviewer asked the author agent to start reviewer agents, by role. */
  | { kind: 'reviewers'; roles: string[] }

/** The reviewer submitted the pull-request review: context for the agent, no
 * work owed. */
export interface Submitted {
  event: string
  comments: number
  body: string
  url?: string
  /** The agent's suggested review comments on this review, and what became of
   * them: posted (added and still a draft at submit), edited among those,
   * dismissed, or never decided. */
  suggestions?: {
    total: number
    posted: number
    edited: number
    dismissed: number
    undecided: number
  }
}

/** Where the reviewer's request for layers stands: parked for the next poll,
 * in the agent's hands, or nowhere. */
export type LayersRequest = 'queued' | 'outlining' | 'stalled' | null

/**
 * What the reviewer asked the layers to be (see shared/presets.ts): left to
 * the agent, a named preset, or their own words alone. `note` is what they
 * want this time only, on top of the preset; with `own` it is the whole ask.
 * `add` asks for no new layers at all, only for the code that changed since
 * to be placed in the ones the review has.
 */
export type LayersAsk =
  | { kind: 'auto'; note?: string }
  | { kind: 'preset'; id: string; note?: string }
  | { kind: 'own'; note: string }
  /** Not a new split: place what is outside the layers into the ones there. */
  | { kind: 'add' }

interface ScopePending {
  threads: Set<string>
  finish: Coverage | null
  /** The reviewer started the review over — the agent is owed a heads-up (and
   * a chance to post a fresh guide). Rides behind real feedback: take() only
   * surfaces it once nothing else is pending. */
  cleared: boolean
  /** The reviewer asked for the outline (or a fresh one), and what for. One
   * slot like `cleared`: two clicks before a poll are one request, the later
   * ask winning. */
  layers: LayersAsk | null
  /** Presets whose conversation has a reviewer message the agent has not
   * seen (Layers dialog): ids, in the order they were spoken to. */
  presets: Set<string>
  /** Reviewer roles whose conversation has a reviewer message the agent has
   * not seen (Reviewer agents page): role ids or draft keys, in order. */
  roles: Set<string>
  /** The reviewer submitted the PR review — one notice, the newest wins. */
  submitted: Submitted | null
  /** The agent's artifacts that broke in the reviewer's browser, oldest
   * first. Work the agent owes, but its own: behind the reviewer's words. */
  artifacts: ArtifactReport[]
  /** Reviewer agents the reviewer asked this agent to start, by role id, in
   * the order asked. Asking twice for one role before a poll is one ask. */
  reviewers: Set<string>
  /** The request was delivered and the outline is owed: epoch ms of the
   * delivery, or null. Per scope like the request itself — a branch switch
   * must not carry "outlining" to a review nobody asked about. No batch and no
   * reply clock: the post that answers it (`layersPosted`) ends it, or the
   * lapse two stall windows on (`watchOutlineLapse`). */
  outlining: number | null
  /** The ask the agent was last handed, until a post answers it. It outlives
   * a lapsed request: a post that comes late still answers the reviewer's
   * last ask, and carries its note. */
  asked: LayersAsk | null
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
  private outlineTimer: ReturnType<typeof setTimeout> | null = null
  private stallTimer: ReturnType<typeof setTimeout> | null = null
  private betweenPolls = false
  /** Why the agent is parked between polls: a reply just landed, its poll
   * ended on its own and the re-poll is expected, or it opened the review and
   * is still orienting itself before its first poll. */
  private parked: 'replied' | 'repolling' | 'arriving' = 'replied'
  private graceTimer: ReturnType<typeof setTimeout> | null = null
  private lastDetach: 'ended' | 'disconnected' | null = null
  private since = Date.now()
  private lastDetail: { state: Presence; reason: PresenceReason } = {
    state: 'waiting',
    reason: 'no-agent',
  }

  private owner: number | null = null

  /** Polls started since the reviewer last sent anything (see `QUIET_POLL_LIMIT`). */
  private quietPolls = 0

  /** The session pid that last received the full reply protocol. Later
   * deliveries to the same session carry the compact form — the full text is
   * the loop's largest recurring token cost. A takeover (new pid) or an
   * anonymous session (null pid) always gets the full form again. */
  private protocolPid: number | null = null

  private batch: { threadIds: string[]; deliveredAt: number } | null = null
  /** Thread id -> stall windows it has sat through unanswered (see `REMINDER_MAX`). */
  private strikes = new Map<string, number>()
  /** Thread id -> reminders actually written to a poll, for the payload's count. */
  private remindersSent = new Map<string, number>()
  /** The stall clock ran out on owed threads and the agent has not been told. */
  private reminderDue = false
  /** When the stall clock last started for real; edits re-arm the timer but
   * not this (see `STALL_EDIT_CAP_MS`). */
  private stallOrigin = 0
  private holdTimer: ReturnType<typeof setTimeout> | null = null
  private holdSince: number | null = null
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
      /** The anonymous arrival's window (see `agentArrived`). */
      arriveGraceMs?: number
    } = {},
    private tuning: QueueTuning = {},
  ) {}

  private get outlineStallMs(): number {
    return this.tuning.outlineStallMs ?? OUTLINE_STALL_MS
  }

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
    this.strikes.clear()
    this.remindersSent.clear()
    this.reminderDue = false
    this.awaitingReply = false
    this.stalled = false
    this.clearStall()
    this.clearBatchWatch()
    for (const listener of this.batchListeners) listener(closed)
  }

  /** Every owed thread got its answer: the batch is over, with nothing unanswered. */
  private closeIfAnswered(): void {
    if (this.batch !== null && this.deliveredAt.size === 0) this.closeBatch('answered')
  }

  /**
   * Nothing is owed any more (the last reply landed, or the last owed thread
   * was dropped or lapsed): the agent stops reading as working on a batch, and
   * whatever was held back so as not to interrupt it goes now.
   */
  private settle(): void {
    this.awaitingReply = false
    this.stalled = false
    this.reminderDue = false
    this.clearStall()
    if (this.holdTimer !== null) this.releaseHold()
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

  needsFullProtocol(): boolean {
    return this.owner === null || this.owner !== this.protocolPid
  }

  markProtocolSent(): void {
    this.protocolPid = this.owner
  }

  /**
   * A poll attaches for its session; the newest poll always carries the review.
   * Returns the pid of a still-live session it took the review from, so both
   * sides can say a hand-off happened. Null when the review was free.
   */
  claimSession(pid: number | null): number | null {
    const claimant = DeliveryQueue.clean(pid)
    const previous = this.ownerConnected() ? this.owner : null
    if (claimant !== this.owner) {
      // A different session is a fresh listener: the quiet streak was not its own.
      this.quietPolls = 0
      // And what the last session still owed is this one's now. It never saw
      // those threads, so they go out again in full rather than as a line
      // under "owed" naming ids it has no text for.
      this.requeueOwed()
    } else if (claimant !== null && this.waiter !== null) {
      // The same session started a second poll: the first is told so, not that
      // "another session" took the review.
      this.releaseWaiter('replaced')
    }
    this.owner = claimant
    return previous !== null && previous !== claimant ? previous : null
  }

  private requeueOwed(): void {
    const owed = [...this.deliveredAt.keys()]
    if (owed.length === 0) return
    const bucket = this.bucket()
    for (const id of owed) bucket.threads.add(id)
    this.batch = null
    this.deliveredAt.clear()
    this.strikes.clear()
    this.remindersSent.clear()
    this.clearBatchWatch()
    this.settle()
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
      bucket = {
        threads: new Set(),
        finish: null,
        cleared: false,
        layers: null,
        presets: new Set(),
        roles: new Set(),
        outlining: null,
        asked: null,
        submitted: null,
        artifacts: [],
        reviewers: new Set(),
      }
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
    if (this.outlining() !== null) return 'working'
    // Ahead of the waiter: with a poll already listening, the moment after the
    // last reply still reads as "answered" before it reads as listening.
    if (this.betweenPolls) return 'working'
    if (this.waiter) return 'listening'
    return 'waiting'
  }

  /** Where the reviewer's layers request stands (see `LayersRequest`). */
  layersRequest(): LayersRequest {
    if (this.outlining() !== null) return this.outlineStalled() ? 'stalled' : 'outlining'
    if (this.buckets.get(this.scope)?.layers) return 'queued'
    return null
  }

  /** The parked ask, while one is parked. */
  layersAsk(): LayersAsk | null {
    return this.buckets.get(this.scope)?.layers ?? null
  }

  /** The reviewer wrote to the agent about a preset. Rides like the layers
   * ask: parked until the next poll, behind open threads. */
  enqueuePreset(id: string): void {
    this.bucket().presets.add(id)
    this.offer()
  }

  /** The reviewer wrote to the agent about a reviewer role. Rides like a
   * preset message. */
  enqueueRole(key: string): void {
    this.bucket().roles.add(key)
    this.offer()
  }

  private outlining(): number | null {
    return this.buckets.get(this.scope)?.outlining ?? null
  }

  /** Derived, not flagged: the clock is the delivery itself, so a stall needs
   * no state to clear — only `armOutlineWatch` to announce the crossing. */
  private outlineStalled(): boolean {
    const since = this.outlining()
    return since !== null && Date.now() - since >= this.outlineStallMs
  }

  presenceDetail(): PresenceDetail {
    return {
      state: this.presence(),
      reason: this.reason(),
      since: this.since,
      listening: this.waiter !== null,
    }
  }

  private reason(): PresenceReason {
    if (this.awaitingReply) return this.stalled ? 'stalled' : 'delivered'
    if (this.outlining() !== null) return this.outlineStalled() ? 'stalled' : 'delivered'
    if (this.betweenPolls) return this.parked
    if (this.waiter) return 'polling'
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

  /**
   * The stall clock: one window with no reply. `fresh` starts it for real (a
   * delivery, a reply, a reminder handed over); an edit only pushes the timer
   * back, and `stallOrigin` keeps how long that has been going on.
   */
  private armStall(fresh = true): void {
    this.clearStall()
    if (fresh) this.stallOrigin = Date.now()
    const timer = setTimeout(() => {
      this.stallTimer = null
      if (!this.awaitingReply) return
      this.stallRanOut()
    }, this.stallAfterMs)
    timer.unref?.()
    this.stallTimer = timer
  }

  /**
   * A whole window passed with no reply. Each owed thread takes a strike. One
   * that already has `REMINDER_MAX` is given up on: the review says "no
   * answer" and stops waiting. The rest are owed a reminder, which wakes a
   * listening poll now and otherwise waits for the next one. The clock starts
   * over either way, so a thread nobody ever answers still ends, poll or no poll.
   */
  private stallRanOut(): void {
    const max = this.tuning.reminderMax ?? REMINDER_MAX
    const lapsed: string[] = []
    for (const id of this.deliveredAt.keys()) {
      const strikes = this.strikes.get(id) ?? 0
      if (strikes >= max) lapsed.push(id)
      else this.strikes.set(id, strikes + 1)
    }
    if (lapsed.length > 0) this.lapse(lapsed)
    if (this.deliveredAt.size === 0) {
      this.notify()
      return
    }
    this.stalled = true
    this.reminderDue = true
    this.armStall()
    if (this.waiter !== null) this.releaseWaiter('reminder')
    this.notify()
  }

  /** The reminders ran out on these threads: they leave the agent's hands as
   * unanswered. The batch stays open for whatever else is still owed. */
  private lapse(threadIds: string[]): void {
    const batch = this.batch
    for (const id of threadIds) {
      this.deliveredAt.delete(id)
      this.strikes.delete(id)
      this.remindersSent.delete(id)
    }
    const closed: BatchClosed = {
      threadIds,
      unanswered: threadIds,
      deliveredAt: batch?.deliveredAt ?? Date.now(),
      closedAt: Date.now(),
      reason: 'lapsed',
    }
    if (batch) batch.threadIds = batch.threadIds.filter((id) => !threadIds.includes(id))
    if (this.deliveredAt.size === 0) {
      this.batch = null
      this.clearBatchWatch()
      this.settle()
    }
    for (const listener of this.batchListeners) listener(closed)
  }

  /**
   * The working tree changed. While a batch is owed that reads as the agent at
   * work: a stall it was showing clears, and the clock is pushed back, up to
   * `STALL_EDIT_CAP_MS` from where it really started.
   */
  noteEdit(): void {
    if (!this.awaitingReply) return
    const cap = this.tuning.editCapMs ?? STALL_EDIT_CAP_MS
    if (Date.now() - this.stallOrigin >= cap) return
    if (this.stallTimer !== null) this.armStall(false)
    if (this.stalled) {
      this.stalled = false
      this.notify()
    }
  }

  private clearStall(): void {
    if (this.stallTimer !== null) clearTimeout(this.stallTimer)
    this.stallTimer = null
  }

  private armOutlineWatch(): void {
    this.clearOutlineWatch()
    const since = this.outlining()
    if (since === null) return
    this.watchOutline(since, this.outlineStallMs)
  }

  /** The crossing's witness. A lapsed or answered outline reads as such
   * already, and a re-armed one has its own timer, so only the crossing is
   * news — and it is news only once `Date.now()` agrees, because a timer can
   * fire a hair early, and a notify then would carry "delivered" to every
   * listener with nothing coming after to correct it. Early, it waits out
   * the remainder instead. */
  private watchOutline(since: number, ms: number): void {
    const timer = setTimeout(() => {
      this.outlineTimer = null
      if (this.outlining() !== since) return
      const left = since + this.outlineStallMs - Date.now()
      if (left > 0) {
        this.watchOutline(since, left)
        return
      }
      this.notify()
      this.watchOutlineLapse(since)
    }, ms)
    timer.unref?.()
    this.outlineTimer = timer
  }

  /** Stalled for a whole second window: the request lapses, so the agent stops
   * reading as working on layers that are not coming. A poll used to end this;
   * a poll now only means "listening", so the clock does. The ask is kept (see
   * `ScopePending.asked`): a post that comes late still answers it. */
  private watchOutlineLapse(since: number): void {
    const timer = setTimeout(() => {
      this.outlineTimer = null
      const bucket = this.buckets.get(this.scope)
      if (!bucket || bucket.outlining !== since) return
      bucket.outlining = null
      this.notify()
    }, this.outlineStallMs)
    timer.unref?.()
    this.outlineTimer = timer
  }

  private clearOutlineWatch(): void {
    if (this.outlineTimer !== null) clearTimeout(this.outlineTimer)
    this.outlineTimer = null
  }

  private armGrace(
    why: 'replied' | 'repolling' | 'arriving' = 'replied',
    windowMs: number = this.replyGraceMs,
  ): void {
    this.clearGrace()
    this.betweenPolls = true
    this.parked = why
    const drop = () => {
      this.graceTimer = null
      if (!this.betweenPolls) return
      this.betweenPolls = false
      this.closeIfAnswered()
      this.notify()
    }
    // A poll is already listening: there is no re-poll to wait for, only the
    // moment "answered" is on screen before the chip says listening again.
    if (this.waiter !== null) {
      const timer = setTimeout(drop, this.tuning.repliedMomentMs ?? REPLIED_MOMENT_MS)
      timer.unref?.()
      this.graceTimer = timer
      return
    }
    const pid = this.owner
    if (pid === null) {
      const timer = setTimeout(drop, windowMs)
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

  /**
   * A poll ended without `diffo end`: the poll window closed, or the process
   * died under its harness. Neither means the agent left — the CLI tells the
   * session to re-run the poll, and it usually does within moments — so the
   * reviewer keeps an agent instead of being asked to invite one again. The
   * agent parks in the same grace a reply uses: a named session is watched
   * until its process is gone (or the cap), an unnamed one gets the fixed
   * window. Only a session that is already dead reads as gone at once. When
   * the grace runs out without a re-poll, the reason it fell to waiting is
   * still the dead poll.
   */
  private pollDropped(): void {
    this.lastDetach = 'disconnected'
    const pid = this.owner
    const isAlive = this.liveness.isAlive ?? pidAlive
    const sessionGone = pid !== null && !isAlive(pid)
    // Mid-batch the batch already says working, and an outline in progress
    // says so too; the grace is for the poll that was the only thing holding
    // the agent.
    if (!sessionGone && !this.awaitingReply && this.outlining() === null) {
      this.armGrace('repolling')
    }
    this.notify()
  }

  /**
   * An agent's CLI opened this review. The agent reads the change and writes
   * its guide before it ever polls, which can take minutes — and a reviewer who
   * opened the URL meanwhile must not be told there is no agent and offered an
   * Invite. So from the open until the first poll the agent is 'working', for
   * the reason 'arriving': a named session is watched until its process is gone
   * (or the cap), an anonymous one gets a fixed window. The first poll ends it
   * the way it ends every grace. An agent already here in any state is left
   * alone — a second open is not a second agent. Returns whether it took.
   */
  agentArrived(pid: number | null): boolean {
    if (this.presence() !== 'waiting') return false
    // Nobody is connected (waiting says so), so whatever owner is on record is
    // history: the arriving session is the one to watch.
    this.owner = DeliveryQueue.clean(pid)
    this.lastDetach = null
    this.armGrace('arriving', this.liveness.arriveGraceMs ?? ARRIVE_GRACE_MS)
    this.notify()
    return true
  }

  enqueueThreads(threadIds: string[]): void {
    const bucket = this.bucket()
    for (const id of threadIds) bucket.threads.add(id)
    this.offer()
  }

  enqueueFinish(coverage: Coverage): void {
    this.bucket().finish = coverage
    // The reviewer is done reading: the whole batch goes now, held or not.
    this.wake(true)
  }

  /** The reviewer cleared the review. A boolean, not a queue: clearing twice
   * before a poll still owes exactly one heads-up. */
  enqueueCleared(): void {
    this.bucket().cleared = true
    this.offer()
  }

  /** The reviewer submitted the PR review. A notice, not feedback: it rides
   * behind everything else and owes the agent no reply. */
  enqueueSubmitted(submitted: Submitted): void {
    this.bucket().submitted = submitted
    this.offer()
  }

  /** An agent artifact broke in the reviewer's browser. Reports for the same
   * artifact merge, so a poll names each broken artifact once. */
  enqueueArtifact(report: ArtifactReport): void {
    const bucket = this.bucket()
    const same = bucket.artifacts.findIndex(
      (r) => r.index === report.index && JSON.stringify(r.owner) === JSON.stringify(report.owner),
    )
    if (same >= 0) {
      const prev = bucket.artifacts[same]!
      const issues = [
        ...prev.issues,
        ...report.issues.filter((i) => !prev.issues.includes(i)),
      ].slice(0, REPORT_ISSUES_MAX)
      bucket.artifacts[same] = { ...prev, issues }
    } else bucket.artifacts.push({ ...report, issues: report.issues.slice(0, REPORT_ISSUES_MAX) })
    this.offer()
  }

  /** The reviewer asked for a reviewer agent in this role, started by the
   * author agent. Rides like a preset message: parked until the next poll,
   * behind the threads the reviewer is already owed an answer on. */
  enqueueReviewer(role: string): void {
    this.bucket().reviewers.add(role)
    this.offer()
  }

  /** The reviewer cleared a preset's conversation, or deleted the preset: a
   * message about it still parked for the agent has nothing left to answer. */
  dropPreset(id: string): void {
    for (const bucket of this.buckets.values()) bucket.presets.delete(id)
    this.notify()
  }

  /** The reviewer cleared a role's conversation, or deleted the role: a
   * message about it still parked for the agent has nothing left to answer. */
  dropRole(key: string): void {
    for (const bucket of this.buckets.values()) bucket.roles.delete(key)
    this.notify()
  }

  /** The reviewer asked for layers — the outline, or a fresh one. Rides like
   * the cleared heads-up: a boolean per scope, surfaced once real feedback is
   * answered. */
  enqueueLayers(ask: LayersAsk = { kind: 'auto' }): void {
    const bucket = this.bucket()
    bucket.layers = ask
    // Asking again over a stalled outline withdraws it: the click means "that
    // one is not coming", and the ask reads as parked for the next poll.
    if (this.outlineStalled()) {
      bucket.outlining = null
      this.clearOutlineWatch()
    }
    this.offer()
  }

  /** The reviewer cleared the review: whatever request was standing is
   * withdrawn — parked or already in the agent's hands. A post that arrives
   * anyway still lands; the store does not consult the queue. */
  dropLayers(): void {
    const bucket = this.buckets.get(this.scope)
    if (bucket) {
      bucket.layers = null
      bucket.outlining = null
      bucket.asked = null
    }
    this.clearOutlineWatch()
    this.notify()
  }

  /** The ask a layers post answers, handed over once: the one the agent was
   * last given, or null when it posts of its own accord. */
  takeLayersAsk(): LayersAsk | null {
    const bucket = this.buckets.get(this.scope)
    const asked = bucket?.asked ?? null
    if (bucket) bucket.asked = null
    return asked
  }

  /** The agent posted layers. Concludes an outstanding request; a spontaneous
   * post concludes nothing. Returns how long the outline took, or null. */
  layersPosted(): number | null {
    const bucket = this.buckets.get(this.scope)
    const since = bucket?.outlining ?? null
    if (bucket === undefined || since === null) return null
    bucket.outlining = null
    this.clearOutlineWatch()
    // Not mid-batch and not already parked: the agent re-polls next, and the
    // grace window is what models that.
    if (!this.awaitingReply && !this.betweenPolls) this.armGrace()
    this.notify()
    return Date.now() - since
  }

  drop(threadId: string): void {
    for (const bucket of this.buckets.values()) bucket.threads.delete(threadId)
    if (this.batch) this.batch.threadIds = this.batch.threadIds.filter((id) => id !== threadId)
    this.release(threadId)
  }

  /**
   * The thread needs no reply from the agent any more (the reviewer resolved
   * or deleted it): it comes off the reply clock without counting as
   * unanswered, and is never reminded. Anything still queued for it stays.
   */
  release(threadId: string): void {
    const owed = this.deliveredAt.delete(threadId)
    this.strikes.delete(threadId)
    this.remindersSent.delete(threadId)
    if (owed && this.deliveredAt.size === 0 && this.awaitingReply) {
      this.settle()
      this.armGrace()
    }
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
    // A poll says "I am listening", never "I am done": threads still owed a
    // reply stay owed, and so does an outline. Only a batch with nothing left
    // on the clock is over.
    this.closeIfAnswered()
    if (this.hasPending()) return Promise.resolve('data')
    // The stall clock ran out while nobody was listening: the reminder goes
    // first. Never for owed threads alone — only a clock that ran out — or
    // every poll would return at once and the agent would spin on it.
    if (this.reminderDue && this.deliveredAt.size > 0) return Promise.resolve('reminder')
    return new Promise((resolve) => {
      const waiter = (outcome: AttachOutcome) => resolve(outcome)
      this.waiter = waiter
      this.lastDetach = null
      this.armWaiterWatch()
      this.notify()
      onAbort?.(() => {
        if (this.waiter === waiter) {
          this.releaseWaiter(null)
          this.pollDropped()
        }
      })
    })
  }

  /**
   * A poll is starting. 'quiet' when the last `limit` polls all ended with
   * nothing from the reviewer and nothing is waiting now: the agent should stop
   * and ask the user. Answering 'quiet' starts the streak over, so the re-poll
   * the user says yes to listens again.
   */
  beginPoll(limit: number = QUIET_POLL_LIMIT): 'listen' | 'quiet' {
    // An agent working a batch polls to listen while it works: those polls are
    // not the reviewer going quiet.
    if (!this.hasPending() && !this.awaitingReply && this.quietPolls >= limit) {
      this.wentQuiet()
      return 'quiet'
    }
    this.quietPolls++
    return 'listen'
  }

  /** A poll ran to its time cap empty. True when it was the last one the
   * streak allows: say 'quiet' now instead of sending the agent back. */
  pollTimedOutQuiet(limit: number = QUIET_POLL_LIMIT): boolean {
    if (this.quietPolls < limit) return false
    this.wentQuiet()
    return true
  }

  /** The agent was told to stop and ask the user: it is not coming back on its
   * own, so the reviewer sees it gone rather than "re-polling" for good. */
  private wentQuiet(): void {
    this.quietPolls = 0
    // A cut-off poll whose process lingers is still attached; feedback must not
    // reach it now that nobody reads it — it waits for the next real poll.
    this.releaseWaiter('superseded')
    this.clearGrace()
    this.lastDetach = 'disconnected'
    this.notify()
  }

  private releaseWaiter(outcome: AttachOutcome | null): void {
    const waiter = this.waiter
    this.waiter = null
    this.clearWaiterWatch()
    this.clearHold()
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
      bucket !== undefined &&
      (bucket.threads.size > 0 ||
        bucket.finish !== null ||
        bucket.cleared ||
        bucket.layers !== null ||
        bucket.presets.size > 0 ||
        bucket.roles.size > 0 ||
        bucket.submitted !== null ||
        bucket.artifacts.length > 0 ||
        bucket.reviewers.size > 0)
    )
  }

  /**
   * Hand a listening poll what is pending. An agent working a batch is not
   * interrupted for every send: the wake is held until the sends stop for
   * `COALESCE_MS` (or `COALESCE_MAX_MS` in all), so several arrive as one.
   * `now` skips the hold. An idle agent is always woken at once.
   */
  private wake(now = false): void {
    if (this.waiter === null) return
    if (!now && this.awaitingReply) {
      this.hold()
      return
    }
    this.releaseWaiter('data')
  }

  /** Something was queued: wake the poll, and tell the page unless the poll
   * took it at once (its confirm announces that). */
  private offer(): void {
    const listening = this.waiter !== null
    this.wake()
    if (!listening || this.waiter !== null) this.notify()
  }

  private hold(): void {
    const now = Date.now()
    this.holdSince ??= now
    const quiet = this.tuning.coalesceMs ?? COALESCE_MS
    const most = this.tuning.coalesceMaxMs ?? COALESCE_MAX_MS
    if (this.holdTimer !== null) clearTimeout(this.holdTimer)
    const timer = setTimeout(
      () => this.releaseHold(),
      Math.max(0, Math.min(quiet, this.holdSince + most - now)),
    )
    timer.unref?.()
    this.holdTimer = timer
  }

  private releaseHold(): void {
    this.clearHold()
    if (this.waiter !== null && this.hasPending()) this.releaseWaiter('data')
  }

  private clearHold(): void {
    if (this.holdTimer !== null) clearTimeout(this.holdTimer)
    this.holdTimer = null
    this.holdSince = null
  }

  /** The threads the agent holds and has not answered, oldest delivery first,
   * with how many times each was handed to it again. */
  owed(): { threadId: string; deliveredAt: number; reminders: number }[] {
    return [...this.deliveredAt.entries()]
      .map(([threadId, deliveredAt]) => ({
        threadId,
        deliveredAt,
        reminders: this.remindersSent.get(threadId) ?? 0,
      }))
      .sort((a, b) => a.deliveredAt - b.deliveredAt)
  }

  /** The reminder for these threads was fully written to a poll. */
  confirmReminder(threadIds: readonly string[]): void {
    this.quietPolls = 0
    this.reminderDue = false
    for (const id of threadIds) {
      if (this.deliveredAt.has(id)) {
        this.remindersSent.set(id, (this.remindersSent.get(id) ?? 0) + 1)
      }
    }
    this.notify()
  }

  /** How many things are queued for the next poll: threads sent since the
   * last delivery, and one for each other kind of ask that is parked. */
  pendingCount(): number {
    const bucket = this.buckets.get(this.scope)
    if (!bucket) return 0
    return (
      bucket.threads.size +
      bucket.presets.size +
      bucket.roles.size +
      bucket.reviewers.size +
      bucket.artifacts.length +
      (bucket.finish !== null ? 1 : 0) +
      (bucket.layers !== null ? 1 : 0) +
      (bucket.cleared ? 1 : 0) +
      (bucket.submitted !== null ? 1 : 0)
    )
  }

  /** Whether the reviewer's layers are owed (asked for, handed over, not posted). */
  owesLayers(): boolean {
    return this.outlining() !== null
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
    // A preset is a few lines of writing: ahead of the outline, which is heavy.
    const presetId = bucket.presets.values().next().value
    if (presetId !== undefined) return { kind: 'preset', id: presetId }
    // A role is the same few lines of writing, asked for in the same way.
    const roleKey = bucket.roles.values().next().value
    if (roleKey !== undefined) return { kind: 'role', id: roleKey }
    // A broken artifact is the agent's own mess, a quick fix: after what the
    // reviewer said, ahead of the heavy outline.
    if (bucket.artifacts.length > 0) return { kind: 'artifacts', reports: [...bucket.artifacts] }
    // Starting a reviewer agent is one hand-off, and the review it brings is
    // what the reviewer is waiting for: ahead of the outline.
    if (bucket.reviewers.size > 0) return { kind: 'reviewers', roles: [...bucket.reviewers] }
    // The outline is heavy work: it waits behind replies the reviewer is
    // already owed, and ahead of the cleared heads-up, which owes nothing.
    if (bucket.layers !== null) return { kind: 'layers', ask: bucket.layers }
    // Real feedback outranks the heads-up: a cleared notice only surfaces once
    // nothing else is owed, and survives in the bucket until then.
    if (bucket.cleared) return { kind: 'cleared' }
    if (bucket.submitted !== null) return { kind: 'submitted', submitted: bucket.submitted }
    return null
  }

  /** The poll response for this snapshot was fully written — NOW it counts as
   * delivered. Clears exactly what the snapshot covered. */
  confirm(snapshot: Snapshot, deliveredThreadIds: string[]): void {
    this.quietPolls = 0
    if (snapshot.kind === 'layers') {
      const bucket = this.bucket()
      bucket.layers = null
      bucket.asked = snapshot.ask
      bucket.outlining = Date.now()
      this.armOutlineWatch()
      this.notify()
      return
    }
    if (snapshot.kind === 'preset') {
      // The reply or edit lands in the conversation when posted; nothing here waits for it.
      this.buckets.get(this.scope)?.presets.delete(snapshot.id)
      this.armGrace()
      this.notify()
      return
    }
    if (snapshot.kind === 'role') {
      // Like a preset: the reply or edit lands in the conversation when posted.
      this.buckets.get(this.scope)?.roles.delete(snapshot.id)
      this.armGrace()
      this.notify()
      return
    }
    if (snapshot.kind === 'cleared') {
      // No batch, no reply owed: the agent may post a guide and re-poll, which
      // is what the grace window already models.
      const bucket = this.buckets.get(this.scope)
      if (bucket) bucket.cleared = false
      this.armGrace()
      this.notify()
      return
    }
    if (snapshot.kind === 'artifacts') {
      const bucket = this.buckets.get(this.scope)
      if (bucket) bucket.artifacts = bucket.artifacts.filter((r) => !snapshot.reports.includes(r))
      this.armGrace()
      this.notify()
      return
    }
    if (snapshot.kind === 'reviewers') {
      // The reviewer agent announces itself when it joins; nothing here waits.
      const bucket = this.buckets.get(this.scope)
      for (const role of snapshot.roles) bucket?.reviewers.delete(role)
      this.armGrace()
      this.notify()
      return
    }
    if (snapshot.kind === 'submitted') {
      const bucket = this.buckets.get(this.scope)
      if (bucket && bucket.submitted === snapshot.submitted) bucket.submitted = null
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
    // A delivery that owes no reply (a finish whose threads are all answered)
    // opens nothing: there is no clock to run, and the agent polls on.
    if (deliveredThreadIds.length === 0) {
      if (!this.awaitingReply) this.armGrace()
      this.notify()
      return
    }
    const now = Date.now()
    this.clearGrace()
    this.closeIfAnswered()
    for (const id of deliveredThreadIds) {
      this.deliveredAt.set(id, now)
      // Handed over afresh (the reviewer wrote in it again): its reminders start over.
      this.strikes.delete(id)
      this.remindersSent.delete(id)
    }
    this.awaitingReply = true
    // The agent listens while it works, so a delivery can land on a batch that
    // is still open: it joins that batch rather than replacing it.
    if (this.batch) {
      for (const id of deliveredThreadIds) {
        if (!this.batch.threadIds.includes(id)) this.batch.threadIds.push(id)
      }
    } else {
      this.batch = { threadIds: [...deliveredThreadIds], deliveredAt: now }
    }
    this.armBatchWatch()
    this.stalled = false
    this.reminderDue = false
    this.armStall()
    this.notify()
  }

  /** The agent replied on a thread. Returns how long since that thread's feedback
   * was delivered, or null when the reply wasn't an answer to a delivery.
   * `interim` (a `--more` reply) keeps the thread on the clock: a follow-up is
   * still owed, so the spinner stays and a batch that closes without the
   * follow-up counts the thread unanswered. */
  agentReplied(threadId: string, interim = false): number | null {
    const at = this.deliveredAt.get(threadId)
    if (!interim) {
      this.deliveredAt.delete(threadId)
    } else if (at === undefined && this.batch) {
      // A promise made after the thread left the clock (an earlier plain reply
      // already concluded it) re-arms it: the live batch owes the follow-up
      // now, and closing without it must read as unanswered.
      this.deliveredAt.set(threadId, Date.now())
      if (!this.batch.threadIds.includes(threadId)) this.batch.threadIds.push(threadId)
      this.awaitingReply = true
      this.clearGrace()
    }
    if (!interim) {
      this.strikes.delete(threadId)
      this.remindersSent.delete(threadId)
    }
    if (this.deliveredAt.size > 0) {
      if (this.awaitingReply) {
        // Any reply is the agent at work: the stall clock starts over.
        this.stalled = false
        this.reminderDue = false
        this.armStall()
        this.notify()
      }
    } else if (this.awaitingReply || this.stalled || this.betweenPolls) {
      // Sends held back so as not to interrupt go to the poll now; its
      // delivery, a moment later, ends the grace this starts.
      this.settle()
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
    for (const bucket of this.buckets.values()) {
      bucket.outlining = null
      bucket.asked = null
    }
    this.clearOutlineWatch()
    this.stalled = false
    this.reminderDue = false
    this.clearStall()
    this.clearGrace()
    this.clearHold()
    this.deliveredAt.clear()
    this.strikes.clear()
    this.remindersSent.clear()
    this.lastDetach = 'ended'
    this.notify()
    return true
  }
}
