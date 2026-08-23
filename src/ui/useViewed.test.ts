// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import type { Changeset, FileChange, Hunk } from '../shared/types.js'
import { fileMark } from './fileMarks.js'
import { useViewed } from './useViewed.js'
import { saveViewed, storageKey } from './viewedStore.js'

const hunk = (path: string, id: string): Hunk => ({
  id,
  path,
  oldStart: 1,
  newStart: 1,
  lines: [{ kind: 'add', oldNo: null, newNo: 1, text: 'x' }],
})

const file = (path: string, hunkIds: string[]): FileChange => ({
  path,
  oldPath: null,
  status: 'modified',
  kind: 'text',
  staged: false,
  hunks: hunkIds.map((id) => hunk(path, id)),
})

function changeset(files: FileChange[]): Changeset {
  return {
    version: 1,
    repo: { name: 'repo', branch: 'main' },
    spec: { kind: 'working-tree' },
    files,
    stats: { files: files.length, additions: 0, deletions: 0 },
  } as Changeset
}

const RENAMED: FileChange = {
  path: 'renamed.ts',
  oldPath: 'old.ts',
  status: 'renamed',
  kind: 'text',
  staged: false,
  hunks: [],
}
const RENAMED_MARK = fileMark(RENAMED)

const CS = changeset([file('a.ts', ['a1', 'a2']), file('b.ts', ['b1']), RENAMED])

function seedHalfRead() {
  saveViewed(storageKey(CS), new Set(['a1']))
}

describe('useViewed — file-level done', () => {
  beforeEach(() => localStorage.clear())

  it('toggleFile marks every hunk in the file, and clears them all again', () => {
    const { result } = renderHook(() => useViewed(CS))

    act(() => result.current.toggleFile('a.ts'))
    expect(result.current.viewed).toEqual(new Set(['a1', 'a2']))

    act(() => result.current.toggleFile('a.ts'))
    expect(result.current.viewed).toEqual(new Set())
  })

  it('a partly-read file toggles up to fully read, not back down', () => {
    seedHalfRead()
    const { result } = renderHook(() => useViewed(CS))
    act(() => result.current.toggleFile('a.ts'))
    expect(result.current.viewed).toEqual(new Set(['a1', 'a2']))
  })

  it('fileProgress counts a file only when all of its marks are read', () => {
    expect(renderHook(() => useViewed(CS)).result.current.fileProgress).toEqual({
      viewed: 0,
      total: 3,
    })

    seedHalfRead()
    const { result } = renderHook(() => useViewed(CS))
    expect(result.current.fileProgress).toEqual({ viewed: 0, total: 3 })
    expect(result.current.progress).toEqual({ viewed: 1, total: 3 })

    act(() => result.current.toggleFile('a.ts'))
    expect(result.current.fileProgress).toEqual({ viewed: 1, total: 3 })

    act(() => result.current.toggleFile('b.ts'))
    expect(result.current.fileProgress).toEqual({ viewed: 2, total: 3 })

    act(() => result.current.toggleFile('renamed.ts'))
    expect(result.current.fileProgress).toEqual({ viewed: 3, total: 3 })
  })

  it('toggleFile persists, so a remount remembers the file was read', () => {
    const first = renderHook(() => useViewed(CS))
    act(() => first.result.current.toggleFile('a.ts'))
    first.unmount()

    const second = renderHook(() => useViewed(CS))
    expect(second.result.current.viewed).toEqual(new Set(['a1', 'a2']))
    expect(second.result.current.fileProgress).toEqual({ viewed: 1, total: 3 })
  })

  it('a file with nothing to read marks through a key of its own', () => {
    const { result } = renderHook(() => useViewed(CS))
    act(() => result.current.toggleFile('renamed.ts'))
    expect(result.current.viewed).toEqual(new Set([RENAMED_MARK]))

    act(() => result.current.toggleFile('renamed.ts'))
    expect(result.current.viewed).toEqual(new Set())

    act(() => result.current.toggleFile('does-not-exist.ts'))
    expect(result.current.viewed).toEqual(new Set())
  })

  it('a rename retargeted loses its mark, the way an edited hunk does', () => {
    const { result, rerender } = renderHook(({ cs }) => useViewed(cs), {
      initialProps: { cs: changeset([RENAMED]) },
    })
    act(() => result.current.toggleFile('renamed.ts'))
    expect(result.current.fileProgress).toEqual({ viewed: 1, total: 1 })

    rerender({ cs: changeset([{ ...RENAMED, oldPath: 'somewhere-else.ts' }]) })
    expect(result.current.fileProgress).toEqual({ viewed: 0, total: 1 })
  })

  it('markFiles / clearFiles batch the file gesture in one storage write', () => {
    const { result } = renderHook(() => useViewed(CS))

    act(() => result.current.markFiles(['a.ts', 'b.ts', 'renamed.ts', 'ghost.ts']))
    expect(result.current.viewed).toEqual(new Set(['a1', 'a2', 'b1', RENAMED_MARK]))
    expect(result.current.fileProgress).toEqual({ viewed: 3, total: 3 })

    act(() => result.current.clearFiles(['a.ts', 'renamed.ts']))
    expect(result.current.viewed).toEqual(new Set(['b1']))
  })

  it('markFiles persists like every other mark', () => {
    const first = renderHook(() => useViewed(CS))
    act(() => first.result.current.markFiles(['b.ts']))
    first.unmount()

    const second = renderHook(() => useViewed(CS))
    expect(second.result.current.viewed).toEqual(new Set(['b1']))
  })

  it('an edited hunk rotates its ID, so its file stops being fully read', () => {
    const { result, rerender } = renderHook(({ cs }) => useViewed(cs), {
      initialProps: { cs: CS },
    })
    act(() => result.current.toggleFile('a.ts'))
    expect(result.current.fileProgress).toEqual({ viewed: 1, total: 3 })

    rerender({ cs: changeset([file('a.ts', ['a1', 'a2-rotated']), file('b.ts', ['b1'])]) })
    expect(result.current.fileProgress).toEqual({ viewed: 0, total: 2 })
  })
})
