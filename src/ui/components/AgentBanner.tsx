import type { AgentNotice } from '../notifications.js'
import { Icon } from './Icon.js'

/**
 * The in-app notification surface: one full-width strip under the header, in
 * the chrome's attention colour — sized and placed to be caught from a second
 * monitor, not discovered in a corner. One event names itself; a burst counts
 * itself out and hands the detail to the monitor.
 */

const LABEL: Record<AgentNotice['kind'], string> = {
  answer: 'Agent answered',
  thread: 'New thread from the agent',
}

function wording(notices: readonly AgentNotice[]): string {
  const answers = notices.filter((n) => n.kind === 'answer').length
  const threads = notices.length - answers
  const count = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`
  if (threads === 0) return `Agent answered ${count(answers, 'thread')}`
  if (answers === 0) return `${count(threads, 'new thread')} from the agent`
  return `Agent replied on ${notices.length} threads — ${count(answers, 'answer')} · ${count(threads, 'new thread')}`
}

export function AgentBanner({
  notices,
  onOpen,
  onClear,
  onOpenMonitor,
}: {
  notices: readonly AgentNotice[]
  onOpen: (notice: AgentNotice) => void
  onClear: () => void
  onOpenMonitor: () => void
}) {
  if (notices.length === 0) return null
  const single = notices.length === 1 ? notices[0]! : null
  return (
    <div className="agent-banner" role="status" aria-live="polite">
      <button
        type="button"
        className="agent-banner-body"
        title={single ? 'open this thread' : 'open the monitor'}
        onClick={() => {
          if (single) {
            onOpen(single)
          } else {
            onClear()
            onOpenMonitor()
          }
        }}
      >
        <Icon name="bell" size="sm" />
        {single ? (
          <>
            <span className="agent-banner-label">{LABEL[single.kind]}</span>
            {single.anchor && <span className="agent-banner-anchor">{single.anchor}</span>}
            <span className="agent-banner-preview">{single.preview}</span>
          </>
        ) : (
          <span className="agent-banner-label">{wording(notices)}</span>
        )}
      </button>
      <button
        type="button"
        className="btn btn-ghost btn-icon btn-sm agent-banner-x"
        data-tip="Dismiss"
        aria-label="dismiss"
        onClick={onClear}
      >
        <Icon name="x" size="sm" />
      </button>
    </div>
  )
}
