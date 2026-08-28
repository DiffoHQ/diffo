import { anchorSpan, type ReviewThread, untouchedAgentVoice } from '../shared/review.js'

export type Turn = 'yours' | 'unanswered' | 'proposed' | 'agent' | 'note' | 'resolved'

export function threadTurn(thread: ReviewThread): Turn {
  if (thread.state === 'resolved') return 'resolved'
  // A fresh agent thread is the agent speaking, not a draft of yours. Once you
  // reply into it, it carries your words and falls through to the normal turns.
  if (untouchedAgentVoice(thread) && thread.state === 'open') return 'proposed'
  if (thread.state === 'open') return 'note'
  // Ahead of `withheld` deliberately: an answer you haven't read is hotter than a
  // follow-up you are sitting on, and the card shows the unsent reply either way.
  if (thread.messages.at(-1)?.author === 'agent') return 'yours'
  if (thread.withheld) return 'note'
  if (!thread.unanswered) return 'agent'
  return thread.state === 'addressed' ? 'yours' : 'unanswered'
}

/** A comment of the reviewer's that hasn't been handed over. An untouched agent
 * thread is never this — until the reviewer replies into it, there is nothing
 * of theirs to send. */
export function isUnsent(thread: ReviewThread): boolean {
  return (thread.state === 'open' || thread.withheld === true) && !untouchedAgentVoice(thread)
}

export const TURN_ORDER: readonly Turn[] = [
  'yours',
  'unanswered',
  'proposed',
  'agent',
  'note',
  'resolved',
]

export const TURN_LABEL: Record<Turn, string> = {
  yours: 'Your turn',
  unanswered: 'No answer',
  proposed: 'From the agent',
  agent: 'Waiting on agent',
  note: 'Not sent',
  resolved: 'Resolved',
}

export type Section = 'yours' | 'proposed' | 'agent' | 'note' | 'settled'

export const SECTION_ORDER: readonly Section[] = ['yours', 'proposed', 'agent', 'note', 'settled']

export const SECTION_LABEL: Record<Section, string> = {
  yours: 'Your turn',
  proposed: 'From the agent',
  agent: 'Waiting on the agent',
  note: 'Not sent',
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
    case 'resolved':
      return 'settled'
  }
}

export type Outcome = 'fixed' | 'answered' | 'changed' | 'no-answer' | 'waiting'

export function threadOutcome(thread: ReviewThread): Outcome | null {
  if (thread.state === 'open' || thread.state === 'resolved') return null
  const replied = thread.messages.at(-1)?.author === 'agent'
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
}

export type PanelTab = 'files' | 'threads'

const firstLine = (text: string) => text.split('\n', 1)[0]!.trim()

function describe(thread: ReviewThread): { anchor: string | null; path: string | null } {
  const a = thread.anchor
  if (a.kind === 'changeset') return { anchor: null, path: null }
  if (a.kind === 'file') return { anchor: a.path, path: a.path }
  return { anchor: `${a.path}:${anchorSpan(a)}`, path: a.path }
}

export function threadItems(
  threads: readonly ReviewThread[],
  working: ReadonlySet<string> = new Set(),
  queued: ReadonlyMap<string, number> = new Map(),
): ThreadItem[] {
  return threads.map((thread) => {
    const lastAgent = [...thread.messages].reverse().find((m) => m.author === 'agent')
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
      question: firstLine(thread.messages[0]?.text ?? ''),
      answer: lastAgent ? firstLine(lastAgent.text) : null,
      ...describe(thread),
      ...(lastAgent?.durationMs !== undefined ? { durationMs: lastAgent.durationMs } : {}),
      updatedAt: thread.updatedAt,
    }
  })
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
