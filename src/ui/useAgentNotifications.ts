import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReviewThread } from '../shared/review.js'
import { isDevServer } from './devMode.js'
import {
  type AgentNotice,
  agentMessageKeys,
  badgeTitle,
  collectNotices,
  tabTitle,
} from './notifications.js'

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
 *
 * The guide is the one exception to the focus gate. The agent shares the URL
 * first and writes the guide while the reviewer is opening the page, so it
 * lands seconds after they arrive — often once they have already scrolled
 * into a file, where the changeset strip it sits in is off-screen. A focused
 * tab gets the banner for it anyway, and that banner does not fade on its
 * own: it goes when clicked or dismissed, because it is the pointer to the
 * orientation the reviewer was meant to read first.
 *
 * It also owns the tab's NAME, not just the badge — the two write the same
 * property, so one of them has to hold the pen or the last effect to run wins.
 * The name is the agent's title for the change (`ReviewState.title`); the badge
 * is a prefix on top of it.
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
  title,
  onOpenThread,
}: {
  threads: readonly ReviewThread[] | undefined
  /** The agent's name for this change, once it has sent one. */
  title: string | undefined
  onOpenThread: (threadId: string) => void
}): AgentNotifications {
  const [notices, setNotices] = useState<readonly AgentNotice[]>([])

  // null = not seeded yet. The first snapshot is history, not news — it only
  // fills the set, so a refresh or an SSE reconnect can never replay old
  // answers.
  const seen = useRef<Set<string> | null>(null)
  // The app's own name, as the server wrote it into the document — `Diffo`, or
  // `diffo-dev` from a checkout. Read once, before anything here overwrites it.
  const appName = useRef(document.title)
  const dev = useRef(isDevServer())
  const titleRef = useRef(title)
  const pendingCount = useRef(0)
  const linger = useRef<ReturnType<typeof setTimeout> | null>(null)

  const openRef = useRef(onOpenThread)
  openRef.current = onOpenThread

  // The one writer of document.title: name underneath, badge on top. Called
  // from every path that moves either, so neither can clobber the other.
  const paintTitle = useCallback(() => {
    document.title = badgeTitle(
      pendingCount.current,
      tabTitle(titleRef.current, appName.current, dev.current),
    )
  }, [])

  // The title arrives long after mount — the agent's first poll may land while
  // the reviewer already has the page open. Declared before the notice effect
  // below, so a commit that brings both a new title and a new answer paints the
  // badge over the new name, not the old one.
  useEffect(() => {
    titleRef.current = title
    paintTitle()
  }, [title, paintTitle])

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
    if (fresh.length === 0) return
    // Focus is checked at fire time: an event landing in the same tick the tab
    // regains focus belongs to the in-app thread flash, not the banner.
    if (document.hasFocus()) {
      const guides = fresh.filter((n) => n.kind === 'guide')
      if (guides.length > 0) setNotices((prev) => [...prev, ...guides])
      return
    }
    // Being away cancels any fade a brief visit started — what's unread stays up.
    if (linger.current) {
      clearTimeout(linger.current)
      linger.current = null
    }
    pendingCount.current += fresh.length
    paintTitle()
    setNotices((prev) => [...prev, ...fresh])
  }, [threads, paintTitle])

  useEffect(() => {
    const onFocus = () => {
      pendingCount.current = 0
      paintTitle()
      // The banner outlives the badge: it is what the reviewer is coming back
      // to click. Give the click a window, then let the page speak for itself.
      if (linger.current) clearTimeout(linger.current)
      linger.current = setTimeout(() => {
        linger.current = null
        // The guide outlives the linger — it is dismissed by hand or by a click.
        setNotices((prev) => prev.filter((n) => n.kind === 'guide'))
      }, BANNER_LINGER_MS)
    }
    window.addEventListener('focus', onFocus)
    return () => {
      window.removeEventListener('focus', onFocus)
      if (linger.current) clearTimeout(linger.current)
      // Unmounting drops the badge, not the name — the page is still this review.
      pendingCount.current = 0
      paintTitle()
    }
  }, [paintTitle])

  const clear = useCallback(() => setNotices([]), [])

  const open = useCallback((notice: AgentNotice) => {
    setNotices((prev) => prev.filter((t) => t.key !== notice.key))
    openRef.current(notice.threadId)
  }, [])

  return { notices, open, clear }
}
