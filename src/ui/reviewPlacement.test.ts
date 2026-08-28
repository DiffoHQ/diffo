import { describe, expect, it } from 'vitest'
import type { ReviewThread } from '../shared/review.js'
import type { DiffLine, FileChange, Hunk } from '../shared/types.js'
import {
  anchorForHunk,
  anchorForLine,
  anchorForRange,
  lineIndexForAnchor,
  partitionThreads,
  placementIndexForAnchor,
  rangedRows,
  rangeStartRows,
  threadsByLine,
} from './reviewPlacement.js'

const ctx = (oldNo: number, newNo: number): DiffLine => ({
  kind: 'context',
  oldNo,
  newNo,
  text: 'ctx',
})
const add = (newNo: number): DiffLine => ({ kind: 'add', oldNo: null, newNo, text: 'added' })
const del = (oldNo: number): DiffLine => ({ kind: 'del', oldNo, newNo: null, text: 'removed' })

const hunk = (id: string, path: string, lines: DiffLine[]): Hunk => ({
  id,
  path,
  oldStart: 1,
  newStart: 1,
  lines,
})

const file = (path: string, hunks: Hunk[]): FileChange => ({
  path,
  oldPath: null,
  status: 'modified',
  kind: 'text',
  staged: false,
  hunks,
})

const thread = (id: string, anchor: ReviewThread['anchor']): ReviewThread => ({
  id,
  anchor,
  state: 'open',
  codeContext: null,
  codeChanged: false,
  messages: [],
  createdAt: '',
  updatedAt: '',
})

describe('partitionThreads', () => {
  const files = [file('a.ts', [hunk('h1', 'a.ts', [add(1)])])]

  it('routes live hunk threads to their hunk', () => {
    const p = partitionThreads(files, [
      thread('t1', { kind: 'hunk', hunkId: 'h1', path: 'a.ts', side: 'new', line: 1 }),
    ])
    expect(p.byHunk.get('h1')!.map((t) => t.id)).toEqual(['t1'])
  })

  it('an edited hunk re-homes its thread onto whichever hunk holds the line now', () => {
    const p = partitionThreads(files, [
      thread('edited', { kind: 'hunk', hunkId: 'dead', path: 'a.ts', side: 'new', line: 1 }),
    ])
    expect(p.byHunk.get('h1')!.map((t) => t.id)).toEqual(['edited'])
    expect(p.byFile.has('a.ts')).toBe(false)
  })

  it('orphaned hunk threads fall back to their file, then to changeset', () => {
    const p = partitionThreads(files, [
      // Line 9 is nowhere in a.ts's diff, so there is no line to sit on.
      thread('gone-hunk', { kind: 'hunk', hunkId: 'dead', path: 'a.ts', side: 'new', line: 9 }),
      thread('gone-file', { kind: 'hunk', hunkId: 'dead2', path: 'z.ts', side: 'new', line: 1 }),
    ])
    expect(p.byFile.get('a.ts')!.map((t) => t.id)).toEqual(['gone-hunk'])
    expect(p.changeset.map((t) => t.id)).toEqual(['gone-file'])
  })

  it('re-homing keeps to the anchored side', () => {
    const two = [
      file('b.ts', [hunk('old-side', 'b.ts', [del(4)]), hunk('new-side', 'b.ts', [add(4)])]),
    ]
    const p = partitionThreads(two, [
      thread('d', { kind: 'hunk', hunkId: 'dead', path: 'b.ts', side: 'old', line: 4 }),
      thread('a', { kind: 'hunk', hunkId: 'dead', path: 'b.ts', side: 'new', line: 4 }),
    ])
    expect(p.byHunk.get('old-side')!.map((t) => t.id)).toEqual(['d'])
    expect(p.byHunk.get('new-side')!.map((t) => t.id)).toEqual(['a'])
  })

  it('file and changeset threads route directly', () => {
    const p = partitionThreads(files, [
      thread('f', { kind: 'file', path: 'a.ts' }),
      thread('f-gone', { kind: 'file', path: 'z.ts' }),
      thread('c', { kind: 'changeset' }),
    ])
    expect(p.byFile.get('a.ts')!.map((t) => t.id)).toEqual(['f'])
    expect(p.changeset.map((t) => t.id)).toEqual(['f-gone', 'c'])
  })
})

describe('anchorForLine / anchorForHunk', () => {
  it('deleted lines anchor to the old side, everything else to the new', () => {
    expect(anchorForLine('h', 'a.ts', del(7))).toEqual({
      kind: 'hunk',
      hunkId: 'h',
      path: 'a.ts',
      side: 'old',
      line: 7,
    })
    expect(anchorForLine('h', 'a.ts', add(3))).toEqual({
      kind: 'hunk',
      hunkId: 'h',
      path: 'a.ts',
      side: 'new',
      line: 3,
    })
    expect(anchorForLine('h', 'a.ts', ctx(4, 5))).toMatchObject({ side: 'new', line: 5 })
  })

  it('hunk anchor lands on the first changed line', () => {
    const h = hunk('h', 'a.ts', [ctx(1, 1), del(2), add(2)])
    expect(anchorForHunk(h)).toMatchObject({ side: 'old', line: 2 })
  })
})

describe('anchorForRange', () => {
  const lines = [ctx(1, 1), del(2), add(2), add(3), ctx(3, 4)]

  it('the first line in the run picks the side; the last line on that side ends it', () => {
    expect(anchorForRange('h', 'a.ts', lines, 0, 4)).toEqual({
      kind: 'hunk',
      hunkId: 'h',
      path: 'a.ts',
      side: 'new',
      line: 1,
      endLine: 4,
    })
    // Starting on the deletion makes it old-side — and the adds inside the run
    // can't be its endpoint, so it clamps inward to the last old-numbered line.
    expect(anchorForRange('h', 'a.ts', lines, 1, 3)).toEqual({
      kind: 'hunk',
      hunkId: 'h',
      path: 'a.ts',
      side: 'old',
      line: 2,
    })
    expect(anchorForRange('h', 'a.ts', lines, 1, 4)).toMatchObject({
      side: 'old',
      line: 2,
      endLine: 3,
    })
  })

  it('a one-line run is a plain single-line anchor, endpoints in either order', () => {
    expect(anchorForRange('h', 'a.ts', lines, 2, 2)).toEqual(anchorForLine('h', 'a.ts', add(2)))
    expect(anchorForRange('h', 'a.ts', lines, 3, 0)).toEqual(
      anchorForRange('h', 'a.ts', lines, 0, 3),
    )
  })

  it('endpoints outside the window clamp instead of bailing', () => {
    expect(anchorForRange('h', 'a.ts', lines, -3, 99)).toMatchObject({ line: 1, endLine: 4 })
  })
})

describe('lineIndexForAnchor / threadsByLine', () => {
  const lines = [ctx(1, 1), del(2), add(2), add(3)]

  it('matches by side-aware line number', () => {
    expect(
      lineIndexForAnchor(lines, { kind: 'hunk', hunkId: 'h', path: 'a', side: 'old', line: 2 }),
    ).toBe(1)
    expect(
      lineIndexForAnchor(lines, { kind: 'hunk', hunkId: 'h', path: 'a', side: 'new', line: 3 }),
    ).toBe(3)
    expect(
      lineIndexForAnchor(lines, { kind: 'hunk', hunkId: 'h', path: 'a', side: 'new', line: 99 }),
    ).toBe(-1)
  })

  it('indices shift with expanded context lines', () => {
    const expanded = [ctx(0, 0), ...lines]
    expect(
      lineIndexForAnchor(expanded, { kind: 'hunk', hunkId: 'h', path: 'a', side: 'old', line: 2 }),
    ).toBe(2)
  })

  it('groups threads per line, strays under -1', () => {
    const map = threadsByLine(lines, [
      thread('a', { kind: 'hunk', hunkId: 'h', path: 'p', side: 'new', line: 2 }),
      thread('b', { kind: 'hunk', hunkId: 'h', path: 'p', side: 'new', line: 2 }),
      thread('c', { kind: 'hunk', hunkId: 'h', path: 'p', side: 'new', line: 99 }),
    ])
    expect(map.get(2)!.map((t) => t.id)).toEqual(['a', 'b'])
    expect(map.get(-1)!.map((t) => t.id)).toEqual(['c'])
  })

  it('a range thread renders under its last line, not its first', () => {
    const map = threadsByLine(lines, [
      thread('r', { kind: 'hunk', hunkId: 'h', path: 'p', side: 'new', line: 2, endLine: 3 }),
    ])
    expect(map.get(3)!.map((t) => t.id)).toEqual(['r'])
  })

  it('a range whose end was edited away falls back to its start line', () => {
    const anchor = {
      kind: 'hunk',
      hunkId: 'h',
      path: 'p',
      side: 'new',
      line: 2,
      endLine: 99,
    } as const
    expect(placementIndexForAnchor(lines, anchor)).toBe(2)
    const map = threadsByLine(lines, [thread('r', anchor)])
    expect(map.get(2)!.map((t) => t.id)).toEqual(['r'])
  })
})

describe('rangedRows', () => {
  const lines = [ctx(1, 1), del(2), add(2), add(3), ctx(3, 4)]

  it('marks every rendered row a range spans, and nothing for single lines', () => {
    const rows = rangedRows(lines, [
      thread('r', { kind: 'hunk', hunkId: 'h', path: 'p', side: 'new', line: 1, endLine: 3 }),
      thread('s', { kind: 'hunk', hunkId: 'h', path: 'p', side: 'new', line: 4 }),
    ])
    expect([...rows].sort()).toEqual([0, 1, 2, 3])
  })

  it('says nothing when either endpoint left the window', () => {
    const rows = rangedRows(lines, [
      thread('r', { kind: 'hunk', hunkId: 'h', path: 'p', side: 'new', line: 90, endLine: 99 }),
    ])
    expect(rows.size).toBe(0)
  })

  it('rangeStartRows marks only each range’s first row — the glyph’s seat', () => {
    const rows = rangeStartRows(lines, [
      thread('r', { kind: 'hunk', hunkId: 'h', path: 'p', side: 'new', line: 1, endLine: 3 }),
      thread('s', { kind: 'hunk', hunkId: 'h', path: 'p', side: 'new', line: 4 }),
    ])
    expect([...rows]).toEqual([0])
  })
})
