import { describe, expect, it } from 'vitest'
import { resizeInPlace } from './resize.js'

// One realm with a box of two cards (a above b), a card c below the box, and
// a card d at the side of the box.
const layout = () => ({
  at: new Map([
    ['a', { x: 20, y: 40, width: 100, height: 50 }],
    ['b', { x: 20, y: 110, width: 100, height: 50 }],
    ['c', { x: 10, y: 200, width: 120, height: 40 }],
    ['d', { x: 200, y: 30, width: 100, height: 60 }],
  ]),
  realms: [{ realm: 'logic', x: 0, y: 0, width: 320, height: 260 }],
  groups: [{ realm: 'logic', group: 'box', level: 1, x: 10, y: 20, width: 120, height: 160 }],
  routes: new Map([
    [
      'a>b',
      [
        { x: 20, y: 60 },
        { x: 20, y: 120 },
      ],
    ],
    [
      'c>d',
      [
        { x: 130, y: 220 },
        { x: 200, y: 60 },
      ],
    ],
    [
      'b>c',
      [
        { x: 20, y: 150 },
        { x: 10, y: 220 },
      ],
    ],
  ]),
  width: 340,
  height: 292,
})
const edges = [
  { key: 'a>b', from: 'a', to: 'b' },
  { key: 'c>d', from: 'c', to: 'd' },
  { key: 'b>c', from: 'b', to: 'c' },
]

describe('resizeInPlace', () => {
  it('moves what is below a card that grows, and keeps the rest', () => {
    const next = resizeInPlace(layout(), new Map([['a', 80]]), edges, 32)
    // The card keeps its place and grows down.
    expect(next.at.get('a')).toEqual({ x: 20, y: 40, width: 100, height: 80 })
    // The card below it in the box moves by the growth.
    expect(next.at.get('b')?.y).toBe(140)
    // The box grows, and the card below the box moves.
    expect(next.groups[0]).toMatchObject({ y: 20, height: 190 })
    expect(next.at.get('c')?.y).toBe(230)
    // The card at the side stays.
    expect(next.at.get('d')?.y).toBe(30)
    expect(next.realms[0]).toMatchObject({ y: 0, height: 290 })
    expect(next.height).toBe(322)
  })

  it('pulls the cards up again when the card gets smaller', () => {
    const grown = resizeInPlace(layout(), new Map([['a', 80]]), edges, 32)
    const back = resizeInPlace(grown, new Map([['a', 50]]), edges, 32)
    expect(back.at).toEqual(layout().at)
    expect(back.groups[0]).toMatchObject({ y: 20, height: 160 })
    expect(back.height).toBe(292)
  })

  it('keeps a route only when its two cards moved by the same amount', () => {
    const next = resizeInPlace(layout(), new Map([['a', 80]]), edges, 32)
    // An end of the arrow has a new height.
    expect(next.routes?.has('a>b')).toBe(false)
    // One end moved, the other did not.
    expect(next.routes?.has('c>d')).toBe(false)
    // The two ends moved by 30.
    expect(next.routes?.get('b>c')).toEqual([
      { x: 20, y: 180 },
      { x: 10, y: 250 },
    ])
  })
})
