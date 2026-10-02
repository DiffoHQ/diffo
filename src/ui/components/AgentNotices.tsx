import type { AgentNotice } from '../notifications.js'
import type { ShownNotice } from '../useAgentNotifications.js'
import { Icon } from './Icon.js'

/**
 * The in-app notification surface: a stack of cards hanging under the agent's
 * chip in the header — the agent spoke, so its notices fall from where it
 * stands. Paper, not the attention wash: each card is a thread card in
 * miniature (the agent avatar, what it did, the anchor, the first line), and
 * the amber stays in the avatar, where the review already keeps it. A card
 * opens its thread or dismisses on its own; a burst shows the newest three
 * and counts the rest into a row that opens the monitor, so no pointer is lost.
 */

/** How many cards stand before the rest fold into the overflow row. */
export const VISIBLE_NOTICES = 3

/** A view-transition name is a CSS identifier: the key's UUIDs pass, its colon
 * does not. One name per card is what lets the browser track it as it moves. */
const vtName = (key: string) => `notice-${key.replace(/[^a-zA-Z0-9_-]/g, '')}`

const VERB: Record<AgentNotice['kind'], string> = {
  answer: 'answered',
  thread: 'opened a thread',
  guide: 'posted a guide to this change',
}

export function AgentNotices({
  notices,
  onOpen,
  onDismiss,
  onClear,
  onOpenMonitor,
}: {
  notices: readonly ShownNotice[]
  onOpen: (notice: AgentNotice) => void
  onDismiss: (notice: AgentNotice) => void
  onClear: () => void
  onOpenMonitor: () => void
}) {
  if (notices.length === 0) return null
  // Newest on top: the one that just landed is the one the eye is looking for.
  const shown = notices.slice(-VISIBLE_NOTICES).reverse()
  const rest = notices.length - shown.length
  return (
    <div className="notices" role="status" aria-live="polite">
      {shown.map((n) => (
        <div
          key={n.key}
          className={`notice notice-${n.kind}`}
          style={{ viewTransitionName: vtName(n.key) }}
        >
          <button
            type="button"
            className="notice-body"
            title={n.kind === 'guide' ? 'read the guide' : 'open this thread'}
            onClick={() => onOpen(n)}
          >
            <span className="avatar avatar-agent" aria-hidden="true">
              <Icon name="sparkle" size="sm" />
            </span>
            <span className="notice-text">
              <span className="notice-head">
                <span className="notice-who">Agent</span> {VERB[n.kind]}
                {n.anchor && <span className="notice-anchor">{n.anchor}</span>}
              </span>
              <span className="notice-preview">{n.preview}</span>
            </span>
          </button>
          <button
            type="button"
            className="btn btn-ghost btn-icon btn-sm notice-x"
            data-tip="Dismiss"
            aria-label="dismiss"
            onClick={() => onDismiss(n)}
          >
            <Icon name="x" size="sm" />
          </button>
          {n.expiresAt !== null && (
            // Keyed on the deadline: a re-armed clock restarts the drain from full.
            <i
              key={n.expiresAt}
              className="notice-drain"
              aria-hidden="true"
              style={{ animationDuration: `${Math.max(0, n.expiresAt - Date.now())}ms` }}
            />
          )}
        </div>
      ))}
      {rest > 0 && (
        <div className="notice notice-more" style={{ viewTransitionName: 'notice-more' }}>
          <button
            type="button"
            className="notice-body"
            title="open the monitor"
            onClick={() => {
              onClear()
              onOpenMonitor()
            }}
          >
            <Icon name="bell" size="sm" />
            <span className="notice-more-label">
              {rest} more {rest === 1 ? 'thread' : 'threads'} · open the monitor
            </span>
          </button>
          <button
            type="button"
            className="btn btn-ghost btn-icon btn-sm notice-x"
            data-tip="Dismiss all"
            aria-label="dismiss all"
            onClick={onClear}
          >
            <Icon name="x" size="sm" />
          </button>
        </div>
      )}
    </div>
  )
}
