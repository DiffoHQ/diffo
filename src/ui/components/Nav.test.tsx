// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ReviewThread } from '../../shared/review.js'
import type { DiffLine, FileChange, Hunk, LineKind } from '../../shared/types.js'
import { fileMark } from '../fileMarks.js'
import { buildTree, Nav, type TreeDir, type TreeNode } from './Nav.js'

afterEach(cleanup)

function hunk(path: string, id: string, lines: DiffLine[] = []): Hunk {
  return { id, path, oldStart: 1, newStart: 1, lines }
}

const line = (kind: LineKind): DiffLine => ({ kind, oldNo: 1, newNo: 1, text: 'x' })

function file(
  path: string,
  status: FileChange['status'] = 'modified',
  hunkIds = ['h'],
): FileChange {
  return {
    path,
    oldPath: null,
    status,
    kind: 'text',
    staged: false,
    hunks: hunkIds.map((id) => hunk(path, `${path}:${id}`)),
  }
}

const FILES = [file('src/server/git.ts'), file('src/ui/App.tsx'), file('docs/index.md', 'added')]

const names = () => [...document.querySelectorAll('.row-base')].map((n) => n.textContent)
const fileRows = () => [...document.querySelectorAll('.row:not(.row-dir)')]

const shape = (nodes: TreeNode[]): unknown =>
  nodes.map((n) => (n.kind === 'dir' ? { [n.name]: shape(n.children) } : n.file.path))

describe('buildTree', () => {
  it('nests shared prefixes under one folder', () => {
    const tree = buildTree([file('src/server/a.ts'), file('src/ui/b.ts'), file('src/c.ts')])
    expect(shape(tree)).toEqual([
      { src: [{ server: ['src/server/a.ts'] }, { ui: ['src/ui/b.ts'] }, 'src/c.ts'] },
    ])
  })

  it("compresses a single-child directory chain into one row — GitHub's trick", () => {
    const tree = buildTree([file('i18n/locales/en/app.json'), file('root.md')])
    expect(shape(tree)).toEqual([{ 'i18n/locales/en': ['i18n/locales/en/app.json'] }, 'root.md'])
    expect((tree[0] as TreeDir).path).toBe('i18n/locales/en')
  })

  it('does not compress a directory that has files of its own', () => {
    const tree = buildTree([file('src/ui/a.ts'), file('src/b.ts')])
    expect(shape(tree)).toEqual([{ src: [{ ui: ['src/ui/a.ts'] }, 'src/b.ts'] }])
  })

  it('sorts folders before files, each alphabetically', () => {
    const tree = buildTree([file('z.md'), file('a/x.ts'), file('b.md'), file('c/y.ts')])
    expect(shape(tree)).toEqual([{ a: ['a/x.ts'] }, { c: ['c/y.ts'] }, 'b.md', 'z.md'])
  })
})

describe('Nav', () => {
  it('renders the tree: folders nest, files sit under them by basename', () => {
    render(<Nav files={FILES} />)
    expect(names()).toEqual(['docs', 'index.md', 'src', 'server', 'git.ts', 'ui', 'App.tsx'])
    expect(
      [...document.querySelectorAll('.row:not(.row-dir) .row-pick')].map((b) =>
        b.getAttribute('title'),
      ),
    ).toEqual(['docs/index.md · new file', 'src/server/git.ts · edited', 'src/ui/App.tsx · edited'])
  })

  it('folds a folder on click and remembers deeper state elsewhere', () => {
    render(<Nav files={FILES} />)
    fireEvent.click(screen.getByText('src'))
    expect(names()).toEqual(['docs', 'index.md', 'src'])
    fireEvent.click(screen.getByText('src'))
    expect(names()).toEqual(['docs', 'index.md', 'src', 'server', 'git.ts', 'ui', 'App.tsx'])
  })

  it('filters by query and forces surviving folders open', () => {
    render(<Nav files={FILES} />)
    fireEvent.click(screen.getByText('src'))
    fireEvent.change(screen.getByLabelText('Filter files'), { target: { value: 'git' } })
    expect(names()).toEqual(['src/server', 'git.ts'])
  })

  it('shows an empty message when nothing matches', () => {
    render(<Nav files={FILES} />)
    fireEvent.change(screen.getByLabelText('Filter files'), { target: { value: 'zzz' } })
    expect(screen.getByText('no files match')).toBeTruthy()
  })

  it('clearing the filter is one click — ours, not the platform-blue one', () => {
    render(<Nav files={FILES} />)
    expect(screen.queryByLabelText('Clear filter')).toBeNull()
    fireEvent.change(screen.getByLabelText('Filter files'), { target: { value: 'zzz' } })
    fireEvent.click(screen.getByLabelText('Clear filter'))
    expect(names()).toEqual(['docs', 'index.md', 'src', 'server', 'git.ts', 'ui', 'App.tsx'])
    expect(screen.queryByLabelText('Clear filter')).toBeNull()
  })

  it('when the app drives the filter, keystrokes report up and the value is obeyed', () => {
    const onQuery = vi.fn()
    const { rerender } = render(<Nav files={FILES} query="git" onQuery={onQuery} />)
    expect(names()).toEqual(['src/server', 'git.ts'])
    fireEvent.change(screen.getByLabelText('Filter files'), { target: { value: 'app' } })
    expect(onQuery).toHaveBeenCalledWith('app')
    // The box did not move on its own — the app owns the value.
    expect((screen.getByLabelText('Filter files') as HTMLInputElement).value).toBe('git')
    rerender(<Nav files={FILES} query="app" onQuery={onQuery} />)
    expect(names()).toEqual(['src/ui', 'App.tsx'])
    fireEvent.click(screen.getByLabelText('Clear filter'))
    expect(onQuery).toHaveBeenCalledWith('')
  })

  it('a file click hands the pick to the app, which expands the file first', () => {
    const onPickFile = vi.fn()
    render(<Nav files={FILES} onPickFile={onPickFile} />)
    fireEvent.click(screen.getByText('git.ts'))
    expect(onPickFile).toHaveBeenCalledWith('src/server/git.ts')
  })

  it('a reviewed file dims in place with a tick — it never jumps to a bucket', () => {
    const onToggleFileViewed = vi.fn()
    const files = [file('src/a.ts'), file('src/b.ts')]
    const { rerender } = render(
      <Nav files={files} viewed={new Set()} onToggleFileViewed={onToggleFileViewed} />,
    )
    expect(screen.getByText('2 left to review')).toBeTruthy()

    fireEvent.click(screen.getByLabelText('Mark reviewed: src/a.ts'))
    expect(onToggleFileViewed).toHaveBeenCalledWith('src/a.ts')

    rerender(
      <Nav
        files={files}
        viewed={new Set(['src/a.ts:h'])}
        onToggleFileViewed={onToggleFileViewed}
      />,
    )
    expect(names()).toEqual(['src', 'a.ts', 'b.ts'])
    const done = document.querySelector('.row-done')!
    expect(done.textContent).toContain('a.ts')
    expect(done.querySelector('[aria-label="Mark not reviewed: src/a.ts"]')).toBeTruthy()
    expect(screen.getByText('1 left to review')).toBeTruthy()
  })

  it('the tally reports the whole changeset even while a filter narrows the view', () => {
    render(<Nav files={FILES} viewed={new Set()} />)
    fireEvent.change(screen.getByLabelText('Filter files'), { target: { value: 'git' } })
    expect(screen.getByText('3 left to review')).toBeTruthy()
  })

  it('says "all reviewed" when the queue is empty', () => {
    render(<Nav files={[file('src/a.ts')]} viewed={new Set(['src/a.ts:h'])} />)
    expect(screen.getByText('all reviewed')).toBeTruthy()
  })

  it('a folder whose every file is reviewed dims and takes the tick', () => {
    render(<Nav files={[file('src/a.ts'), file('docs/b.md')]} viewed={new Set(['src/a.ts:h'])} />)
    const dirs = [...document.querySelectorAll('.row-dir')]
    expect(dirs.map((d) => `${d.textContent}:${d.classList.contains('row-done')}`)).toEqual([
      'docs:false',
      'src:true',
    ])
  })

  it("a folder's box retires everything unreviewed under it", () => {
    const onMarkFiles = vi.fn()
    const files = [file('src/a.ts'), file('src/deep/b.ts'), file('docs/c.md')]
    render(<Nav files={files} viewed={new Set(['src/a.ts:h'])} onMarkFiles={onMarkFiles} />)
    fireEvent.click(screen.getByLabelText('Mark 1 file in src reviewed'))
    expect(onMarkFiles).toHaveBeenCalledWith(['src/deep/b.ts'])
  })

  it("a folder's box is indeterminate while only some of it is read", () => {
    render(
      <Nav
        files={[file('src/a.ts'), file('src/b.ts'), file('docs/c.md')]}
        viewed={new Set(['src/a.ts:h'])}
      />,
    )
    const boxes = [...document.querySelectorAll('.row-dir .row-box')]
    expect(boxes.map((b) => b.getAttribute('aria-checked'))).toEqual(['false', 'mixed'])
  })

  it('a folder already done gives itself back', () => {
    const onClearFiles = vi.fn()
    render(
      <Nav
        files={[file('src/a.ts'), file('src/b.ts')]}
        viewed={new Set(['src/a.ts:h', 'src/b.ts:h'])}
        onClearFiles={onClearFiles}
      />,
    )
    const box = document.querySelector('.row-dir .row-box')!
    expect(box.getAttribute('aria-checked')).toBe('true')
    fireEvent.click(box)
    expect(onClearFiles).toHaveBeenCalledWith(['src/a.ts', 'src/b.ts'])
  })

  it('the folder box retires everything under it, hunkless files included', () => {
    const rename: FileChange = {
      path: 'src/new.ts',
      oldPath: 'src/old.ts',
      status: 'renamed',
      kind: 'text',
      staged: false,
      hunks: [],
    }
    const onMarkFiles = vi.fn()
    render(<Nav files={[rename, file('src/a.ts')]} viewed={new Set()} onMarkFiles={onMarkFiles} />)
    fireEvent.click(screen.getByLabelText('Mark 2 files in src reviewed'))
    expect(onMarkFiles).toHaveBeenCalledWith(['src/a.ts', 'src/new.ts'])
  })

  it('"Hide reviewed" reports up, and collapses the tree when the app says so', () => {
    const onHideReviewed = vi.fn()
    const files = [file('src/a.ts'), file('src/b.ts')]
    const { rerender } = render(
      <Nav
        files={files}
        viewed={new Set(['src/a.ts:h'])}
        hideReviewed={false}
        onHideReviewed={onHideReviewed}
      />,
    )
    fireEvent.click(screen.getByLabelText('Filter options'))
    fireEvent.click(screen.getByText('Hide reviewed'))
    expect(onHideReviewed).toHaveBeenCalledWith(true)
    expect(names()).toEqual(['src', 'a.ts', 'b.ts'])

    rerender(
      <Nav
        files={files}
        viewed={new Set(['src/a.ts:h'])}
        hideReviewed={true}
        onHideReviewed={onHideReviewed}
      />,
    )
    expect(names()).toEqual(['src', 'b.ts'])
  })

  it('"Hide tests" hides the .test. twins and says how many it is hiding', () => {
    const onHideTests = vi.fn()
    const files = [file('src/a.ts'), file('src/a.test.ts'), file('src/b.spec.ts')]
    const { rerender } = render(<Nav files={files} hideTests={false} onHideTests={onHideTests} />)
    fireEvent.click(screen.getByLabelText('Filter options'))
    expect(screen.getByText('Hide tests').parentElement!.textContent).toContain('2')
    fireEvent.click(screen.getByText('Hide tests'))
    expect(onHideTests).toHaveBeenCalledWith(true)

    rerender(<Nav files={files} hideTests={true} onHideTests={onHideTests} />)
    expect(names()).toEqual(['src', 'a.ts'])
  })

  it('offers no filter menu at all when the app drives none of the switches', () => {
    render(<Nav files={FILES} />)
    expect(screen.queryByLabelText('Filter options')).toBeNull()
  })

  it('"Only since review" narrows to what the agent rewrote — and only exists when that means something', () => {
    const onOnlyChanged = vi.fn()
    const { rerender } = render(
      <Nav
        files={[file('src/a.ts'), file('src/b.ts')]}
        changed={new Set(['src/b.ts'])}
        onlyChanged={false}
        onOnlyChanged={onOnlyChanged}
      />,
    )
    fireEvent.click(screen.getByLabelText('Filter options'))
    expect(screen.getByText('Only since review').parentElement!.textContent).toContain('1')
    fireEvent.click(screen.getByText('Only since review'))
    expect(onOnlyChanged).toHaveBeenCalledWith(true)
    rerender(
      <Nav
        files={[file('src/a.ts'), file('src/b.ts')]}
        changed={new Set(['src/b.ts'])}
        onlyChanged={true}
        onOnlyChanged={onOnlyChanged}
      />,
    )
    expect(names()).toEqual(['src', 'b.ts'])
    rerender(
      <Nav
        files={[file('src/a.ts')]}
        changed={new Set()}
        onlyChanged={false}
        onOnlyChanged={onOnlyChanged}
      />,
    )
    fireEvent.click(screen.getByLabelText('Filter options'))
    expect(screen.queryByText('Only since review')).toBeNull()
  })

  it('a row is a container, never a button — a button cannot contain a button', () => {
    render(<Nav files={[file('src/a.ts')]} viewed={new Set()} onToggleFileViewed={() => {}} />)
    for (const row of document.querySelectorAll('.row')) {
      expect(row.tagName).toBe('DIV')
      expect(row.querySelector('button button')).toBeNull()
    }
  })

  it('the right slot shows a thread count', () => {
    const thread = { id: 't-1' } as ReviewThread
    render(<Nav files={[file('src/a.ts')]} threads={new Map([['src/a.ts', [thread, thread]]])} />)
    expect(document.querySelector('.row-count')!.textContent).toContain('2')
  })

  it('git status rides in the name: + born, − died, nothing for an edit', () => {
    render(
      <Nav
        files={[file('docs/new.md', 'added'), file('docs/old.md', 'deleted'), file('docs/m.md')]}
      />,
    )
    const rows = fileRows()
    expect(rows[1]!.querySelector('.row-st-add')!.textContent).toBe('+')
    expect(rows[2]!.querySelector('.row-st-del')!.textContent).toBe('−')
    expect(rows[2]!.querySelector('.row-base-del')).toBeTruthy()
    expect(rows[0]!.querySelector('.row-st')).toBeNull()
  })

  it('a rename says where it came from', () => {
    const renamed: FileChange = {
      ...file('src/cfg.ts'),
      oldPath: 'src/env.ts',
      status: 'renamed',
    }
    render(<Nav files={[renamed]} />)
    expect(document.querySelector('.row-was')!.textContent).toBe('env.ts →')
  })

  it('reading a file no longer erases what git did to it', () => {
    render(<Nav files={[file('docs/new.md', 'added')]} viewed={new Set(['docs/new.md:h'])} />)
    expect(
      document.querySelector('.row:not(.row-dir) .row-box')!.getAttribute('aria-checked'),
    ).toBe('true')
    expect(document.querySelector('.row-st-add')).toBeTruthy()
  })

  it('the tooltip carries the diffstat the row no longer shows', () => {
    const mixed: FileChange = {
      ...file('src/a.ts'),
      hunks: [hunk('src/a.ts', 'h', [line('add'), line('add'), line('del'), line('context')])],
    }
    render(<Nav files={[mixed]} />)
    expect(fileRows()[0]!.querySelector('.row-pick')!.getAttribute('title')).toBe(
      'src/a.ts · edited · +2 −1',
    )
  })

  it('a file with nothing to read still gets a box to tick', () => {
    const rename: FileChange = {
      path: 'src/new.ts',
      oldPath: 'src/old.ts',
      status: 'renamed',
      kind: 'text',
      staged: false,
      hunks: [],
    }
    const marked: string[] = []
    render(<Nav files={[rename]} viewed={new Set()} onToggleFileViewed={(p) => marked.push(p)} />)
    const box = document.querySelector('.row:not(.row-dir) .row-box')!
    expect(box.getAttribute('aria-checked')).toBe('false')
    fireEvent.click(box)
    expect(marked).toEqual(['src/new.ts'])
  })

  it('reads as done once its own mark is set', () => {
    const rename: FileChange = {
      path: 'src/new.ts',
      oldPath: 'src/old.ts',
      status: 'renamed',
      kind: 'text',
      staged: false,
      hunks: [],
    }
    render(<Nav files={[rename]} viewed={new Set([fileMark(rename)])} />)
    expect(
      document.querySelector('.row:not(.row-dir) .row-box')!.getAttribute('aria-checked'),
    ).toBe('true')
  })

  it('the box carries the read state, and says which file it belongs to', () => {
    const [first] = FILES
    render(
      <Nav
        files={[first!]}
        viewed={new Set(first!.hunks.map((h) => h.id))}
        onToggleFileViewed={() => {}}
      />,
    )
    const box = document.querySelector('.row:not(.row-dir) .row-box')!
    expect(box.getAttribute('aria-checked')).toBe('true')
    expect(box.getAttribute('aria-label')).toBe(`Mark not reviewed: ${first!.path}`)
  })

  it('says the one thing you cannot know unaided: the agent rewrote it', () => {
    render(<Nav files={FILES} viewed={new Set()} changed={new Set(['src/server/git.ts'])} />)
    expect(document.querySelectorAll('.row-since')).toHaveLength(1)
    expect(screen.getByLabelText('changed since your last review')).toBeTruthy()
    expect(screen.queryByText('skipped')).toBeNull()
  })

  it('with no round sent, no file carries a reason — there is no "since" yet', () => {
    render(<Nav files={FILES} viewed={new Set()} />)
    expect(document.querySelectorAll('.row-since')).toHaveLength(0)
  })
})
