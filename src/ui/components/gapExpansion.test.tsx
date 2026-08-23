// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { FileChange, Hunk } from '../../shared/types.js'
import { EMPTY_DELTA } from '../liveDelta.js'
import { FileBody } from './ReadingPane.js'

vi.mock('../highlight.js', () => ({
  tokenizeLines: async () => null,
  langForPath: () => null,
}))

afterEach(cleanup)

const FILE_TEXT = Array.from({ length: 794 }, (_, i) => `line ${i + 1}`).join('\n')

const HUNK: Hunk = {
  id: 'h4',
  path: 'src/server/index.ts',
  oldStart: 677,
  newStart: 713,
  lines: [
    { kind: 'context', oldNo: 677, newNo: 713, text: 'console.log(a)' },
    { kind: 'add', oldNo: null, newNo: 714, text: '  const unsubscribeBatch = 1' },
  ],
}

function file(hunks: Hunk[], newLineCount: number | null = 794): FileChange {
  return {
    path: 'src/server/index.ts',
    oldPath: null,
    status: 'modified',
    kind: 'text',
    staged: false,
    hunks,
    newLineCount,
  }
}

function renderBody(f: FileChange) {
  return render(<FileBody file={f} delta={EMPTY_DELTA} handlers={{}} />)
}

const FAILED = /couldn't read more context/

const byLabel = (label: string) => screen.getByLabelText(label)

describe('gap expansion', () => {
  it('expand up reveals 20 lines glued above the hunk', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(FILE_TEXT, { status: 200 })),
    )
    renderBody(file([HUNK]))
    fireEvent.click(byLabel('expand up'))
    await waitFor(() => expect(screen.getByText('line 693')).toBeTruthy())
    expect(screen.getByText('line 712')).toBeTruthy()
    expect(screen.queryByText('line 692')).toBeNull()
    expect(screen.queryByText(FAILED)).toBeNull()
  })

  it('the tail gap expands down below the last hunk', async () => {
    vi.stubGlobal('fetch', async () => new Response(FILE_TEXT, { status: 200 }))
    renderBody(file([HUNK]))
    fireEvent.click(byLabel('expand down'))
    await waitFor(() => expect(screen.getByText('line 715')).toBeTruthy())
    expect(screen.getByText('line 734')).toBeTruthy()
    expect(screen.queryByText('line 735')).toBeNull()
  })

  it('no tail expander without a head line count', () => {
    renderBody(file([HUNK], null))
    expect(screen.queryByLabelText('expand down')).toBeNull()
  })

  it('a gap that fits one step offers a single expand-all, then merges into a hairline', async () => {
    vi.stubGlobal('fetch', async () => new Response(FILE_TEXT, { status: 200 }))
    const near: Hunk = {
      ...HUNK,
      id: 'h1',
      oldStart: 7,
      newStart: 10,
      lines: [{ kind: 'context', oldNo: 7, newNo: 10, text: 'ctx' }],
    }
    const { container } = renderBody(file([near], null))
    fireEvent.click(byLabel('expand all 9 hidden lines'))
    await waitFor(() => expect(screen.getByText('line 1')).toBeTruthy())
    expect(screen.getByText('line 9')).toBeTruthy()
    expect(container.querySelector('.hunk-boundary-merged')).toBeTruthy()
    // and the hairline can fold it all back
    fireEvent.click(byLabel('hide expanded lines'))
    expect(screen.queryByText('line 1')).toBeNull()
    expect(container.querySelector('.hunk-boundary-merged')).toBeNull()
  })

  it('a between-hunks gap expands down from the band, gluing lines to the hunk above', async () => {
    vi.stubGlobal('fetch', async () => new Response(FILE_TEXT, { status: 200 }))
    const first: Hunk = {
      ...HUNK,
      id: 'h1',
      oldStart: 100,
      newStart: 100,
      lines: [{ kind: 'context', oldNo: 100, newNo: 100, text: 'first hunk' }],
    }
    // no tail gap (newLineCount null), so the middle band owns the only ⬇
    renderBody(file([first, HUNK], null))
    fireEvent.click(byLabel('expand down'))
    await waitFor(() => expect(screen.getByText('line 101')).toBeTruthy())
    expect(screen.getByText('line 120')).toBeTruthy()
    expect(screen.queryByText('line 121')).toBeNull()
  })

  it('says so when /api/file refuses instead of doing nothing', async () => {
    vi.stubGlobal('fetch', async () => new Response('nope', { status: 404 }))
    renderBody(file([HUNK]))
    fireEvent.click(byLabel('expand up'))
    await waitFor(() => expect(screen.getByText(FAILED)).toBeTruthy())
  })

  it('says so when the fetch itself blows up', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new Error('offline')
    })
    renderBody(file([HUNK]))
    fireEvent.click(byLabel('expand up'))
    await waitFor(() => expect(screen.getByText(FAILED)).toBeTruthy())
  })

  it('says so when the file on disk no longer reaches the hunk', async () => {
    vi.stubGlobal('fetch', async () => new Response('line 1\nline 2\n', { status: 200 }))
    renderBody(file([HUNK]))
    fireEvent.click(byLabel('expand up'))
    await waitFor(() => expect(screen.getByText(FAILED)).toBeTruthy())
  })

  it('clears the failure note once an expansion lands', async () => {
    let ok = false
    vi.stubGlobal('fetch', async () =>
      ok ? new Response(FILE_TEXT, { status: 200 }) : new Response('nope', { status: 500 }),
    )
    renderBody(file([HUNK]))
    fireEvent.click(byLabel('expand up'))
    await waitFor(() => expect(screen.getByText(FAILED)).toBeTruthy())
    ok = true
    fireEvent.click(byLabel('expand up'))
    await waitFor(() => expect(screen.getByText('line 693')).toBeTruthy())
    expect(screen.queryByText(FAILED)).toBeNull()
  })

  it('offers no expanders at all on a hunk starting at line 1 with no tail', () => {
    const top: Hunk = {
      ...HUNK,
      id: 'h1',
      oldStart: 1,
      newStart: 1,
      lines: [
        { kind: 'context', oldNo: 1, newNo: 1, text: 'ctx' },
        { kind: 'add', oldNo: null, newNo: 2, text: 'added' },
      ],
    }
    const { container } = renderBody(file([top], 2))
    expect(container.querySelector('.gap-btn')).toBeNull()
  })

  it('deleted files cannot expand — there is no head side to read', () => {
    const f = { ...file([HUNK]), status: 'deleted' as const }
    const { container } = renderBody(f)
    expect(container.querySelector('.gap-btn')).toBeNull()
  })
})
