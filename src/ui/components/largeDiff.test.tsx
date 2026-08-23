// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DiffLine, FileChange } from '../../shared/types.js'
import { ReadingPane } from './ReadingPane.js'

vi.mock('../highlight.js', () => ({
  tokenizeLines: async () => null,
  langForPath: () => null,
}))

afterEach(cleanup)

function bigFile(path = 'src/big.ts', changed = 500): FileChange {
  const lines: DiffLine[] = Array.from(
    { length: changed },
    (_, i): DiffLine => ({ kind: 'add', oldNo: null, newNo: i + 1, text: `line ${i + 1}` }),
  )
  return {
    path,
    oldPath: null,
    status: 'added',
    kind: 'text',
    staged: false,
    hunks: [{ id: 'h-big', path, oldStart: 0, newStart: 1, lines }],
  }
}

const STUB_NOTE = /not rendered by default/

describe('large-diff stub', () => {
  it('stubs a large file behind a note and renders it on Load diff', () => {
    render(<ReadingPane files={[bigFile()]} />)
    expect(screen.getByText(STUB_NOTE).textContent).toContain('500 changed lines')
    expect(screen.queryByText('line 1')).toBeNull()
    fireEvent.click(screen.getByText('Load diff'))
    expect(screen.getByText('line 1')).toBeTruthy()
    expect(screen.queryByText(STUB_NOTE)).toBeNull()
  })

  it('stubs a lockfile with its own wording even when the diff is small', () => {
    const lock = bigFile('pnpm-lock.yaml', 5)
    render(<ReadingPane files={[lock]} />)
    expect(screen.getByText(/Generated file/)).toBeTruthy()
    expect(screen.queryByText('line 1')).toBeNull()
  })

  it('never stubs the hunk keyboard navigation has selected', () => {
    render(<ReadingPane files={[bigFile()]} selectedId="h-big" />)
    expect(screen.queryByText(STUB_NOTE)).toBeNull()
    expect(screen.getByText('line 1')).toBeTruthy()
  })

  it('leaves small files alone', () => {
    render(<ReadingPane files={[bigFile('src/small.ts', 30)]} />)
    expect(screen.queryByText(STUB_NOTE)).toBeNull()
    expect(screen.getByText('line 1')).toBeTruthy()
  })
})
