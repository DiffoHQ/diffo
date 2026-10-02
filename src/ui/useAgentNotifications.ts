import { useCallback, useEffect, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
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
 * the OS. Two surfaces: a stack of notice cards under the agent's chip
 * (AgentNotices), and a `(n)` tab-title badge. No permission prompts, no Notification API, nothing
 * the OS can mute: the tab parked on a second monitor IS the notification
 * surface.
 *
 * Focus decides how long a card lives, not whether it shows. A parked tab is
 * visible all day while the reviewer types in an editor, and it's exactly the
 * tab that needs the notices: while unfocused, they accumulate and stay, and
 * the badge counts them. On focus the badge clears at once, and the cards
 * linger briefly — long enough to click the thing you came back for — then
 * go; the thread cards themselves take over from there. A notice landing on
 * a focused tab shows too — the thread it points at is often below the fold —
 * but with no badge, and it fades on its own after the same linger.
 *
 * The guide is the one card that never fades. The agent shares the URL first
 * and writes the guide while the reviewer is opening the page, so it lands
 * seconds after they arrive — often once they have already scrolled into a
 * file, where the changeset strip it sits in is off-screen. It goes when
 * clicked or dismissed, because it is the pointer to the orientation the
 * reviewer was meant to read first.
 *
 * It also owns the tab's NAME, not just the badge — the two write the same
 * property, so one of them has to hold the pen or the last effect to run wins.
 * The name is the agent's title for the change (`ReviewState.title`); the badge
 * is a prefix on top of it.
 */

/** How long the cards survive the reviewer's return, so a click can land. */
export const BANNER_LINGER_MS = 8_000

/** Cards that start their clock together leave one after another, oldest
 * (bottom) first, this far apart — a cascade, not a blink. */
export const FADE_STAGGER_MS = 350

/**
 * Put every card that can fade on the clock: the first goes at `first`, each
 * later one a beat after it. The guide never fades, and never takes a slot in
 * the cascade.
 */
function armClocks(notices: readonly ShownNotice[], first: number): ShownNotice[] {
  let slot = 0
  return notices.map((n) =>
    n.kind === 'guide' ? n : { ...n, expiresAt: first + FADE_STAGGER_MS * slot++ },
  )
}

/**
 * Where a card landing now joins the cascade: a full linger from now, or one
 * beat after the latest deadline already in the stack, whichever is later —
 * two cards from two snapshots a few milliseconds apart still leave a beat
 * apart, not together.
 */
function nextSlot(stack: readonly ShownNotice[], now: number): number {
  let latest = Number.NEGATIVE_INFINITY
  for (const n of stack) if (n.expiresAt !== null && n.expiresAt > latest) latest = n.expiresAt
  return Math.max(now + BANNER_LINGER_MS, latest + FADE_STAGGER_MS)
}

/**
 * Every change to the stack goes through here, so the browser can animate it:
 * a card slides in, a dismissed one fades out, and the cards left behind glide
 * up to close the gap. The View Transitions API does the measuring; the CSS
 * on `.notice` says how each part moves. Where the API is missing the update
 * applies at once — the CSS keeps a plain slide-in for that case.
 */
function animated(update: () => void): void {
  const doc = document as Document & {
    startViewTransition?: (cb: () => void) => { ready: Promise<void>; finished: Promise<void> }
  }
  if (typeof doc.startViewTransition !== 'function') {
    update()
    return
  }
  const transition = doc.startViewTransition(() => flushSync(update))
  // A transition is skipped when the tab is hidden or when the next change
  // lands before this one has finished; the update still applies, and the
  // skip is nobody's error — but it rejects `ready`, which would otherwise
  // surface as an unhandled rejection in the console.
  transition.ready.catch(() => {})
  transition.finished.catch(() => {})
}

/** A notice as the stack shows it: the pure notice, plus its clock. */
export interface ShownNotice extends AgentNotice {
  /** When the card fades on its own (epoch ms), or null while it waits for the
   * reviewer to come back — the card draws this as a draining line. */
  expiresAt: number | null
}

export interface AgentNotifications {
  notices: readonly ShownNotice[]
  /** Click-through: open the thread and drop its notice. */
  open: (notice: AgentNotice) => void
  /** Drop one notice without going anywhere. */
  dismiss: (notice: AgentNotice) => void
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
  const [notices, setNotices] = useState<readonly ShownNotice[]>([])

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
    // Focus is checked at fire time. On a focused tab the cards show without
    // a badge and fade by themselves — the guide excepted, which waits for a
    // click or a dismiss.
    if (document.hasFocus()) {
      const now = Date.now()
      const landed = fresh.map((n) => ({ ...n, expiresAt: null }))
      animated(() => setNotices((prev) => [...prev, ...armClocks(landed, nextSlot(prev, now))]))
      return
    }
    pendingCount.current += fresh.length
    paintTitle()
    // The clock stops for everyone: what's up stays up until the reviewer is back.
    const waiting = fresh.map((n) => ({ ...n, expiresAt: null }))
    animated(() =>
      setNotices((prev) => [
        ...prev.map((n) => (n.expiresAt === null ? n : { ...n, expiresAt: null })),
        ...waiting,
      ]),
    )
  }, [threads, paintTitle])

  useEffect(() => {
    const onFocus = () => {
      pendingCount.current = 0
      paintTitle()
      // The cards outlive the badge: they are what the reviewer is coming back
      // to click. Give the click a window, then let the page speak for itself —
      // every card's clock restarts from here, cards that landed mid-visit too.
      const first = Date.now() + BANNER_LINGER_MS
      setNotices((prev) => armClocks(prev, first))
    }
    window.addEventListener('focus', onFocus)
    return () => {
      window.removeEventListener('focus', onFocus)
      // Unmounting drops the badge, not the name — the page is still this review.
      pendingCount.current = 0
      paintTitle()
    }
  }, [paintTitle])

  // The reaper: one timer, armed for the nearest deadline in the stack, that
  // drops whatever has expired and lets the effect re-arm for the next. Cards
  // leave in deadline order, so a cascade is just deadlines a beat apart.
  useEffect(() => {
    let next = Number.POSITIVE_INFINITY
    for (const n of notices) if (n.expiresAt !== null && n.expiresAt < next) next = n.expiresAt
    if (next === Number.POSITIVE_INFINITY) return
    const timer = setTimeout(
      () => {
        const now = Date.now()
        animated(() =>
          setNotices((prev) => prev.filter((n) => n.expiresAt === null || n.expiresAt > now)),
        )
      },
      Math.max(0, next - Date.now()),
    )
    return () => clearTimeout(timer)
  }, [notices])

  const clear = useCallback(() => animated(() => setNotices([])), [])

  const dismiss = useCallback((notice: AgentNotice) => {
    animated(() => setNotices((prev) => prev.filter((t) => t.key !== notice.key)))
  }, [])

  const open = useCallback((notice: AgentNotice) => {
    animated(() => setNotices((prev) => prev.filter((t) => t.key !== notice.key)))
    openRef.current(notice.threadId)
  }, [])

  return { notices, open, dismiss, clear }
}
