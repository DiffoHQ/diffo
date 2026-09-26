import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { type LayerInput, parseLayersInput, parseSuggestReason } from '../shared/layers.js'
import {
  type Anchor,
  type AnchoredLines,
  type Audience,
  type Author,
  type Coverage,
  EMPTY_REVIEW,
  type GithubThread,
  type Landed,
  type LastFinish,
  type Layers,
  normalizeTitle,
  type ReviewMessage,
  type ReviewState,
  type ReviewThread,
  seenByAgent,
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
    options: { audience?: Audience; parentId?: string; suggestedReply?: string } = {},
  ): ReviewThread {
    const now = new Date().toISOString()
    return this.insert({
      id: randomUUID(),
      anchor,
      state: 'open',
      // A public draft has no intent: it is a review comment, not an ask of the agent.
      ...(options.audience === 'pr' ? { audience: 'pr' as const } : intent ? { intent } : {}),
      ...(options.parentId ? { parentId: options.parentId } : {}),
      codeContext: capture?.codeContext ?? null,
      ...(capture?.anchored ? { anchored: capture.anchored } : {}),
      codeChanged: false,
      messages: [
        {
          id: randomUUID(),
          author,
          text,
          at: now,
          ...(author === 'agent' && options.suggestedReply
            ? { suggestedReply: options.suggestedReply }
            : {}),
        },
      ],
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
    suggestedReply?: string,
  ): ReviewThread | null {
    return this.update(threadId, ({ unanswered: _answered, ...thread }) => {
      const message: ReviewMessage = {
        id: randomUUID(),
        author,
        text,
        at: new Date().toISOString(),
        ...(author === 'agent' && suggestedReply ? { suggestedReply } : {}),
      }
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

  /**
   * The reviewer rewrites one of their own messages. Words the agent never saw
   * are a draft fixed in place. Words it did see are a change of mind, like
   * editing a chat message: the message is stamped edited and everything after
   * it is cut — the agent's answers to the old words included — so the thread
   * is the agent's to answer again. Cut, not kept: the old branch is not worth
   * a second history on the card. `withheld` holds a seen rewrite back from the
   * agent, the same as a withheld reply.
   */
  editMessage(
    threadId: string,
    messageId: string,
    text: string,
    withheld = false,
  ): ReviewThread | null {
    const current = this.state.threads.find((t) => t.id === threadId)
    const index = current?.messages.findIndex((m) => m.id === messageId) ?? -1
    if (!current || index === -1) return null
    const seen = seenByAgent(current, index)
    const cut = current.messages.slice(index + 1)
    const cutAnswer = cut.some((m) => m.author === 'agent')
    return this.update(threadId, ({ unanswered, awaitingFollowUp, ...thread }) => {
      const before = thread.messages[index]!
      const edited: ReviewMessage = {
        ...before,
        text,
        ...(seen || before.editedAt ? { editedAt: new Date().toISOString() } : {}),
      }
      return {
        ...thread,
        // Speaking to the agent again un-strands the thread, as a reply does.
        ...(unanswered && !seen ? { unanswered } : {}),
        // A promised follow-up belonged to a reply that is gone.
        ...(awaitingFollowUp && !cutAnswer ? { awaitingFollowUp } : {}),
        // The answer that addressed it is gone: the thread waits on the agent again.
        ...(cutAnswer && thread.state === 'addressed' ? { state: 'sent' as const } : {}),
        ...(seen && cut.length > 0 ? { rewound: true as const } : {}),
        ...(seen && withheld ? { withheld: true } : {}),
        messages: [...thread.messages.slice(0, index), edited],
      }
    })
  }

  /** A delivery just handed these threads to the agent — remember through when,
   * so replies and the typing indicator can tell delivered words from raced ones.
   * The delivery also carried the word that a rewind withdrew the old replies. */
  markDelivered(threadIds: readonly string[]): void {
    const ids = new Set(threadIds)
    if (ids.size === 0) return
    const at = new Date().toISOString()
    this.state = {
      ...this.state,
      threads: this.state.threads.map(({ rewound, ...t }) =>
        ids.has(t.id) ? { ...t, deliveredThrough: at } : { ...t, ...(rewound ? { rewound } : {}) },
      ),
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
   * Start the review over: threads, the last-finish record, the landed marker,
   * and the tab title all go. Not just the threads — a kept `lastFinish` would
   * carry hunk ids from the dead changeset into the next review's "since last
   * review" lens, reporting everything as new, and a kept title would name the
   * work that just ended. The cleared agent is woken (see the DELETE route), so
   * its next poll names the new round. `seenHead` survives: it describes the
   * repo, not the review being discarded.
   */
  reset(): string[] {
    const ids = this.state.threads.map((t) => t.id)
    const { lastFinish, landed, title, layers, layersSuggested } = this.state
    if (ids.length === 0 && !lastFinish && !landed && !title && !layers && !layersSuggested) {
      return []
    }
    const {
      lastFinish: _finish,
      landed: _landed,
      title: _title,
      // The plan described the round that ended; the next one is outlined afresh.
      layers: _layers,
      layersSuggested: _suggested,
      ...rest
    } = this.state
    this.state = { ...rest, threads: [] }
    this.commit()
    return ids
  }

  /**
   * Replace the reading plan — the whole list, never a merge, so the agent never
   * has to diff its own outline. Ids are minted here and kept for any layer
   * whose title matches an existing one: that is what holds the reviewer's
   * active layer in place across a re-post. Posting also answers the suggestion,
   * so it goes.
   */
  setLayers(items: readonly LayerInput[]): Layers {
    const kept = new Map((this.state.layers?.items ?? []).map((l) => [l.title, l.id]))
    const layers: Layers = {
      items: items.map((item) => ({ id: kept.get(item.title) ?? randomUUID(), ...item })),
      postedAt: new Date().toISOString(),
    }
    const { layersSuggested: _suggested, ...rest } = this.state
    this.state = { ...rest, layers }
    this.commit()
    return layers
  }

  /** The agent's flag at open: this read benefits from layers. Once layers exist
   * the flag has nothing to add, so it is refused rather than recorded. */
  suggestLayers(reason?: string): boolean {
    if (this.state.layers) return false
    this.state = { ...this.state, layersSuggested: reason ? { reason } : {} }
    this.commit()
    return true
  }

  /** The agent's name for this changeset, carried by its poll. The newest one
   * wins: a change that grows a second subject renames its own tab. */
  setTitle(title: string): void {
    if (this.state.title === title) return
    this.state = { ...this.state, title }
    this.commit()
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

  /**
   * The pull request's conversation, as the forge sees it now. An upsert: a
   * thread already here (by id, or by the GitHub thread a local draft became)
   * takes the incoming messages it lacks and GitHub's resolution; a new one is
   * inserted — the description ahead of everything, so it reads first.
   * Threads that came from GitHub take GitHub's fresh anchor too (it re-maps
   * lines after a push); a thread the reviewer wrote here keeps its own
   * content-addressed one. Local state the reviewer is still holding — a
   * queued resolve, an unposted reply — is never overwritten.
   */
  importGithubThreads(incoming: readonly ReviewThread[]): { added: number; updated: number } {
    let added = 0
    let updated = 0
    let threads = this.state.threads
    const front: ReviewThread[] = []
    // A reply the reviewer posted on a conversation thread is a new issue
    // comment to GitHub; it comes back as a thread of its own, but its id is
    // already on the message it came from. That one stays where it is.
    const known = new Set(
      threads.flatMap((t) => t.messages.flatMap((m) => (m.github ? [m.github.id] : []))),
    )
    for (const next of incoming) {
      const key = next.github?.threadId
      const index = threads.findIndex(
        (t) => t.id === next.id || (key !== undefined && t.github?.threadId === key),
      )
      if (index === -1) {
        if (next.messages.every((m) => m.github !== undefined && known.has(m.github.id))) continue
        added++
        if (next.github?.kind === 'description') front.push(next)
        else threads = [...threads, next]
        continue
      }
      const current = threads[index]!
      const merged = mergeImported(current, next)
      if (merged !== current) {
        updated++
        threads = [...threads.slice(0, index), merged, ...threads.slice(index + 1)]
      }
    }
    if (added === 0 && updated === 0) return { added, updated }
    this.state = { ...this.state, threads: [...front, ...threads] }
    this.commit()
    return { added, updated }
  }

  /**
   * Resolve (or reopen) a public thread locally and queue the change for Finish
   * — nothing reaches GitHub before then. Toggling back clears the queue entry.
   * A thread GitHub has not seen yet just changes state; there is nothing to
   * queue about it.
   */
  queueResolve(threadId: string, resolve: boolean): ReviewThread | null {
    return this.update(threadId, ({ queued: _queued, ...thread }) => {
      const state = resolve ? ('resolved' as const) : ('sent' as const)
      if (!thread.github) return { ...thread, state }
      const wasResolvedOnGithub = thread.github.resolved
      const queued =
        resolve === wasResolvedOnGithub
          ? undefined
          : resolve
            ? { resolve: true as const }
            : { unresolve: true as const }
      return {
        ...thread,
        state,
        ...(queued ? { queued } : {}),
        // Resolving locally drops the snapshot like any resolve; reopening does
        // not bring it back (see setState).
        ...(resolve ? { codeContext: null } : {}),
      }
    })
  }

  /**
   * GitHub accepted these: a posted draft gains its thread id and moves to
   * `sent`; a posted reply gains its comment id; a posted resolve clears its
   * queue entry. Each is one thread, one commit at the end.
   */
  markPosted(
    posted: readonly {
      threadId: string
      github?: GithubThread
      messages?: Record<string, NonNullable<ReviewMessage['github']>>
      /** The messages above went to GitHub as this one body: keep the first,
       * with this text, and drop the rest. */
      collapse?: string
      resolveDone?: boolean
    }[],
  ): void {
    if (posted.length === 0) return
    const byId = new Map(posted.map((p) => [p.threadId, p]))
    const now = new Date().toISOString()
    let changed = false
    const threads = this.state.threads.map((thread) => {
      const p = byId.get(thread.id)
      if (!p) return thread
      changed = true
      const { queued, ...rest } = thread
      let messages = p.messages
        ? thread.messages.map((m) => (p.messages![m.id] ? { ...m, github: p.messages![m.id]! } : m))
        : thread.messages
      if (p.collapse !== undefined && p.messages) {
        let kept = false
        messages = messages.flatMap((m) => {
          if (!p.messages![m.id]) return [m]
          if (kept) return []
          kept = true
          return [{ ...m, text: p.collapse! }]
        })
      }
      return {
        ...rest,
        ...(p.github ? { github: p.github } : {}),
        ...(p.github && thread.state === 'open' ? { state: 'sent' as const, sentAt: now } : {}),
        ...(queued && !p.resolveDone ? { queued } : {}),
        messages,
        updatedAt: now,
      }
    })
    if (!changed) return
    this.state = { ...this.state, threads }
    this.commit()
  }

  /** Pull-request bookkeeping: the pending review being filled, submissions made. */
  setPr(pr: NonNullable<ReviewState['pr']>): void {
    this.state = { ...this.state, pr }
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

/** One thread's upsert (see `importGithubThreads`). Returns the same object
 * when nothing changed, so the caller can count real updates. */
function mergeImported(current: ReviewThread, next: ReviewThread): ReviewThread {
  const fromGithub = current.id.startsWith('gh:')
  let messages = current.messages
  let changed = false
  for (const m of next.messages) {
    const ghId = m.github?.id
    const index = ghId === undefined ? -1 : messages.findIndex((c) => c.github?.id === ghId)
    if (index === -1) {
      messages = [...messages, m]
      changed = true
    } else if (messages[index]!.text !== m.text) {
      // Edited on GitHub: the words move, the authorship stays local.
      messages = messages.map((c, i) => (i === index ? { ...c, text: m.text } : c))
      changed = true
    }
  }
  if (changed) messages = [...messages].sort((a, b) => a.at.localeCompare(b.at))
  const github: GithubThread | undefined =
    current.github && next.github
      ? {
          ...current.github,
          resolved: next.github.resolved,
          outdated: next.github.outdated,
          ...(next.github.line !== undefined ? { line: next.github.line } : {}),
          ...(next.github.startLine !== undefined ? { startLine: next.github.startLine } : {}),
          ...(next.github.side !== undefined ? { side: next.github.side } : {}),
          ...(next.github.url !== undefined ? { url: next.github.url } : {}),
          ...(next.github.reviewState !== undefined
            ? { reviewState: next.github.reviewState }
            : {}),
        }
      : (next.github ?? current.github)
  if (JSON.stringify(github) !== JSON.stringify(current.github)) changed = true
  // GitHub's resolution wins unless the reviewer is holding a change of their own.
  let state = current.state
  if (!current.queued && next.github) {
    if (next.github.resolved && state !== 'resolved') state = 'resolved'
    else if (!next.github.resolved && state === 'resolved') state = 'sent'
  }
  if (state !== current.state) changed = true
  const anchor = fromGithub ? next.anchor : current.anchor
  if (JSON.stringify(anchor) !== JSON.stringify(current.anchor)) changed = true
  if (!changed) return current
  return {
    ...current,
    anchor,
    state,
    ...(github ? { github } : {}),
    messages,
    updatedAt: messages.at(-1)?.at ?? current.updatedAt,
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
  const title = normalizeTitle(parsed.title)
  const layers = normalizeLayers(parsed.layers, now)
  const layersSuggested = normalizeSuggested(parsed.layersSuggested)
  const pr = normalizePr(parsed.pr)
  return {
    version: 1,
    threads: [...valid, ...migrated],
    ...(pr ? { pr } : {}),
    ...(title ? { title } : {}),
    ...(lastFinish ? { lastFinish } : {}),
    ...(typeof parsed.seenHead === 'string' && parsed.seenHead !== ''
      ? { seenHead: parsed.seenHead }
      : {}),
    ...(landed ? { landed } : {}),
    ...(layers ? { layers } : {}),
    // A suggestion answered by a post has nothing left to say.
    ...(layersSuggested && !layers ? { layersSuggested } : {}),
  }
}

/** Stored layers go back through the same validation a post does; a list that
 * would be refused at the door is dropped whole rather than half-kept. Ids are
 * the one field a post never carries, so they are read here and re-minted only
 * when missing. */
function normalizeLayers(value: unknown, now: string): Layers | null {
  if (typeof value !== 'object' || value === null) return null
  const l = value as Record<string, unknown>
  if (!Array.isArray(l.items)) return null
  const parsed = parseLayersInput(l.items)
  if (!parsed.ok) return null
  const ids = l.items.map((item: unknown) =>
    typeof item === 'object' && item !== null && typeof (item as { id?: unknown }).id === 'string'
      ? ((item as { id: string }).id as string)
      : randomUUID(),
  )
  return {
    items: parsed.items.map((item, i) => ({ id: ids[i]!, ...item })),
    postedAt: typeof l.postedAt === 'string' ? l.postedAt : now,
  }
}

function normalizeSuggested(value: unknown): { reason?: string } | null {
  if (typeof value !== 'object' || value === null) return null
  const reason = parseSuggestReason((value as { reason?: unknown }).reason)
  return reason ? { reason } : {}
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
    if (msg.author !== 'reviewer' && msg.author !== 'agent' && msg.author !== 'github') return null
    const github = normalizeMessageGithub(msg.github)
    // A GitHub-authored message with no GitHub identity is nobody's — drop the thread.
    if (msg.author === 'github' && !github) return null
    messages.push({
      id: typeof msg.id === 'string' ? msg.id : randomUUID(),
      author: msg.author,
      text: msg.text,
      at: typeof msg.at === 'string' ? msg.at : now,
      ...(typeof msg.durationMs === 'number' ? { durationMs: msg.durationMs } : {}),
      ...(msg.author === 'agent' && typeof msg.suggestedReply === 'string' && msg.suggestedReply
        ? { suggestedReply: msg.suggestedReply }
        : {}),
      ...(typeof msg.editedAt === 'string' ? { editedAt: msg.editedAt } : {}),
      ...(github ? { github } : {}),
    })
  }
  const github = normalizeThreadGithub(t.github)
  const queued = normalizeQueued(t.queued)
  return {
    id: t.id,
    anchor,
    state: t.state as ThreadState,
    ...(t.audience === 'pr' ? { audience: 'pr' as const } : {}),
    ...(typeof t.parentId === 'string' && t.parentId !== '' ? { parentId: t.parentId } : {}),
    ...(github ? { github } : {}),
    ...(queued ? { queued } : {}),
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
    // Survives a restart: the agent is owed the word that its replies were cut.
    ...(t.rewound === true ? { rewound: true as const } : {}),
    messages,
    createdAt: typeof t.createdAt === 'string' ? t.createdAt : now,
    updatedAt: typeof t.updatedAt === 'string' ? t.updatedAt : now,
  }
}

const GITHUB_KINDS = new Set(['inline', 'review', 'comment', 'description'])
const REVIEW_STATES = new Set(['APPROVED', 'CHANGES_REQUESTED', 'COMMENTED', 'DISMISSED'])

function normalizeUser(value: unknown): { login: string; avatarUrl: string } | null {
  if (typeof value !== 'object' || value === null) return null
  const u = value as Record<string, unknown>
  if (typeof u.login !== 'string' || u.login === '') return null
  return { login: u.login, avatarUrl: typeof u.avatarUrl === 'string' ? u.avatarUrl : '' }
}

function normalizeMessageGithub(value: unknown): ReviewMessage['github'] | null {
  if (typeof value !== 'object' || value === null) return null
  const g = value as Record<string, unknown>
  const user = normalizeUser(g.user)
  if (typeof g.id !== 'string' || !user) return null
  return { id: g.id, user, ...(typeof g.url === 'string' ? { url: g.url } : {}) }
}

function normalizeThreadGithub(value: unknown): GithubThread | null {
  if (typeof value !== 'object' || value === null) return null
  const g = value as Record<string, unknown>
  if (typeof g.threadId !== 'string' || !GITHUB_KINDS.has(g.kind as string)) return null
  const lineOf = (v: unknown): number | null | undefined =>
    v === null ? null : typeof v === 'number' && Number.isInteger(v) ? v : undefined
  const line = lineOf(g.line)
  const startLine = lineOf(g.startLine)
  return {
    threadId: g.threadId,
    kind: g.kind as GithubThread['kind'],
    resolved: g.resolved === true,
    outdated: g.outdated === true,
    ...(REVIEW_STATES.has(g.reviewState as string)
      ? { reviewState: g.reviewState as GithubThread['reviewState'] }
      : {}),
    ...(line !== undefined ? { line } : {}),
    ...(startLine !== undefined ? { startLine } : {}),
    ...(g.side === 'LEFT' || g.side === 'RIGHT' ? { side: g.side } : {}),
    ...(typeof g.url === 'string' ? { url: g.url } : {}),
  }
}

function normalizeQueued(value: unknown): ReviewThread['queued'] | null {
  if (typeof value !== 'object' || value === null) return null
  const q = value as Record<string, unknown>
  if (q.resolve === true) return { resolve: true }
  if (q.unresolve === true) return { unresolve: true }
  return null
}

function normalizePr(value: unknown): ReviewState['pr'] | null {
  if (typeof value !== 'object' || value === null) return null
  const p = value as Record<string, unknown>
  const submissions = Array.isArray(p.submissions)
    ? p.submissions.flatMap((s: unknown) => {
        if (typeof s !== 'object' || s === null) return []
        const x = s as Record<string, unknown>
        if (
          typeof x.at !== 'string' ||
          typeof x.event !== 'string' ||
          typeof x.reviewId !== 'string'
        ) {
          return []
        }
        return [
          { at: x.at, event: x.event, reviewId: x.reviewId, comments: Number(x.comments) || 0 },
        ]
      })
    : []
  return {
    ...(typeof p.pendingReviewId === 'string' && p.pendingReviewId !== ''
      ? { pendingReviewId: p.pendingReviewId }
      : {}),
    submissions,
  }
}
