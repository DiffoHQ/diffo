import type { ReviewThread } from '../../../shared/review.js'
import type { Hunk } from '../../../shared/types.js'
import type { GraphStep } from '../../components/ReadingPane.js'
import type { Realm } from '../basic/build.js'
import type { EdgeKind } from '../repo/repo.js'

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

export const NO_STEPS: readonly GraphStep[] = []

/** The group of the cards that no step holds. */
export const OTHER_STEP: GraphStep = {
  key: '',
  number: null,
  title: 'In no step',
  mechanical: false,
  parts: [],
}

export const REPO_KEY = 'diffo.graph.repo'

export const OVERLAY_KEY = 'diffo.graph.overlay'

export const HEADER = 34

/** Lines a card shows before it folds the others. */
export const FOLD = 40

/** Above this size the head text of a file is not read. */
export const MAX_FILE_BYTES = 1_500_000

// Small, so a wide graph fits in a narrow canvas (the side by side layout).
export const MIN_ZOOM = 0.03

/** The time of the move of the view to a fit, in milliseconds. */
export const GLIDE_MS = 220

/** The cards with a new height that keep the layout: more than this is a new layout. */
export const RESIZE_MOST = 3

/** The space around the graph, as the layouts make it. */
export const LAYOUT_MARGIN = 32

export const REALMS: readonly Realm[] = ['tests', 'logic', 'boilerplate']

/** The realms that have a switch in the graph. */
export const GROUP_REALMS: readonly Realm[] = ['logic', 'boilerplate']

/** The name of the box of a contract between two groups. */
export const contractGroup = (a: string, b: string) => `${a} ↔ ${b}`

/** The kind of arrow that the language steps add. A repo adds more. */
export const CALLBACK: EdgeKind = {
  id: 'callback',
  name: 'Callback',
  tip: 'A callback or an object that a function gives to a call, which runs it. With the rules of a repository: from the function that runs a callback to the function that was bound',
  rgb: '48, 176, 199',
}

export const REALM_NAME: Record<Realm, string> = {
  tests: 'Tests',
  logic: 'Logic',
  boilerplate: 'Support',
}

export const MAX_ZOOM = 2

export interface View {
  x: number
  y: number
  k: number
}
