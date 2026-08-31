import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import {
  type Anchor,
  type AnchoredLines,
  type Author,
  type Coverage,
  EMPTY_REVIEW,
  type Landed,
  type LastFinish,
  type ReviewMessage,
  type ReviewState,
  type ReviewThread,
  THREAD_INTENTS,
  type ThreadCapture,
  type ThreadIntent,
  type ThreadState,
} from '../shared/review.js'
import type { ChangesetSpec } from '../shared/types.js'
import type { DiffoDb, ReviewScope } from './db.js'
import { getBranchName } from './git.js'

const STATES: ThreadState[] = ['open', 'sent', 'addressed', 'resolved']

export class ReviewStore {
  private state: ReviewState
  private listeners = new Set<(state: ReviewState) => void>()
  readonly repoPath: string
  private key: ReviewScope

  constructor(
    root: string,
    private db: DiffoDb,
    spec: ChangesetSpec,
  ) {
    this.repoPath = resolve(root)
    this.key = {
      repoPath: this.repoPath,
      branch: getBranchName(this.repoPath),
      base: spec.kind === 'branch' ? spec.base : '',
    }
    this.state = this.load()
  }

  get scope(): ReviewScope {
    return this.key
  }

  /**
   * HEAD moved under a running server: swap to that branch's review. Deliberately
   * does NOT commit first — the state on screen belongs to the branch we are
   * leaving, and writing it under the new key is the bleed this scoping prevents.
   */
  rescope(branch: string): void {
    if (branch === this.key.branch) return
    this.key = { ...this.key, branch }
    this.state = this.load()
    for (const listener of this.listeners) listener(this.state)
  }

  private load(): ReviewState {
    const stored = this.db.getReview(this.key)
    return (stored !== null ? parseReview(stored) : null) ?? structuredClone(EMPTY_REVIEW)
  }

  get(): ReviewState {
    return this.state
  }

  subscribe(listener: (state: ReviewState) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  createThread(
    anchor: Anchor,
    text: string,
    capture: ThreadCapture | null,
    intent?: ThreadIntent,
    author: Author = 'reviewer',
  ): ReviewThread {
    const now = new Date().toISOString()
    return this.insert({
      id: randomUUID(),
      anchor,
      state: 'open',
      ...(intent ? { intent } : {}),
      codeContext: capture?.codeContext ?? null,
      ...(capture?.anchored ? { anchored: capture.anchored } : {}),
      codeChanged: false,
      messages: [{ id: randomUUID(), author, text, at: now }],
      createdAt: now,
      updatedAt: now,
    })
  }

  /**
   * The closing note of a Finish round, as a thread. Anchored to the changeset
   * and opened in the reviewer's voice, so it travels the ordinary path: the
   * agent replies to it with `diffo reply`, the queue counts it as feedback
   * still owed an answer, and the reviewer sees their own summing-up in the rail
   * beside everything else they said.
   */
  closingNote(text: string): ReviewThread {
    const now = new Date().toISOString()
    return this.insert({
      id: randomUUID(),
      anchor: { kind: 'changeset' },
      state: 'open',
      closingNote: true,
      codeContext: null,
      codeChanged: false,
      messages: [{ id: randomUUID(), author: 'reviewer', text, at: now }],
      createdAt: now,
      updatedAt: now,
    })
  }

  private insert(thread: ReviewThread): ReviewThread {
    this.state = { ...this.state, threads: [...this.state.threads, thread] }
    this.commit()
    return thread
  }

  /** `withheld` marks a reviewer reply the agent has not been given. Only ever true
   * for the reviewer: an agent message proves the agent has the thread.
   *
   * `seenThroughMs` is when the delivery this agent reply answers was handed over.
   * The reply is inserted after the messages that delivery carried and before any
   * the reviewer raced in since — appended at the end, it would render as an
   * answer to a comment it never saw, and the raced comment would stop reading
   * as "waiting on the agent" even though it still is. */
  addMessage(
    threadId: string,
    author: Author,
    text: string,
    withheld = false,
    seenThroughMs?: number,
    followUp = false,
  ): ReviewThread | null {
    return this.update(threadId, ({ unanswered: _answered, ...thread }) => {
      const message = { id: randomUUID(), author, text, at: new Date().toISOString() }
      // Raced = a reviewer message the agent has not seen. The agent's own
      // messages are never raced past — an interim reply postdates the delivery
      // too, and the follow-up must land after it, not above it.
      const raced =
        author === 'agent' && seenThroughMs !== undefined
          ? thread.messages.findIndex(
              (m) => m.author === 'reviewer' && Date.parse(m.at) > seenThroughMs,
            )
          : -1
      // An agent reply settles the promised follow-up — unless it renews the
      // promise. A reviewer message leaves it: the agent still owes the ending.
      const { awaitingFollowUp: _promised, ...settled } = thread
      return {
        ...(author === 'agent' ? settled : thread),
        ...(author === 'agent' && followUp ? { awaitingFollowUp: true as const } : {}),
        // An agent message does NOT clear this: it proves the agent had the thread, not
        // that it saw the line you are still holding. Only a real hand-over
        // (`clearWithheld`, from Send or Finish) clears it.
        ...(withheld && author === 'reviewer' ? { withheld: true } : {}),
        messages:
          raced === -1
            ? [...thread.messages, message]
            : [...thread.messages.slice(0, raced), message, ...thread.messages.slice(raced)],
      }
    })
  }

  /** A delivery just handed these threads to the agent — remember through when,
   * so replies and the typing indicator can tell delivered words from raced ones. */
  markDelivered(threadIds: readonly string[]): void {
    const ids = new Set(threadIds)
    if (ids.size === 0) return
    const at = new Date().toISOString()
    this.state = {
      ...this.state,
      threads: this.state.threads.map((t) => (ids.has(t.id) ? { ...t, deliveredThrough: at } : t)),
    }
    this.commit()
  }

  clearWithheld(threadIds: readonly string[]): void {
    const ids = new Set(threadIds)
    if (!this.state.threads.some((t) => ids.has(t.id) && t.withheld)) return
    this.state = {
      ...this.state,
      threads: this.state.threads.map(({ withheld, ...t }) =>
        ids.has(t.id) ? t : { ...t, ...(withheld ? { withheld } : {}) },
      ),
    }
    this.commit()
  }

  markUnanswered(threadIds: readonly string[]): void {
    this.setUnanswered(threadIds, (t) => !t.unanswered && t.state !== 'resolved')
  }

  clearUnanswered(threadIds: readonly string[]): void {
    this.setUnanswered(threadIds, (t) => t.unanswered === true)
  }

  private setUnanswered(
    threadIds: readonly string[],
    applies: (thread: ReviewThread) => boolean,
  ): void {
    const wanted = new Set(threadIds)
    let changed = false
    const threads = this.state.threads.map((thread) => {
      if (!wanted.has(thread.id) || !applies(thread)) return thread
      changed = true
      // Marking unanswered settles the follow-up promise too — "the agent moved
      // on" and "a follow-up is coming" cannot both be true.
      const { unanswered: _was, awaitingFollowUp: _promised, ...rest } = thread
      return thread.unanswered ? rest : { ...rest, unanswered: true }
    })
    if (!changed) return
    this.state = { ...this.state, threads }
    this.commit()
  }

  setState(threadId: string, state: ThreadState): ReviewThread | null {
    return this.update(threadId, ({ awaitingFollowUp: promised, ...thread }) => ({
      ...thread,
      // Resolving settles the promised follow-up along with the thread.
      ...(promised && state !== 'resolved' ? { awaitingFollowUp: true as const } : {}),
      state,
      ...(state === 'sent' && !thread.sentAt ? { sentAt: new Date().toISOString() } : {}),
      // A settled thread drops its frozen diff: the snapshot keeps the thread legible
      // while the code moves underneath it, and it is the heaviest thing in the store
      // (66% of the review row). The messages stay, and so does `anchored` — it is
      // small, and a follow-up on this thread has nothing else to point at the code.
      // Reopening does not bring the snapshot back.
      ...(state === 'resolved' ? { codeContext: null } : {}),
    }))
  }

  removeThread(threadId: string): boolean {
    const threads = this.state.threads.filter((t) => t.id !== threadId)
    if (threads.length === this.state.threads.length) return false
    this.state = { ...this.state, threads }
    this.commit()
    return true
  }

  /**
   * Start the review over: threads, the last-finish record, and the landed
   * marker all go. Not just the threads — a kept `lastFinish` would carry hunk
   * ids from the dead changeset into the next review's "since last review"
   * lens, reporting everything as new. `seenHead` survives: it describes the
   * repo, not the review being discarded.
   */
  reset(): string[] {
    const ids = this.state.threads.map((t) => t.id)
    if (ids.length === 0 && !this.state.lastFinish && !this.state.landed) return []
    const { lastFinish: _finish, landed: _landed, ...rest } = this.state
    this.state = { ...rest, threads: [] }
    this.commit()
    return ids
  }

  /** The base the work under review sits on — see `ReviewState.seenHead` for
   * when the caller must NOT move it. */
  noteHead(sha: string): void {
    if (this.state.seenHead === sha) return
    this.state = { ...this.state, seenHead: sha }
    this.commit()
  }

  markLanded(landed: Landed): void {
    if (this.state.landed?.sha === landed.sha) return
    this.state = { ...this.state, landed }
    this.commit()
  }

  clearLanded(): void {
    if (!this.state.landed) return
    const { landed: _landed, ...rest } = this.state
    this.state = rest
    this.commit()
  }

  annotateAgentReplies(threadIds: string[], durationMs: number): void {
    let changed = false
    const threads = this.state.threads.map((thread) => {
      if (!threadIds.includes(thread.id)) return thread
      const index = thread.messages.findLastIndex((m) => m.author === 'agent')
      if (index === -1 || thread.messages[index]!.durationMs !== undefined) return thread
      changed = true
      const messages = [...thread.messages]
      messages[index] = { ...messages[index]!, durationMs }
      return { ...thread, messages }
    })
    if (!changed) return
    this.state = { ...this.state, threads }
    this.commit()
  }

  send(threadId: string): ReviewThread | null {
    const thread = this.state.threads.find((t) => t.id === threadId)
    if (!thread) return null
    if (thread.state !== 'open') return thread
    return this.setState(threadId, 'sent')
  }

  finish(only?: ReadonlySet<string>): ReviewThread[] {
    const flush = (t: ReviewThread) => t.state === 'open' && (only?.has(t.id) ?? true)
    if (this.state.threads.some(flush)) {
      this.state = {
        ...this.state,
        threads: this.state.threads.map((t) =>
          flush(t)
            ? {
                ...t,
                state: 'sent' as const,
                ...(t.sentAt ? {} : { sentAt: new Date().toISOString() }),
                updatedAt: new Date().toISOString(),
              }
            : t,
        ),
      }
      this.commit()
    }
    return this.state.threads
  }

  recordFinish(hunkIds: readonly string[], coverage: Coverage): LastFinish {
    const lastFinish: LastFinish = {
      at: new Date().toISOString(),
      hunkIds: [...hunkIds],
      coverage,
    }
    this.state = { ...this.state, lastFinish }
    this.commit()
    return lastFinish
  }

  markFinishCollected(): void {
    const lastFinish = this.state.lastFinish
    if (!lastFinish || lastFinish.collectedAt) return
    this.state = {
      ...this.state,
      lastFinish: { ...lastFinish, collectedAt: new Date().toISOString() },
    }
    this.commit()
  }

  /**
   * Changeset changed — reconcile hunk-anchored threads against the new hunk ids.
   * Content-addressing does the work: an edited hunk has a new id, so its old one
   * vanishes. `sent` + vanished → `addressed`; `open` + vanished → `codeChanged`,
   * cleared again if it comes back (a revert).
   */
  reconcile(currentHunkIds: ReadonlySet<string>): void {
    let changed = false
    const threads = this.state.threads.map((thread) => {
      if (thread.anchor.kind !== 'hunk') return thread
      const exists = currentHunkIds.has(thread.anchor.hunkId)
      if (thread.state === 'sent' && !exists) {
        changed = true
        return { ...thread, state: 'addressed' as const, updatedAt: new Date().toISOString() }
      }
      if ((thread.state === 'open' || thread.state === 'sent') && thread.codeChanged === exists) {
        changed = true
        return { ...thread, codeChanged: !exists }
      }
      return thread
    })
    if (!changed) return
    this.state = { ...this.state, threads }
    this.commit()
  }

  private update(
    threadId: string,
    change: (thread: ReviewThread) => ReviewThread,
  ): ReviewThread | null {
    const index = this.state.threads.findIndex((t) => t.id === threadId)
    if (index === -1) return null
    const updated = { ...change(this.state.threads[index]!), updatedAt: new Date().toISOString() }
    const threads = [...this.state.threads]
    threads[index] = updated
    this.state = { ...this.state, threads }
    this.commit()
    return updated
  }

  private commit(): void {
    this.db.setReview(this.key, JSON.stringify(this.state))
    for (const listener of this.listeners) listener(this.state)
  }
}

/** Tolerant parse: agents hand-edit this file, so anything recoverable is
 * recovered. Threads with a broken shape are dropped, optional fields are filled
 * in. Returns null only when the file as a whole is unusable. */
export function parseReview(raw: string): ReviewState | null {
  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch {
    return null
  }
  if (typeof data !== 'object' || data === null) return null
  const parsed = data as Record<string, unknown>
  const threads = parsed.threads
  if (!Array.isArray(threads)) return null
  const now = new Date().toISOString()
  const valid = threads
    .map((t) => normalizeThread(t, now))
    .filter((t): t is ReviewThread => t !== null)
  // A review written before agent threads existed may still carry `suggestions` —
  // the retired predecessor. Each becomes what it was always meant to be: an
  // agent comment thread on its file. (File-anchored: the raw line number it
  // stored can't be mapped to a hunk here, and file-level is the honest fallback.)
  const migrated = Array.isArray(parsed.suggestions)
    ? parsed.suggestions
        .map((s) => migrateLegacySuggestion(s, now))
        .filter((t): t is ReviewThread => t !== null)
    : []
  const lastFinish = normalizeLastFinish(parsed.lastFinish, now)
  const landed = normalizeLanded(parsed.landed, now)
  return {
    version: 1,
    threads: [...valid, ...migrated],
    ...(lastFinish ? { lastFinish } : {}),
    ...(typeof parsed.seenHead === 'string' && parsed.seenHead !== ''
      ? { seenHead: parsed.seenHead }
      : {}),
    ...(landed ? { landed } : {}),
  }
}

/** A landed marker without a sha can't be checked against history, so it is
 * dropped; the subject is only a caption and defaults away. */
function normalizeLanded(value: unknown, now: string): Landed | null {
  if (typeof value !== 'object' || value === null) return null
  const l = value as Record<string, unknown>
  if (typeof l.sha !== 'string' || l.sha === '') return null
  return {
    sha: l.sha,
    subject: typeof l.subject === 'string' ? l.subject : '',
    at: typeof l.at === 'string' ? l.at : now,
  }
}

/** A finish with no hunk ids can't answer the only question it exists for, so it is
 * dropped rather than kept as a record reporting "nothing changed". */
function normalizeLastFinish(value: unknown, now: string): LastFinish | null {
  if (typeof value !== 'object' || value === null) return null
  const f = value as Record<string, unknown>
  if (!Array.isArray(f.hunkIds)) return null
  return {
    at: typeof f.at === 'string' ? f.at : now,
    hunkIds: f.hunkIds.filter((x): x is string => typeof x === 'string'),
    coverage: normalizeCoverage(f.coverage),
    ...(typeof f.collectedAt === 'string' ? { collectedAt: f.collectedAt } : {}),
  }
}

function normalizeCoverage(value: unknown): Coverage {
  const c = (typeof value === 'object' && value !== null ? value : {}) as Record<string, unknown>
  const count = (v: unknown): number => (typeof v === 'number' && v >= 0 ? v : 0)
  const fileList = (v: unknown): string[] | undefined =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : undefined
  const changedFiles = fileList(c.changedFiles)
  const commentedUnread = fileList(c.commentedUnread)
  return {
    viewedHunks: count(c.viewedHunks),
    totalHunks: count(c.totalHunks),
    ...(typeof c.viewedFiles === 'number' ? { viewedFiles: count(c.viewedFiles) } : {}),
    ...(typeof c.totalFiles === 'number' ? { totalFiles: count(c.totalFiles) } : {}),
    skippedFiles: fileList(c.skippedFiles) ?? [],
    ...(changedFiles !== undefined ? { changedFiles } : {}),
    ...(commentedUnread !== undefined ? { commentedUnread } : {}),
    ...(typeof c.note === 'string' ? { note: c.note } : {}),
  }
}

function migrateLegacySuggestion(value: unknown, now: string): ReviewThread | null {
  if (typeof value !== 'object' || value === null) return null
  const s = value as Record<string, unknown>
  if (typeof s.file !== 'string' || typeof s.text !== 'string') return null
  const at = typeof s.at === 'string' ? s.at : now
  return {
    id: typeof s.id === 'string' ? s.id : randomUUID(),
    anchor: { kind: 'file', path: s.file },
    state: 'open',
    codeContext: null,
    codeChanged: false,
    messages: [{ id: randomUUID(), author: 'agent', text: s.text, at }],
    createdAt: at,
    updatedAt: at,
  }
}

export function parseAnchor(value: unknown): Anchor | null {
  if (typeof value !== 'object' || value === null) return null
  const anchor = value as Record<string, unknown>
  if (anchor.kind === 'hunk') {
    if (typeof anchor.hunkId !== 'string' || typeof anchor.path !== 'string') return null
    if (anchor.side !== 'old' && anchor.side !== 'new') return null
    if (typeof anchor.line !== 'number') return null
    // A range's end must extend past its start — anything else collapses back to a
    // single line rather than persisting a degenerate span.
    const endLine =
      typeof anchor.endLine === 'number' &&
      Number.isInteger(anchor.endLine) &&
      anchor.endLine > anchor.line
        ? anchor.endLine
        : undefined
    return {
      kind: 'hunk',
      hunkId: anchor.hunkId,
      path: anchor.path,
      side: anchor.side,
      line: anchor.line,
      ...(endLine !== undefined ? { endLine } : {}),
    }
  }
  if (anchor.kind === 'file') {
    return typeof anchor.path === 'string' ? { kind: 'file', path: anchor.path } : null
  }
  return anchor.kind === 'changeset' ? { kind: 'changeset' } : null
}

/** Dropped when malformed — the thread is still fine without it. */
function normalizeAnchored(value: unknown): AnchoredLines | null {
  if (typeof value !== 'object' || value === null) return null
  const a = value as Record<string, unknown>
  if (typeof a.start !== 'number' || typeof a.end !== 'number' || typeof a.text !== 'string') {
    return null
  }
  if (!Number.isInteger(a.start) || !Number.isInteger(a.end) || a.start < 0 || a.end < a.start) {
    return null
  }
  return { start: a.start, end: a.end, text: a.text }
}

function normalizeThread(value: unknown, now: string): ReviewThread | null {
  if (typeof value !== 'object' || value === null) return null
  const t = value as Record<string, unknown>
  if (typeof t.id !== 'string' || !STATES.includes(t.state as ThreadState)) return null
  const anchor = parseAnchor(t.anchor)
  if (!anchor) return null
  const anchored = normalizeAnchored(t.anchored)
  if (!Array.isArray(t.messages)) return null
  const messages: ReviewMessage[] = []
  for (const m of t.messages) {
    if (typeof m !== 'object' || m === null) return null
    const msg = m as Record<string, unknown>
    if (typeof msg.text !== 'string') return null
    if (msg.author !== 'reviewer' && msg.author !== 'agent') return null
    messages.push({
      id: typeof msg.id === 'string' ? msg.id : randomUUID(),
      author: msg.author,
      text: msg.text,
      at: typeof msg.at === 'string' ? msg.at : now,
      ...(typeof msg.durationMs === 'number' ? { durationMs: msg.durationMs } : {}),
    })
  }
  return {
    id: t.id,
    anchor,
    state: t.state as ThreadState,
    ...(THREAD_INTENTS.includes(t.intent as ThreadIntent)
      ? { intent: t.intent as ThreadIntent }
      : {}),
    codeContext: typeof t.codeContext === 'string' ? t.codeContext : null,
    ...(anchored ? { anchored } : {}),
    codeChanged: t.codeChanged === true,
    ...(t.unanswered === true ? { unanswered: true } : {}),
    // Mutually exclusive with `unanswered` — a hand-edited file carrying both
    // resolves to "the agent moved on".
    ...(t.awaitingFollowUp === true && t.unanswered !== true
      ? { awaitingFollowUp: true as const }
      : {}),
    ...(t.closingNote === true ? { closingNote: true as const } : {}),
    ...(typeof t.sentAt === 'string' ? { sentAt: t.sentAt } : {}),
    messages,
    createdAt: typeof t.createdAt === 'string' ? t.createdAt : now,
    updatedAt: typeof t.updatedAt === 'string' ? t.updatedAt : now,
  }
}
