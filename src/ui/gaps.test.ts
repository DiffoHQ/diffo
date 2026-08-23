import { describe, expect, it } from 'vitest'
import type { DiffLine, FileChange, Hunk } from '../shared/types.js'
import { fileGaps, gapRemaining, gapSize, materializeGap } from './gaps.js'

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

function hunk(id: string, oldStart: number, newStart: number, lines: DiffLine[]): Hunk {
  return { id, path: 'a.ts', oldStart, newStart, lines }
}

function file(hunks: Hunk[], newLineCount: number | null = null): FileChange {
  return {
    path: 'a.ts',
    oldPath: null,
    status: 'modified',
    kind: 'text',
    staged: false,
    hunks,
    newLineCount,
  }
}

const headLines = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`)

describe('fileGaps', () => {
  it('finds the top gap, the gaps between hunks, and the tail gap', () => {
    // hunk A shows new 38-41, hunk B shows new 70-72, file has 100 lines.
    const a = hunk('a', 35, 38, [ctx(35, 38), add(39), ctx(36, 40), ctx(37, 41)])
    const b = hunk('b', 66, 70, [ctx(66, 70), add(71), ctx(67, 72)])
    const gaps = fileGaps(file([a, b], 100))
    expect(gaps).toEqual([
      { key: 'top:a', above: null, below: 0, startNewNo: 1, endNewNo: 37, offset: 3 },
      { key: 'a:b', above: 0, below: 1, startNewNo: 42, endNewNo: 69, offset: 4 },
      { key: 'b:tail', above: 1, below: null, startNewNo: 73, endNewNo: 100, offset: 5 },
    ])
  })

  it('offers no top gap when the first hunk already starts at line 1', () => {
    const gaps = fileGaps(file([hunk('a', 1, 1, [ctx(1, 1), add(2)])], 2))
    expect(gaps).toEqual([])
  })

  it('offers no tail gap without a head line count, or when the hunk reaches EOF', () => {
    const h = hunk('a', 1, 1, [ctx(1, 1), add(2)])
    expect(fileGaps(file([h], null))).toEqual([])
    expect(fileGaps(file([h], 2))).toEqual([])
  })

  it('omits a zero-size gap between adjacent hunks', () => {
    const a = hunk('a', 1, 1, [ctx(1, 1), add(2)])
    const b = hunk('b', 2, 3, [ctx(2, 3), add(4)])
    expect(fileGaps(file([a, b], 4))).toEqual([])
  })

  it('handles a pure-insertion hunk, where git points at the line before it', () => {
    // @@ -5,0 +6,3 @@ — inserted new 6-8; unchanged new 5 is old 5.
    const h = hunk('a', 5, 6, [add(6), add(7), add(8)])
    const gaps = fileGaps(file([h], 20))
    expect(gaps).toEqual([
      { key: 'top:a', above: null, below: 0, startNewNo: 1, endNewNo: 5, offset: 0 },
      { key: 'a:tail', above: 0, below: null, startNewNo: 9, endNewNo: 20, offset: 3 },
    ])
  })

  it('handles a pure-deletion hunk the same way', () => {
    // @@ -10,3 +9,0 @@ — old 10-12 deleted; unchanged new 10 is old 13.
    const h = hunk('a', 10, 9, [del(10), del(11), del(12)])
    const gaps = fileGaps(file([h], 20))
    expect(gaps).toEqual([
      { key: 'top:a', above: null, below: 0, startNewNo: 1, endNewNo: 9, offset: 0 },
      { key: 'a:tail', above: 0, below: null, startNewNo: 10, endNewNo: 20, offset: -3 },
    ])
  })
})

describe('materializeGap', () => {
  const gap = { key: 'a:b', above: 0, below: 1, startNewNo: 42, endNewNo: 69, offset: 4 }

  it('slices fromTop below the hunk above, fromBottom above the hunk below', () => {
    const { top, bottom, merged } = materializeGap(headLines, gap, { fromTop: 2, fromBottom: 3 })
    expect(merged).toBe(false)
    expect(top).toEqual([
      { kind: 'context', oldNo: 38, newNo: 42, text: 'line 42' },
      { kind: 'context', oldNo: 39, newNo: 43, text: 'line 43' },
    ])
    expect(bottom.map((l) => l.newNo)).toEqual([67, 68, 69])
    expect(bottom[0]).toEqual({ kind: 'context', oldNo: 63, newNo: 67, text: 'line 67' })
  })

  it('a fully opened gap merges into one run on the hunk below', () => {
    const exp = { fromTop: 20, fromBottom: 20 } // 40 ≥ the 28-line gap
    expect(gapRemaining(gap, exp)).toBe(0)
    const { top, bottom, merged } = materializeGap(headLines, gap, exp)
    expect(merged).toBe(true)
    expect(top).toEqual([])
    expect(bottom.map((l) => l.newNo)).toEqual(
      Array.from({ length: gapSize(gap) }, (_, i) => 42 + i),
    )
  })

  it('a merged tail gap glues to the hunk above instead', () => {
    const tail = { key: 'b:tail', above: 1, below: null, startNewNo: 73, endNewNo: 100, offset: 5 }
    const { top, bottom, merged } = materializeGap(headLines, tail, { fromTop: 28, fromBottom: 0 })
    expect(merged).toBe(true)
    expect(bottom).toEqual([])
    expect(top.map((l) => l.newNo)).toEqual(Array.from({ length: 28 }, (_, i) => 73 + i))
    expect(top[0]!.oldNo).toBe(68)
  })

  it('clamps to what the fetched file actually has — a live edit shows less, never wrong', () => {
    const short = headLines.slice(0, 50)
    const { top, bottom } = materializeGap(short, gap, { fromTop: 5, fromBottom: 5 })
    expect(top.map((l) => l.newNo)).toEqual([42, 43, 44, 45, 46])
    expect(bottom).toEqual([]) // 65-69 are beyond the shortened file
  })
})
