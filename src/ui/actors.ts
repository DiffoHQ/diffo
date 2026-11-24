import { createContext, useContext } from 'react'
import {
  nextReviewerHue,
  openedByReviewerAgent,
  REVIEWER_HUES,
  type ReviewerChatMessage,
  type ReviewerCoverage,
  type ReviewerEvent,
  type ReviewerState,
  type ReviewThread,
} from '../shared/review.js'

/**
 * The reviewer agents in this review, for everything that draws one: its
 * colour, and whether it is connected. A context for the same reason the pull
 * request is one (prMode.ts): a message byline, a rail row and the header all
 * ask, and none of them should be handed it through every layer between.
 */

export type { ReviewerState }

export interface Reviewers {
  /** Their names, in the order they joined. */
  seats: readonly string[]
  /** Who is connected. A name missing here is away. */
  states: ReadonlyMap<string, ReviewerState>
  /** Roles a reviewer is on its way in: the agent was asked to start one,
   * and none has joined in that role yet. */
  starting?: readonly string[]
  /** Each reviewer's colour, as the review stores it (see `reviewerHue`). */
  hues?: ReadonlyMap<string, number>
  /** The role each reviewer joined in, by id. */
  roles?: ReadonlyMap<string, string>
  /** The role each reviewer joined in, by its name ("Code comments"). */
  roleNames?: ReadonlyMap<string, string>
  /** What each reviewer did, oldest first. */
  activity?: ReadonlyMap<string, readonly ReviewerEvent[]>
  /** Each reviewer's private conversation with the human, oldest first. */
  chats?: ReadonlyMap<string, readonly ReviewerChatMessage[]>
  /** How much of the change each reviewer read. */
  coverage?: ReadonlyMap<string, ReviewerCoverage>
  /** How many of each reviewer's threads stopped and wait for the human. */
  needsYou?: ReadonlyMap<string, number>
}

export const NO_REVIEWERS: Reviewers = { seats: [], states: new Map() }

export const ReviewersContext = createContext<Reviewers>(NO_REVIEWERS)

export function useReviewers(): Reviewers {
  return useContext(ReviewersContext)
}

/**
 * A reviewer agent's hue, 1-based: the one it was given when it took its
 * seat, so the reviewers of one review get different colours for as long as
 * the palette lasts and each keeps its own even when another is removed. A
 * name with no seat (a removed reviewer's thread) falls back to a hash of the
 * name, which is at least the same every time.
 */
export function reviewerHue(name: string, hues?: ReadonlyMap<string, number>): number {
  const stored = hues?.get(name)
  if (stored !== undefined) return stored
  let hash = 0
  for (const ch of name) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0
  return (hash % REVIEWER_HUES) + 1
}

/**
 * The reviewers on their way, by role, each with the colour it will have: the
 * next one nobody wears. Each new reviewer gets a name of its own when it
 * joins, so none of them comes back to a seat already here.
 */
export function arrivingReviewers(reviewers: Reviewers): { role: string; hue: number }[] {
  const worn = [...(reviewers.hues?.values() ?? [])]
  return (reviewers.starting ?? []).map((role) => {
    const hue = nextReviewerHue(worn)
    worn.push(hue)
    return { role, hue }
  })
}

/** A reviewer's last word on what it is doing: its log's newest line that is
 * not part of its conversation with the human (their message, its receipt,
 * its answer). */
export function lastDoing(events: readonly ReviewerEvent[] | undefined): ReviewerEvent | undefined {
  return events?.findLast((e) => e.kind !== 'told' && e.kind !== 'heard' && e.kind !== 'said')
}

/** How many of the human's messages a reviewer has not read yet: what they
 * wrote after its last receipt. */
export function unreadMessages(events: readonly ReviewerEvent[] | undefined): number {
  if (!events) return 0
  const read = events.findLastIndex((e) => e.kind === 'heard')
  return events.slice(read + 1).filter((e) => e.kind === 'told').length
}

/**
 * A reviewer's thread that only the human can move on: stopped for them (the
 * rounds cap, or an agent asked them to decide), or held by them (a reply written and not sent, or reopened and not
 * sent again), so the reviewer's poll waits on their word.
 */
export function waitsOnYou(thread: ReviewThread): boolean {
  if (thread.state === 'resolved') return false
  return thread.needsYou !== undefined || thread.withheld === true || thread.state === 'open'
}

/** How many of each reviewer's threads wait on the human (see `waitsOnYou`). */
export function needsYouBy(threads: readonly ReviewThread[]): Map<string, number> {
  const counts = new Map<string, number>()
  for (const t of threads) {
    if (!waitsOnYou(t)) continue
    const by = openedByReviewerAgent(t)
    if (by !== null) counts.set(by, (counts.get(by) ?? 0) + 1)
  }
  return counts
}

/**
 * Where a reviewer stands, in the words agent tools already use (GitHub's
 * working and completed, Linear's awaiting input, Cursor's needs attention):
 * one status each, so the page never asks the human to decode a ring.
 */
export type ReviewerStatus =
  | 'needs'
  | 'working'
  | 'waiting'
  | 'starting'
  | 'done'
  | 'away'
  | 'stopped'

export const REVIEWER_STATUS_WORDS: Record<ReviewerStatus, string> = {
  needs: 'Needs you',
  working: 'Working',
  waiting: 'Waiting for your agent',
  starting: 'On its way',
  done: 'Done',
  away: 'Not connected',
  stopped: 'Stopped',
}

/** One reviewer as the panel and the top bar show it. */
export interface ReviewerRow {
  /** Its name, or the role of one that has not joined yet. */
  name: string
  hue: number
  status: ReviewerStatus
  /** What it is on, in a few words. Null when there is nothing to say. */
  line: string | null
  /** When that line became true. */
  at?: string
  /** It has a seat; false for a role on its way. */
  seated: boolean
}

/**
 * How long a reviewer has worked: from when it first joined to now while it
 * is live, or to its last line once it is done, away or stopped. Null before
 * it has joined.
 */
export function workedMs(
  events: readonly ReviewerEvent[] | undefined,
  live: boolean,
  now: number,
): number | null {
  const joined = events?.find((e) => e.kind === 'joined')
  if (!joined) return null
  const end = live ? now : Date.parse(events!.at(-1)!.at)
  return Math.max(0, end - Date.parse(joined.at))
}

/** "<1m", "14m", "1h 05m". */
export function formatWorked(ms: number): string {
  const minutes = Math.floor(ms / 60_000)
  if (minutes < 1) return '<1m'
  if (minutes < 60) return `${minutes}m`
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`
}

/** The threads a reviewer opened: still open, and closed. */
export function threadCountsBy(
  threads: readonly ReviewThread[],
  name: string,
): { open: number; closed: number } {
  let open = 0
  let closed = 0
  for (const t of threads) {
    if (openedByReviewerAgent(t) !== name) continue
    if (t.state === 'resolved') closed++
    else open++
  }
  return { open, closed }
}

/** Every reviewer with its status, in the order they joined, the ones on
 * their way last. */
export function reviewerRows(reviewers: Reviewers): ReviewerRow[] {
  const rows: ReviewerRow[] = reviewers.seats.map((name) => {
    const here = reviewers.states.get(name) ?? 'away'
    const last = lastDoing(reviewers.activity?.get(name))
    const needs = reviewers.needsYou?.get(name) ?? 0
    const hue = reviewerHue(name, reviewers.hues)
    const at = last ? { at: last.at } : {}
    // Stopped by the human: that is all there is to say of it, whatever waits.
    if (here === 'stopped') return { name, hue, status: 'stopped', line: null, ...at, seated: true }
    if (needs > 0) {
      const line = `${needs} ${needs === 1 ? 'thread needs' : 'threads need'} you`
      return { name, hue, status: 'needs', line, seated: true }
    }
    // Finished is the whole news: the row's counts say the rest. One that
    // finished and is gone stays finished, whatever it logged after (its
    // account of what it read comes after the poll that ended it).
    const events = reviewers.activity?.get(name) ?? []
    const done = events
      .slice(events.findLastIndex((e) => e.kind === 'joined') + 1)
      .findLast((e) => e.kind === 'done')
    if (last?.kind === 'done' || (here === 'away' && done)) {
      return { name, hue, status: 'done', line: 'finished', at: (done ?? last)!.at, seated: true }
    }
    if (here === 'away') {
      return {
        name,
        hue,
        status: 'away',
        line: last ? `last: ${last.text}` : null,
        ...at,
        seated: true,
      }
    }
    const status = here === 'listening' ? 'waiting' : 'working'
    return { name, hue, status, line: last?.text ?? null, ...at, seated: true }
  })
  for (const { role, hue } of arrivingReviewers(reviewers)) {
    rows.push({
      name: role,
      hue,
      status: 'starting',
      line: 'your agent is starting it',
      seated: false,
    })
  }
  return rows
}

/** Where one of a reviewer's threads stands, in a word. */
export type CommentStatus = 'closed' | 'open' | 'needs you' | 'gone'

/**
 * One line of a reviewer's story (its own view): a step, a comment with where
 * its thread stands, a message between it and the human, its start and end.
 */
export type StoryItem =
  | { kind: 'joined'; at: string }
  /** A progress line; `current` while it is what the reviewer is on now. */
  | { kind: 'step'; text: string; at: string; current: boolean }
  | {
      kind: 'comment'
      where: string
      threadId?: string
      status: CommentStatus
      /** The comment's first words, for a hover. */
      first: string
      at: string
    }
  | { kind: 'message'; from: 'you' | 'agent'; text: string; at: string }
  | { kind: 'done'; at: string }
  | { kind: 'stopped'; at: string }

/** A place in the code as a reviewer said it, short enough for a sidebar:
 * the file's name and line, without its directory or which side. */
export function shortWhere(where: string): string {
  const plain = where.replace(/\s*\((new|old) side\)$/, '')
  const slash = plain.lastIndexOf('/')
  return slash === -1 || plain.includes(' ') ? plain : plain.slice(slash + 1)
}

function commentStatus(thread: ReviewThread | undefined): CommentStatus {
  if (!thread) return 'gone'
  if (thread.state === 'resolved') return 'closed'
  return waitsOnYou(thread) ? 'needs you' : 'open'
}

/**
 * A reviewer's story, newest first, the way a feed reads: where it ended up
 * on top. Each step is one line, each comment one line with where its thread
 * stands, and the human's messages and its answers sit where they were said.
 * Waits and receipts are not steps: the comments' states say them.
 */
export function reviewerStory(
  events: readonly ReviewerEvent[],
  chat: readonly ReviewerChatMessage[],
  threads: readonly ReviewThread[],
  working: boolean,
): StoryItem[] {
  const byId = new Map(threads.map((t) => [t.id, t]))
  const items: StoryItem[] = []
  for (const e of events) {
    if (e.kind === 'joined') items.push({ kind: 'joined', at: e.at })
    else if (e.kind === 'doing')
      items.push({ kind: 'step', text: e.text, at: e.at, current: false })
    else if (e.kind === 'commented') {
      const thread = e.threadId === undefined ? undefined : byId.get(e.threadId)
      items.push({
        kind: 'comment',
        where: shortWhere(e.text.replace(/^commented on /, '')),
        ...(e.threadId !== undefined ? { threadId: e.threadId } : {}),
        status: commentStatus(thread),
        first: (thread?.messages[0]?.text ?? '').split('\n')[0]!.slice(0, 160),
        at: e.at,
      })
    } else if (e.kind === 'done') items.push({ kind: 'done', at: e.at })
    else if (e.kind === 'stopped') items.push({ kind: 'stopped', at: e.at })
  }
  for (const m of chat) items.push({ kind: 'message', from: m.from, text: m.text, at: m.at })
  // Oldest first, then turned: a stable sort keeps same-moment lines in the
  // order they happened.
  items.sort((a, b) => a.at.localeCompare(b.at))
  items.reverse()
  // The newest step is what it is on now, while it works and nothing came after.
  const top = items.find((i) => i.kind !== 'message')
  if (working && top?.kind === 'step') top.current = true
  return items
}
