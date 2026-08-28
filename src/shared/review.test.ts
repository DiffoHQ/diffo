import { describe, expect, it } from 'vitest'
import {
  anchorSpan,
  describeAnchor,
  type ReviewThread,
  threadsInChangeset,
  undeliveredThreadIds,
} from './review.js'
import type { DiffLine, FileChange, Hunk } from './types.js'

const add = (newNo: number): DiffLine => ({ kind: 'add', oldNo: null, newNo, text: 'added' })

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

describe('threadsInChangeset', () => {
  const files = [file('a.ts', [hunk('h1', 'a.ts', [add(1)])])]

  it('keeps a thread whose hunk is live, or whose file at least still is', () => {
    const { active, past } = threadsInChangeset(files, [
      thread('live', { kind: 'hunk', hunkId: 'h1', path: 'a.ts', side: 'new', line: 1 }),
      thread('edited', { kind: 'hunk', hunkId: 'dead', path: 'a.ts', side: 'new', line: 1 }),
      thread('on-file', { kind: 'file', path: 'a.ts' }),
      thread('note', { kind: 'changeset' }),
    ])
    expect(active.map((t) => t.id)).toEqual(['live', 'edited', 'on-file', 'note'])
    expect(past).toEqual([])
  })

  it('drops threads whose file has left the changeset entirely', () => {
    const { active, past } = threadsInChangeset(files, [
      thread('gone-hunk', { kind: 'hunk', hunkId: 'dead', path: 'z.ts', side: 'new', line: 1 }),
      thread('gone-file', { kind: 'file', path: 'z.ts' }),
    ])
    expect(active).toEqual([])
    expect(past.map((t) => t.id)).toEqual(['gone-hunk', 'gone-file'])
  })

  it('a renamed file keeps the threads opened under its old name', () => {
    const renamed: FileChange = {
      ...file('b.ts', [hunk('h2', 'b.ts', [add(1)])]),
      oldPath: 'a.ts',
      status: 'renamed',
    }
    const { active, past } = threadsInChangeset(
      [renamed],
      [
        thread('old-hunk', { kind: 'hunk', hunkId: 'h1', path: 'a.ts', side: 'new', line: 1 }),
        thread('old-file', { kind: 'file', path: 'a.ts' }),
        thread('new-file', { kind: 'file', path: 'b.ts' }),
      ],
    )
    expect(active.map((t) => t.id)).toEqual(['old-hunk', 'old-file', 'new-file'])
    expect(past).toEqual([])
  })

  it('an empty changeset owns nothing — including its own notes', () => {
    const { active, past } = threadsInChangeset(
      [],
      [
        thread('note', { kind: 'changeset' }),
        thread('h', { kind: 'hunk', hunkId: 'h1', path: 'a.ts', side: 'new', line: 1 }),
      ],
    )
    expect(active).toEqual([])
    expect(past.map((t) => t.id)).toEqual(['note', 'h'])
  })
})

describe('undeliveredThreadIds — what a restart still owes the agent', () => {
  const sent = (id: string, over: Partial<ReviewThread> = {}): ReviewThread => ({
    ...thread(id, { kind: 'changeset' }),
    state: 'sent',
    sentAt: `2026-08-15T00:00:0${id}Z`,
    messages: [{ id: `m-${id}`, author: 'reviewer', text: 'q', at: '2026-08-15T00:00:00Z' }],
    ...over,
  })

  it('re-queues a sent thread the reviewer spoke last on', () => {
    expect(undeliveredThreadIds([sent('1')])).toEqual(['1'])
  })

  it('never re-queues a withheld reply — withholding has to survive a restart', () => {
    expect(undeliveredThreadIds([sent('1', { withheld: true })])).toEqual([])
  })

  it('still re-queues the others alongside it, in send order', () => {
    const ids = undeliveredThreadIds([sent('3'), sent('1', { withheld: true }), sent('2')])
    expect(ids).toEqual(['2', '3'])
  })
})

describe('anchorSpan / describeAnchor — the one label the agent ever sees', () => {
  const single = { kind: 'hunk', hunkId: 'h', path: 'a.ts', side: 'new', line: 12 } as const

  it('a single line stays a bare number; a range reads start-end', () => {
    expect(anchorSpan(single)).toBe('12')
    expect(anchorSpan({ ...single, endLine: 20 })).toBe('12-20')
  })

  it('describeAnchor carries the range through to the prompt', () => {
    expect(describeAnchor(single)).toBe('a.ts:12 (new side)')
    expect(describeAnchor({ ...single, endLine: 20 })).toBe('a.ts:12-20 (new side)')
    expect(describeAnchor({ kind: 'file', path: 'a.ts' })).toBe('a.ts')
    expect(describeAnchor({ kind: 'changeset' })).toBe('the whole changeset')
  })
})
