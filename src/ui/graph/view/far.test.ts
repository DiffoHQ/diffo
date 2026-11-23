import { describe, expect, it } from 'vitest'
import type { CanvasCard } from '../model.js'
import { type FarItem, farByKey, farLabels, farTree, readingOrder } from './far.js'
import type { RealmLayout } from './layout.js'

const card = (id: string, title: string, add = 1): CanvasCard => ({
  id,
  path: `src/${id}.ts`,
  title,
  lines: Array.from({ length: add }, (_, i) => ({
    kind: 'add' as const,
    oldNo: null,
    newNo: i + 1,
    text: '',
  })),
  hunkIds: [`${id}:h`],
  box: [],
})

// The box `Server` holds the box `IO` (the cards a above b) and the card c.
// The card d is in no box.
const cards = [
  card('a', 'read()', 2),
  card('b', 'write()', 3),
  card('c', 'save()'),
  card('d', 'main()'),
]
const layout: RealmLayout<string> = {
  at: new Map([
    ['a', { x: 40, y: 80, width: 200, height: 100 }],
    ['b', { x: 40, y: 220, width: 200, height: 100 }],
    ['c', { x: 320, y: 80, width: 200, height: 100 }],
    ['d', { x: 640, y: 80, width: 200, height: 100 }],
  ]),
  realms: [{ realm: '', x: 0, y: 0, width: 900, height: 400 }],
  groups: [
    { realm: '', group: 'Server', level: 1, x: 10, y: 20, width: 540, height: 340 },
    { realm: '', group: 'IO', level: 2, x: 20, y: 40, width: 240, height: 300 },
  ],
  width: 900,
  height: 400,
}
const tree = () => farTree(layout, cards)
const keys = (items: readonly FarItem[]) => items.map((i) => i.key).sort()

describe('the tree of the boxes and the cards', () => {
  it('puts each item in the smallest box that holds it', () => {
    const roots = tree()
    expect(keys(roots)).toEqual(['card:d', 'group:0'])
    const server = roots.find((r) => r.key === 'group:0')
    expect(server?.name).toBe('Server')
    expect(keys(server?.children ?? [])).toEqual(['card:c', 'group:1'])
    const io = server?.children.find((c) => c.key === 'group:1')
    expect(keys(io?.children ?? [])).toEqual(['card:a', 'card:b'])
  })

  it('gives a box the lines of all the cards in it', () => {
    const all = farByKey(tree())
    expect(all.get('group:0')?.add).toBe(6)
    expect(all.get('group:1')?.add).toBe(5)
    expect(all.get('card:a')).toMatchObject({ name: 'read()', depth: 2 })
    expect(all.get('group:0')?.depth).toBe(0)
  })
})

describe('the order of the Up and the Down keys', () => {
  it('goes card by card in a box, then to the next box, by place', () => {
    expect(readingOrder(tree(), [])).toEqual(['a', 'b', 'c', 'd'])
  })

  it('puts the cards of the given order first, then the others', () => {
    expect(readingOrder(tree(), ['d', 'b', 'gone'])).toEqual(['d', 'b', 'a', 'c'])
  })
})

describe('the names from far', () => {
  const frame = { width: 2000, height: 2000 }

  it('opens the outer boxes when each name is large enough to read', () => {
    const names = farLabels(tree(), 0.5, 0, frame)
    expect(names.level).toBe(1)
    expect([...names.boxes]).toEqual(['group:1'])
    expect([...names.cards].sort()).toEqual(['card:c', 'card:d'])
    expect(names.under.get('card:a')).toBe('group:1')
  })

  it('closes the outer boxes when a name is too small', () => {
    const names = farLabels(tree(), 0.02, 0, frame)
    expect(names.level).toBe(0)
    expect([...names.boxes]).toEqual(['group:0'])
    expect([...names.cards]).toEqual(['card:d'])
  })

  it('does not close a level that a click opened', () => {
    const names = farLabels(tree(), 0.02, 2, frame)
    expect(names.level).toBe(2)
    expect(names.boxes.size).toBe(0)
    expect(names.cards.size).toBe(4)
  })

  it('opens a box that is larger than the canvas', () => {
    const names = farLabels(tree(), 1, 0, { width: 300, height: 300 })
    // `Server` is 540 wide: the view is in it, so the box in it shows.
    expect(names.boxes.has('group:0')).toBe(false)
  })
})
