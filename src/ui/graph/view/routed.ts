import ELK, {
  type ElkExtendedEdge,
  type ElkNode,
  type LayoutOptions,
} from 'elkjs/lib/elk.bundled.js'
import type { GroupBox, Placed, RealmBox, RealmLayout } from './layout.js'

/**
 * The layout of the graph with the ELK layout engine. It places the cards and
 * the boxes, and it gives a route for each arrow.
 *
 * The engine does what the layout of `layout.ts` cannot: it puts the cards in
 * an order that makes the arrows cross as little as possible, also the
 * arrows between two boxes, and it routes each arrow around the cards, with
 * straight parts. An arrow leaves its card at the line of the call (a port
 * at a fixed place) and enters the target at its header.
 *
 * The rules of the boxes are the same as in `layout.ts`: a box for two or
 * more cards, a call goes right between boxes and down inside the innermost
 * box, and the parts with no call between them are packed to a shape near
 * `ASPECT`.
 */

export interface RoutedCard {
  id: string
  width: number
  height: number
  realm: string
  /** The group of the card in its realm. */
  group?: string
  /** The boxes inside the group, the outer one first. */
  path?: readonly (string | undefined)[]
}

export interface RoutedEdge {
  key: string
  from: string
  to: string
  /** Where the arrow leaves its card, from the top of the card. */
  fromY: number
  /** Where the arrow enters its target, from the top of the target. */
  toY: number
}

export interface Point {
  x: number
  y: number
}

export interface RoutedLayout<R extends string> extends RealmLayout<R> {
  /** Edge key → the points of the route of the arrow. */
  routes: Map<string, Point[]>
}

const ASPECT = 1.5
/** The part that holds the realms that an arrow connects. */
const MAIN = 'main'
const NESTED: LayoutOptions = { 'elk.hierarchyHandling': 'INCLUDE_CHILDREN' }
const PART_GAP = 120
const MARGIN = 32
const TITLE = { realm: 44, group: 36, inner: 30 }

const SHARED: LayoutOptions = {
  'elk.algorithm': 'layered',
  'elk.edgeRouting': 'ORTHOGONAL',
  'elk.layered.spacing.nodeNodeBetweenLayers': '90',
  'elk.spacing.nodeNode': '36',
  'elk.spacing.edgeNode': '24',
  'elk.spacing.edgeEdge': '14',
  'elk.layered.spacing.edgeNodeBetweenLayers': '24',
  'elk.layered.spacing.edgeEdgeBetweenLayers': '14',
  'elk.spacing.componentComponent': '70',
  'elk.aspectRatio': String(ASPECT),
  'elk.layered.thoroughness': '40',
  'elk.layered.crossingMinimization.greedySwitch.type': 'TWO_SIDED',
}

const pad = (top: number): string => `[top=${top + 28},left=32,bottom=32,right=32]`

interface Tree {
  node: ElkNode
  /** card id → the ids of the boxes around it, the outer one first. */
  parents: Map<string, string[]>
  boxes: Map<
    string,
    { kind: 'realm' | 'group' | 'inner'; name: string; level: number; realm: string }
  >
  /** The parts with no border that hold the cards with no arrow. */
  packs: Set<string>
}

/** The cards with the boxes of `path` around them, from `depth`. */
function nest(
  cards: readonly RoutedCard[],
  depth: number,
  prefix: string,
  realm: string,
  chain: string[],
  tree: Tree,
  ports: Map<string, ElkNode['ports']>,
  /** Each box of `path` is drawn, also for one card. */
  strict = false,
): ElkNode[] {
  return pack(nestBoxes(cards, depth, prefix, realm, chain, tree, ports, strict), prefix, tree)
}

/**
 * The cards and the boxes of one level that have no arrow go in one part
 * with no border, packed in rows to a shape near `ASPECT`. In the layers of
 * the engine they would be one long column.
 */
/** Each node of a column has the number of the column, so the engine keeps
 * the cards of a column in the layers of that column. */
function inColumn(nodes: readonly ElkNode[], column: number): void {
  for (const node of nodes) {
    node.layoutOptions = {
      ...node.layoutOptions,
      'elk.partitioning.partition': String(column),
    }
    inColumn(node.children ?? [], column)
  }
}

/** The node, or a card in it, has an arrow. */
function wired(node: ElkNode): boolean {
  return (node.ports ?? []).length > 0 || (node.children ?? []).some(wired)
}

function pack(nodes: ElkNode[], prefix: string, tree: Tree): ElkNode[] {
  const alone = nodes.filter((n) => !wired(n))
  if (alone.length < 2) return nodes
  const id = `${prefix}/alone`
  tree.packs.add(id)
  return [
    ...nodes.filter((n) => !alone.includes(n)),
    {
      id,
      children: alone,
      layoutOptions: {
        'elk.algorithm': 'rectpacking',
        'elk.aspectRatio': String(ASPECT),
        'elk.spacing.nodeNode': '28',
        'elk.padding': '[top=0,left=0,bottom=0,right=0]',
      },
    },
  ]
}

function nestBoxes(
  cards: readonly RoutedCard[],
  depth: number,
  prefix: string,
  realm: string,
  chain: string[],
  tree: Tree,
  ports: Map<string, ElkNode['ports']>,
  strict: boolean,
): ElkNode[] {
  const leaf = (c: RoutedCard): ElkNode => {
    tree.parents.set(c.id, chain)
    return {
      id: c.id,
      width: c.width,
      height: c.height,
      ports: ports.get(c.id) ?? [],
      layoutOptions: { 'elk.portConstraints': 'FIXED_POS' },
    }
  }
  if (!cards.some((c) => c.path !== undefined && depth < c.path.length)) return cards.map(leaf)
  const members = new Map<string, RoutedCard[]>()
  for (const c of cards) {
    const key = c.path?.[depth]
    if (key === undefined) continue
    const list = members.get(key)
    if (list) list.push(c)
    else members.set(key, [c])
  }
  // The boxes of the layout itself are only for two or more cards, and not
  // for all the cards of a level. A box that the caller asks for is drawn.
  const keys = [...members].filter(([, list]) => strict || list.length > 1).map(([key]) => key)
  const all = keys.length === 1 && members.get(keys[0] ?? '')?.length === cards.length
  if (keys.length === 0 || (all && !strict))
    return nestBoxes(cards, depth + 1, prefix, realm, chain, tree, ports, strict)
  const boxed = new Set<string>()
  const out: ElkNode[] = []
  for (const key of keys) {
    const own = members.get(key) ?? []
    for (const c of own) boxed.add(c.id)
    const id = `${prefix}/${depth}:${key}`
    tree.boxes.set(id, { kind: 'inner', name: key, level: depth + 1, realm })
    const children = nest(own, depth + 1, id, realm, [...chain, id], tree, ports, strict)
    out.push({
      id,
      children,
      layoutOptions: {
        ...SHARED,
        // Inside the innermost box, a call goes down.
        'elk.direction': children.every((n) => n.children === undefined || tree.packs.has(n.id))
          ? 'DOWN'
          : 'RIGHT',
        'elk.padding': pad(TITLE.inner),
      },
    })
  }
  for (const c of cards) if (!boxed.has(c.id)) out.push(leaf(c))
  return out
}

export async function layoutRouted<R extends string>(
  order: readonly R[],
  cards: readonly (RoutedCard & { realm: R })[],
  edges: readonly RoutedEdge[],
  /**
   * The realms are columns, from left to right in the order of `order`,
   * also a realm with no arrow, and each box of `path` is drawn. Without
   * it, the engine puts the realms in the order of the calls, packs the ones
   * with no arrow, and makes a box only for two or more cards.
   */
  columns = false,
): Promise<RoutedLayout<R>> {
  const ids = new Set(cards.map((c) => c.id))
  const used = edges.filter((e) => ids.has(e.from) && ids.has(e.to) && e.from !== e.to)
  const sizeOf = new Map(cards.map((c) => [c.id, c]))
  // A port at each place where an arrow leaves a card, and one where the
  // arrows enter it.
  const ports = new Map<string, NonNullable<ElkNode['ports']>>()
  const portOf = (card: string, side: 'out' | 'in', y: number): string => {
    const id = `${card}|${side}${Math.round(y)}`
    const list = ports.get(card) ?? []
    if (!list.some((p) => p.id === id)) {
      list.push({
        id,
        x: side === 'out' ? (sizeOf.get(card)?.width ?? 0) : 0,
        y,
        width: 1,
        height: 1,
        layoutOptions: { 'elk.port.side': side === 'out' ? 'EAST' : 'WEST' },
      })
      ports.set(card, list)
    }
    return id
  }
  const wires = used.map((e) => ({
    id: e.key,
    sources: [portOf(e.from, 'out', e.fromY)],
    targets: [portOf(e.to, 'in', e.toY)],
    from: e.from,
    to: e.to,
  }))

  const tree: Tree = {
    node: { id: 'root' },
    parents: new Map(),
    boxes: new Map(),
    packs: new Set(),
  }
  const realms: ElkNode[] = []
  for (const realm of order) {
    const own = cards.filter((c) => c.realm === realm)
    if (own.length === 0) continue
    const rid = `realm:${realm}`
    tree.boxes.set(rid, { kind: 'realm', name: realm, level: -1, realm })
    const names = [...new Set(own.map((c) => c.group).filter((g) => g !== undefined))]
    let children: ElkNode[]
    if (names.length < 2) {
      children = nest(own, 0, rid, realm, [rid], tree, ports, columns)
    } else {
      children = names.map((name) => {
        const gid = `${rid}/g:${name}`
        tree.boxes.set(gid, { kind: 'group', name, level: 0, realm })
        const inner = nest(
          own.filter((c) => c.group === name),
          0,
          gid,
          realm,
          [rid, gid],
          tree,
          ports,
          columns,
        )
        return {
          id: gid,
          children: inner,
          layoutOptions: {
            ...SHARED,
            'elk.direction': inner.every((n) => n.children === undefined || tree.packs.has(n.id))
              ? 'DOWN'
              : 'RIGHT',
            'elk.padding': pad(TITLE.group),
          },
        }
      })
    }
    if (columns) inColumn(children, realms.length)
    realms.push({
      id: rid,
      children,
      layoutOptions: {
        ...SHARED,
        ...(columns ? { 'elk.partitioning.partition': String(realms.length) } : {}),
        'elk.direction': children.every((n) => n.children === undefined || tree.packs.has(n.id))
          ? 'DOWN'
          : 'RIGHT',
        'elk.padding': pad(TITLE.realm),
      },
    })
  }

  // An edge is in the innermost box that has its two ends.
  const edgesOf = new Map<string, ElkExtendedEdge[]>()
  for (const w of wires) {
    const a = tree.parents.get(w.from) ?? []
    const b = tree.parents.get(w.to) ?? []
    let i = 0
    while (i < a.length && i < b.length && a[i] === b[i]) i++
    const home = i === 0 ? MAIN : (a[i - 1] ?? MAIN)
    const list = edgesOf.get(home) ?? []
    list.push({ id: w.id, sources: w.sources, targets: w.targets })
    edgesOf.set(home, list)
  }
  const attach = (node: ElkNode): void => {
    const own = edgesOf.get(node.id)
    if (own) node.edges = own
    for (const child of node.children ?? []) attach(child)
  }
  // The realms that an arrow connects are one part, in layers. Each realm
  // with no arrow is a part of its own.
  const layers: LayoutOptions = {
    ...SHARED,
    'elk.direction': 'RIGHT',
    'elk.hierarchyHandling': 'INCLUDE_CHILDREN',
    'elk.spacing.nodeNode': '120',
  }
  const main: ElkNode = {
    id: MAIN,
    children: columns ? realms : realms.filter(wired),
    layoutOptions: {
      ...layers,
      ...(columns ? { 'elk.partitioning.activate': 'true' } : {}),
      'elk.padding': '[top=0,left=0,bottom=0,right=0]',
    },
  }
  tree.packs.add(MAIN)
  const parts: ElkNode[] = [
    ...((main.children ?? []).length > 0 ? [main] : []),
    ...(columns ? [] : realms.filter((r) => !wired(r))).map((r) => ({
      ...r,
      layoutOptions: { ...r.layoutOptions, ...NESTED },
    })),
  ]
  for (const part of parts) attach(part)
  // Each part has its own run of the engine.
  const elk = new ELK()
  const done = await Promise.all(parts.map((part) => elk.layout(part)))

  const at = new Map<string, Placed>()
  const realmBoxes: RealmBox<R>[] = []
  const groups: GroupBox<R>[] = []
  const routes = new Map<string, Point[]>()
  const walk = (node: ElkNode, ox: number, oy: number): void => {
    const x = ox + (node.x ?? 0)
    const y = oy + (node.y ?? 0)
    const box = tree.boxes.get(node.id)
    const rect = { x, y, width: node.width ?? 0, height: node.height ?? 0 }
    if (box?.kind === 'realm') realmBoxes.push({ realm: box.realm as R, ...rect })
    else if (box) groups.push({ realm: box.realm as R, group: box.name, level: box.level, ...rect })
    else if (!tree.packs.has(node.id)) at.set(node.id, rect)
    // The points of an edge are from the corner of the box that has it.
    for (const edge of node.edges ?? []) {
      const points: Point[] = []
      for (const s of edge.sections ?? []) {
        for (const p of [s.startPoint, ...(s.bendPoints ?? []), s.endPoint]) {
          points.push({ x: p.x + x, y: p.y + y })
        }
      }
      if (points.length > 1) routes.set(edge.id, points)
    }
    for (const child of node.children ?? []) walk(child, x, y)
  }
  // The parts in rows, to a width that makes the shape near `ASPECT`.
  const area = done.reduce(
    (sum, p) => sum + ((p.width ?? 0) + PART_GAP) * ((p.height ?? 0) + PART_GAP),
    0,
  )
  const limit = Math.max(...done.map((p) => p.width ?? 0), Math.sqrt(area * ASPECT))
  let x = 0
  let y = 0
  let rowHeight = 0
  let width = 0
  for (const part of done) {
    const w = part.width ?? 0
    if (x > 0 && x + w > limit) {
      x = 0
      y += rowHeight + PART_GAP
      rowHeight = 0
    }
    walk(part, x + MARGIN, y + MARGIN)
    width = Math.max(width, x + w)
    rowHeight = Math.max(rowHeight, part.height ?? 0)
    x += w + PART_GAP
  }
  if (columns) {
    // The engine puts each column at the height of the cards that its arrows
    // connect it to. With few arrows between the columns, they make stairs:
    // a graph that is much taller than its tallest column. The columns move
    // up to one top line. An arrow in one column moves with it. An arrow
    // between two columns loses its route, and the view draws it as a curve.
    const realmOf = new Map(cards.map((c) => [c.id, c.realm]))
    const shift = new Map(realmBoxes.map((r) => [r.realm, MARGIN - r.y]))
    const up = (realm: R | undefined) => (realm === undefined ? 0 : (shift.get(realm) ?? 0))
    for (const [id, p] of at) at.set(id, { ...p, y: p.y + up(realmOf.get(id)) })
    for (const g of groups) g.y += up(g.realm)
    for (const r of realmBoxes) r.y += up(r.realm)
    for (const e of used) {
      const from = realmOf.get(e.from)
      const points = routes.get(e.key)
      if (points === undefined) continue
      if (from !== realmOf.get(e.to)) routes.delete(e.key)
      else
        routes.set(
          e.key,
          points.map((pt) => ({ x: pt.x, y: pt.y + up(from) })),
        )
    }
    return {
      at,
      realms: realmBoxes,
      groups,
      routes,
      width: width + MARGIN * 2,
      height: Math.max(0, ...realmBoxes.map((r) => r.height)) + MARGIN * 2,
    }
  }
  return {
    at,
    realms: realmBoxes,
    groups,
    routes,
    width: width + MARGIN * 2,
    height: y + rowHeight + MARGIN * 2,
  }
}
