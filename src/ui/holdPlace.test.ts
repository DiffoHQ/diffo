// @vitest-environment jsdom
import { renderHook } from '@testing-library/react'
import { useLayoutEffect } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import { keepPlace, placeIn, useHeldPlace } from './holdPlace.js'

/**
 * jsdom lays nothing out, so the page here is a list of rows with tops the
 * test sets: a pane 0–600 on screen, scrolled by `scrollTop`, and
 * `elementFromPoint` answering from those tops.
 */
function page(rows: { cls?: string; top: number; height: number }[], scrollTop: number) {
  const pane = document.createElement('div')
  document.body.append(pane)
  pane.getBoundingClientRect = () => ({ top: 0, bottom: 600, left: 0, width: 800 }) as DOMRect
  pane.scrollTop = scrollTop
  const nodes = rows.map((row) => {
    const node = document.createElement('div')
    if (row.cls) node.className = row.cls
    pane.append(node)
    node.getBoundingClientRect = () =>
      ({ top: row.top, bottom: row.top + row.height, height: row.height }) as DOMRect
    return node
  })
  document.elementFromPoint = (_x: number, y: number) =>
    // The last match wins, as the stuck header paints over the row under it.
    nodes.findLast((_n, i) => y >= rows[i]!.top && y < rows[i]!.top + rows[i]!.height) ?? pane
  return { pane, nodes, rows }
}

afterEach(() => {
  document.body.replaceChildren()
  // @ts-expect-error jsdom has none of its own; leave it as found.
  delete document.elementFromPoint
})

describe('placeIn', () => {
  it('takes the first row under the top of the pane', () => {
    const { pane, nodes } = page(
      [
        { top: -40, height: 20 },
        { top: -5, height: 20 },
        { top: 15, height: 20 },
      ],
      900,
    )
    expect(placeIn(pane)).toEqual({ node: nodes[1], top: -5, scrollTop: 900 })
  })

  it('looks under the stuck file header, never at it', () => {
    const { pane, nodes } = page(
      [
        { top: 30, height: 20 },
        { top: 50, height: 20 },
        { cls: 'file-header', top: 0, height: 42 },
      ],
      900,
    )
    expect(placeIn(pane)?.node).toBe(nodes[0])
  })

  it('skips a block that starts far above the view: it can grow there unseen', () => {
    const { pane, nodes } = page(
      [
        { top: -400, height: 430 },
        { top: 30, height: 60 },
      ],
      900,
    )
    expect(placeIn(pane)?.node).toBe(nodes[1])
  })

  it('holds nothing at the very top: what arrives above is what comes next', () => {
    const { pane } = page([{ top: 0, height: 20 }], 0)
    expect(placeIn(pane)).toBeNull()
  })
})

describe('keepPlace', () => {
  it('scrolls by what the row moved, so it sits where it did', () => {
    const { pane, nodes, rows } = page([{ top: 10, height: 20 }], 900)
    const held = placeIn(pane)!
    rows[0]!.top = 255 // a thread card landed above
    keepPlace(pane, held)
    expect(pane.scrollTop).toBe(1145)
    expect(held.node).toBe(nodes[0])
  })

  it("leaves the reader's own scroll alone", () => {
    const { pane, rows } = page([{ top: 10, height: 20 }], 900)
    const held = placeIn(pane)!
    // They scrolled 100 down meanwhile: the row is 100 higher, and nothing grew.
    pane.scrollTop = 1000
    rows[0]!.top = -90
    keepPlace(pane, held)
    expect(pane.scrollTop).toBe(1000)
  })

  it('does nothing for a row that left the page', () => {
    const { pane, nodes, rows } = page([{ top: 10, height: 20 }], 900)
    const held = placeIn(pane)!
    nodes[0]!.remove()
    rows[0]!.top = 255
    keepPlace(pane, held)
    expect(pane.scrollTop).toBe(900)
  })
})

describe('useHeldPlace', () => {
  it('holds the place across a commit that changed the key, and only then', () => {
    const { pane, rows } = page([{ top: 10, height: 20 }], 900)
    const ref = { current: pane }
    // The row moves in a layout effect declared before the hook's own: after
    // the hook read the place during render, before it puts it back. That is
    // when a thread card lands in the real page.
    const { rerender } = renderHook(
      ({ k, top }) => {
        useLayoutEffect(() => {
          rows[0]!.top = top
        })
        useHeldPlace(ref, k)
      },
      { initialProps: { k: 1, top: 10 } },
    )
    // A new key: read at 10, moved to 255, scrolled by the 245 it moved.
    rerender({ k: 2, top: 255 })
    expect(pane.scrollTop).toBe(1145)
    // The same key: the page moved for a reason of the pane's own, not held.
    rerender({ k: 2, top: 400 })
    expect(pane.scrollTop).toBe(1145)
  })
})
