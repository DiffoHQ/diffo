import { useEffect, useState } from 'react'

/** Is the page dark *right now*? An explicit `data-theme` on <html> wins; otherwise
 * the OS decides. Syntax tokens are inline styles, outside the CSS variables' reach,
 * so this hook has to answer the same question the stylesheet does. */
const isDark = () => {
  const explicit = document.documentElement.getAttribute('data-theme')
  if (explicit === 'dark') return true
  if (explicit === 'light') return false
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false
}

export function useDarkMode(): boolean {
  const [dark, setDark] = useState(() => typeof window !== 'undefined' && isDark())
  useEffect(() => {
    const update = () => setDark(isDark())
    const media = window.matchMedia?.('(prefers-color-scheme: dark)')
    media?.addEventListener('change', update)
    // The theme menu writes data-theme on <html>; there's no event for an attribute.
    const observer = new MutationObserver(update)
    observer.observe(document.documentElement, { attributeFilter: ['data-theme'] })
    return () => {
      media?.removeEventListener('change', update)
      observer.disconnect()
    }
  }, [])
  return dark
}

export function fileAnchor(path: string): string {
  return `file-${path.replace(/[^a-zA-Z0-9_-]/g, '_')}`
}

/**
 * Take the reader to something in the reading pane — a file card, a thread — and
 * run `arrived` once they are there.
 *
 * An instant scroll across a long changeset reads as a page reload: nothing moved,
 * the screen simply became different. Gliding keeps the reader oriented — they see
 * which way they went and roughly how far. Reduced motion still gets the cut.
 */
export function glideTo(node: Element, arrived?: (node: Element) => void): void {
  const still = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
  const pane = node.closest('.reading-pane')
  const from = pane?.scrollTop
  const aim = () => node.scrollIntoView({ behavior: still ? 'instant' : 'smooth', block: 'start' })
  aim()
  if (still) {
    arrived?.(node)
    return
  }
  /*
   * Keep aiming while the page settles under the target.
   *
   * The browser locks a scroll destination in at the moment it is asked, but the
   * jump itself is often what makes the page grow: it widens the render window, and
   * landing near the sentinel pulls in the next batch of files — all of it above the
   * target, all of it pushing the target down after the destination was fixed. A
   * diagram finishing its render does the same. Native scroll anchoring would absorb
   * this, but the pane opts out of it on purpose (it does its own sweep arithmetic),
   * so nothing corrects it and the file you asked for lands mid-screen.
   *
   * Re-aiming retargets the animation in flight rather than restarting it, so this
   * is invisible: the glide simply ends where the reader was promised.
   */
  const column = pane?.querySelector('.reading-col')
  let top = (node as HTMLElement).offsetTop
  let settling: ResizeObserver | null = null
  if (column && typeof ResizeObserver === 'function') {
    settling = new ResizeObserver(() => {
      const now = (node as HTMLElement).offsetTop
      if (now === top) return
      top = now
      aim()
    })
    settling.observe(column)
  }
  let done = false
  const arrive = () => {
    if (done) return
    done = true
    settling?.disconnect()
    // A smooth scroll that never ran — a throttled tab, a renderer that isn't
    // painting — must not strand the reader on the wrong screen. Only that case is
    // corrected: a pane that moved at all is a pane doing its job, even if the
    // reader grabbed the wheel halfway and went somewhere else on purpose.
    if (pane && pane.scrollTop === from) {
      node.scrollIntoView({ behavior: 'instant', block: 'start' })
    }
    arrived?.(node)
  }
  // scrollend is the honest signal; the timer covers browsers without it, and is
  // long enough that a scroll still in flight is never cut short.
  pane?.addEventListener('scrollend', arrive, { once: true })
  setTimeout(arrive, 1200)
}
