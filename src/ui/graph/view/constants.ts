import type { ReviewThread } from '../../../shared/review.js'
import type { Hunk } from '../../../shared/types.js'

export const CARD_WIDTH = 560

/** A card is as wide as its longest line, to this limit. A longer line can
 * be read with a scroll in the selected card. */
export const MAX_CARD_WIDTH = 1280

/** The line number, the sign and the border of a card, beside the text. */
export const LINE_GUTTER = 140

/** Space in the header for the file name and the marks, beside the name. */
export const HEAD_EXTRA = 260

export const NO_THREADS: ReviewThread[] = []

export const NO_HUNKS: Hunk[] = []

export const OVERLAY_KEY = 'diffo.graph.overlay'

export const HEADER = 34

/** Lines a card shows before it folds the others. */
export const FOLD = 40

/** Above this size the head text of a file is not read. */
export const MAX_FILE_BYTES = 1_500_000

// Small, so a wide graph fits in the card of a graph.
export const MIN_ZOOM = 0.03

export const MAX_ZOOM = 2

/** The time of the move of the view to a fit, in milliseconds. */
export const GLIDE_MS = 220

/** The cards with a new height that keep the layout: more than this is a new layout. */
export const RESIZE_MOST = 3

/** The space around the graph, as the layout makes it. */
export const LAYOUT_MARGIN = 32

/** The color of an arrow, as `r, g, b`. */
export const ARROW_RGB = '255, 55, 95'

export interface View {
  x: number
  y: number
  k: number
}
