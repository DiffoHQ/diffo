import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReviewThread } from '../shared/review.js'
import { type AgentNotice, agentMessageKeys, badgeTitle, collectNotices } from './notifications.js'

/**
 * Tells a reviewer who isn't looking that the agent spoke — in-app, not through
 * the OS. Two surfaces: a banner strip under the header (AgentBanner), and a
 * `(n)` tab-title badge. No permission prompts, no Notification API, nothing
 * the OS can mute: the tab parked on a second monitor IS the notification
 * surface.
 *
 * The gate is focus, not visibility — that parked tab is visible all day while
 * the reviewer types in an editor, and it's exactly the tab that needs the
 * banner. While unfocused, notices accumulate and stay. On focus the badge
 * clears at once, and the banner lingers briefly — long enough to click the
 * thing you came back for — then goes; the thread cards themselves take over
 * from there.
 */

/** How long the banner survives the reviewer's return, so a click can land. */
export const BANNER_LINGER_MS = 8_000

export interface AgentNotifications {
  notices: readonly AgentNotice[]
  /** Click-through: open the thread and drop its notice. */
  open: (notice: AgentNotice) => void
  clear: () => void
}

export function useAgentNotifications({
  threads,
  onOpenThread,
}: {
  threads: readonly ReviewThread[] | undefined
  onOpenThread: (threadId: string) => void
}): AgentNotifications {
  const [notices, setNotices] = useState<readonly AgentNotice[]>([])

  // null = not seeded yet. The first snapshot is history, not news — it only
  // fills the set, so a refresh or an SSE reconnect can never replay old
  // answers.
  const seen = useRef<Set<string> | null>(null)
  const baseTitle = useRef(document.title)
  const pendingCount = useRef(0)
  const linger = useRef<ReturnType<typeof setTimeout> | null>(null)

  const openRef = useRef(onOpenThread)
  openRef.current = onOpenThread

  useEffect(() => {
    if (!threads) return
    if (seen.current === null) {
      seen.current = new Set(agentMessageKeys(threads))
      return
    }
    const fresh = collectNotices(threads, seen.current)
    // Union, not replace: a transient refetch that briefly misses a thread must
    // not forget its messages and re-announce them a tick later.
    for (const k of agentMessageKeys(threads)) seen.current.add(k)
    // Focus is checked at fire time: an event landing in the same tick the tab
    // regains focus belongs to the in-app thread flash, not the banner.
    if (fresh.length === 0 || document.hasFocus()) return
    // Being away cancels any fade a brief visit started — what's unread stays up.
    if (linger.current) {
      clearTimeout(linger.current)
      linger.current = null
    }
    pendingCount.current += fresh.length
    document.title = badgeTitle(pendingCount.current, baseTitle.current)
    setNotices((prev) => [...prev, ...fresh])
  }, [threads])

  useEffect(() => {
    const onFocus = () => {
      pendingCount.current = 0
      document.title = baseTitle.current
      // The banner outlives the badge: it is what the reviewer is coming back
      // to click. Give the click a window, then let the page speak for itself.
      if (linger.current) clearTimeout(linger.current)
      linger.current = setTimeout(() => {
        linger.current = null
        setNotices([])
      }, BANNER_LINGER_MS)
    }
    window.addEventListener('focus', onFocus)
    return () => {
      window.removeEventListener('focus', onFocus)
      if (linger.current) clearTimeout(linger.current)
      document.title = baseTitle.current
    }
  }, [])

  const clear = useCallback(() => setNotices([]), [])

  const open = useCallback((notice: AgentNotice) => {
    setNotices((prev) => prev.filter((t) => t.key !== notice.key))
    openRef.current(notice.threadId)
  }, [])

  return { notices, open, clear }
}
