// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { FileChange } from '../../shared/types.js'
import { canPreviewMarkdown, MarkdownPreview } from './MarkdownPreview.js'
import { ReadingPane } from './ReadingPane.js'

vi.mock('../highlight.js', () => ({
  tokenizeLines: async () => null,
  langForPath: () => null,
}))

vi.mock('../mermaid.js', () => ({
  renderMermaidIn: async () => {},
}))

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

function file(path: string, status: FileChange['status'] = 'modified'): FileChange {
  return { path, oldPath: null, status, kind: 'text', staged: false, hunks: [] }
}

describe('canPreviewMarkdown', () => {
  it('is markdown extensions on any side that still has a head file', () => {
    expect(canPreviewMarkdown(file('README.md'))).toBe(true)
    expect(canPreviewMarkdown(file('docs/GUIDE.markdown', 'added'))).toBe(true)
    expect(canPreviewMarkdown(file('notes.MD'))).toBe(true)
    expect(canPreviewMarkdown(file('src/index.ts'))).toBe(false)
    expect(canPreviewMarkdown(file('README.md', 'deleted'))).toBe(false)
  })
})

describe('markdown preview', () => {
  it('shows a preview button on markdown files only', () => {
    render(<ReadingPane files={[file('README.md'), file('src/index.ts')]} />)
    expect(screen.getByLabelText('Preview README.md rendered')).toBeTruthy()
    expect(screen.queryByLabelText('Preview src/index.ts rendered')).toBeNull()
  })

  it('opens a modal that fetches the head side and renders it', async () => {
    const fetchMock = vi.fn(async () => new Response('# Title\n\nSome *prose*.', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    render(<ReadingPane files={[file('README.md')]} />)
    fireEvent.click(screen.getByLabelText('Preview README.md rendered'))
    await waitFor(() =>
      expect(screen.getByRole('heading', { level: 1, name: 'Title' })).toBeTruthy(),
    )
    expect(fetchMock).toHaveBeenCalledWith('/api/file?path=README.md&side=head')
    expect(screen.getByRole('dialog')).toBeTruthy()
    fireEvent.click(screen.getByLabelText('Close'))
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('says so when the file cannot be read', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('gone', { status: 404 })),
    )
    render(<MarkdownPreview path="README.md" onClose={() => {}} />)
    await waitFor(() => expect(screen.getByText(/couldn't read this file/)).toBeTruthy())
  })

  it('closing via the backdrop never collapses the file behind it', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('hello', { status: 200 })),
    )
    const onToggleCollapsed = vi.fn()
    render(
      <ReadingPane
        files={[file('README.md')]}
        collapsed={new Set()}
        onToggleCollapsed={onToggleCollapsed}
      />,
    )
    fireEvent.click(screen.getByLabelText('Preview README.md rendered'))
    await waitFor(() => expect(screen.getByText('hello')).toBeTruthy())
    fireEvent.click(document.querySelector('.modal-backdrop')!)
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(onToggleCollapsed).not.toHaveBeenCalled()
  })
})
