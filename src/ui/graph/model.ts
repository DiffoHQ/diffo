import type { GraphColor } from '../../shared/graphs.js'
import type { DiffLine } from '../../shared/types.js'

/**
 * The data that the canvas draws. The canvas does not know what made it: a
 * graph block of the agent (`block.ts`) is the one maker today.
 */

export interface CanvasCard {
  id: string
  /** The file of the code, or '' for a card with no code. */
  path: string
  /** The name in the header of the card. */
  title: string
  /** The diff lines of the card. Lines of code that the change does not touch
   * are lines with no change. */
  lines: DiffLine[]
  /** The hunks of the review that the lines come from: a card with one takes
   * comments and the Viewed mark. The first one is where "Open in list" goes. */
  hunkIds: string[]
  /** What the card is, when it is not changed code: a note of the agent, or
   * code that the change does not touch. */
  tag?: 'note' | 'code'
  /** Text below the header: the text of a note, or why a card has no code. */
  text?: string
  /** The titles of the boxes that the card is in, the outer one first. */
  box: readonly string[]
}

export interface CanvasArrow {
  from: string
  to: string
  label?: string
  /** The head line of `from` where the arrow leaves its card. 0: the header. */
  line: number
}

export interface CanvasBox {
  title: string
  color?: GraphColor
  boxes: CanvasBox[]
}

export interface CanvasGraph {
  cards: CanvasCard[]
  arrows: CanvasArrow[]
  /** The boxes, for their colors. A card names its boxes itself. */
  boxes: CanvasBox[]
  /** The ids of the cards in the order to read them. */
  order: string[]
}
