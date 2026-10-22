// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { type CommitInfo, type FileChange, type Hunk, UNCOMMITTED } from '../../shared/types.js'
import { CommitRail, commitProgress } from './CommitRail.js'

afterEach(cleanup)

const hunk = (path: string, n: number): Hunk => ({
  id: `${path}#${n}`,
  path,
  oldStart: 1,
  newStart: 1,
  lines: [],
})

const file = (path: string, hunks = 1): FileChange => ({
  path,
  oldPath: null,
  status: 'modified',
  kind: 'text',
  staged: false,
  hunks: Array.from({ length: hunks }, (_, i) => hunk(path, i + 1)),
})

const commit = (sha: string, subject: string, over: Partial<CommitInfo> = {}): CommitInfo => ({
  sha,
  short: sha.slice(0, 7),
  subject,
  body: '',
  author: 'Ada',
  at: null,
  stats: { files: 1, additions: 3, deletions: 1 },
  ...over,
})

const COMMITS = [
  commit('aaaaaaa1', 'Parse the date'),
  commit('bbbbbbb2', 'Resolve weekdays'),
  commit(UNCOMMITTED, 'Uncommitted changes', { short: '', author: null }),
]
const FILES = new Map([
  ['aaaaaaa1', [file('src/parse.ts', 2)]],
  ['bbbbbbb2', [file('src/dates.ts'), file('src/weekday.ts')]],
  [UNCOMMITTED, [file('README.md')]],
])

const rail = (over: Partial<Parameters<typeof CommitRail>[0]> = {}) =>
  render(
    <CommitRail
      commits={COMMITS}
      filesBySha={FILES}
      activeSha="aaaaaaa1"
      onPick={vi.fn()}
      viewed={new Set()}
      {...over}
    />,
  )

describe('CommitRail', () => {
  it('lists commits in order, the active one current, with who and size', () => {
    const { container } = rail()
    const rows = [...container.querySelectorAll('.row-commit')]
    expect(rows.map((r) => r.querySelector('.row-base')?.textContent)).toEqual([
      'Parse the date',
      'Resolve weekdays',
      'Uncommitted changes',
    ])
    expect(rows[0]!.getAttribute('aria-current')).toBe('true')
    expect(rows[0]!.textContent).toContain('aaaaaaa · Ada')
    expect(rows[0]!.textContent).toContain('+3')
  })

  it('picks a commit from its row', () => {
    const onPick = vi.fn()
    rail({ onPick })
    fireEvent.click(screen.getByText('Resolve weekdays'))
    expect(onPick).toHaveBeenCalledWith('bbbbbbb2')
  })

  it('rolls up the marks of the commit’s own files, and marks them in one click', () => {
    const onMarkCommitFiles = vi.fn()
    rail({ viewed: new Set(['src/dates.ts#1']), onMarkCommitFiles })
    const box = screen.getByRole('checkbox', { name: /in Resolve weekdays reviewed/ })
    expect(box.getAttribute('aria-checked')).toBe('mixed')
    fireEvent.click(box)
    expect(onMarkCommitFiles).toHaveBeenCalledWith([FILES.get('bbbbbbb2')![1]])
  })

  it('opens a commit’s files as a tree', () => {
    rail()
    fireEvent.click(screen.getByRole('button', { name: 'Show the files in Resolve weekdays' }))
    expect(screen.getByText('weekday.ts')).toBeTruthy()
  })

  it('explains an empty list on a working-tree review', () => {
    rail({ commits: [] })
    expect(screen.getByText(/review is of uncommitted changes/)).toBeTruthy()
  })
})

describe('commitProgress', () => {
  it('counts files and marks of the commit’s own diff', () => {
    const files = FILES.get('bbbbbbb2')!
    expect(commitProgress(files, new Set(['src/dates.ts#1']))).toEqual({
      files: 2,
      doneFiles: 1,
      marks: 2,
      doneMarks: 1,
    })
  })
})
