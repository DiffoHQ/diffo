import type { FileChange } from './types.js'

export type ThreadState = 'open' | 'sent' | 'addressed' | 'resolved'

export type ThreadIntent = 'question' | 'fix'

export const THREAD_INTENTS: readonly ThreadIntent[] = ['fix', 'question']

export type Anchor =
  | { kind: 'hunk'; hunkId: string; path: string; side: 'old' | 'new'; line: number }
  | { kind: 'file'; path: string }
  | { kind: 'changeset' }

export type Author = 'reviewer' | 'agent'

export interface ReviewMessage {
  id: string
  author: Author
  text: string
  at: string
  durationMs?: number
}

export interface ReviewThread {
  id: string
  anchor: Anchor
  state: ThreadState
  intent?: ThreadIntent
  codeContext: string | null
  /** The anchored hunk no longer exists in the current changeset (its
   * content-addressed ID rotated). `sent` threads become `addressed` instead. */
  codeChanged: boolean
  /** The agent concluded the batch this thread went out in without replying —
   * not "slow", so the UI must stop waiting on it. */
  unanswered?: boolean
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
  messages: ReviewMessage[]
  createdAt: string
  updatedAt: string
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

export interface ReviewState {
  version: 1
  threads: ReviewThread[]
  lastFinish?: LastFinish
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

export const REVIEW_VERDICTS = ['comment', 'approve', 'request-changes'] as const
export type ReviewVerdict = (typeof REVIEW_VERDICTS)[number]

export interface Coverage {
  viewedHunks: number
  totalHunks: number
  viewedFiles?: number
  totalFiles?: number
  skippedFiles: string[]
  changedFiles?: string[]
  commentedUnread?: string[]
  filteredOut?: string[]
  verdict?: ReviewVerdict
  note?: string
}

export interface OutgoingThread {
  id: string
  anchor: Anchor
  text: string
  fresh: boolean
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
): { active: ReviewThread[]; past: ReviewThread[] } {
  const hunkIds = new Set(files.flatMap((f) => f.hunks.map((h) => h.id)))
  // A thread anchors to the path as it was when it was opened, so a renamed file
  // must answer to both names.
  const paths = new Set(files.flatMap((f) => (f.oldPath ? [f.path, f.oldPath] : [f.path])))
  const lives = (thread: ReviewThread): boolean => {
    const anchor = thread.anchor
    if (anchor.kind === 'changeset') return files.length > 0
    if (anchor.kind === 'file') return paths.has(anchor.path)
    return hunkIds.has(anchor.hunkId) || paths.has(anchor.path)
  }
  const active: ReviewThread[] = []
  const past: ReviewThread[] = []
  for (const thread of threads) (lives(thread) ? active : past).push(thread)
  return { active, past }
}

export function describeAnchor(anchor: Anchor): string {
  if (anchor.kind === 'changeset') return 'the whole changeset'
  if (anchor.kind === 'file') return anchor.path
  return `${anchor.path}:${anchor.line} (${anchor.side} side)`
}
