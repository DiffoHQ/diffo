import type { CanvasCard } from '../model.js'
import type { RealmLayout } from './layout.js'

/** Below this zoom the code of a card is too small to read. */
export const FAR_ZOOM = 0.6

/** The names are in the page from this zoom, so they can fade in. */
export const FAR_MOUNT = FAR_ZOOM + 0.2

/** A card or a box, with the boxes and the cards in it. */
export interface FarItem {
  key: string
  name: string
  /** The added and the removed lines of the card, or of all the cards in the box. */
  add: number
  del: number
  /** The shape of the item: its name from far has the same shape. */
  shape: 'card' | 'box'
  card: boolean
  x: number
  y: number
  width: number
  height: number
  children: FarItem[]
}

export const NO_KEYS: Set<string> = new Set()

export const rectOf = (r: { x: number; y: number; width: number; height: number }) => ({
  x: r.x,
  y: r.y,
  width: r.width,
  height: r.height,
})

/**
 * From far, a card shows its name on a wash. When off, a card shows only its
 * small code, and only the boxes have names.
 */
export const FAR_CARD_NAMES = true

/** The smallest name from far that is easy to read, in pixels of the screen. */
export const FAR_MIN = 8

/**
 * The size of the name of an item from far, in pixels of the graph: the name
 * fills its card or its box. The size is a part of the item, so the name
 * grows and shrinks with the item when the zoom changes.
 */
export function farSize(item: FarItem): number {
  const letters = Math.max(1, item.name.length)
  if (item.card) return Math.min((item.width - 24) / (letters * 0.62), item.height * 0.45)
  // The name of a box can be on some lines: a long title in a narrow box is
  // then much larger than on one line. The size is the largest one of each
  // number of lines. A line is not full, because it breaks at a space.
  let best = 0
  for (let lines = 1; lines <= 6; lines++) {
    const perLine = Math.ceil(letters / lines) + (lines > 1 ? 4 : 0)
    const size = Math.min((item.width - 40) / (perLine * 0.6), (item.height * 0.8) / (lines * 1.2))
    best = Math.max(best, size)
  }
  return best
}

export interface FarNames {
  /** The keys of the closed boxes: each shows its name. */
  boxes: Set<string>
  /** The keys of the cards that are under no closed box. */
  cards: Set<string>
  /** For each card under a closed box: the key of that box. */
  under: Map<string, string>
  /** The boxes at this depth, and deeper, are closed. */
  level: number
  /** The depth at which no box is closed. */
  most: number
}

/**
 * The names to show at a zoom. The full view has one level: the boxes at
 * that depth are closed, and each has its name in its middle, in place of
 * what is in it. The boxes around them are open, and their cards have names.
 * By the zoom, the level is 1 (the outer boxes are open, and show their
 * groups and their loose cards) when each name is large enough to read, and
 * 0 (the outer boxes are closed) if not. The level is not less than `least`:
 * a click in a box opens the box. At each level, a box that is larger than
 * the canvas is open too, so a zoom into a box opens it, one box at a time.
 */
export function farLabels(
  roots: readonly FarItem[],
  k: number,
  least: number,
  frame: { width: number; height: number },
): FarNames {
  // A box that is larger than the canvas is open: the view is in it.
  const large = (item: FarItem) => item.width * k > frame.width || item.height * k > frame.height
  const deep = (item: FarItem): number =>
    item.card ? 0 : 1 + Math.max(0, ...item.children.map(deep))
  const most = Math.max(0, ...roots.map(deep))
  const floor = Math.min(least, most)
  // From far, a box in a box is closed: the name of a group is before the
  // names of its cards. Only a click opens a deeper level.
  const top = Math.max(floor, Math.min(most, 1))
  for (let level = top; level >= floor; level--) {
    const boxes = new Set<string>()
    const cards = new Set<string>()
    const under = new Map<string, string>()
    const hide = (item: FarItem, box: string): void => {
      if (item.card) under.set(item.key, box)
      for (const child of item.children) hide(child, box)
    }
    let clear = true
    const visit = (item: FarItem, depth: number): void => {
      if (item.card || (depth >= level && !large(item))) {
        if (item.card) cards.add(item.key)
        if (item.name === '') return
        if ((FAR_CARD_NAMES || !item.card) && farSize(item) * k < FAR_MIN) clear = false
        if (!item.card) {
          boxes.add(item.key)
          hide(item, item.key)
        }
        return
      }
      for (const child of item.children) visit(child, depth + 1)
    }
    for (const root of roots) visit(root, 0)
    if (clear || level === floor) return { boxes, cards, under, level, most }
  }
  return { boxes: new Set(), cards: new Set(), under: new Map(), level: top, most }
}

/**
 * The boxes and the cards of a layout as a tree: each item is in the
 * smallest box that holds it. The names from far, the breadcrumb and the
 * order of the keys read this tree.
 */
export function farTree(layout: RealmLayout<string>, cards: readonly CanvasCard[]): FarItem[] {
  type Item = FarItem & { area: number }
  const items: Item[] = []
  const add = (item: Omit<FarItem, 'add' | 'del'> & { add?: number; del?: number }) =>
    items.push({ add: 0, del: 0, ...item, area: item.width * item.height })
  layout.groups.forEach((g, i) => {
    add({
      key: `group:${i}`,
      shape: 'box',
      name: g.group,
      card: false,
      children: [],
      ...rectOf(g),
    })
  })
  for (const c of cards) {
    const p = layout.at.get(c.id)
    if (p)
      add({
        key: `card:${c.id}`,
        name: c.title,
        add: c.lines.filter((l) => l.kind === 'add').length,
        del: c.lines.filter((l) => l.kind === 'del').length,
        shape: 'card',
        card: true,
        children: [],
        ...rectOf(p),
      })
  }
  const holds = (a: Item, b: Item) =>
    !a.card &&
    a !== b &&
    a.area > b.area &&
    a.x <= b.x + 1 &&
    a.y <= b.y + 1 &&
    a.x + a.width >= b.x + b.width - 1 &&
    a.y + a.height >= b.y + b.height - 1
  const roots: FarItem[] = []
  for (const item of items) {
    let parent: Item | undefined
    for (const other of items) {
      if (holds(other, item) && (!parent || other.area < parent.area)) parent = other
    }
    if (parent) parent.children.push(item)
    else roots.push(item)
  }
  // The lines of a box are the lines of all the cards in it.
  const sum = (item: FarItem): void => {
    for (const child of item.children) {
      sum(child)
      item.add += child.add
      item.del += child.del
    }
  }
  for (const root of roots) sum(root)
  return roots
}

/** Each item of the tree by its key, with its depth. */
export function farByKey(roots: readonly FarItem[]): Map<string, FarItem & { depth: number }> {
  const all = new Map<string, FarItem & { depth: number }>()
  const walk = (item: FarItem, depth: number) => {
    all.set(item.key, { ...item, depth })
    for (const child of item.children) walk(child, depth + 1)
  }
  for (const root of roots) walk(root, 0)
  return all
}

/**
 * One order of all the cards, for the Up and the Down keys. The cards of
 * `order` are first, in that order. Then the others: card by card in a box,
 * box by box in the box around it, each in the order of its place from the
 * top.
 */
export function readingOrder(roots: readonly FarItem[], order: readonly string[]): string[] {
  const byPlace = (a: FarItem, b: FarItem) => a.y - b.y || a.x - b.x
  const cardsOf = (item: FarItem): string[] =>
    item.card ? [item.key.slice('card:'.length)] : [...item.children].sort(byPlace).flatMap(cardsOf)
  const all = [...roots].sort(byPlace).flatMap(cardsOf)
  const there = new Set(all)
  const first = order.filter((id) => there.has(id))
  const named = new Set(first)
  return [...first, ...all.filter((id) => !named.has(id))]
}
