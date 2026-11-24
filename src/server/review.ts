import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { withoutArtifacts } from '../shared/artifacts.js'
import { type LayerInput, parseLayersInput, parseSuggestReason } from '../shared/layers.js'
import { type LayersPresetUse, parseLayersNote, parsePresetUse } from '../shared/presets.js'
import {
  type Anchor,
  type AnchoredCommit,
  type AnchoredLayer,
  type AnchoredLines,
  type Audience,
  type Author,
  type Coverage,
  type DraftOrigin,
  EMPTY_REVIEW,
  type GithubThread,
  isHumanMessage,
  type Landed,
  type LastFinish,
  type Layers,
  type NeedsYou,
  nextReviewerHue,
  normalizeTitle,
  openedByReviewerAgent,
  type PrCommentOutcome,
  type PrCommentSuggestion,
  parseReviewerName,
  REVIEWER_HUES,
  REVIEWER_LIMITS,
  type ReviewerAgent,
  type ReviewMessage,
  type ReviewState,
  type ReviewThread,
  roundsOf,
  type SharedLayersFrom,
  seenByAgent,
  THREAD_INTENTS,
  type ThreadCapture,
  type ThreadIntent,
  type ThreadState,
} from '../shared/review.js'
import type { ChangesetSpec } from '../shared/types.js'
import { type DiffoDb, type ReviewScope, reviewerHubKey } from './db.js'
import { getBranchName } from './git.js'

const STATES: ThreadState[] = ['open', 'sent', 'addressed', 'resolved']

/**
 * The reviewer agent's cursor (`reviewerSeenAt`) as it must stand once
 * `edited` is rewritten: an edit keeps the message's time, so a cursor at or
 * past it would never hand the new words over. It moves back to the newest
 * message before it, or goes when there is none; one still short of it stays.
 */
function reviewerCursorBefore(
  thread: ReviewThread,
  edited: ReviewMessage,
): { reviewerSeenAt?: string } {
  const seenAt = thread.reviewerSeenAt
  if (seenAt === undefined) return {}
  if (Date.parse(seenAt) < Date.parse(edited.at)) return { reviewerSeenAt: seenAt }
  const earlier = thread.messages
    .filter((m) => m.id !== edited.id && Date.parse(m.at) < Date.parse(edited.at))
    .map((m) => m.at)
    .sort()
    .at(-1)
  return earlier === undefined ? {} : { reviewerSeenAt: earlier }
}

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
    options: {
      audience?: Audience
      parentId?: string
      suggestedReply?: string
      prComment?: string
      origin?: DraftOrigin
      /** The reviewer agent that wrote it (see `ReviewMessage.by`). */
      by?: string
    } = {},
  ): ReviewThread {
    const now = new Date().toISOString()
    return this.insert({
      id: randomUUID(),
      anchor,
      state: 'open',
      // A public draft has no intent: it is a review comment, not an ask of the agent.
      ...(options.audience === 'pr' ? { audience: 'pr' as const } : intent ? { intent } : {}),
      ...(options.parentId ? { parentId: options.parentId } : {}),
      ...(options.audience === 'pr' && options.origin ? { origin: options.origin } : {}),
      codeContext: capture?.codeContext ?? null,
      ...(capture?.anchored ? { anchored: capture.anchored } : {}),
      ...(capture?.anchoredLayer ? { anchoredLayer: capture.anchoredLayer } : {}),
      ...(capture?.anchoredCommit ? { anchoredCommit: capture.anchoredCommit } : {}),
      codeChanged: false,
      messages: [
        {
          id: randomUUID(),
          author,
          text,
          at: now,
          ...(author === 'reviewer' && options.by ? { by: options.by } : {}),
          ...(author === 'agent' && options.suggestedReply
            ? { suggestedReply: options.suggestedReply }
            : {}),
          ...(author === 'agent' && options.prComment
            ? { prComment: { text: options.prComment } }
            : {}),
        },
      ],
      createdAt: now,
      updatedAt: now,
    })
  }

  /**
   * The reviewer's decision on a suggested PR comment: added to their review
   * (the public draft it became is named) or dismissed. Stamped once — a
   * decided suggestion is history, and the card shows it as such. Null when
   * the thread or message is not a live suggestion.
   */
  decidePrComment(
    threadId: string,
    messageId: string,
    outcome: PrCommentOutcome,
  ): ReviewThread | null {
    const current = this.state.threads.find((t) => t.id === threadId)
    const message = current?.messages.find((m) => m.id === messageId)
    if (!current || !message || message.author !== 'agent' || !message.prComment) return null
    if (message.prComment.outcome !== undefined) return null
    return this.setPrCommentOutcome(threadId, messageId, outcome)
  }

  /**
   * The decision taken back: a dismissed suggestion returns live, with its
   * buttons. An added one does too, but only once the draft it became is gone
   * (discarded) — while the draft stands, reviving the suggestion would offer
   * the same comment twice. Null when there is nothing to restore.
   */
  restorePrComment(threadId: string, messageId: string): ReviewThread | null {
    const current = this.state.threads.find((t) => t.id === threadId)
    const message = current?.messages.find((m) => m.id === messageId)
    const outcome = message?.prComment?.outcome
    if (!current || !message || !outcome) return null
    if (
      outcome.kind === 'added' &&
      this.state.threads.some((t) => t.id === outcome.draftThreadId)
    ) {
      return null
    }
    return this.setPrCommentOutcome(threadId, messageId, undefined)
  }

  private setPrCommentOutcome(
    threadId: string,
    messageId: string,
    outcome: PrCommentOutcome | undefined,
  ): ReviewThread | null {
    return this.update(threadId, (thread) => ({
      ...thread,
      messages: thread.messages.map((m) => {
        if (m.id !== messageId) return m
        const { outcome: _was, ...rest } = m.prComment!
        return { ...m, prComment: outcome ? { ...rest, outcome } : rest }
      }),
    }))
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
   * as "waiting on the agent" even though it still is.
   *
   * `by` names the reviewer agent that wrote a `reviewer` message. The rounds
   * cap is kept here, in the one place a message lands: the author agent's
   * answer that completes the last allowed round marks the thread `needsYou`,
   * and the human's next message clears it. */
  addMessage(
    threadId: string,
    author: Author,
    text: string,
    withheld = false,
    seenThroughMs?: number,
    followUp = false,
    suggestedReply?: string,
    prComment?: string,
    by?: string,
  ): ReviewThread | null {
    return this.update(threadId, ({ unanswered: _answered, needsYou, ...thread }) => {
      const message: ReviewMessage = {
        id: randomUUID(),
        author,
        text,
        at: new Date().toISOString(),
        ...(author === 'reviewer' && by ? { by } : {}),
        ...(author === 'agent' && suggestedReply ? { suggestedReply } : {}),
        ...(author === 'agent' && prComment ? { prComment: { text: prComment } } : {}),
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
      const messages =
        raced === -1
          ? [...thread.messages, message]
          : [...thread.messages.slice(0, raced), message, ...thread.messages.slice(raced)]
      // An interim reply is not the answer yet: the round closes, and the cap
      // with it, on the plain reply that follows.
      const capped =
        author === 'agent' &&
        !followUp &&
        thread.state !== 'resolved' &&
        openedByReviewerAgent({ messages }) !== null &&
        roundsOf({ messages }) >= REVIEWER_LIMITS.rounds
      return {
        ...(author === 'agent' ? settled : thread),
        // The human's word takes the thread back from the agents; anyone
        // else's leaves it stopped.
        ...(needsYou && !isHumanMessage(message)
          ? { needsYou }
          : capped
            ? { needsYou: 'rounds' as const }
            : {}),
        ...(author === 'agent' && followUp ? { awaitingFollowUp: true as const } : {}),
        // An agent message does NOT clear this: it proves the agent had the thread, not
        // that it saw the line you are still holding. Only a real hand-over
        // (`clearWithheld`, from Send or Finish) clears it.
        ...(withheld && author === 'reviewer' ? { withheld: true } : {}),
        messages,
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
    // Only the human edits, and an edit is their word on the thread: it lifts
    // `needsYou` the way a reply does.
    return this.update(
      threadId,
      ({ unanswered, awaitingFollowUp, needsYou: _needs, reviewerSeenAt: _cursor, ...thread }) => {
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
          // A reviewer agent handed these words already gets them again: its
          // cursor goes back to just before them.
          ...reviewerCursorBefore(current, before),
          messages: [...thread.messages.slice(0, index), edited],
        }
      },
    )
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

  /**
   * An agent in a reviewer agent's thread hands it to the human for a
   * decision (`reply --ask`): it stops the way a thread at the rounds cap
   * does, neither agent is handed it or writes in it, and the human's next
   * word gives it back.
   */
  askHuman(threadId: string, who: 'author' | 'reviewer'): ReviewThread | null {
    return this.update(threadId, (thread) => ({ ...thread, needsYou: who }))
  }

  /** `by` names the reviewer agent closing a thread it opened; a resolve
   * without it is the human's. */
  setState(threadId: string, state: ThreadState, by?: string): ReviewThread | null {
    return this.update(
      threadId,
      ({ awaitingFollowUp: promised, needsYou, resolvedBy: _was, ...thread }) => ({
        ...thread,
        // Resolving settles the promised follow-up along with the thread.
        ...(promised && state !== 'resolved' ? { awaitingFollowUp: true as const } : {}),
        // A resolved thread needs nobody. One reopened with its rounds spent
        // is the human's again: an agent may write in it only after they do.
        ...(state === 'resolved'
          ? {}
          : needsYou
            ? { needsYou }
            : state === 'open' &&
                openedByReviewerAgent(thread) !== null &&
                roundsOf(thread) >= REVIEWER_LIMITS.rounds
              ? { needsYou: 'rounds' as const }
              : {}),
        ...(state === 'resolved' && by ? { resolvedBy: by } : {}),
        state,
        ...(state === 'sent' && !thread.sentAt ? { sentAt: new Date().toISOString() } : {}),
        // A settled thread drops its frozen diff: the snapshot keeps the thread legible
        // while the code moves underneath it, and it is the heaviest thing in the store
        // (66% of the review row). The messages stay, and so does `anchored` — it is
        // small, and a follow-up on this thread has nothing else to point at the code.
        // Reopening does not bring the snapshot back.
        ...(state === 'resolved' ? { codeContext: null } : {}),
      }),
    )
  }

  /** A reviewer agent takes its seat: every reviewer command does, `join`
   * with a role, the others without. Idempotent: a seat taken again stays the
   * first one, and changes only the role when it names another. */
  registerReviewer(name: string, role?: string): ReviewerAgent {
    const seats = this.state.reviewers ?? []
    const seated = seats.find((r) => r.name === name)
    if (seated && (role === undefined || seated.role === role)) return seated
    const reviewer: ReviewerAgent = seated
      ? { ...seated, role }
      : {
          name,
          joinedAt: new Date().toISOString(),
          ...(role ? { role } : {}),
          hue: nextReviewerHue(seats.map((r) => r.hue)),
        }
    this.state = {
      ...this.state,
      reviewers: seated ? seats.map((r) => (r === seated ? reviewer : r)) : [...seats, reviewer],
    }
    this.commit()
    return reviewer
  }

  /** Where the reviewer agents' log, unread messages and removals are kept
   * (see `ReviewerHubSnapshot`): beside the review, not in it, so a progress
   * line does not wake every listener on the review. */
  private hubKey(): string {
    return reviewerHubKey(this.key.repoPath, this.key.branch, this.key.base)
  }

  loadReviewerHub(): string | null {
    return this.db.getUiSetting(this.hubKey())
  }

  saveReviewerHub(json: string): void {
    this.db.setUiSetting(this.hubKey(), json)
  }

  /** The human takes a reviewer agent out of the review. Its threads stay:
   * they are part of what was said. False when it had no seat. */
  removeReviewer(name: string): boolean {
    const seats = this.state.reviewers ?? []
    if (!seats.some((r) => r.name === name)) return false
    const { reviewers: _was, ...rest } = this.state
    const left = seats.filter((r) => r.name !== name)
    this.state = left.length > 0 ? { ...rest, reviewers: left } : rest
    this.commit()
    return true
  }

  /** The author agent's flag: this change deserves a reviewer in this role.
   * The newest one stands; a second flag replaces the first. */
  suggestReviewer(role: string, reason?: string): void {
    this.state = { ...this.state, reviewerSuggested: { role, ...(reason ? { reason } : {}) } }
    this.commit()
  }

  /** The suggestion is settled: the human started a reviewer or passed, or one
   * joined. With a role, only a suggestion for that role goes. False when
   * there was none to clear. */
  clearReviewerSuggestion(role?: string): boolean {
    const suggested = this.state.reviewerSuggested
    if (!suggested || (role !== undefined && suggested.role !== role)) return false
    const { reviewerSuggested: _gone, ...rest } = this.state
    this.state = rest
    this.commit()
    return true
  }

  /** A reviewer agent's poll just handed it these threads, each through the
   * message named: its inbox is whatever lands after that one. */
  markReviewerSeen(handed: readonly { threadId: string; through: string }[]): void {
    const through = new Map(handed.map((h) => [h.threadId, h.through]))
    if (!this.state.threads.some((t) => through.has(t.id))) return
    this.state = {
      ...this.state,
      threads: this.state.threads.map((t) =>
        through.has(t.id) ? { ...t, reviewerSeenAt: through.get(t.id)! } : t,
      ),
    }
    this.commit()
  }

  removeThread(threadId: string): boolean {
    const removed = this.state.threads.find((t) => t.id === threadId)
    if (!removed) return false
    this.state = { ...this.state, threads: this.state.threads.filter((t) => t.id !== threadId) }
    this.commit()
    // A discarded draft that began as the agent's suggestion hands the
    // suggestion back: the words are still in the private thread, and the
    // reviewer may want them again, edited differently, or dismissed for good.
    if (removed.origin) this.restorePrComment(removed.origin.threadId, removed.origin.messageId)
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
    const { lastFinish, landed, title, layers, layersSuggested, reviewers, reviewerSuggested } =
      this.state
    if (
      ids.length === 0 &&
      !lastFinish &&
      !landed &&
      !title &&
      !layers &&
      !layersSuggested &&
      !reviewers &&
      !reviewerSuggested
    ) {
      return []
    }
    const {
      lastFinish: _finish,
      landed: _landed,
      title: _title,
      // The plan described the round that ended; the next one is outlined afresh.
      layers: _layers,
      layersSuggested: _suggested,
      // A seat belongs to the round: the next one's reviewers join again.
      reviewers: _reviewers,
      reviewerSuggested: _reviewerSuggested,
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
   * active layer in place across a re-post. Posting also answers the
   * suggestion: it stops nudging and stays as what the agent thinks fits, and
   * a preset the agent picked for this post replaces it.
   */
  setLayers(
    items: readonly LayerInput[],
    follows: { preset?: LayersPresetUse; note?: string; shared?: SharedLayersFrom } = {},
  ): Layers {
    const kept = new Map((this.state.layers?.items ?? []).map((l) => [l.title, l.id]))
    const layers: Layers = {
      items: items.map((item) => ({ id: kept.get(item.title) ?? randomUUID(), ...item })),
      postedAt: new Date().toISOString(),
      ...(follows.preset ? { preset: follows.preset } : {}),
      ...(follows.note ? { note: follows.note } : {}),
      ...(follows.shared ? { shared: follows.shared } : {}),
    }
    const { layersSuggested: prior, ...rest } = this.state
    const picked = follows.preset?.picked ? follows.preset : undefined
    const suggested = picked
      ? {
          preset: picked.id,
          ...(picked.why ? { reason: picked.why } : {}),
          answered: true as const,
        }
      : prior
        ? { ...prior, answered: true as const }
        : undefined
    this.state = {
      ...rest,
      layers,
      ...(suggested ? { layersSuggested: suggested } : {}),
      threads: reconcileLayerThreads(rest.threads, layers),
    }
    this.commit()
    return layers
  }

  /**
   * A reading guide shared on the pull request becomes this review's layers,
   * unless the review already has its own: an outline this review's agent
   * posted always wins, and a guide never overwrites it. A guide already loaded
   * is replaced only by a newer share of it. Returns whether the layers changed.
   */
  applySharedLayers(items: readonly LayerInput[], from: SharedLayersFrom): boolean {
    const current = this.state.layers
    if (current && !current.shared) return false
    if (
      current?.shared &&
      current.shared.commentId === from.commentId &&
      current.shared.postedAt === from.postedAt
    ) {
      return false
    }
    // A pack is someone else's text: an artifact in it would run here.
    this.setLayers(items.map(withoutArtifacts), { shared: from })
    return true
  }

  /** The reviewer removed the outline. The layers go; a sent thread on one of
   * them reads as addressed, as it does when a re-post drops its layer.
   * False when there was no outline to remove. */
  removeLayers(): boolean {
    if (!this.state.layers) return false
    const { layers: _layers, ...rest } = this.state
    this.state = {
      ...rest,
      threads: reconcileLayerThreads(rest.threads, { items: [], postedAt: '' }),
    }
    this.commit()
    return true
  }

  /** The agent's flag at open: this read benefits from layers, and, when it
   * names one, by which preset. Once layers exist the flag has nothing to
   * add, so it is refused rather than recorded. */
  suggestLayers(reason?: string, preset?: string): boolean {
    if (this.state.layers) return false
    this.state = {
      ...this.state,
      layersSuggested: { ...(reason ? { reason } : {}), ...(preset ? { preset } : {}) },
    }
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
   * The branch's commits moved — a rebase, an amend, a reword. A commit thread
   * follows its commit's message, the way a hunk thread follows its content: on
   * a commit still listed by its sha it stays; on a new sha with the very same
   * message (a rebase, an amend that kept the words) it moves there. With
   * neither the commit was reworded, squashed or dropped: the thread is flagged
   * `codeChanged` (cleared if it comes back), and a `sent` one becomes `addressed`.
   */
  reconcileCommits(listed: readonly CommitMessage[]): void {
    const shas = new Set(listed.map((c) => c.sha))
    const byMessage = new Map<string, CommitMessage>()
    for (const c of listed) {
      const key = messageKey(c.subject, c.body)
      if (!byMessage.has(key)) byMessage.set(key, c)
    }
    let changed = false
    const threads = this.state.threads.map((thread) => {
      if (thread.anchor.kind !== 'commit') return thread
      const frozen = thread.anchoredCommit
      const moved =
        shas.has(thread.anchor.sha) || !frozen
          ? undefined
          : byMessage.get(messageKey(frozen.subject, frozen.body ?? ''))
      const anchor = moved ? { ...thread.anchor, sha: moved.sha } : thread.anchor
      const exists = shas.has(anchor.sha)
      // Unlike a hunk thread's, a commit thread's liveness is this flag alone
      // (`threadsInChangeset`), so it is set whatever the state: an addressed or
      // resolved thread on a dropped commit reads with the past too.
      const codeChanged = !exists
      if (thread.state === 'sent' && !exists) {
        changed = true
        return {
          ...thread,
          anchor,
          state: 'addressed' as const,
          codeChanged,
          updatedAt: new Date().toISOString(),
        }
      }
      if (anchor === thread.anchor && codeChanged === thread.codeChanged) return thread
      changed = true
      return { ...thread, anchor, codeChanged }
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
  const reviewers = normalizeReviewers(parsed.reviewers, now)
  const suggestedRole = storedName((parsed.reviewerSuggested as { role?: unknown } | null)?.role)
  const suggestedWhy = parseSuggestReason(
    (parsed.reviewerSuggested as { reason?: unknown } | null)?.reason,
  )
  return {
    version: 1,
    threads: [...valid, ...migrated],
    ...(reviewers.length > 0 ? { reviewers } : {}),
    ...(suggestedRole
      ? {
          reviewerSuggested: {
            role: suggestedRole,
            ...(suggestedWhy ? { reason: suggestedWhy } : {}),
          },
        }
      : {}),
    ...(pr ? { pr } : {}),
    ...(title ? { title } : {}),
    ...(lastFinish ? { lastFinish } : {}),
    ...(typeof parsed.seenHead === 'string' && parsed.seenHead !== ''
      ? { seenHead: parsed.seenHead }
      : {}),
    ...(landed ? { landed } : {}),
    ...(layers ? { layers } : {}),
    // Next to layers a suggestion is answered, whatever the file says: it is
    // kept for what it names, and no longer nudges.
    ...(layersSuggested
      ? {
          layersSuggested: layers
            ? { ...layersSuggested, answered: true as const }
            : layersSuggested,
        }
      : {}),
  }
}

/** Seats with a name the door would refuse are dropped; one name, one seat. */
function normalizeReviewers(value: unknown, now: string): ReviewerAgent[] {
  if (!Array.isArray(value)) return []
  const seats = new Map<string, ReviewerAgent>()
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) continue
    const r = entry as Record<string, unknown>
    const parsed = parseReviewerName(r.name)
    if (!parsed.ok || seats.has(parsed.name)) continue
    const role = storedName(r.role)
    // A seat with no colour it can wear gets the next free one.
    const hue =
      typeof r.hue === 'number' && Number.isInteger(r.hue) && r.hue >= 1 && r.hue <= REVIEWER_HUES
        ? r.hue
        : nextReviewerHue([...seats.values()].map((s) => s.hue))
    seats.set(parsed.name, {
      name: parsed.name,
      joinedAt: typeof r.joinedAt === 'string' ? r.joinedAt : now,
      ...(role ? { role } : {}),
      hue,
    })
  }
  return [...seats.values()]
}

/** A stored name that would not pass the door is dropped, and the message or
 * thread reads as the human's: the safe side, since the human's word is the
 * one an agent may not overrule. */
function storedName(value: unknown): string | undefined {
  const parsed = parseReviewerName(value)
  return parsed.ok ? parsed.name : undefined
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
  // The preset is read back through the post's own validation; a bad one is
  // dropped on its own, the list stays.
  const use = parsePresetUse(l.preset)
  const note = parseLayersNote(l.note)
  const shared = normalizeShared(l.shared)
  return {
    items: parsed.items.map((item, i) => ({ id: ids[i]!, ...item })),
    postedAt: typeof l.postedAt === 'string' ? l.postedAt : now,
    ...(use.ok && use.use ? { preset: use.use } : {}),
    ...(note ? { note } : {}),
    ...(shared ? { shared } : {}),
  }
}

function normalizeShared(value: unknown): SharedLayersFrom | null {
  if (typeof value !== 'object' || value === null) return null
  const v = value as Record<string, unknown>
  const str = (k: string) => (typeof v[k] === 'string' && v[k] !== '' ? (v[k] as string) : null)
  const by = str('by')
  const sha = str('sha')
  const commentId = str('commentId')
  const postedAt = str('postedAt')
  if (!by || !sha || !commentId || !postedAt) return null
  const url = str('url')
  return { by, sha, commentId, postedAt, ...(url ? { url } : {}) }
}

function normalizeSuggested(
  value: unknown,
): { reason?: string; preset?: string; answered?: true } | null {
  if (typeof value !== 'object' || value === null) return null
  const v = value as { reason?: unknown; preset?: unknown; answered?: unknown }
  const reason = parseSuggestReason(v.reason)
  // The id goes through the post's own check; whether it is still a preset
  // that is on is decided where it is shown.
  const use = typeof v.preset === 'string' ? parsePresetUse({ id: v.preset }) : null
  return {
    ...(reason ? { reason } : {}),
    ...(use?.ok && use.use ? { preset: use.use.id } : {}),
    ...(v.answered === true ? { answered: true as const } : {}),
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

/**
 * A re-post dropped a layer (its title is gone), so the threads on it have
 * nothing left to sit under — the same fate as a hunk whose id rotated: a
 * `sent` thread was overtaken and reads as addressed; an open one stays as it
 * is and the UI files it with the threads the changeset left behind.
 */
function reconcileLayerThreads(threads: ReviewThread[], layers: Layers): ReviewThread[] {
  const ids = new Set(layers.items.map((l) => l.id))
  return threads.map((thread) =>
    thread.anchor.kind === 'layer' && thread.state === 'sent' && !ids.has(thread.anchor.layerId)
      ? { ...thread, state: 'addressed' as const, updatedAt: new Date().toISOString() }
      : thread,
  )
}

export function parseAnchor(value: unknown): Anchor | null {
  if (typeof value !== 'object' || value === null) return null
  const anchor = value as Record<string, unknown>
  if (anchor.kind === 'layer') {
    if (typeof anchor.layerId !== 'string' || anchor.layerId === '') return null
    if (typeof anchor.title !== 'string' || anchor.title.trim() === '') return null
    return { kind: 'layer', layerId: anchor.layerId, title: anchor.title.trim() }
  }
  if (anchor.kind === 'commit') {
    if (typeof anchor.sha !== 'string' || !/^[0-9a-f]{40}$/.test(anchor.sha)) return null
    const subject = typeof anchor.subject === 'string' ? anchor.subject.trim() : ''
    return { kind: 'commit', sha: anchor.sha, subject }
  }
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
    const commit =
      typeof anchor.commit === 'string' && /^[0-9a-f]{40}$/.test(anchor.commit)
        ? anchor.commit
        : undefined
    return {
      kind: 'hunk',
      hunkId: anchor.hunkId,
      path: anchor.path,
      side: anchor.side,
      line: anchor.line,
      ...(endLine !== undefined ? { endLine } : {}),
      ...(commit !== undefined ? { commit } : {}),
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

/** A listed commit, as `reconcileCommits` matches threads against it. */
export interface CommitMessage {
  sha: string
  subject: string
  body: string
}

const messageKey = (subject: string, body: string): string => `${subject}\n\n${body}`

/** Dropped when malformed — the thread keeps its anchor's subject regardless. */
function normalizeAnchoredCommit(value: unknown): AnchoredCommit | null {
  if (typeof value !== 'object' || value === null) return null
  const a = value as Record<string, unknown>
  if (typeof a.subject !== 'string') return null
  return {
    subject: a.subject,
    ...(typeof a.body === 'string' && a.body !== '' ? { body: a.body } : {}),
  }
}

/** Dropped when malformed — the thread keeps its anchor's title regardless. */
function normalizeAnchoredLayer(value: unknown): AnchoredLayer | null {
  if (typeof value !== 'object' || value === null) return null
  const a = value as Record<string, unknown>
  if (typeof a.title !== 'string' || !Array.isArray(a.files)) return null
  if (!a.files.every((f: unknown) => typeof f === 'string')) return null
  return {
    title: a.title,
    ...(typeof a.summary === 'string' && a.summary !== '' ? { summary: a.summary } : {}),
    files: a.files as string[],
  }
}

function normalizePrComment(value: unknown): PrCommentSuggestion | null {
  if (typeof value !== 'object' || value === null) return null
  const v = value as Record<string, unknown>
  if (typeof v.text !== 'string' || v.text.trim() === '') return null
  const o = v.outcome
  let outcome: PrCommentOutcome | undefined
  if (typeof o === 'object' && o !== null) {
    const r = o as Record<string, unknown>
    const at = typeof r.at === 'string' ? r.at : new Date().toISOString()
    if (r.kind === 'dismissed') outcome = { kind: 'dismissed', at }
    else if (r.kind === 'added' && typeof r.draftThreadId === 'string') {
      outcome = { kind: 'added', draftThreadId: r.draftThreadId, edited: r.edited === true, at }
    }
  }
  return { text: v.text, ...(outcome ? { outcome } : {}) }
}

function normalizeOrigin(value: unknown): DraftOrigin | null {
  if (typeof value !== 'object' || value === null) return null
  const v = value as Record<string, unknown>
  if (typeof v.threadId !== 'string' || typeof v.messageId !== 'string') return null
  return { threadId: v.threadId, messageId: v.messageId, edited: v.edited === true }
}

function normalizeThread(value: unknown, now: string): ReviewThread | null {
  if (typeof value !== 'object' || value === null) return null
  const t = value as Record<string, unknown>
  if (typeof t.id !== 'string' || !STATES.includes(t.state as ThreadState)) return null
  const anchor = parseAnchor(t.anchor)
  if (!anchor) return null
  const anchored = normalizeAnchored(t.anchored)
  const anchoredLayer = normalizeAnchoredLayer(t.anchoredLayer)
  const anchoredCommit = normalizeAnchoredCommit(t.anchoredCommit)
  if (!Array.isArray(t.messages)) return null
  // Why it stopped for the human; anything else is not a stop.
  const needsYou: NeedsYou | null =
    t.needsYou === 'rounds' || t.needsYou === 'author' || t.needsYou === 'reviewer'
      ? t.needsYou
      : null
  const messages: ReviewMessage[] = []
  for (const m of t.messages) {
    if (typeof m !== 'object' || m === null) return null
    const msg = m as Record<string, unknown>
    if (typeof msg.text !== 'string') return null
    if (msg.author !== 'reviewer' && msg.author !== 'agent' && msg.author !== 'github') return null
    const github = normalizeMessageGithub(msg.github)
    // A GitHub-authored message with no GitHub identity is nobody's — drop the thread.
    if (msg.author === 'github' && !github) return null
    const by = msg.author === 'reviewer' ? storedName(msg.by) : undefined
    messages.push({
      id: typeof msg.id === 'string' ? msg.id : randomUUID(),
      author: msg.author,
      text: msg.text,
      at: typeof msg.at === 'string' ? msg.at : now,
      ...(typeof msg.durationMs === 'number' ? { durationMs: msg.durationMs } : {}),
      ...(msg.author === 'agent' && typeof msg.suggestedReply === 'string' && msg.suggestedReply
        ? { suggestedReply: msg.suggestedReply }
        : {}),
      ...(msg.author === 'agent' && normalizePrComment(msg.prComment)
        ? { prComment: normalizePrComment(msg.prComment)! }
        : {}),
      ...(typeof msg.editedAt === 'string' ? { editedAt: msg.editedAt } : {}),
      ...(by ? { by } : {}),
      ...(github ? { github } : {}),
    })
  }
  const github = normalizeThreadGithub(t.github)
  const queued = normalizeQueued(t.queued)
  const resolvedBy = t.state === 'resolved' ? storedName(t.resolvedBy) : undefined
  return {
    id: t.id,
    anchor,
    state: t.state as ThreadState,
    ...(t.audience === 'pr' ? { audience: 'pr' as const } : {}),
    ...(typeof t.parentId === 'string' && t.parentId !== '' ? { parentId: t.parentId } : {}),
    ...(github ? { github } : {}),
    ...(t.audience === 'pr' && normalizeOrigin(t.origin)
      ? { origin: normalizeOrigin(t.origin)! }
      : {}),
    ...(queued ? { queued } : {}),
    ...(THREAD_INTENTS.includes(t.intent as ThreadIntent)
      ? { intent: t.intent as ThreadIntent }
      : {}),
    codeContext: typeof t.codeContext === 'string' ? t.codeContext : null,
    ...(anchored ? { anchored } : {}),
    ...(anchoredLayer ? { anchoredLayer } : {}),
    ...(anchoredCommit ? { anchoredCommit } : {}),
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
    // A resolved thread needs nobody, whatever the file says.
    ...(needsYou && t.state !== 'resolved' ? { needsYou } : {}),
    ...(resolvedBy ? { resolvedBy } : {}),
    ...(typeof t.reviewerSeenAt === 'string' ? { reviewerSeenAt: t.reviewerSeenAt } : {}),
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
