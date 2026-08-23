import { type ReviewThread, untouchedAgentVoice } from '../shared/review.js'

/**
 * What's worth telling a reviewer who isn't looking: the agent answered a thread
 * of theirs, or opened one of its own. This module is the pure half — diffing
 * review snapshots into notices — so it tests without a DOM in sight. The hook
 * (useAgentNotifications) owns the browser: toasts and the tab-title badge.
 */

export interface AgentNotice {
  /** `${threadId}:${messageId}` — one notice per agent message, ever. */
  key: string
  /** `answer` = a reply into a thread the reviewer is part of; `thread` = the
   * agent opened this thread itself and the reviewer hasn't touched it. */
  kind: 'answer' | 'thread'
  threadId: string
  /** Where it sits, for the banner: `path:line`, a path, or null for a
   * changeset-level note. */
  anchor: string | null
  /** First line of the agent's message. */
  preview: string
}

const key = (threadId: string, messageId: string) => `${threadId}:${messageId}`

/** Every agent message currently in the review, as notice keys. Seeding `seen`
 * from this on first load is what keeps a page refresh from replaying history. */
export function agentMessageKeys(threads: readonly ReviewThread[]): string[] {
  return threads.flatMap((t) =>
    t.messages.filter((m) => m.author === 'agent').map((m) => key(t.id, m.id)),
  )
}

function anchorLabel(thread: ReviewThread): string | null {
  const a = thread.anchor
  if (a.kind === 'changeset') return null
  if (a.kind === 'file') return a.path
  return `${a.path}:${a.line}`
}

/**
 * The notices a fresh snapshot owes: per thread, the latest agent message not in
 * `seen`. One notice per thread — an agent that wrote twice into one thread is
 * still one "it answered here", not two banners.
 */
export function collectNotices(
  threads: readonly ReviewThread[],
  seen: ReadonlySet<string>,
): AgentNotice[] {
  const notices: AgentNotice[] = []
  for (const thread of threads) {
    const last = [...thread.messages].reverse().find((m) => m.author === 'agent')
    if (!last || seen.has(key(thread.id, last.id))) continue
    notices.push({
      key: key(thread.id, last.id),
      kind: untouchedAgentVoice(thread) ? 'thread' : 'answer',
      threadId: thread.id,
      anchor: anchorLabel(thread),
      preview: last.text.split('\n', 1)[0]!.trim(),
    })
  }
  return notices
}

/** The tab-strip badge: `(3) Diffo`. Zero restores the title untouched. */
export function badgeTitle(pending: number, base: string): string {
  return pending > 0 ? `(${pending}) ${base}` : base
}
