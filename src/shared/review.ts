import type { FileChange, GhUser } from './types.js'

export type ThreadState = 'open' | 'sent' | 'addressed' | 'resolved'

export type ThreadIntent = 'question' | 'fix'

export const THREAD_INTENTS: readonly ThreadIntent[] = ['fix', 'question']

export type Anchor =
  /** `line` is the first (or only) anchored line; `endLine` widens it to a range.
   * Absent `endLine` ⇒ a single line, so every pre-range anchor is already valid. */
  | {
      kind: 'hunk'
      hunkId: string
      path: string
      side: 'old' | 'new'
      line: number
      endLine?: number
    }
  | { kind: 'file'; path: string }
  | { kind: 'changeset' }
  /** One step of the agent's outline. `layerId` is the server-minted id, which
   * a re-post keeps for a matching title, so the thread follows its layer by
   * title. `title` is carried so a thread whose layer left the outline can
   * still say which step it was about. Agent-only: GitHub has no layers. */
  | { kind: 'layer'; layerId: string; title: string }

/** `github` is a person on the pull request — the author, another reviewer, a
 * bot — carried on the message's `github` block. The reviewer's own words posted
 * to GitHub stay `reviewer`: the message gains a `github` id when it lands. */
export type Author = 'reviewer' | 'agent' | 'github'

/** Who a thread is for. Absent means the agent — every thread from before pull
 * requests existed, and every private thread since. A `pr` thread is a review
 * comment: drafted here, posted to GitHub on Finish, never handed to the agent. */
export type Audience = 'pr' | 'agent'

/** The exact lines a hunk anchor covers, frozen at creation: where they sit
 * inside `codeContext` (0-based row indices, inclusive) and their text
 * (`+`/`-`/` `-prefixed like the snapshot, capped). The text outlives the
 * snapshot — `codeContext` is dropped on resolve, and once the code moves the
 * anchor's line numbers go stale, so this text is how a later follow-up still
 * identifies what the comment was about. */
export interface AnchoredLines {
  start: number
  end: number
  text: string
}

/** The layer as it was outlined when a layer thread was opened. A re-post may
 * reword the summary or move files; this is what the comment was about. */
export interface AnchoredLayer {
  title: string
  summary?: string
  files: string[]
}

/** What a new thread freezes about the code it anchors to. `anchored` is absent
 * for pre-range snapshots and for anchors whose lines fell outside the hunk.
 * A layer thread freezes the layer instead and carries no snapshot. */
export interface ThreadCapture {
  codeContext: string | null
  anchored?: AnchoredLines
  anchoredLayer?: AnchoredLayer
}

export interface ReviewMessage {
  id: string
  author: Author
  text: string
  at: string
  durationMs?: number
  /** Agent only: a reply the agent offers the reviewer, one line. The composer
   * shows it as ghost text while the reviewer has typed nothing; Tab takes it.
   * Never sent on its own — the reviewer still presses send. */
  suggestedReply?: string
  /** Agent only, on a pull request: a review comment it drafted for the
   * reviewer to leave the author. Nothing of it reaches GitHub on its own —
   * the reviewer adds it to their review (as a public draft on the same
   * anchor), edits it first, or dismisses it; the `outcome` records which.
   * Absent `outcome` on the latest such message ⇒ the suggestion is live. */
  prComment?: PrCommentSuggestion
  /** ISO, stamped when the reviewer rewrites a message the agent had already
   * seen. An edit to words the agent never saw is just a draft fixed in place. */
  editedAt?: string
  /** Set once the message exists on GitHub: the comment's node id, who wrote it
   * there, and where. A `reviewer` message in a posted public thread without
   * this block is a reply still owed to GitHub. */
  github?: { id: string; user: GhUser; url?: string }
}

export interface PrCommentSuggestion {
  /** The comment as GitHub will show it: Markdown, a ```suggestion block allowed. */
  text: string
  outcome?: PrCommentOutcome
}

export type PrCommentOutcome =
  /** The reviewer added it to their review: `draftThreadId` is the public
   * draft it became, `edited` whether they changed the words first. */
  | { kind: 'added'; draftThreadId: string; edited: boolean; at: string }
  | { kind: 'dismissed'; at: string }

/** Where a public draft came from, when the agent wrote the first version:
 * the private thread and message that carried the suggestion. Rendering
 * only — the draft is the reviewer's, and posts under their login. */
export interface DraftOrigin {
  threadId: string
  messageId: string
  edited: boolean
}

/** A review comment on GitHub tops out at 65 536 characters; a suggestion that
 * long is a mistake, and the reviewer edits it in a thread card. */
export const PR_COMMENT_MAX = 10_000

export function parsePrComment(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const text = value.trim()
  return text ? text.slice(0, PR_COMMENT_MAX) : undefined
}

/**
 * The suggestion the reviewer can still act on: the latest agent message
 * carrying one, while nothing has been decided about it and the thread is
 * open. Earlier suggestions in the same thread are superseded, decided or
 * not — a redraft replaces, it never stacks.
 */
export function liveSuggestion(thread: ReviewThread): ReviewMessage | null {
  if (isPublic(thread) || thread.state === 'resolved') return null
  for (let i = thread.messages.length - 1; i >= 0; i--) {
    const m = thread.messages[i]!
    if (m.author !== 'agent' || !m.prComment) continue
    return m.prComment.outcome === undefined ? m : null
  }
  return null
}

/** Ghost text has one line and little room: collapse whitespace and cap it. */
export const SUGGESTED_REPLY_MAX = 120

export function parseSuggestedReply(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const line = value.replace(/\s+/g, ' ').trim()
  return line ? line.slice(0, SUGGESTED_REPLY_MAX) : undefined
}

/** A public thread's link to GitHub, filled when it is imported or posted. */
export interface GithubThread {
  /** The review thread's node id (inline), the review's (a body), the comment's
   * (a general comment), or `description`. What replies and resolves address. */
  threadId: string
  kind: 'inline' | 'review' | 'comment' | 'description'
  /** For a `review` thread: the verdict it carried. */
  reviewState?: 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED' | 'DISMISSED'
  resolved: boolean
  /** GitHub's own verdict: the commented line is no longer in the diff. */
  outdated: boolean
  /** The line GitHub reports, for re-anchoring after a push. */
  line?: number | null
  startLine?: number | null
  side?: 'LEFT' | 'RIGHT'
  url?: string
}

export interface ReviewThread {
  id: string
  anchor: Anchor
  state: ThreadState
  /** See {@link Audience}. Absent ⇒ 'agent'. */
  audience?: Audience
  /** A private aside under a public thread: same anchor, rendered nested under
   * its parent, delivered to the agent like any private thread. */
  parentId?: string
  /** Present on every public thread that exists on GitHub. */
  github?: GithubThread
  /** A public draft the agent first wrote; see {@link DraftOrigin}. */
  origin?: DraftOrigin
  /** Queued for Finish — nothing has left the machine. */
  queued?: { resolve?: true; unresolve?: true }
  intent?: ThreadIntent
  codeContext: string | null
  /** See {@link AnchoredLines}. Absent on threads created before it existed. */
  anchored?: AnchoredLines
  /** See {@link AnchoredLayer}. Present on every layer thread. */
  anchoredLayer?: AnchoredLayer
  /** The anchored hunk no longer exists in the current changeset (its
   * content-addressed ID rotated). `sent` threads become `addressed` instead. */
  codeChanged: boolean
  /** The agent concluded the batch this thread went out in without replying —
   * not "slow", so the UI must stop waiting on it. */
  unanswered?: boolean
  /** The agent's last reply was posted with `--more`: an interim word, with a
   * follow-up promised on this thread. The UI keeps waiting on the agent
   * instead of handing the turn back. Cleared by the agent's next plain
   * reply; downgraded to `unanswered` when the batch closes without one. */
  awaitingFollowUp?: true
  /** The reviewer's closing note for one Finish round, kept as a thread rather
   * than as prose in the prompt: a note the agent cannot reply to is the one
   * piece of the review with no way back. Anchored to the changeset, created by
   * Finish, and flushed in that same batch. */
  closingNote?: true
  /** ISO, stamped on the transition to `sent`. The queue's line is FIFO by this,
   * so it has to survive a restart. */
  sentAt?: string
  /** The reviewer added a reply and chose not to hand it over yet. Stored rather
   * than inferred, because "the last message is the reviewer's" is also true of a
   * reply that WAS delivered. */
  withheld?: boolean
  /** ISO, stamped when a delivery hands this thread to the agent. Messages after
   * it raced in mid-answer: the agent's reply inserts before them, and the UI
   * draws its typing indicator there rather than under words the agent has
   * never seen. */
  deliveredThrough?: string
  /** The reviewer rewrote a message the agent had seen and everything after it
   * was cut. The agent's session still remembers the cut replies, so the next
   * delivery has to say they are withdrawn; that delivery clears the flag. */
  rewound?: true
  messages: ReviewMessage[]
  createdAt: string
  updatedAt: string
}

/** For the agent, or for GitHub. Absent audience is the agent — every thread
 * from before pull requests existed. */
export function isPublic(thread: Pick<ReviewThread, 'audience'>): boolean {
  return thread.audience === 'pr'
}

/** A public thread the reviewer wrote here and has not posted yet. */
export function isDraft(thread: ReviewThread): boolean {
  return isPublic(thread) && thread.state === 'open' && thread.github === undefined
}

/** Reviewer replies on a posted public thread that GitHub has not seen. */
export function unpostedReplies(thread: ReviewThread): ReviewMessage[] {
  if (!isPublic(thread) || thread.github === undefined) return []
  return thread.messages.filter((m) => m.author === 'reviewer' && m.github === undefined)
}

/** The retired predecessor of agent-started threads. Kept only so `parseReview`
 * can migrate a stored review that still carries them. */
export interface LegacySuggestion {
  id: string
  file: string
  line: number | null
  text: string
  at: string
}

/** The thread was started by the agent (its opening message is the agent's).
 * Drives rendering — avatar, head label — and never changes. */
export function startedByAgent(thread: ReviewThread): boolean {
  return thread.messages[0]?.author === 'agent'
}

/** The agent has this message: it replied after it, or a delivery carried it.
 * Decides what an edit is — a draft fixed in place, or a change of mind the
 * agent has to be told about. */
export function seenByAgent(thread: ReviewThread, index: number): boolean {
  const message = thread.messages[index]
  if (!message) return false
  if (thread.messages.slice(index + 1).some((m) => m.author === 'agent')) return true
  return (
    thread.deliveredThrough !== undefined &&
    Date.parse(message.at) <= Date.parse(thread.deliveredThrough)
  )
}

/** Agent-started with nothing of the reviewer's in it. Only these are excluded
 * from the reviewer's counts, Send, and the finish flush — the moment the
 * reviewer writes a reply into an agent thread, it carries their feedback and
 * moves exactly like a thread they opened themselves. */
export function untouchedAgentVoice(thread: ReviewThread): boolean {
  return startedByAgent(thread) && !thread.messages.some((m) => m.author === 'reviewer')
}

/**
 * Where you left off: the last time you hit Finish. One record, overwritten each
 * time, never a history. `hunkIds` does the real work — hunk ids are
 * content-addressed, so `current − hunkIds` IS "what changed since I last looked".
 */
export interface LastFinish {
  at: string
  hunkIds: string[]
  coverage: Coverage
  /** Absent ⇒ nobody has picked the batch up yet, so a restart must send it again. */
  collectedAt?: string
}

/**
 * The commit that took this review's changeset — the local equivalent of "PR
 * merged", and the one moment a review's life provably ends. Stamped when the
 * diff empties because HEAD advanced (a stash empties the diff too, but HEAD
 * stays put); dropped again if that commit leaves HEAD's history (an amend or a
 * reset brought the work back). Pure metadata: nothing is deleted on its
 * account — it only lets the UI *offer* a fresh start.
 */
export interface Landed {
  sha: string
  /** The commit subject at stamp time, so the offer can name what landed. */
  subject: string
  at: string
}

/**
 * One step of the change, as the agent that wrote it would explain it: a
 * coherent unit — *the parser now returns null instead of throwing* — and the
 * files that belong to that step. Ordered the way the change is explained, not
 * the way it was committed. A layer says what a step IS, never whether it is
 * fine: the guide's stance applies to every summary.
 */
export interface Layer {
  /** Server-minted. Stable across re-posts while the title matches, so a
   * re-post never resets the reviewer's place. */
  id: string
  title: string
  /** Markdown; a ```mermaid fence renders, same as the guide. */
  summary?: string
  /** The files render collapsed — a rename, a call-site follow-through. Nothing
   * else changes: fold, never hide. */
  kind?: 'mechanical'
  files: LayerFile[]
  /** What the agent chose, found, or ran into while making this step — the
   * handful of lines a reviewer reads before (or instead of) the diff. Most
   * layers have none; a plumbing step has nothing to decide. At most five. */
  decisions?: Decision[]
}

/**
 * A decision is one short line — what the agent chose, found, or ran into
 * while making the step — with an optional sentence more and the places it
 * lives. Nothing about it is typed: the line carries its own weight.
 */
export interface Decision {
  /** One short line — the agent is asked for under eight words. */
  text: string
  /** One sentence more, inline markdown; the card shows it on open. */
  detail?: string
  /** Where it lives in the code, head side: one to three places, since a
   * decision can span hunks (the rule and the test that pins it). The line is
   * optional: a decision may point at a file, or at nothing in the changeset. */
  at?: DecisionAt[]
}

/** The most places one decision names: enough for a rule and its test, never
 * a file list — the layer's files are that. */
export const DECISION_PLACES = 3

export interface DecisionAt {
  path: string
  line?: number
  endLine?: number
}

/**
 * A file in a layer: the path, or the path with a one-line note on why it is
 * in this step. Stored as the agent sent it. A `path:from-to` range is accepted
 * by the parser and ignored in v1 — reserved so a big file can be split later
 * without a protocol change; `layerFilePath` strips it.
 */
export type LayerFile = string | { path: string; note?: string }

export interface Layers {
  items: Layer[]
  postedAt: string
}

/** The path a layer file names, without the reserved `:from-to` range. */
export function layerFilePath(file: LayerFile): string {
  const raw = typeof file === 'string' ? file : file.path
  return raw.replace(/:\d+-\d+$/, '')
}

export function layerFileNote(file: LayerFile): string | undefined {
  return typeof file === 'string' ? undefined : file.note
}

export interface ReviewState {
  version: 1
  threads: ReviewThread[]
  /**
   * The agent's reading plan for this changeset. Resolved against the live
   * changeset at render, never at write: a listed path that no longer differs
   * contributes nothing, and a file no layer lists lands in a derived trailing
   * layer the UI computes and never stores.
   */
  layers?: Layers
  /**
   * The agent flagged at open that this read benefits from layers, without
   * writing them — generating them is heavy and happens on the reviewer's
   * request. Cleared the moment layers are posted.
   */
  layersSuggested?: { reason?: string }
  /**
   * What this changeset is, in a few words, as the agent named it when it
   * started polling. Exists for one job: telling a reviewer's tabs apart, all
   * of them otherwise titled "Diffo". Absent until an agent sends one — the tab
   * keeps the plain name rather than guessing from the branch, which is how the
   * reviewer got here in the first place.
   */
  title?: string
  lastFinish?: LastFinish
  /** Pull-request review bookkeeping: the pending review Diffo is filling, and
   * what it has submitted. Present only on a review opened on a PR. */
  pr?: {
    pendingReviewId?: string
    submissions: { at: string; event: string; reviewId: string; comments: number }[]
  }
  /**
   * HEAD as of the last recompute that could move it: the base the work under
   * review sits on. What makes a commit made while no server ran detectable at
   * the next startup — and deliberately frozen while the diff is empty over a
   * non-empty review (landed or stashed), so an amend of the landing commit
   * still reads as "landed" and a hard reset back to this sha reads as "not".
   */
  seenHead?: string
  landed?: Landed
}

/**
 * Feedback the reviewer is still owed an answer on — the delivery queue's contents,
 * derived rather than remembered, so a restart cannot drop an Ask nobody collected.
 * The cuts: handed over at all; not already ruled unanswered by a closed batch; not
 * deliberately withheld; and the reviewer spoke last.
 */
export function undeliveredThreadIds(threads: readonly ReviewThread[]): string[] {
  return (
    threads
      .filter(
        (t) =>
          !isPublic(t) &&
          (t.state === 'sent' || t.state === 'addressed') &&
          t.unanswered !== true &&
          t.withheld !== true &&
          t.messages.at(-1)?.author === 'reviewer',
      )
      // Send order, not array order — the queue's line is a promise a rebuilt queue
      // has to make again. `sentAt` is absent only on older threads, which sort first.
      .sort((a, b) => (a.sentAt ?? '').localeCompare(b.sentAt ?? ''))
      .map((t) => t.id)
  )
}

export interface Coverage {
  viewedHunks: number
  totalHunks: number
  viewedFiles?: number
  totalFiles?: number
  skippedFiles: string[]
  changedFiles?: string[]
  commentedUnread?: string[]
  filteredOut?: string[]
  note?: string
}

export interface OutgoingThread {
  id: string
  anchor: Anchor
  text: string
  fresh: boolean
}

/**
 * The longest title worth carrying. A tab shows around twenty characters, so
 * this is a backstop against an agent's essay, not a target — the slack over
 * twenty is for the full name the browser shows on hover.
 */
export const MAX_TITLE_LEN = 40

/**
 * Whatever the agent sent, made fit to be a tab's name: controls stripped,
 * whitespace collapsed to one line, capped. Null for anything that isn't a
 * usable title — the caller then leaves the existing name alone rather than
 * blanking it.
 */
export function normalizeTitle(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const line = raw
    // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping them is the point
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (line === '') return null
  return line.length > MAX_TITLE_LEN ? `${line.slice(0, MAX_TITLE_LEN - 1).trimEnd()}…` : line
}

export const EMPTY_REVIEW: ReviewState = { version: 1, threads: [] }

/**
 * Threads this changeset still owns, and the ones it has left behind. A thread is
 * *active* while the diff still has somewhere to put it — its hunk, or failing that
 * its file — and a changeset-level note lives as long as the changeset has files.
 *
 * Past threads are hidden, never deleted: a stash or a branch switch empties the diff
 * for a minute and must not destroy a thread.
 */
export function threadsInChangeset(
  files: readonly FileChange[],
  threads: readonly ReviewThread[],
  layers?: Layers,
): { active: ReviewThread[]; past: ReviewThread[] } {
  const hunkIds = new Set(files.flatMap((f) => f.hunks.map((h) => h.id)))
  // A thread anchors to the path as it was when it was opened, so a renamed file
  // must answer to both names.
  const paths = new Set(files.flatMap((f) => (f.oldPath ? [f.path, f.oldPath] : [f.path])))
  // A layer thread lives exactly as long as its layer is in the outline; a
  // re-post that drops the title retires the thread with it.
  const layerIds = new Set((layers?.items ?? []).map((l) => l.id))
  const lives = (thread: ReviewThread): boolean => {
    const anchor = thread.anchor
    if (anchor.kind === 'changeset') return files.length > 0
    if (anchor.kind === 'file') return paths.has(anchor.path)
    if (anchor.kind === 'layer') return layerIds.has(anchor.layerId)
    return hunkIds.has(anchor.hunkId) || paths.has(anchor.path)
  }
  const active: ReviewThread[] = []
  const past: ReviewThread[] = []
  for (const thread of threads) (lives(thread) ? active : past).push(thread)
  return { active, past }
}

/** The line part of a hunk anchor's label: `12`, or `12-20` for a range. */
export function anchorSpan(anchor: Extract<Anchor, { kind: 'hunk' }>): string {
  return anchor.endLine === undefined ? `${anchor.line}` : `${anchor.line}-${anchor.endLine}`
}

export function describeAnchor(anchor: Anchor): string {
  if (anchor.kind === 'changeset') return 'the whole changeset'
  if (anchor.kind === 'file') return anchor.path
  if (anchor.kind === 'layer') return `layer "${anchor.title}"`
  return `${anchor.path}:${anchorSpan(anchor)} (${anchor.side} side)`
}
