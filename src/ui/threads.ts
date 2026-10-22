import { anchorSpan, isPublic, type ReviewThread, untouchedAgentVoice } from '../shared/review.js'

export type Turn = 'yours' | 'unanswered' | 'proposed' | 'agent' | 'note' | 'posted' | 'resolved'

export function threadTurn(thread: ReviewThread): Turn {
  if (thread.state === 'resolved') return 'resolved'
  // A public thread has two lives: a draft here, and a thread on GitHub. Neither
  // is anyone's turn in the agent sense — the conversation is with the PR.
  if (isPublic(thread)) return thread.state === 'open' && !thread.github ? 'note' : 'posted'
  // A fresh agent thread is the agent speaking, not a draft of yours. Once you
  // reply into it, it carries your words and falls through to the normal turns.
  if (untouchedAgentVoice(thread) && thread.state === 'open') return 'proposed'
  if (thread.state === 'open') return 'note'
  // Ahead of `withheld` deliberately: an answer you haven't read is hotter than a
  // follow-up you are sitting on, and the card shows the unsent reply either way.
  // A `--more` reply is a promise, not an answer: the agent still holds the turn.
  if (thread.messages.at(-1)?.author === 'agent') {
    return thread.awaitingFollowUp === true ? 'agent' : 'yours'
  }
  if (thread.withheld) return 'note'
  if (!thread.unanswered) return 'agent'
  return thread.state === 'addressed' ? 'yours' : 'unanswered'
}

/** A comment of the reviewer's that hasn't been handed over. An untouched agent
 * thread is never this — until the reviewer replies into it, there is nothing
 * of theirs to send. Nor is a public thread: a GitHub draft is pending for the
 * PR, never for the agent. */
export function isUnsent(thread: ReviewThread): boolean {
  return (
    (thread.state === 'open' || thread.withheld === true) &&
    !untouchedAgentVoice(thread) &&
    !isPublic(thread)
  )
}

export const TURN_ORDER: readonly Turn[] = [
  'yours',
  'unanswered',
  'proposed',
  'agent',
  'note',
  'posted',
  'resolved',
]

export const TURN_LABEL: Record<Turn, string> = {
  yours: 'Your turn',
  unanswered: 'No answer',
  proposed: 'From the agent',
  agent: 'Waiting on agent',
  note: 'Draft',
  posted: 'On GitHub',
  resolved: 'Resolved',
}

export type Section = 'yours' | 'proposed' | 'agent' | 'note' | 'posted' | 'settled'

export const SECTION_ORDER: readonly Section[] = [
  'yours',
  'proposed',
  'agent',
  'note',
  'posted',
  'settled',
]

export const SECTION_LABEL: Record<Section, string> = {
  yours: 'Your turn',
  proposed: 'From the agent',
  agent: 'Waiting on the agent',
  note: 'Drafts',
  posted: 'On GitHub',
  settled: 'Settled',
}

export function sectionOf(turn: Turn): Section {
  switch (turn) {
    case 'yours':
    case 'unanswered':
      return 'yours'
    case 'proposed':
      return 'proposed'
    case 'agent':
      return 'agent'
    case 'note':
      return 'note'
    case 'posted':
      return 'posted'
    case 'resolved':
      return 'settled'
  }
}

export type Outcome = 'fixed' | 'answered' | 'changed' | 'no-answer' | 'waiting'

export function threadOutcome(thread: ReviewThread): Outcome | null {
  if (thread.state === 'open' || thread.state === 'resolved' || isPublic(thread)) return null
  // An interim (`--more`) reply doesn't count as replied — a follow-up is owed.
  const replied = thread.messages.at(-1)?.author === 'agent' && thread.awaitingFollowUp !== true
  // `addressed` means reconcile saw the commented hunk's content-addressed id
  // rotate, i.e. the code under the comment was rewritten.
  const changed = thread.state === 'addressed'
  if (replied) return changed ? 'fixed' : 'answered'
  if (changed) return 'changed'
  return thread.unanswered ? 'no-answer' : 'waiting'
}

export interface ThreadItem {
  thread: ReviewThread
  turn: Turn
  outcome?: Outcome
  question: string
  answer: string | null
  anchor: string | null
  path: string | null
  durationMs?: number
  updatedAt: string
  working?: boolean
  /** 1-based place in the delivery queue. Only set while an agent is on the loop;
   * a pending send with nobody attached is a copied prompt, not a queue position. */
  queued?: number
  gone?: boolean
  /** GitHub's word: the commented line left the diff, though the file is still
   * in it. Reads with the departed threads, but for a different reason than
   * `gone`, and the wording says which. */
  outdated?: boolean
}

/** The rail's three lists. Layers is always present — with layers it is the
 * default and carries a count; without, its body offers to outline. */
export type PanelTab = 'layers' | 'files' | 'threads'

/** The first non-blank line, trimmed: what a collapsed card or rail row shows
 * for a body that may run to paragraphs (a bot's review comment, say). */
export function firstLine(text: string): string {
  for (const line of text.split('\n')) {
    const t = line.trim()
    if (t !== '') return t
  }
  return ''
}

function describe(thread: ReviewThread): { anchor: string | null; path: string | null } {
  const a = thread.anchor
  if (a.kind === 'changeset') return { anchor: null, path: null }
  if (a.kind === 'file') return { anchor: a.path, path: a.path }
  if (a.kind === 'layer') return { anchor: `layer “${a.title}”`, path: null }
  return { anchor: `${a.path}:${anchorSpan(a)}`, path: a.path }
}

/** The two sides of a pull request review: threads for GitHub, threads for
 * the agent. On a PR the rail groups by side and only orders by turn inside a
 * group, so a row's side is never something to work out from its section. */
export type Side = 'github' | 'agent'

/** A GitHub thread is yours when you started it here, replied in it, spoke in
 * it on GitHub, or are @mentioned in it. Everything else on the PR, bots
 * included, is someone else's conversation and folds behind one line. */
export function involves(thread: ReviewThread, login: string | null): boolean {
  if (thread.messages.some((m) => m.author === 'reviewer')) return true
  if (!login) return false
  const at = new RegExp(`@${login}(?![\\w-])`, 'i')
  return thread.messages.some(
    (m) => m.author === 'github' && (m.github?.user.login === login || at.test(m.text)),
  )
}

export function bySide(items: readonly ThreadItem[]): Record<Side, ThreadItem[]> {
  const rank = (i: ThreadItem) => TURN_ORDER.indexOf(i.turn)
  const hottestFirst = (xs: ThreadItem[]) =>
    xs.sort((a, b) => rank(a) - rank(b) || b.updatedAt.localeCompare(a.updatedAt))
  return {
    github: hottestFirst(items.filter((i) => isPublic(i.thread))),
    agent: hottestFirst(items.filter((i) => !isPublic(i.thread))),
  }
}

export function threadItems(
  threads: readonly ReviewThread[],
  working: ReadonlySet<string> = new Set(),
  queued: ReadonlyMap<string, number> = new Map(),
): ThreadItem[] {
  return threads.map((thread) => {
    // The last word from the other side: the agent on a private thread, the
    // last GitHub voice on a public one.
    const lastAgent = [...thread.messages]
      .reverse()
      .find((m) => (isPublic(thread) ? m.author === 'github' : m.author === 'agent'))
    const place = queued.get(thread.id)
    const outcome = threadOutcome(thread)
    return {
      thread,
      turn: threadTurn(thread),
      ...(outcome ? { outcome } : {}),
      ...(working.has(thread.id) ? { working: true } : {}),
      // Working outranks queued: a follow-up can re-queue a thread the agent already
      // holds, and "on it" is the truer of the two.
      ...(place !== undefined && !working.has(thread.id) ? { queued: place } : {}),
      ...(thread.github?.outdated === true ? { outdated: true } : {}),
      question: firstLine(thread.messages[0]?.text ?? ''),
      answer: lastAgent ? firstLine(lastAgent.text) : null,
      ...describe(thread),
      ...(lastAgent?.durationMs !== undefined ? { durationMs: lastAgent.durationMs } : {}),
      updatedAt: thread.updatedAt,
    }
  })
}

/** An anchor at chip length: the basename keeps the line number, the directory
 * goes — the full path is one click away in the monitor. */
export function shortAnchor(anchor: string | null): string {
  if (anchor === null) return 'the changeset'
  return anchor.slice(anchor.lastIndexOf('/') + 1)
}

/**
 * The chip's one-line account of what the agent is doing right now, composed
 * from the batch the client already tracks. Null when there is nothing more
 * specific to say than "working".
 */
export function agentActivity(
  stillTo: readonly ThreadItem[],
  lastAnswered: string | null,
): string | null {
  const working = stillTo.find((i) => i.working === true)
  if (working) return `working on ${shortAnchor(working.anchor)}`
  if (lastAnswered !== null) return `answered ${lastAnswered}`
  if (stillTo.length > 0) {
    return `picked up ${stillTo.length} comment${stillTo.length === 1 ? '' : 's'}`
  }
  return null
}

export function byTurn(items: readonly ThreadItem[]): Map<Turn, ThreadItem[]> {
  const out = new Map<Turn, ThreadItem[]>()
  for (const turn of TURN_ORDER) {
    const group = items
      .filter((i) => i.turn === turn)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    if (group.length > 0) out.set(turn, group)
  }
  return out
}

export function bySection(items: readonly ThreadItem[]): Map<Section, ThreadItem[]> {
  const out = new Map<Section, ThreadItem[]>()
  for (const section of SECTION_ORDER) {
    const group = items
      .filter((i) => sectionOf(i.turn) === section)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    if (group.length > 0) out.set(section, group)
  }
  return out
}

export function yourTurnCount(items: readonly ThreadItem[]): number {
  return items.filter((i) => i.turn === 'yours' || i.turn === 'unanswered').length
}

export function unsettledCount(items: readonly ThreadItem[]): number {
  return items.filter((i) => sectionOf(i.turn) !== 'settled').length
}

export function byFile(items: readonly ThreadItem[]): Map<string, ThreadItem[]> {
  const out = new Map<string, ThreadItem[]>()
  for (const item of items) {
    if (item.path === null) continue
    const list = out.get(item.path)
    if (list) list.push(item)
    else out.set(item.path, [item])
  }
  return out
}

export function holdsAttention(items: readonly ThreadItem[] | undefined): boolean {
  return (items ?? []).some((i) => i.turn === 'yours' || i.turn === 'agent')
}
