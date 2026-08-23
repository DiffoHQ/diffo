import { describe, expect, it } from 'vitest'
import type { LastFinish } from '../shared/review.js'
import type { Changeset, FileChange, Hunk } from '../shared/types.js'
import { computeSinceLastReview, NOTHING_SINCE } from './sinceLastReview.js'

const hunk = (id: string, path: string): Hunk => ({ id, path, oldStart: 1, newStart: 1, lines: [] })

const file = (path: string, ...hunkIds: string[]): FileChange =>
  ({ path, status: 'modified', hunks: hunkIds.map((id) => hunk(id, path)) }) as FileChange

const changeset = (...files: FileChange[]): Changeset =>
  ({ version: 1, files }) as unknown as Changeset

const finish = (hunkIds: string[]): LastFinish => ({
  at: '2026-08-12T00:00:00Z',
  hunkIds,
  coverage: { viewedHunks: 0, totalHunks: 0, skippedFiles: [] },
})

describe('computeSinceLastReview', () => {
  it('reports only what the agent moved, not what you have yet to open', () => {
    const cs = changeset(file('a.ts', 'a2'), file('b.ts', 'b1'), file('c.ts', 'c1'))
    const delta = computeSinceLastReview(cs, finish(['a1', 'b1', 'c1']))

    expect(delta.changedFiles).toEqual(['a.ts'])
    expect([...delta.changedHunkIds]).toEqual(['a2'])
    expect(delta.changed.has('b.ts')).toBe(false)
    expect(delta.changed.has('c.ts')).toBe(false)
  })

  it('a changed file is changed even if you had read every hunk before', () => {
    const delta = computeSinceLastReview(changeset(file('a.ts', 'a2')), finish(['a1']))
    expect(delta.changed.has('a.ts')).toBe(true)
  })

  it('a file with some hunks new and some old still counts as changed, once', () => {
    const delta = computeSinceLastReview(changeset(file('a.ts', 'a1', 'a2')), finish(['a1']))
    expect(delta.changedFiles).toEqual(['a.ts'])
    expect([...delta.changedHunkIds]).toEqual(['a2'])
  })

  it('files that cannot be read cannot be owed', () => {
    const delta = computeSinceLastReview(changeset(file('logo.png')), finish([]))
    expect(delta.changedFiles).toEqual([])
    expect(delta.changed.has('logo.png')).toBe(false)
  })

  it('with no finish recorded there is no "since" to measure from', () => {
    const cs = changeset(file('a.ts', 'a1'))
    expect(computeSinceLastReview(cs, null)).toEqual(NOTHING_SINCE)
    expect(computeSinceLastReview(cs, undefined)).toEqual(NOTHING_SINCE)
    expect(computeSinceLastReview(undefined, finish(['a1']))).toEqual(NOTHING_SINCE)
  })

  it('an empty hunk list makes everything new — a finish on an empty diff', () => {
    const delta = computeSinceLastReview(changeset(file('a.ts', 'a1')), finish([]))
    expect(delta.changedFiles).toEqual(['a.ts'])
  })

  it('reading what the agent moved settles it — the round drains without a finish', () => {
    const cs = changeset(file('a.ts', 'a2'))
    const delta = computeSinceLastReview(cs, finish(['a1']), new Set(['a2']))

    expect(delta.changedFiles).toEqual([])
    expect([...delta.changedHunkIds]).toEqual([])
  })

  it('a file is still owed while any hunk the agent moved is unread', () => {
    const cs = changeset(file('a.ts', 'a2', 'a3'))
    const delta = computeSinceLastReview(cs, finish(['a1']), new Set(['a2']))

    expect(delta.changedFiles).toEqual(['a.ts'])
    expect([...delta.changedHunkIds]).toEqual(['a3'])
  })

  it('marks on hunks the agent left alone settle nothing', () => {
    const cs = changeset(file('a.ts', 'a1', 'a2'))
    const delta = computeSinceLastReview(cs, finish(['a1']), new Set(['a1']))

    expect(delta.changed.has('a.ts')).toBe(true)
    expect([...delta.changedHunkIds]).toEqual(['a2'])
  })
})
