import { describe, expect, it } from 'vitest'
import type { FileChange } from '../../shared/types.js'
import { fixturePr } from '../fixture.js'
import type { ImportedInlineThread, ImportedThread } from '../types.js'
import { anchorForImported, githubPosition, threadsFromGithub } from './map.js'

const file: FileChange = {
  path: 'src/upload.ts',
  oldPath: null,
  status: 'modified',
  kind: 'text',
  staged: false,
  hunks: [
    {
      id: 'h1',
      path: 'src/upload.ts',
      oldStart: 10,
      newStart: 10,
      lines: [
        { kind: 'context', oldNo: 10, newNo: 10, text: 'a' },
        { kind: 'del', oldNo: 11, newNo: null, text: 'old' },
        { kind: 'add', oldNo: null, newNo: 11, text: 'new' },
        { kind: 'add', oldNo: null, newNo: 12, text: 'new2' },
        { kind: 'context', oldNo: 12, newNo: 13, text: 'b' },
      ],
    },
  ],
}

const comment = (id: string, body: string, at = '2026-09-20T12:00:00Z') => ({
  id,
  user: { login: 'jonas', avatarUrl: '' },
  body,
  at,
  url: `https://github.com/acme/widgets/pull/482#discussion_r${id}`,
})

describe('anchorForImported', () => {
  const inline = (over: Partial<ImportedInlineThread>): ImportedInlineThread => ({
    kind: 'inline',
    id: 'T1',
    resolved: false,
    outdated: false,
    path: 'src/upload.ts',
    line: 11,
    startLine: null,
    side: 'RIGHT',
    comments: [comment('C1', 'why?')],
    ...over,
  })

  it('lands a RIGHT-side line on the hunk showing it', () => {
    expect(anchorForImported(inline({}), [file])).toEqual({
      anchor: { kind: 'hunk', hunkId: 'h1', path: 'src/upload.ts', side: 'new', line: 11 },
      placed: true,
    })
  })

  it('lands a LEFT-side line on the old side', () => {
    expect(anchorForImported(inline({ side: 'LEFT' }), [file])).toEqual({
      anchor: { kind: 'hunk', hunkId: 'h1', path: 'src/upload.ts', side: 'old', line: 11 },
      placed: true,
    })
  })

  it('turns startLine..line into a range', () => {
    expect(anchorForImported(inline({ startLine: 11, line: 12 }), [file]).anchor).toEqual({
      kind: 'hunk',
      hunkId: 'h1',
      path: 'src/upload.ts',
      side: 'new',
      line: 11,
      endLine: 12,
    })
  })

  it('falls back to the file, unplaced, when the line is not in the diff', () => {
    expect(anchorForImported(inline({ line: 400 }), [file])).toEqual({
      anchor: { kind: 'file', path: 'src/upload.ts' },
      placed: false,
    })
    expect(anchorForImported(inline({ line: null }), [file]).placed).toBe(false)
  })
})

describe('threadsFromGithub', () => {
  const imported: ImportedThread[] = [
    {
      kind: 'inline',
      id: 'T1',
      resolved: true,
      outdated: false,
      path: 'src/upload.ts',
      line: 11,
      startLine: null,
      side: 'RIGHT',
      comments: [
        comment('C1', 'why not AbortSignal?'),
        comment('C2', 'node 18', '2026-09-20T13:00:00Z'),
      ],
    },
    {
      kind: 'comment',
      id: 'IC1',
      comments: [comment('IC1', 'general remark', '2026-09-21T09:00:00Z')],
    },
    {
      kind: 'review',
      id: 'R1',
      state: 'APPROVED',
      comments: [comment('R1', 'LGTM', '2026-09-20T18:00:00Z')],
    },
  ]

  it('leads with the description, then the conversation in time order, then inline threads', () => {
    const threads = threadsFromGithub(fixturePr(), imported, [file])
    expect(threads.map((t) => t.id)).toEqual([
      'gh:description:PR_kwDO_482',
      'gh:R1',
      'gh:IC1',
      'gh:T1',
    ])
    expect(threads.every((t) => t.audience === 'pr')).toBe(true)
  })

  it('carries the PR author on the description and the verdict on a review', () => {
    const [description, review] = threadsFromGithub(fixturePr(), imported, [file])
    expect(description!.messages[0]!.github?.user.login).toBe('mira-k')
    expect(description!.github?.kind).toBe('description')
    expect(review!.github?.reviewState).toBe('APPROVED')
    expect(review!.anchor).toEqual({ kind: 'changeset' })
  })

  it('maps inline comments to github-authored messages and mirrors resolution', () => {
    const inline = threadsFromGithub(fixturePr(), imported, [file]).at(-1)!
    expect(inline.state).toBe('resolved')
    expect(inline.messages.map((m) => [m.author, m.github?.id])).toEqual([
      ['github', 'C1'],
      ['github', 'C2'],
    ])
    expect(inline.anchor.kind).toBe('hunk')
    expect(inline.github?.outdated).toBe(false)
  })

  it('marks an unplaceable inline thread outdated even when GitHub did not', () => {
    const gone: ImportedThread = { ...(imported[0] as ImportedInlineThread), line: 999 }
    const thread = threadsFromGithub(fixturePr(), [gone], [file]).at(-1)!
    expect(thread.anchor).toEqual({ kind: 'file', path: 'src/upload.ts' })
    expect(thread.github?.outdated).toBe(true)
  })

  it('writes a placeholder body when the PR has no description', () => {
    const [description] = threadsFromGithub(fixturePr({ body: '  ' }), [], [file])
    expect(description!.messages[0]!.text).toBe('_No description._')
  })
})

describe('githubPosition', () => {
  it('has no position for the changeset', () => {
    expect(githubPosition({ kind: 'changeset' }, 'x', [file])).toBeNull()
  })

  it('makes a FILE comment of a file anchor', () => {
    expect(githubPosition({ kind: 'file', path: 'src/upload.ts' }, 'x', [file])).toEqual({
      draft: { path: 'src/upload.ts', body: 'x', subjectType: 'FILE' },
      downgraded: false,
    })
  })

  it('positions a new-side line on RIGHT and an old-side line on LEFT', () => {
    expect(
      githubPosition(
        { kind: 'hunk', hunkId: 'h1', path: 'src/upload.ts', side: 'new', line: 12 },
        'x',
        [file],
      ),
    ).toEqual({
      draft: { path: 'src/upload.ts', body: 'x', subjectType: 'LINE', line: 12, side: 'RIGHT' },
      downgraded: false,
    })
    expect(
      githubPosition(
        { kind: 'hunk', hunkId: 'h1', path: 'src/upload.ts', side: 'old', line: 11 },
        'x',
        [file],
      )!.draft,
    ).toMatchObject({ line: 11, side: 'LEFT' })
  })

  it('opens a range with startLine on the same side', () => {
    expect(
      githubPosition(
        { kind: 'hunk', hunkId: 'h1', path: 'src/upload.ts', side: 'new', line: 11, endLine: 13 },
        'x',
        [file],
      )!.draft,
    ).toEqual({
      path: 'src/upload.ts',
      body: 'x',
      subjectType: 'LINE',
      line: 13,
      side: 'RIGHT',
      startLine: 11,
      startSide: 'RIGHT',
    })
  })

  it('downgrades a line outside the diff to a FILE comment and says so', () => {
    expect(
      githubPosition(
        { kind: 'hunk', hunkId: 'h1', path: 'src/upload.ts', side: 'new', line: 200 },
        'x',
        [file],
      ),
    ).toEqual({
      draft: { path: 'src/upload.ts', body: 'x', subjectType: 'FILE' },
      downgraded: true,
    })
  })
})
