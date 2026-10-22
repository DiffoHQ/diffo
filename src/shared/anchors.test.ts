import { describe, expect, it } from 'vitest'
import { translateHunkAnchor } from './anchors.js'
import type { DiffLine, FileChange, Hunk } from './types.js'

const line = (kind: DiffLine['kind'], oldNo: number | null, newNo: number | null): DiffLine => ({
  kind,
  oldNo,
  newNo,
  text: `${kind}:${oldNo}/${newNo}`,
})

/** The same edit — `two` becomes `TWO` under one context line each side —
 * starting at `at` in both versions. */
const hunk = (id: string, at: number): Hunk => ({
  id,
  path: 'a.ts',
  oldStart: at,
  newStart: at,
  lines: [
    line('context', at, at),
    line('del', at + 1, null),
    line('add', null, at + 1),
    line('context', at + 2, at + 2),
  ],
})

const file = (...hunks: Hunk[]): FileChange => ({
  path: 'a.ts',
  oldPath: null,
  status: 'modified',
  kind: 'text',
  staged: false,
  hunks,
})

describe('translateHunkAnchor', () => {
  const inCommit = [file(hunk('h', 10))]
  const inFull = [file(hunk('h', 14))]

  it('renames the line by its position in the shared hunk', () => {
    const anchor = { kind: 'hunk', hunkId: 'h', path: 'a.ts', side: 'new', line: 11 } as const
    expect(translateHunkAnchor(anchor, inCommit, inFull)).toEqual({ ...anchor, line: 15 })
    expect(translateHunkAnchor({ ...anchor, line: 15 }, inFull, inCommit)).toEqual({
      ...anchor,
      line: 11,
    })
  })

  it('renames both ends of a range, and the old side by old numbers', () => {
    const range = {
      kind: 'hunk',
      hunkId: 'h',
      path: 'a.ts',
      side: 'new',
      line: 10,
      endLine: 12,
    } as const
    expect(translateHunkAnchor(range, inCommit, inFull)).toEqual({
      ...range,
      line: 14,
      endLine: 16,
    })
    const old = { kind: 'hunk', hunkId: 'h', path: 'a.ts', side: 'old', line: 11 } as const
    expect(translateHunkAnchor(old, inCommit, inFull)).toEqual({ ...old, line: 15 })
  })

  it('leaves the anchor alone when either diff lacks the hunk or their shapes differ', () => {
    const anchor = { kind: 'hunk', hunkId: 'h', path: 'a.ts', side: 'new', line: 11 } as const
    expect(translateHunkAnchor(anchor, inCommit, [file()])).toBe(anchor)
    expect(translateHunkAnchor(anchor, [file()], inFull)).toBe(anchor)
    const wider = file({
      ...hunk('h', 14),
      lines: [...hunk('h', 14).lines, line('context', 17, 17)],
    })
    expect(translateHunkAnchor(anchor, inCommit, [wider])).toBe(anchor)
  })

  it('is the identity when the numbering already agrees', () => {
    const anchor = { kind: 'hunk', hunkId: 'h', path: 'a.ts', side: 'new', line: 11 } as const
    expect(translateHunkAnchor(anchor, inCommit, [file(hunk('h', 10))])).toBe(anchor)
  })
})
