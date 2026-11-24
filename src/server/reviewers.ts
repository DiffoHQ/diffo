import { stripArtifacts } from '../shared/artifacts.js'
import {
  describeAnchor,
  isHumanMessage,
  openedByReviewerAgent,
  parseReviewerChat,
  parseReviewerCoverage,
  parseReviewerEvents,
  REVIEWER_CHAT_MAX,
  REVIEWER_LIMITS,
  REVIEWER_MESSAGE_MAX,
  type ReviewerChatMessage,
  type ReviewerCoverage,
  type ReviewerEvent,
  type ReviewerEventKind,
  type ReviewerState,
  type ReviewMessage,
  type ReviewThread,
  roundsOf,
} from '../shared/review.js'
import type { FileChange } from '../shared/types.js'

/**
 * Reviewer agents: the second kind of agent in a review (see `ReviewerAgent`).
 * Everything about them that is not a thread lives here, apart from the author
 * agent's `DeliveryQueue` on purpose: a reviewer's poll must never claim,
 * supersede or count against the author's session, and the simplest way to
 * keep that true is for the two never to share state.
 *
 * A reviewer agent has no queue. Its inbox is derived from the threads it
 * opened and the cursor each one carries (`reviewerSeenAt`), so a restart, a
 * killed poll or a second poll loses nothing.
 */

/** How long after its last command a reviewer agent still reads as here: it
 * holds no poll while it reads the diff and writes its comments. */
export const REVIEWER_ACTIVE_MS = 5 * 60_000

/** How long a reviewer agent the author agent was asked to start may take to
 * join before the page stops saying it is on its way. */
export const REVIEWER_START_MS = 5 * 60_000

export interface ReviewerPresence {
  name: string
  state: ReviewerState
}

/** How many lines a reviewer's log keeps: the page shows the recent ones. */
export const REVIEWER_LOG_MAX = 60
export const REVIEWER_PROGRESS_MAX = 140
/** How much of the human's message its line in the log keeps. */
const REVIEWER_TOLD_LOG_MAX = 280

/** The human's message to a reviewer agent, waiting for it. */
export interface ReviewerNote {
  at: string
  text: string
}

/**
 * What the hub keeps across a restart: each reviewer's log, the messages it
 * has not read, and who the human removed. Presence is not in it: who is
 * connected is a fact about this server's life, and a restart ends it.
 */
export interface ReviewerHubSnapshot {
  logs: Record<string, ReviewerEvent[]>
  notes: Record<string, ReviewerNote[]>
  /** Each reviewer's private conversation with the human. */
  chats: Record<string, ReviewerChatMessage[]>
  removed: string[]
  /** Reviewers the human stopped: kept, with their log and conversation. */
  stopped: string[]
  /** How much of the change each reviewer read (see `ReviewerCoverage`). */
  coverage: Record<string, ReviewerCoverage>
}

/** A stored snapshot, read leniently: what does not parse is dropped alone. */
export function parseHubSnapshot(raw: string | null): ReviewerHubSnapshot {
  const empty: ReviewerHubSnapshot = {
    logs: {},
    notes: {},
    chats: {},
    removed: [],
    stopped: [],
    coverage: {},
  }
  if (!raw) return empty
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return empty
  }
  if (typeof value !== 'object' || value === null) return empty
  const v = value as Record<string, unknown>
  const logs: Record<string, ReviewerEvent[]> = {}
  if (typeof v.logs === 'object' && v.logs !== null) {
    for (const [name, events] of Object.entries(v.logs)) {
      const parsed = parseReviewerEvents(events).slice(-REVIEWER_LOG_MAX)
      if (parsed.length > 0) logs[name] = parsed
    }
  }
  const notes: Record<string, ReviewerNote[]> = {}
  if (typeof v.notes === 'object' && v.notes !== null) {
    for (const [name, list] of Object.entries(v.notes)) {
      if (!Array.isArray(list)) continue
      const kept = list.filter(
        (n): n is ReviewerNote =>
          typeof n === 'object' &&
          n !== null &&
          typeof (n as ReviewerNote).at === 'string' &&
          typeof (n as ReviewerNote).text === 'string',
      )
      if (kept.length > 0) notes[name] = kept.map((n) => ({ at: n.at, text: n.text }))
    }
  }
  const chats: Record<string, ReviewerChatMessage[]> = {}
  if (typeof v.chats === 'object' && v.chats !== null) {
    for (const [name, list] of Object.entries(v.chats)) {
      const parsed = parseReviewerChat(list)
      if (parsed.length > 0) chats[name] = parsed
    }
  }
  const names = (list: unknown) =>
    Array.isArray(list) ? list.filter((n): n is string => typeof n === 'string') : []
  const coverage: Record<string, ReviewerCoverage> = {}
  if (typeof v.coverage === 'object' && v.coverage !== null) {
    for (const [name, value] of Object.entries(v.coverage)) {
      const parsed = parseReviewerCoverage(value)
      if (parsed) coverage[name] = parsed
    }
  }
  return {
    logs,
    notes,
    chats,
    removed: names(v.removed),
    stopped: names(v.stopped),
    coverage,
  }
}

/**
 * One changed file as a unified diff: the same hunks the human reads on the
 * page, so a reviewer agent reading it through `diffo diff` reads what they
 * read (untracked files whole, as added).
 */
export function renderFilePatch(file: FileChange): string {
  const from = file.status === 'added' ? '/dev/null' : `a/${file.oldPath ?? file.path}`
  const to = file.status === 'deleted' ? '/dev/null' : `b/${file.path}`
  const head = [`diff --diffo ${file.path} (${file.status})`, `--- ${from}`, `+++ ${to}`]
  if (file.hunks.length === 0) return [...head, `(${file.kind} file: no text diff)`].join('\n')
  const body = file.hunks.flatMap((h) => {
    const old = h.lines.filter((l) => l.kind !== 'add').length
    const now = h.lines.filter((l) => l.kind !== 'del').length
    return [
      `@@ -${h.oldStart},${old} +${h.newStart},${now} @@${h.context ? ` ${h.context}` : ''}`,
      ...h.lines.map((l) => `${l.kind === 'add' ? '+' : l.kind === 'del' ? '-' : ' '}${l.text}`),
    ]
  })
  return [...head, ...body].join('\n')
}

/**
 * The names a new reviewer agent is given when it brings none: short, easy
 * to tell apart and to say, none of them a role. A name is never given twice
 * in a review, so a new reviewer never inherits another's threads, log or
 * conversation; the role is what it looks for, the name is who it is.
 */
export const REVIEWER_NAMES = [
  'juno',
  'remy',
  'iris',
  'otto',
  'nova',
  'milo',
  'ezra',
  'luna',
  'kai',
  'theo',
  'ivy',
  'finn',
  'zara',
  'leo',
  'mira',
  'nico',
  'ruby',
  'sage',
  'tess',
  'axel',
  'bea',
  'cleo',
  'dex',
  'eli',
  'faye',
  'gus',
  'hana',
  'jude',
  'kit',
  'lou',
  'mae',
  'nell',
  'olin',
  'pia',
  'quin',
  'rhea',
  'sol',
  'uma',
  'vera',
  'wren',
] as const

/** A name for a new reviewer: an unused one from `pool`, at random; when all
 * are used, the first with a number. `pick` chooses among the free ones. */
export function pickReviewerName(
  taken: ReadonlySet<string>,
  pool: readonly string[] = REVIEWER_NAMES,
  pick: (free: readonly string[]) => string = (free) =>
    free[Math.floor(Math.random() * free.length)]!,
): string {
  const free = pool.filter((n) => !taken.has(n))
  if (free.length > 0) return pick(free)
  for (let n = 2; ; n++) {
    const numbered = pool.map((name) => `${name}-${n}`).filter((name) => !taken.has(name))
    if (numbered.length > 0) return pick(numbered)
  }
}

/** The human's message to a reviewer: trimmed, capped. Null when empty or too long. */
export function parseReviewerMessage(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const text = value.trim()
  return text === '' || text.length > REVIEWER_MESSAGE_MAX ? null : text
}

/** A reviewer's own progress line: one line, clipped. Null when it says nothing. */
export function parseProgress(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const text = clip(value, REVIEWER_PROGRESS_MAX)
  return text === '' ? null : text
}

/** Who wrote a message, in the words a prompt or a payload uses. */
export function voiceOf(message: Pick<ReviewMessage, 'author' | 'by'>): string {
  if (message.author === 'agent') return 'author agent'
  if (message.author === 'github') return 'github'
  return isHumanMessage(message) ? 'human reviewer' : `reviewer agent ${message.by}`
}

/** What a thread a reviewer agent opened holds for it right now. */
type Standing =
  /** Something it has not been handed: the author agent's answer, or the human's. */
  | { kind: 'news'; unseen: ReviewMessage[] }
  /** Stopped for the human and it has not been told yet. */
  | { kind: 'stopped'; unseen: ReviewMessage[] }
  /** An answer is still owed to it: the author agent's, or the human's while
   * they hold the thread (an unsent reply, or a reopen). */
  | { kind: 'waiting' }
  /** It has the answer and has neither replied nor closed the thread. */
  | { kind: 'yours' }
  /** Stopped for the human (rounds cap or --ask), and already announced. */
  | { kind: 'human' }
  /** The author agent's batch closed without an answer. */
  | { kind: 'unanswered' }
  | { kind: 'resolved' }

function standingOf(thread: ReviewThread, name: string): Standing {
  if (thread.state === 'resolved') return { kind: 'resolved' }
  const seen = thread.reviewerSeenAt === undefined ? null : Date.parse(thread.reviewerSeenAt)
  const unseen = thread.messages.filter(
    (m) => m.by !== name && (seen === null || Date.parse(m.at) > seen),
  )
  if (thread.needsYou) return unseen.length > 0 ? { kind: 'stopped', unseen } : { kind: 'human' }
  // A reply the human is still holding is not theirs to the agents yet, and
  // neither is a thread they reopened and have not sent again. Their words
  // are on the way, so the reviewer waits for them: unlike a thread stopped at
  // the rounds cap, this one comes back to it.
  if (thread.withheld || thread.state === 'open') return { kind: 'waiting' }
  // An interim reply promises the real one: wait for that.
  if (thread.awaitingFollowUp) return { kind: 'waiting' }
  if (unseen.length > 0) return { kind: 'news', unseen }
  if (thread.messages.at(-1)?.by !== name) return { kind: 'yours' }
  return thread.unanswered ? { kind: 'unanswered' } : { kind: 'waiting' }
}

const YOUR_WORDS_CAP = 240

function clip(text: string, cap: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > cap ? `${flat.slice(0, cap - 1)}…` : flat
}

/** The newest of these messages' timestamps: an answer can be filed above a
 * message that raced it, so the last in the list is not always the latest. */
function latest(messages: readonly ReviewMessage[]): string {
  return messages.reduce(
    (at, m) => (Date.parse(m.at) > Date.parse(at) ? m.at : at),
    messages[0]!.at,
  )
}

/** Whether the code under a thread moved since it was commented. Only a line
 * anchor can tell: a hunk's id is its content, a file's or the changeset's is not. */
function codeChanged(thread: ReviewThread): boolean | null {
  if (thread.anchor.kind !== 'hunk') return null
  return thread.state === 'addressed' || thread.codeChanged
}

export interface InboxThread {
  threadId: string
  where: string
  /** true: the commented lines changed since the comment. false: they are as
   * they were. null: the thread is on a file or the changeset, which cannot say. */
  code_changed: boolean | null
  rounds: number
  rounds_left: number
  /** The reviewer agent's own last words here, clipped: what the answer answers. */
  you_said: string
  messages: { from: string; text: string }[]
}

export interface ReviewerInbox {
  /** Threads with something new, oldest answer first. */
  threads: InboxThread[]
  /** Threads that just stopped for the human (the rounds cap, or an agent
   * asked them), announced once, with the words it had not read yet: the
   * human's answer, later, comes after these and must not skip them. */
  needsHuman: { threadId: string; where: string; messages: { from: string; text: string }[] }[]
  /** Answered already, and neither replied to nor closed: its move. */
  yourMove: { threadId: string; where: string }[]
  /** What this inbox hands over, and through which message of each thread:
   * what `markReviewerSeen` stamps, so a message landing while the payload is
   * on the wire is still news to the next poll. */
  handed: { threadId: string; through: string }[]
  /** Threads `name` opened in this review, resolved ones included. */
  opened: number
  /** Epoch ms of the last change to any of them; 0 with none. */
  lastChange: number
  counts: {
    /** Still owed an answer: the reason to keep polling. */
    waiting: number
    /** Answered, and neither replied to nor closed. */
    yours: number
    /** Stopped for the human (`needsYou`); a thread they are holding counts
     * as waiting. */
    human: number
    /** The author agent moved on without answering. */
    unanswered: number
    resolved: number
  }
}

/** The inbox of the reviewer agent `name`, from the review as it stands. */
export function reviewerInbox(threads: readonly ReviewThread[], name: string): ReviewerInbox {
  const inbox: ReviewerInbox = {
    threads: [],
    needsHuman: [],
    yourMove: [],
    handed: [],
    opened: 0,
    lastChange: 0,
    counts: { waiting: 0, yours: 0, human: 0, unanswered: 0, resolved: 0 },
  }
  for (const thread of threads) {
    if (openedByReviewerAgent(thread) !== name) continue
    inbox.opened++
    inbox.lastChange = Math.max(inbox.lastChange, Date.parse(thread.updatedAt))
    const standing = standingOf(thread, name)
    const where = describeAnchor(thread.anchor)
    if (standing.kind === 'news') {
      const rounds = roundsOf(thread)
      const own = thread.messages.findLast((m) => m.by === name)
      inbox.threads.push({
        threadId: thread.id,
        where,
        code_changed: codeChanged(thread),
        rounds,
        rounds_left: Math.max(0, REVIEWER_LIMITS.rounds - rounds),
        you_said: clip(own?.text ?? '', YOUR_WORDS_CAP),
        // An artifact's HTML is for the page, not for another agent's context.
        messages: standing.unseen.map((m) => ({
          from: voiceOf(m),
          text: stripArtifacts(m.text),
        })),
      })
      inbox.handed.push({ threadId: thread.id, through: latest(standing.unseen) })
      // Handed over now, so it is the reviewer agent's move from here on.
      inbox.counts.yours++
    } else if (standing.kind === 'stopped') {
      inbox.needsHuman.push({
        threadId: thread.id,
        where,
        messages: standing.unseen.map((m) => ({ from: voiceOf(m), text: stripArtifacts(m.text) })),
      })
      inbox.handed.push({ threadId: thread.id, through: latest(standing.unseen) })
      inbox.counts.human++
    } else {
      if (standing.kind === 'yours') inbox.yourMove.push({ threadId: thread.id, where })
      inbox.counts[standing.kind]++
    }
  }
  return inbox
}

/**
 * Who of the reviewer agents is connected, the one poll each may hold, and
 * what each did and was told. Presence and polls are in memory only, a fact
 * about this server's life; logs, notes, chats, removals and stops are kept
 * across a restart (see `ReviewerHubSnapshot`). The seat itself is in the
 * review (`ReviewState.reviewers`).
 */
export class ReviewerHub {
  private polls = new Map<string, () => void>()
  private lastSeen = new Map<string, number>()
  private pids = new Map<string, number>()
  private timers = new Map<string, ReturnType<typeof setTimeout>>()
  private listeners = new Set<() => void>()
  /** Roles the author agent was asked to start a reviewer in, and the timer
   * that gives up on each. */
  private starts = new Map<string, ReturnType<typeof setTimeout>>()
  /** What each reviewer did, oldest first; kept across a restart (see
   * `ReviewerHubSnapshot`). */
  private logs = new Map<string, ReviewerEvent[]>()
  /** Reviewers the human took out of the review. Their next command is
   * refused until they are brought back in with a join. */
  private removed = new Set<string>()
  /** Reviewers the human stopped. Like the removed, their commands are
   * refused until a join brings them back; unlike them, their log and
   * conversation stay, and so does their seat. */
  private stopped = new Set<string>()
  /** What the human wrote to each reviewer and it has not picked up yet,
   * oldest first. */
  private notes = new Map<string, ReviewerNote[]>()
  /** Each reviewer's private conversation with the human, oldest first. */
  private chats = new Map<string, ReviewerChatMessage[]>()
  /** How much of the change each reviewer read (see `ReviewerCoverage`). */
  private coverages = new Map<string, ReviewerCoverage>()
  /** The wake of each reviewer's held poll, so a message reaches it at once. */
  private noteWaiters = new Map<string, () => void>()

  constructor(
    private activeMs: number = REVIEWER_ACTIVE_MS,
    private isAlive: (pid: number) => boolean = () => true,
    private startMs: number = REVIEWER_START_MS,
  ) {}

  /** What to keep across a restart (see `ReviewerHubSnapshot`). */
  snapshot(): ReviewerHubSnapshot {
    return {
      logs: Object.fromEntries(this.logs),
      notes: Object.fromEntries(this.notes),
      chats: Object.fromEntries(this.chats),
      removed: [...this.removed],
      stopped: [...this.stopped],
      coverage: Object.fromEntries(this.coverages),
    }
  }

  /** Back from a snapshot, at startup: before any reviewer has connected. */
  restore(snapshot: ReviewerHubSnapshot): void {
    this.logs = new Map(Object.entries(snapshot.logs))
    this.notes = new Map(Object.entries(snapshot.notes))
    this.chats = new Map(Object.entries(snapshot.chats))
    this.removed = new Set(snapshot.removed)
    this.stopped = new Set(snapshot.stopped)
    this.coverages = new Map(Object.entries(snapshot.coverage))
  }

  /** Another branch's review came up under this server: its snapshot replaces
   * what was kept for the last one, and the page hears it. */
  reload(snapshot: ReviewerHubSnapshot): void {
    this.restore(snapshot)
    this.notify()
  }

  /** A new round: the seats went, and so does what was kept for them. Who
   * the human removed stays removed: a sub-agent still reading the diff must
   * not walk back in because the round turned over. Only a join readmits. */
  clear(): void {
    this.logs.clear()
    this.notes.clear()
    this.chats.clear()
    this.coverages.clear()
    this.notify()
  }

  /** The roles a reviewer agent is on its way in, oldest ask first. */
  starting(): string[] {
    return [...this.starts.keys()]
  }

  /** The reviewer asked the author agent to start a reviewer in this role.
   * It reads as on its way until one joins in that role, or the wait runs out:
   * an agent that cannot start one says so in chat, not here. */
  expect(role: string): void {
    const pending = this.starts.get(role)
    if (pending !== undefined) clearTimeout(pending)
    const timer = setTimeout(() => {
      this.starts.delete(role)
      this.notify()
    }, this.startMs)
    timer.unref?.()
    this.starts.set(role, timer)
    this.notify()
  }

  /** A reviewer agent joined in this role: the one that was awaited, if any. */
  arrived(role: string): void {
    const pending = this.starts.get(role)
    if (pending === undefined) return
    clearTimeout(pending)
    this.starts.delete(role)
    this.notify()
  }

  /**
   * The human removed this reviewer: its poll is released (and told why, see
   * `isRemoved`), and everything this server knew of it goes. Its commands are
   * refused from here on, so a sub-agent still running cannot walk back in.
   */
  remove(name: string): void {
    this.removed.add(name)
    this.logs.delete(name)
    this.chats.delete(name)
    this.coverages.delete(name)
    this.disconnect(name)
  }

  /** Its session ends: no presence, no unread notes, and its held poll is
   * released. What else goes is the caller's to say (see `remove`, `stop`). */
  private disconnect(name: string): void {
    this.lastSeen.delete(name)
    this.pids.delete(name)
    this.notes.delete(name)
    const timer = this.timers.get(name)
    if (timer !== undefined) clearTimeout(timer)
    this.timers.delete(name)
    const release = this.polls.get(name)
    this.polls.delete(name)
    release?.()
    this.notify()
  }

  isRemoved(name: string): boolean {
    return this.removed.has(name)
  }

  /**
   * The human stopped this reviewer: its poll is released (and told why, see
   * `isStopped`), and its commands are refused from here on. Unlike a removal,
   * only its unread messages go (they stay in the conversation); its seat,
   * log and conversation stay to be read.
   */
  stop(name: string): void {
    this.stopped.add(name)
    this.log(name, 'stopped', 'stopped by you')
    this.disconnect(name)
  }

  isStopped(name: string): boolean {
    return this.stopped.has(name)
  }

  /** Brought back in (a join): the removal or the stop no longer stands. */
  readmit(name: string): void {
    this.removed.delete(name)
    this.stopped.delete(name)
  }

  /** Every name this hub has known: given once, never again (see
   * `pickReviewerName`). */
  knownNames(): Set<string> {
    // A session still running counts too: a new round drops the seats and
    // logs, but not the reviewer polling or commenting under that name.
    return new Set([
      ...this.logs.keys(),
      ...this.removed,
      ...this.stopped,
      ...this.lastSeen.keys(),
      ...this.pids.keys(),
      ...this.polls.keys(),
    ])
  }

  /**
   * The human writes to a reviewer agent: the message waits for its next poll
   * or progress line, and a poll it holds right now wakes for it.
   */
  tell(name: string, text: string): void {
    const at = new Date().toISOString()
    const notes = this.notes.get(name) ?? []
    notes.push({ at, text })
    this.notes.set(name, notes)
    this.addChat(name, { at, from: 'you', text })
    this.log(name, 'told', clip(text, REVIEWER_TOLD_LOG_MAX))
    this.noteWaiters.get(name)?.()
  }

  /** The reviewer answers the human, privately (`diffo chat`): into their
   * conversation and its log, never a thread, never the author agent. */
  say(name: string, text: string): void {
    this.addChat(name, { at: new Date().toISOString(), from: 'agent', text })
    this.log(name, 'said', clip(text, REVIEWER_TOLD_LOG_MAX))
  }

  /** The human's conversation with `name`, oldest first. */
  chat(name: string): readonly ReviewerChatMessage[] {
    return this.chats.get(name) ?? []
  }

  private addChat(name: string, message: ReviewerChatMessage): void {
    const chat = [...(this.chats.get(name) ?? []), message].slice(-REVIEWER_CHAT_MAX)
    this.chats.set(name, chat)
  }

  /** What the human wrote to `name` and it has not picked up, oldest first. */
  unread(name: string): readonly ReviewerNote[] {
    return this.notes.get(name) ?? []
  }

  /** `name` was handed these: they leave its unread, and its log says so. A
   * message written while the payload was on the wire stays for the next one. */
  markRead(name: string, handed: readonly ReviewerNote[]): void {
    if (handed.length === 0) return
    const left = (this.notes.get(name) ?? []).filter((n) => !handed.includes(n))
    if (left.length > 0) this.notes.set(name, left)
    else this.notes.delete(name)
    this.log(
      name,
      'heard',
      handed.length === 1 ? 'read your message' : `read your ${handed.length} messages`,
    )
  }

  /** A held poll's wake for messages. Returns the detach. */
  onNote(name: string, wake: () => void): () => void {
    this.noteWaiters.set(name, wake)
    return () => {
      if (this.noteWaiters.get(name) === wake) this.noteWaiters.delete(name)
    }
  }

  /** How much of the change it read; nothing yet for one that fetched none. */
  coverage(name: string): ReviewerCoverage {
    return this.coverages.get(name) ?? { fetched: [] }
  }

  /** It fetched these changed files through `diffo diff`. */
  fetched(name: string, paths: readonly string[]): void {
    const current = this.coverage(name)
    const fetched = [...new Set([...current.fetched, ...paths])]
    if (fetched.length === current.fetched.length) return
    this.coverages.set(name, { ...current, fetched })
    this.notify()
  }

  /** Its own account when it finished: the changed files it did not read. */
  reported(name: string, skipped: readonly string[]): void {
    const current = this.coverage(name)
    this.coverages.set(name, {
      ...current,
      reported: { skipped: [...new Set(skipped)], at: new Date().toISOString() },
    })
    this.notify()
  }

  /** What `name` did, oldest first. */
  activity(name: string): readonly ReviewerEvent[] {
    return this.logs.get(name) ?? []
  }

  /** Add a line to a reviewer's log. The same status twice in a row (a poll
   * waking on its heartbeat, or re-run after a timeout) is the one already
   * there: it keeps the time it first became true. A message either way, and
   * its receipt, is never folded: "ok" twice is two messages. */
  log(name: string, kind: ReviewerEventKind, text: string, threadId?: string): void {
    const log = this.logs.get(name) ?? []
    const last = log.at(-1)
    const said = kind === 'told' || kind === 'said' || kind === 'heard'
    if (!said && last && last.kind === kind && last.text === text && last.threadId === threadId) {
      return
    }
    log.push({
      at: new Date().toISOString(),
      kind,
      text,
      ...(threadId === undefined ? {} : { threadId }),
    })
    if (log.length > REVIEWER_LOG_MAX) log.splice(0, log.length - REVIEWER_LOG_MAX)
    this.logs.set(name, log)
    this.notify()
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private notify(): void {
    for (const listener of this.listeners) listener()
  }

  state(name: string): ReviewerState {
    if (this.stopped.has(name)) return 'stopped'
    if (this.polls.has(name)) return 'listening'
    const seen = this.lastSeen.get(name)
    return seen !== undefined && Date.now() - seen < this.activeMs ? 'active' : 'away'
  }

  presence(names: readonly string[]): ReviewerPresence[] {
    return names.map((name) => ({ name, state: this.state(name) }))
  }

  /**
   * The pid of another live session that holds this name, or null when the
   * seat is free for `pid`. Two sessions under one name would share an inbox,
   * and each poll would throw the other out. A session Diffo
   * cannot identify (no pid) is taken at its word.
   */
  heldBy(name: string, pid: number | null): number | null {
    const holder = this.pids.get(name)
    if (holder === undefined || pid === null || holder === pid) return null
    return this.state(name) !== 'away' && this.isAlive(holder) ? holder : null
  }

  /** The reviewer agent ran a command: it is here, for a while. */
  touch(name: string, pid: number | null): void {
    const before = this.state(name)
    this.lastSeen.set(name, Date.now())
    if (pid !== null) this.pids.set(name, pid)
    this.armExpiry(name)
    if (before !== this.state(name)) this.notify()
  }

  /** `active` ends by the clock, with nothing else to announce it. */
  private armExpiry(name: string): void {
    const pending = this.timers.get(name)
    if (pending !== undefined) clearTimeout(pending)
    const timer = setTimeout(() => {
      this.timers.delete(name)
      if (this.state(name) === 'away') this.notify()
    }, this.activeMs + 50)
    timer.unref?.()
    this.timers.set(name, timer)
  }

  /**
   * A poll takes the name's one seat; an older poll under the same name is
   * released (`onSuperseded`), as the author agent's would be. Returns the
   * detach, safe to call more than once and after being superseded.
   */
  attach(name: string, onSuperseded: () => void): () => void {
    this.polls.get(name)?.()
    this.polls.set(name, onSuperseded)
    this.notify()
    return () => {
      if (this.polls.get(name) !== onSuperseded) return
      this.polls.delete(name)
      this.lastSeen.set(name, Date.now())
      this.armExpiry(name)
      this.notify()
    }
  }
}
