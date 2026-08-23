import { describe, expect, it } from 'vitest'
import type { DiffLine } from '../shared/types.js'
import { actionForKey } from './keyboard.js'
import { toSplitRows } from './splitRows.js'

const ctx = (oldNo: number, newNo: number, text = 'ctx'): DiffLine => ({
  kind: 'context',
  oldNo,
  newNo,
  text,
})
const add = (newNo: number, text = 'added'): DiffLine => ({ kind: 'add', oldNo: null, newNo, text })
const del = (oldNo: number, text = 'removed'): DiffLine => ({
  kind: 'del',
  oldNo,
  newNo: null,
  text,
})

describe('toSplitRows', () => {
  it('context lines span both sides', () => {
    const rows = toSplitRows([ctx(1, 1), ctx(2, 2)])
    expect(rows).toHaveLength(2)
    expect(rows[0]!.left!.line).toBe(rows[0]!.right!.line)
  })

  it('pairs a del run with the following add run row by row', () => {
    const rows = toSplitRows([del(5, 'old1'), del(6, 'old2'), add(5, 'new1'), add(6, 'new2')])
    expect(rows).toHaveLength(2)
    expect(rows[0]!.left!.line.text).toBe('old1')
    expect(rows[0]!.right!.line.text).toBe('new1')
    expect(rows[1]!.left!.line.text).toBe('old2')
    expect(rows[1]!.right!.line.text).toBe('new2')
  })

  it('unbalanced runs leave empty cells on the short side', () => {
    const rows = toSplitRows([del(5), add(5), add(6), add(7)])
    expect(rows).toHaveLength(3)
    expect(rows[1]!.left).toBeNull()
    expect(rows[2]!.left).toBeNull()
  })

  it('pure additions sit on the right only', () => {
    const rows = toSplitRows([add(1), add(2)])
    expect(rows.every((r) => r.left === null)).toBe(true)
  })

  it('idx points back into the original line array', () => {
    const lines = [ctx(1, 1), del(2), add(2)]
    const rows = toSplitRows(lines)
    expect(rows[1]!.left!.idx).toBe(1)
    expect(rows[1]!.right!.idx).toBe(2)
  })
})

describe('actionForKey', () => {
  it.each([
    ['j', false, 'next-hunk'],
    ['k', false, 'prev-hunk'],
    ['J', true, 'next-file'],
    ['K', true, 'prev-file'],
    ['v', false, 'toggle-viewed'],
    ['u', false, 'toggle-view-mode'],
    ['b', false, 'toggle-nav'],
    ['/', false, 'focus-search'],
    ['c', false, 'comment'],
    ['n', false, 'next-unreviewed'],
    ['o', false, 'toggle-fold'],
    ['?', false, 'shortcuts'],
    ['x', false, null],
  ])('%s (shift=%s) → %s', (key, shift, expected) => {
    expect(actionForKey(key, shift)).toBe(expected)
  })

  it('every shortcut the sheet advertises actually exists', () => {
    for (const key of ['j', 'k', 'J', 'K', 'n', '/', 'v', 'u', 'o', 'b', 'c', '?']) {
      expect(actionForKey(key, key === key.toUpperCase() && key.length === 1)).not.toBeNull()
    }
  })
})
