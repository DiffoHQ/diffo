import { useLayoutEffect, useState } from 'react'
import type { CanvasCard } from '../model.js'
import { CARD_WIDTH, HEAD_EXTRA, LINE_GUTTER, MAX_CARD_WIDTH } from './constants.js'

/** The width of one character of the code font. */
export function useCharWidth(): number {
  const [width, setWidth] = useState(7.3)
  useLayoutEffect(() => {
    const probe = document.createElement('span')
    probe.className = 'hunk-lines'
    probe.style.cssText = 'position:absolute;visibility:hidden;white-space:pre'
    probe.textContent = 'x'.repeat(100)
    document.body.appendChild(probe)
    const w = probe.getBoundingClientRect().width / 100
    probe.remove()
    if (w > 0) setWidth(w)
  }, [])
  return width
}

/** The width of a card that shows each of its lines in full. */
export function cardWidth(card: CanvasCard, char: number): number {
  let longest = 0
  for (const line of card.lines) {
    const length = line.text.replace(/\t/g, '        ').length
    if (length > longest) longest = length
  }
  const fit = Math.ceil(longest * char) + LINE_GUTTER
  // The header shows the title in full, with space for its marks.
  const head = Math.ceil(card.title.length * char * 1.1) + HEAD_EXTRA
  return Math.min(MAX_CARD_WIDTH, Math.max(CARD_WIDTH, fit, head))
}

export function baseName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1)
}
