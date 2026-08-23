import { describe, expect, it } from 'vitest'
import type { Changeset, FileChange, Hunk } from '../shared/types.js'
import { computeDelta } from './liveDelta.js'

function hunk(path: string, id: string): Hunk {
  return { id, path, oldStart: 1, newStart: 1, lines: [] }
}

function file(path: string, hunkIds: string[]): FileChange {
  return {
    path,
    oldPath: null,
    status: 'modified',
    kind: 'text',
    staged: false,
    hunks: hunkIds.map((id) => hunk(path, id)),
  }
}

function changeset(version: number, files: FileChange[]): Changeset {
  return {
    version,
    spec: { kind: 'working-tree' },
    repo: { path: '/tmp/demo', name: 'r', branch: 'main', worktree: null },
    files,
    stats: { files: files.length, additions: 0, deletions: 0 },
  }
}

describe('computeDelta', () => {
  it('first load: nothing is fresh', () => {
    const next = changeset(1, [file('a.ts', ['h1', 'h2'])])
    const delta = computeDelta(null, next, new Set())
    expect(delta.freshHunkIds.size).toBe(0)
    expect(delta.changedViewedHunkIds.size).toBe(0)
  })

  it('a new hunk is fresh; surviving hunks are not', () => {
    const prev = changeset(1, [file('a.ts', ['h1'])])
    const next = changeset(2, [file('a.ts', ['h1', 'h2'])])
    const delta = computeDelta(prev, next, new Set())
    expect([...delta.freshHunkIds]).toEqual(['h2'])
  })

  it('an edited viewed hunk gets the changed-since-viewed badge', () => {
    const prev = changeset(1, [file('a.ts', ['h1'])])
    const next = changeset(2, [file('a.ts', ['h1b'])])
    const delta = computeDelta(prev, next, new Set(['h1']))
    expect([...delta.freshHunkIds]).toEqual(['h1b'])
    expect([...delta.changedViewedHunkIds]).toEqual(['h1b'])
  })

  it('an edited UNviewed hunk is fresh but not badged', () => {
    const prev = changeset(1, [file('a.ts', ['h1'])])
    const next = changeset(2, [file('a.ts', ['h1b'])])
    const delta = computeDelta(prev, next, new Set())
    expect([...delta.freshHunkIds]).toEqual(['h1b'])
    expect(delta.changedViewedHunkIds.size).toBe(0)
  })

  it('edits in one file never badge another file', () => {
    const prev = changeset(1, [file('a.ts', ['a1']), file('b.ts', ['b1'])])
    const next = changeset(2, [file('a.ts', ['a2']), file('b.ts', ['b1', 'b2'])])
    const delta = computeDelta(prev, next, new Set(['a1', 'b1']))
    expect(delta.changedViewedHunkIds.has('a2')).toBe(true)
    expect(delta.changedViewedHunkIds.has('b2')).toBe(false)
    expect(delta.freshHunkIds.has('b2')).toBe(true)
  })

  it('a hunk moving between files (same ID impossible — path is hashed) stays fresh', () => {
    const prev = changeset(1, [file('a.ts', ['h1'])])
    const next = changeset(2, [file('b.ts', ['h1-in-b'])])
    const delta = computeDelta(prev, next, new Set())
    expect(delta.freshHunkIds.has('h1-in-b')).toBe(true)
  })
})
