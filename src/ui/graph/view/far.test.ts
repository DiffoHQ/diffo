import { describe, expect, it } from 'vitest'
import type { GraphNode } from '../basic/build.js'
import { plainRepo } from '../repo/plain.js'
import { type FarItem, farByKey, farLabels, farTree, readingOrder } from './far.js'
import type { RealmLayout } from './layout.js'

const node = (id: string, path: string, name: string, add = 1): GraphNode => ({
  id,
  path,
  name,
  lines: Array.from({ length: add }, (_, i) => ({
    kind: 'add' as const,
    oldNo: null,
    newNo: i + 1,
    text: '',
  })),
  hunkIds: [`${id}:h`],
  realm: 'logic',
  group: '',
})

// The logic has a box `ui` with the cards a (above) and b, and a loose card
// c. The support code has the card d.
const nodes = [
  node('a', 'ui/a.ts', 'A.one', 2),
  node('b', 'ui/b.ts', 'A.two', 3),
  node('c', 'core/c.ts', 'run'),
  { ...node('d', 'x.json', 'd'), realm: 'boilerplate' as const },
]
const layout: RealmLayout<string> = {
  at: new Map([
    ['a', { x: 40, y: 80, width: 200, height: 100 }],
    ['b', { x: 40, y: 220, width: 200, height: 100 }],
    ['c', { x: 320, y: 80, width: 200, height: 100 }],
    ['d', { x: 640, y: 80, width: 200, height: 100 }],
  ]),
  realms: [
    { realm: 'boilerplate', x: 600, y: 0, width: 280, height: 400 },
    { realm: 'logic', x: 0, y: 0, width: 560, height: 400 },
  ],
  groups: [{ realm: 'logic', group: 'ui', level: 1, x: 20, y: 40, width: 240, height: 300 }],
  width: 900,
  height: 400,
}
const tree = () => farTree(layout, nodes, false, plainRepo)
const keys = (items: readonly FarItem[]) => items.map((i) => i.key).sort()

describe('the tree of the boxes and the cards', () => {
  it('puts each item in the smallest box that holds it', () => {
    const roots = tree()
    expect(keys(roots)).toEqual(['realm:0', 'realm:1'])
    const logic = roots.find((r) => r.realm === 'logic')
    expect(keys(logic?.children ?? [])).toEqual(['card:c', 'group:0'])
    const ui = logic?.children.find((c) => c.key === 'group:0')
    expect(keys(ui?.children ?? [])).toEqual(['card:a', 'card:b'])
  })

  it('gives a box the lines of all the cards in it', () => {
    const logic = tree().find((r) => r.realm === 'logic')
    expect(logic?.add).toBe(6)
    expect(logic?.children.find((c) => c.key === 'group:0')?.add).toBe(5)
  })

  it('names a loose card of an outer box by its group', () => {
    const all = farByKey(tree())
    // `c` has no box: from far it has the name of its folder, as the box
    // next to it has. A card in a box has the name of its function.
    expect(all.get('card:c')?.name).toBe('core')
    expect(all.get('card:a')?.name).toBe('A.one')
    expect(all.get('card:a')?.depth).toBe(2)
    expect(all.get('realm:1')?.depth).toBe(0)
  })
})

describe('the order of the Up and the Down keys', () => {
  it('goes card by card in a box, then to the next box, the logic first', () => {
    expect(readingOrder(tree(), [])).toEqual(['a', 'b', 'c', 'd'])
  })

  it('puts the cards of the order of the agent first in their outer box', () => {
    expect(readingOrder(tree(), ['c', 'b'])).toEqual(['c', 'b', 'a', 'd'])
  })
})

describe('the names from far', () => {
  const frame = { width: 2000, height: 2000 }

  it('opens the outer boxes when each name is large enough to read', () => {
    const names = farLabels(tree(), 0.5, 0, frame)
    expect(names.level).toBe(1)
    expect([...names.boxes]).toEqual(['group:0'])
    expect([...names.cards].sort()).toEqual(['card:c', 'card:d'])
    expect(names.under.get('card:a')).toBe('group:0')
  })

  it('closes the outer boxes when a name is too small', () => {
    const names = farLabels(tree(), 0.02, 0, frame)
    expect(names.level).toBe(0)
    expect([...names.boxes].sort()).toEqual(['realm:0', 'realm:1'])
    expect(names.cards.size).toBe(0)
  })

  it('does not close a level that a click opened', () => {
    const names = farLabels(tree(), 0.02, 2, frame)
    expect(names.level).toBe(2)
    expect(names.boxes.size).toBe(0)
    expect(names.cards.size).toBe(4)
  })

  it('opens a box that is larger than the canvas', () => {
    const names = farLabels(tree(), 1, 1, { width: 200, height: 200 })
    // The box `ui` is 240 wide: the view is in it, so its cards show.
    expect(names.boxes.has('group:0')).toBe(false)
    expect(names.cards.has('card:a')).toBe(true)
  })
})
