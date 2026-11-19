import type { GraphNode, Realm } from '../basic/build.js'
import type { GraphRepo } from '../repo/repo.js'
import { REALM_NAME } from './constants.js'
import type { RealmLayout } from './layout.js'
import { boxName, nodeTitle } from './names.js'

/** Below this zoom the code of a card is too small to read. */
export const FAR_ZOOM = 0.6

/** The names are in the page from this zoom, so they can fade in. */
export const FAR_MOUNT = FAR_ZOOM + 0.2

/** A card or a box, with the boxes and the cards in it. */
export interface FarItem {
  key: string
  name: string
  /** A card: its group in the repo, when it has one. */
  group?: string
  /** The added and the removed lines of the card, or of all the cards in the box. */
  add: number
  del: number
  /** A box of the agent: its step, and its title when it is not the column. */
  step?: string
  box?: string
  /** The realm of a box of Diffo: its class gives the color. */
  realm?: string
  /** The shape of the item: its name from far has the same shape. */
  shape: 'card' | 'realm' | 'entity' | 'inner' | 'box'
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
 * The name of a card from far: short, so it is large. A function has no
 * class in its name, and the top level of a file is the name of the file.
 */
export function farCardName(node: GraphNode): string {
  const name = nodeTitle(node).replace(/^\(top level\) /, '')
  return name.split('::').pop() || name
}

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
 * smallest box that holds it. The names from far, the outline, the
 * breadcrumb and the order of the keys read this tree.
 */
export function farTree(
  layout: RealmLayout<string>,
  nodes: readonly GraphNode[],
  /** The outer boxes are the steps of an outline, not the realms. */
  grouped: boolean,
  repo: GraphRepo,
): FarItem[] {
  type Item = FarItem & { area: number }
  const items: Item[] = []
  const add = (item: Omit<FarItem, 'add' | 'del'> & { add?: number; del?: number }) =>
    items.push({ add: 0, del: 0, ...item, area: item.width * item.height })
  layout.realms.forEach((r, i) => {
    add({
      key: `realm:${i}`,
      shape: 'realm',
      // A box with no name gets no name from far.
      name: (grouped ? r.realm : REALM_NAME[r.realm as Realm]) ?? '',
      step: grouped ? r.realm : undefined,
      realm: grouped ? undefined : r.realm,
      card: false,
      children: [],
      ...rectOf(r),
    })
  })
  layout.groups.forEach((g, i) => {
    add({
      key: `group:${i}`,
      shape: g.level === 0 ? 'entity' : grouped ? 'box' : 'inner',
      name: boxName(g.group, g.level, grouped),
      step: grouped ? g.realm : undefined,
      box: grouped ? g.group : undefined,
      realm: grouped ? undefined : g.realm,
      card: false,
      children: [],
      ...rectOf(g),
    })
  })
  for (const n of nodes) {
    const p = layout.at.get(n.id)
    if (p)
      add({
        key: `card:${n.id}`,
        name: farCardName(n),
        add: n.lines.filter((l) => l.kind === 'add').length,
        // A function that the change removes has only removed lines.
        del: n.removed
          ? Math.max(1, n.lines.length)
          : n.lines.filter((l) => l.kind === 'del').length,
        // The group of the card in the repo. One card makes no box, so
        // the card stands for its group.
        group:
          !grouped && n.realm !== 'tests' && !n.between
            ? repo.boxes(n.path, n.cls)?.[0]
            : undefined,
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
    // A card of a group that has no box, directly in an outer box: from
    // far it has the name of its group, as the boxes next to it have. So
    // an open outer box shows groups only, with or without a box.
    if (item.card && item.group !== undefined && parent?.key.startsWith('realm:')) {
      item.name = boxName(item.group, 1, false)
    }
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
 * One order of all the cards of the change, for the Up and the Down keys:
 * card by card in a group, group by group in the group around it, then the
 * next outer group. In a box, the cards and the boxes are in the order of
 * their places, from the top. With an order of the agent in a step, the
 * cards of that order are first in the step.
 */
export function readingOrder(roots: readonly FarItem[], agentOrder: readonly string[]): string[] {
  const byPlace = (a: FarItem, b: FarItem) => a.y - b.y || a.x - b.x
  const cardsOf = (item: FarItem): string[] =>
    item.card ? [item.key.slice('card:'.length)] : [...item.children].sort(byPlace).flatMap(cardsOf)
  // The outer groups: the steps from the left, or the logic, then the
  // support code, then the tests.
  const rank = (item: FarItem) =>
    item.step !== undefined ? item.x : item.realm === 'logic' ? 0 : item.realm === 'tests' ? 2 : 1
  const first = new Map(agentOrder.map((id, i) => [id, i]))
  return [...roots]
    .sort((a, b) => rank(a) - rank(b) || byPlace(a, b))
    .flatMap((root) => {
      const cards = cardsOf(root)
      const named = cards
        .filter((id) => first.has(id))
        .sort((a, b) => (first.get(a) ?? 0) - (first.get(b) ?? 0))
      return [...named, ...cards.filter((id) => !first.has(id))]
    })
}
