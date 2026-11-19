import type { Placed, RealmLayout } from './layout.js'
import type { Point } from './routed.js'

/**
 * A card got a new height after the layout (the reviewer shows more lines
 * of it). The layout engine would find a new place for each card, and the
 * card would jump. This function keeps each card where it is: the card
 * grows down, and what is below it in its box moves down by the same
 * amount. A box grows with what is in it, and then it moves what is below
 * it. A card that gets smaller pulls them up again.
 */

type Resized<R extends string> = RealmLayout<R> & { routes?: Map<string, Point[]> }

interface Item {
  /** The id of a card, or null for a box. */
  card: string | null
  rect: Placed
  /** The place before the change. */
  was: Placed
  children: Item[]
  /** How far the item moved down. */
  moved: number
}

const holds = (a: Placed, b: Placed) =>
  a.x <= b.x + 1 &&
  a.y <= b.y + 1 &&
  a.x + a.width >= b.x + b.width - 1 &&
  a.y + a.height >= b.y + b.height - 1

const sideBySide = (a: Placed, b: Placed) => a.x < b.x + b.width && b.x < a.x + a.width

/** Moves an item and all that is in it. */
function moveDown(item: Item, by: number): void {
  if (by === 0) return
  item.rect.y += by
  item.moved += by
  for (const child of item.children) moveDown(child, by)
}

/**
 * Gives each child its new height, then moves each child by what the
 * children above it need.
 */
function settle(children: Item[], heights: ReadonlyMap<string, number>): void {
  const order = [...children].sort((a, b) => a.was.y - b.was.y)
  const done: Item[] = []
  for (const child of order) {
    grow(child, heights)
    // The gap to each item that was above it, in its column, stays.
    let push: number | null = null
    for (const above of done) {
      if (!sideBySide(above.was, child.was)) continue
      if (above.was.y + above.was.height > child.was.y + 1) continue
      const need = above.moved + (above.rect.height - above.was.height)
      push = push === null ? need : Math.max(push, need)
    }
    moveDown(child, push ?? 0)
    done.push(child)
  }
}

/** Gives an item its new height: a card from `heights`, a box from what is in it. */
function grow(item: Item, heights: ReadonlyMap<string, number>): void {
  if (item.card !== null) {
    item.rect.height = heights.get(item.card) ?? item.rect.height
    return
  }
  if (item.children.length === 0) return
  const bottom = (list: Item[], of: (i: Item) => Placed) =>
    Math.max(...list.map((i) => of(i).y + of(i).height))
  // The space below the lowest child stays.
  const space = item.was.y + item.was.height - bottom(item.children, (i) => i.was)
  settle(item.children, heights)
  item.rect.height = bottom(item.children, (i) => i.rect) + space - item.rect.y
}

/**
 * The layout with the new heights of some cards, and each card in its
 * place. `heights` has the cards with a new height only.
 */
export function resizeInPlace<R extends string>(
  layout: Resized<R>,
  heights: ReadonlyMap<string, number>,
  edges: readonly { key: string; from: string; to: string }[],
  margin: number,
): Resized<R> {
  const make = (card: string | null, rect: Placed): Item => ({
    card,
    rect: { ...rect },
    was: { ...rect },
    children: [],
    moved: 0,
  })
  const realms = layout.realms.map((r) => ({ box: r, item: make(null, r) }))
  const groups = layout.groups.map((g) => ({ box: g, item: make(null, g) }))
  const cards = [...layout.at].map(([id, p]) => ({ id, item: make(id, p) }))
  const boxes = [...realms, ...groups].map((b) => b.item)
  const all = [...boxes, ...cards.map((c) => c.item)]
  // Each item is in the smallest box that holds it.
  const roots: Item[] = []
  const area = (i: Item) => i.was.width * i.was.height
  for (const item of all) {
    let parent: Item | undefined
    for (const box of boxes) {
      if (box === item || area(box) <= area(item) || !holds(box.was, item.was)) continue
      if (!parent || area(box) < area(parent)) parent = box
    }
    if (parent) parent.children.push(item)
    else roots.push(item)
  }
  settle(roots, heights)

  const at = new Map(cards.map((c) => [c.id, c.item.rect]))
  const movedOf = new Map(cards.map((c) => [c.id, c.item.moved]))
  // An arrow keeps its route when its two cards moved by the same amount
  // and have the same heights as before. If not, the view draws a curve.
  let routes: Map<string, Point[]> | undefined
  if (layout.routes) {
    routes = new Map()
    for (const { key, from, to } of edges) {
      const points = layout.routes.get(key)
      if (points === undefined || heights.has(from) || heights.has(to)) continue
      const by = movedOf.get(from)
      if (by === undefined || by !== movedOf.get(to)) continue
      routes.set(key, by === 0 ? points : points.map((p) => ({ x: p.x, y: p.y + by })))
    }
  }
  const lowest = Math.max(0, ...all.map((i) => i.rect.y + i.rect.height))
  return {
    ...layout,
    at,
    realms: realms.map((r) => ({ ...r.box, ...r.item.rect })),
    groups: groups.map((g) => ({ ...g.box, ...g.item.rect })),
    ...(routes ? { routes } : {}),
    height: lowest + margin,
  }
}
