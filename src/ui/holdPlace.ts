import { type RefObject, useLayoutEffect, useRef } from 'react'

/**
 * Keeping the reader where they are while the page changes above them.
 *
 * A thread that lands above the viewport, or grows there, pushes everything
 * under it down by its height. One reviewer never sees that: their own comment
 * goes in where they are looking. Reviewer agents comment anywhere, at any
 * moment, and the author agent answers each one, so with a few of them at work
 * the code being read slid away every few seconds.
 *
 * Browsers fix this themselves (scroll anchoring), but the reading pane has to
 * opt out of it (see `.reading-pane-barred` in styles.css), and Safari has
 * none. So the pane does it by hand: note what sits at the top of the view
 * before a change to the threads is committed, and put it back after.
 */
export interface Held {
  node: Element
  /** Its top edge in the viewport, and the pane's scroll, when it was noted. */
  top: number
  scrollTop: number
}

/** What stays stuck to the top of the pane: never a place in the text. */
const STUCK = '.pane-bar, .file-header'
/** An element that starts further above the probe than this can grow above the
 * view without its own top moving, so it holds nothing. */
const NEAR = 80
const STEP = 24
const TRIES = 12

/** The first thing the reader can see in the pane, or null at the very top:
 * there, what arrives above is what they are about to read. */
export function placeIn(pane: HTMLElement): Held | null {
  if (pane.scrollTop <= 0) return null
  if (typeof document.elementFromPoint !== 'function') return null
  const box = pane.getBoundingClientRect()
  const x = box.left + box.width / 2
  let y = box.top + 4
  for (let i = 0; i < TRIES && y < box.bottom; i++) {
    const hit = document.elementFromPoint(x, y)
    if (!hit || !pane.contains(hit)) return null
    // The pane's own padding, or a gap between two cards: look further down.
    if (hit === pane) {
      y += STEP
      continue
    }
    const stuck = hit.closest(STUCK)
    if (stuck) {
      y = stuck.getBoundingClientRect().bottom + 2
      continue
    }
    const top = hit.getBoundingClientRect().top
    if (top >= y - NEAR) return { node: hit, top, scrollTop: pane.scrollTop }
    y += STEP
  }
  return null
}

/** Scroll the pane so `held` sits where it did. A scroll the reader made in
 * between is theirs and stays. */
export function keepPlace(pane: HTMLElement, held: Held): void {
  if (!held.node.isConnected) return
  const moved = held.node.getBoundingClientRect().top - held.top + (pane.scrollTop - held.scrollTop)
  if (Math.abs(moved) >= 1) pane.scrollTop += moved
}

/**
 * Hold the reader's place across every commit in which `key` changed. The
 * place is read during render, while the page still shows what they were
 * looking at, and put back before the browser paints.
 */
export function useHeldPlace(pane: RefObject<HTMLElement | null>, key: unknown): void {
  const last = useRef(key)
  const held = useRef<Held | null>(null)
  if (last.current !== key) {
    last.current = key
    held.current = pane.current ? placeIn(pane.current) : null
  }
  useLayoutEffect(() => {
    const was = held.current
    held.current = null
    if (was && pane.current) keepPlace(pane.current, was)
  })
}
