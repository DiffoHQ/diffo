// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FileChange, Hunk } from '../../shared/types.js'
import { fileMark } from '../fileMarks.js'
import { ReadingPane } from './ReadingPane.js'

vi.mock('../highlight.js', () => ({
  tokenizeLines: async () => null,
  langForPath: () => null,
}))

afterEach(cleanup)

function hunk(path: string, id: string, lines: Hunk['lines']): Hunk {
  return { id, path, oldStart: 1, newStart: 1, lines }
}

const FILES: FileChange[] = [
  {
    path: 'src/b.ts',
    oldPath: null,
    status: 'modified',
    kind: 'text',
    staged: false,
    hunks: [
      hunk('src/b.ts', 'hunk-1', [
        { kind: 'context', oldNo: 1, newNo: 1, text: 'const keep = true' },
        { kind: 'del', oldNo: 2, newNo: null, text: 'const removed = 1' },
        { kind: 'add', oldNo: null, newNo: 2, text: 'const added = 2' },
      ]),
      hunk('src/b.ts', 'hunk-2', [{ kind: 'add', oldNo: null, newNo: 9, text: 'later()' }]),
    ],
  },
  {
    path: 'src/renamed-new.ts',
    oldPath: 'src/renamed-old.ts',
    status: 'renamed',
    kind: 'text',
    staged: false,
    hunks: [],
  },
  { path: 'logo.png', oldPath: null, status: 'added', kind: 'image', staged: false, hunks: [] },
]

describe('ReadingPane', () => {
  it('renders files in order with their hunks as cards', () => {
    const { container } = render(<ReadingPane files={FILES} />)
    const sections = container.querySelectorAll('.file-section')
    expect(sections).toHaveLength(3)
    expect(sections[0]!.querySelectorAll('.hunk')).toHaveLength(2)
    const ids = [...sections[0]!.querySelectorAll('.hunk')].map((h) =>
      h.getAttribute('data-hunk-id'),
    )
    expect(ids).toEqual(['hunk-1', 'hunk-2'])
  })

  it('renders add, del, and context lines with markers and numbers', () => {
    const { container } = render(<ReadingPane files={[FILES[0]!]} />)
    const rows = container.querySelectorAll('.hunk .line')
    expect(rows[0]!.className).toContain('line-context')
    expect(rows[1]!.className).toContain('line-del')
    expect(rows[2]!.className).toContain('line-add')
    expect(rows[1]!.textContent).toContain('const removed = 1')
    expect(rows[2]!.textContent).toContain('const added = 2')
    const delCells = rows[1]!.querySelectorAll('.line-no')
    expect(delCells[0]!.textContent).toBe('2')
    expect(delCells[1]!.textContent).toBe('')
  })

  it('shows rename old → new path', () => {
    render(<ReadingPane files={[FILES[1]!]} />)
    expect(screen.getByText('src/renamed-old.ts')).toBeTruthy()
    expect(screen.getByText(/renamed-new\.ts/)).toBeTruthy()
  })

  it('renders image files side-by-side (head only when added) and stubs binaries', () => {
    const { container } = render(<ReadingPane files={[FILES[2]!]} />)
    expect(container.querySelectorAll('.image-side')).toHaveLength(1)
    expect(container.querySelector('.image-side-head img')?.getAttribute('src')).toContain(
      '/api/file?path=logo.png&side=head',
    )
    cleanup()
    const binary = { ...FILES[2]!, path: 'data.bin', kind: 'binary' as const }
    render(<ReadingPane files={[binary]} />)
    expect(screen.getByText('binary file changed')).toBeTruthy()
  })

  it('shows the empty state for a clean tree', () => {
    render(<ReadingPane files={[]} />)
    expect(screen.getByText('Nothing to review')).toBeTruthy()
  })

  it('collapsed files show only the headline, chevron flips, body returns on expand', () => {
    const collapsed = new Set([FILES[0]!.path])
    const { container, rerender } = render(
      <ReadingPane files={[FILES[0]!]} collapsed={collapsed} />,
    )
    expect(container.querySelectorAll('.hunk')).toHaveLength(0)
    expect(container.querySelector('.file-chevron')!.className).toContain('chevron-shut')
    expect(container.querySelector('.file-path')!.textContent).toContain('src/b.ts')
    rerender(<ReadingPane files={[FILES[0]!]} collapsed={new Set()} />)
    expect(container.querySelectorAll('.hunk')).toHaveLength(2)
    expect(container.querySelector('.file-chevron')!.className).not.toContain('chevron-shut')
  })

  it('renders icons, never emoji — an emoji cannot be sized or coloured', () => {
    const { container } = render(
      <ReadingPane
        files={[FILES[0]!]}
        comments={{
          partition: { byHunk: new Map(), byFile: new Map(), changeset: [] },
          actions: {
            create: async () => {
              throw new Error('unused')
            },
            reply: async () => {},
            send: async () => ({ delivered: false }),
            resolve: async () => {},
            reopen: async () => {},
          },
        }}
      />,
    )
    expect(container.querySelector('.file-comment-btn svg[data-icon="chat"]')).toBeTruthy()
    expect(container.textContent).not.toMatch(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u)
  })

  describe('changed since your last review — said once per file', () => {
    it('the header counts the owed hunks; no hunk repeats the words', () => {
      const { container } = render(
        <ReadingPane files={[FILES[0]!]} sinceReview={new Set(['hunk-2'])} />,
      )
      expect(screen.getByText('the agent changed 1 hunk')).toBeTruthy()
      expect(container.querySelectorAll('.hunk-badge')).toHaveLength(0)
      expect(container.querySelectorAll('.hunk-since-review')).toHaveLength(1)
    })

    it('a whole file the agent moved reads as "this", not a hunk tally', () => {
      render(<ReadingPane files={[FILES[0]!]} sinceReview={new Set(['hunk-1', 'hunk-2'])} />)
      expect(screen.getByText('the agent changed this')).toBeTruthy()
    })

    it('the count survives collapsing the file — the header is all that is left', () => {
      render(
        <ReadingPane
          files={[FILES[0]!]}
          sinceReview={new Set(['hunk-2'])}
          collapsed={new Set([FILES[0]!.path])}
        />,
      )
      expect(screen.getByText('the agent changed 1 hunk')).toBeTruthy()
    })

    it('says nothing when the round is drained', () => {
      const { container } = render(<ReadingPane files={[FILES[0]!]} sinceReview={new Set()} />)
      expect(container.querySelector('.file-since')).toBeNull()
    })
  })

  it('clicking the file header calls onToggleCollapsed with the path', () => {
    const calls: string[] = []
    const { container } = render(
      <ReadingPane files={[FILES[0]!]} onToggleCollapsed={(p) => calls.push(p)} />,
    )
    ;(container.querySelector('.file-header') as HTMLElement).click()
    expect(calls).toEqual(['src/b.ts'])
  })

  describe('file-level viewed', () => {
    it('the file header carries the Viewed checkbox, and the hunk header does not', () => {
      const calls: string[] = []
      const { container } = render(
        <ReadingPane
          files={[FILES[0]!]}
          viewed={new Set()}
          onToggleFileViewed={(p) => calls.push(p)}
        />,
      )
      expect(container.querySelector('.hunk-viewed-toggle')).toBeNull()

      const toggle = container.querySelector('.file-viewed-toggle')!
      expect(toggle.textContent).toContain('Viewed')
      expect(toggle.getAttribute('aria-pressed')).toBe('false')
      fireEvent.click(toggle)
      expect(calls).toEqual(['src/b.ts'])
    })

    it('checks itself only when every hunk in the file is viewed', () => {
      const { container, rerender } = render(
        <ReadingPane
          files={[FILES[0]!]}
          viewed={new Set(['hunk-1'])}
          onToggleFileViewed={() => {}}
        />,
      )
      const checked = () =>
        container.querySelector('.file-viewed-toggle')!.getAttribute('aria-pressed') === 'true'
      expect(checked()).toBe(false)

      rerender(
        <ReadingPane
          files={[FILES[0]!]}
          viewed={new Set(['hunk-1', 'hunk-2'])}
          onToggleFileViewed={() => {}}
        />,
      )
      expect(checked()).toBe(true)
    })

    it('offers the Viewed control on a file with nothing to read', () => {
      const marked: string[] = []
      const { container, rerender } = render(
        <ReadingPane
          files={[FILES[1]!]}
          viewed={new Set()}
          onToggleFileViewed={(p) => marked.push(p)}
        />,
      )
      const toggle = container.querySelector('.file-viewed-toggle')!
      expect(toggle.getAttribute('aria-pressed')).toBe('false')
      fireEvent.click(toggle)
      expect(marked).toEqual(['src/renamed-new.ts'])

      rerender(
        <ReadingPane
          files={[FILES[1]!]}
          viewed={new Set([fileMark(FILES[1]!)])}
          onToggleFileViewed={() => {}}
        />,
      )
      expect(container.querySelector('.file-viewed-toggle')!.getAttribute('aria-pressed')).toBe(
        'true',
      )
    })

    it('dims hunks only once the whole file is read — a half-reviewed file stays at full strength', () => {
      const { container, rerender } = render(
        <ReadingPane files={[FILES[0]!]} viewed={new Set(['hunk-1'])} />,
      )
      // hunk-1 is ticked, but hunk-2 is still owed: the ticked hunk is the context
      // the unread one gets judged by, so nothing fades yet.
      expect(container.querySelectorAll('.hunk-viewed')).toHaveLength(0)

      rerender(<ReadingPane files={[FILES[0]!]} viewed={new Set(['hunk-1', 'hunk-2'])} />)
      expect(container.querySelectorAll('.hunk-viewed')).toHaveLength(2)
    })

    it('toggling viewed does not fire the header collapse handler', () => {
      const collapse: string[] = []
      const { container } = render(
        <ReadingPane
          files={[FILES[0]!]}
          viewed={new Set()}
          onToggleFileViewed={() => {}}
          onToggleCollapsed={(p) => collapse.push(p)}
        />,
      )
      fireEvent.click(container.querySelector('.file-viewed-toggle')!)
      expect(collapse).toEqual([])
    })
  })

  describe('auto-load window', () => {
    it('renders a sentinel only while more files exist', () => {
      vi.stubGlobal(
        'IntersectionObserver',
        class {
          observe() {}
          disconnect() {}
        },
      )
      const { container, rerender } = render(
        <ReadingPane files={[FILES[0]!]} hasMore onLoadMore={() => {}} />,
      )
      expect(container.querySelector('.load-more')).toBeTruthy()
      rerender(<ReadingPane files={[FILES[0]!]} onLoadMore={() => {}} />)
      expect(container.querySelector('.load-more')).toBeNull()
      vi.unstubAllGlobals()
    })

    it('asks for the next batch when the sentinel comes into view', () => {
      let intersect: (entries: { isIntersecting: boolean }[]) => void = () => {}
      vi.stubGlobal(
        'IntersectionObserver',
        class {
          constructor(cb: typeof intersect) {
            intersect = cb
          }
          observe() {}
          disconnect() {}
        },
      )
      const calls: number[] = []
      render(<ReadingPane files={[FILES[0]!]} hasMore onLoadMore={() => calls.push(1)} />)
      expect(calls).toHaveLength(0)
      intersect([{ isIntersecting: true }])
      expect(calls).toHaveLength(1)
      vi.unstubAllGlobals()
    })

    it('without IntersectionObserver, asks for the rest rather than strand it', () => {
      const calls: number[] = []
      render(<ReadingPane files={[FILES[0]!]} hasMore onLoadMore={() => calls.push(1)} />)
      expect(calls).toHaveLength(1)
    })
  })

  it('commenting on a collapsed file expands it first, so the composer can show', () => {
    const collapse: string[] = []
    const { container } = render(
      <ReadingPane
        files={[FILES[0]!]}
        collapsed={new Set(['src/b.ts'])}
        onToggleCollapsed={(p) => collapse.push(p)}
        comments={{
          partition: { byHunk: new Map(), byFile: new Map(), changeset: [] },
          actions: {
            create: async () => {
              throw new Error('unused')
            },
            reply: async () => {},
            send: async () => ({ delivered: false }),
            resolve: async () => {},
            reopen: async () => {},
          },
        }}
      />,
    )
    fireEvent.click(container.querySelector('.file-comment-btn')!)
    expect(collapse).toEqual(['src/b.ts'])
  })
})

describe('ReadingPane — the pane bar', () => {
  const controls = (over: Partial<Parameters<typeof ReadingPane>[0]['controls']> = {}) => {
    const m = {
      left: 12,
      total: 30,
      hideReviewed: true,
      onHideReviewed: () => {},
      hideTests: false,
      onHideTests: () => {},
      testCount: 8,
      onlyChanged: false,
      onOnlyChanged: () => {},
      changedCount: 0,
      hiddenTests: 0,
      hiddenReviewed: 0,
      hiddenUnchanged: 0,
      pinned: new Set<string>(),
      onSweep: () => {},
      onShowAll: () => {},
      viewMode: 'unified' as const,
      onSetViewMode: () => {},
      allCollapsed: false,
      onToggleCollapseAll: () => {},
      ...over,
    }
    return {
      scopeLeft: m.left,
      scopeTotal: m.total,
      excludedTests: 0,
      excludedUnchanged: 0,
      ...m,
    }
  }

  it('counts down, and offers the filters as switches rather than tick-boxes', () => {
    const { container } = render(<ReadingPane files={[FILES[0]!]} controls={controls()} />)
    expect(screen.getByText('12 left')).toBeTruthy()
    const switches = [...container.querySelectorAll('.pane-bar [role="switch"]')]
    expect(switches.map((s) => s.textContent)).toEqual(['Hide reviewed', 'Hide tests8'])
    expect(container.querySelector('.pane-bar [role="checkbox"]')).toBeNull()
    expect(container.querySelector('.reading-pane-barred')).toBeTruthy()
  })

  it('carries the diff layout, with both modes shown and the current one pressed', () => {
    const onSetViewMode = vi.fn()
    render(
      <ReadingPane
        files={[FILES[0]!]}
        controls={controls({ viewMode: 'unified', onSetViewMode })}
      />,
    )
    expect(screen.getByLabelText('Unified diff').getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByLabelText('Split diff').getAttribute('aria-pressed')).toBe('false')
    fireEvent.click(screen.getByLabelText('Split diff'))
    expect(onSetViewMode).toHaveBeenCalledWith('split')
  })

  it('carries fold-all, which the header offered as an unlabelled icon', () => {
    const onToggleCollapseAll = vi.fn()
    const { rerender } = render(
      <ReadingPane files={[FILES[0]!]} controls={controls({ onToggleCollapseAll })} />,
    )
    fireEvent.click(screen.getByLabelText('Collapse all files'))
    expect(onToggleCollapseAll).toHaveBeenCalled()
    rerender(
      <ReadingPane
        files={[FILES[0]!]}
        controls={controls({ allCollapsed: true, onToggleCollapseAll })}
      />,
    )
    expect(screen.getByLabelText('Expand all files')).toBeTruthy()
  })

  it('carries + Note, and offers it only when the app can open a composer', () => {
    const onAddNote = vi.fn()
    const { rerender } = render(<ReadingPane files={[FILES[0]!]} controls={controls()} />)
    expect(screen.queryByText('Note')).toBeNull()
    rerender(<ReadingPane files={[FILES[0]!]} controls={controls({ onAddNote })} />)
    fireEvent.click(screen.getByText('Note'))
    expect(onAddNote).toHaveBeenCalled()
  })

  it('hides a switch with nothing to say, and shows it again once it is on', () => {
    const { rerender } = render(
      <ReadingPane files={[FILES[0]!]} controls={controls({ testCount: 0, changedCount: 0 })} />,
    )
    expect(screen.queryByText('Hide tests')).toBeNull()
    expect(screen.queryByText('Only since review')).toBeNull()
    expect(screen.getByText('Hide reviewed')).toBeTruthy()

    rerender(
      <ReadingPane
        files={[FILES[0]!]}
        controls={controls({
          testCount: 0,
          hideTests: true,
          changedCount: 0,
          onlyChanged: true,
        })}
      />,
    )
    expect(screen.getByText('Hide tests')).toBeTruthy()
    expect(screen.getByText('Only since review')).toBeTruthy()
  })

  it('names both reasons files are missing, and undoes both at once', () => {
    let shown = 0
    render(
      <ReadingPane
        files={[FILES[0]!]}
        controls={controls({ hiddenTests: 4, hiddenReviewed: 6, onShowAll: () => shown++ })}
      />,
    )
    expect(screen.getByText(/4 tests, 6 reviewed/)).toBeTruthy()
    fireEvent.click(screen.getByText('Show all files'))
    expect(shown).toBe(1)
  })

  it('singularises one hidden test', () => {
    render(<ReadingPane files={[FILES[0]!]} controls={controls({ hiddenTests: 1 })} />)
    expect(screen.getByText(/1 test /)).toBeTruthy()
  })

  it('ends on the payoff, not on the clean-tree empty state', () => {
    let finished = 0
    render(
      <ReadingPane
        files={[]}
        controls={controls({
          left: 0,
          onFinish: () => finished++,
          stats: { additions: 1448, deletions: 278 },
          unsent: 3,
        })}
      />,
    )
    expect(screen.getByText("That's the whole changeset")).toBeTruthy()
    expect(screen.queryByText('Nothing to review')).toBeNull()
    expect(screen.getByText(/\+1,448/)).toBeTruthy()
    expect(screen.getByLabelText(/3 comments waiting to go back/).textContent).toBe('3')
    fireEvent.click(screen.getByText('Finish review'))
    expect(finished).toBe(1)
  })

  it('does not invent comments to send when there are none', () => {
    render(<ReadingPane files={[]} controls={controls({ left: 0 })} />)
    expect(screen.queryByText(/waiting to go back/)).toBeNull()
  })

  it('never says −0 in the one line meant to feel good', () => {
    render(
      <ReadingPane
        files={[]}
        controls={controls({ left: 0, stats: { additions: 90, deletions: 0 } })}
      />,
    )
    expect(screen.getByText(/\+90/)).toBeTruthy()
    expect(screen.queryByText(/−0/)).toBeNull()
  })

  it('still says the tree is clean when the changeset really is empty', () => {
    render(<ReadingPane files={[]} controls={controls({ left: 0, total: 0 })} />)
    expect(screen.getByText('Nothing to review')).toBeTruthy()
  })

  it('says what emptied the pane when a filter did it, not that you are done', () => {
    render(<ReadingPane files={[]} controls={controls({ left: 12, hiddenReviewed: 18 })} />)
    expect(screen.getByText('12 files still to review')).toBeTruthy()
    expect(screen.queryByText("That's the whole changeset")).toBeNull()
  })

  describe('the payoff', () => {
    it('docks over the diff when files are still on screen', () => {
      const { container } = render(
        <ReadingPane files={[FILES[0]!]} controls={controls({ left: 0, hideReviewed: false })} />,
      )
      expect(container.querySelector('.done-card')).toBeTruthy()
      expect(container.querySelector('.pane-done')).toBeNull()
      expect(container.querySelector('.file-section')).toBeTruthy()
      expect(screen.getByText("That's the whole changeset")).toBeTruthy()
    })

    it('takes the whole pane when there is nothing left to show', () => {
      const { container } = render(<ReadingPane files={[]} controls={controls({ left: 0 })} />)
      expect(container.querySelector('.pane-done')).toBeTruthy()
      expect(container.querySelector('.done-card')).toBeNull()
    })

    it('stays away while anything in scope is unread', () => {
      const { container } = render(<ReadingPane files={[FILES[0]!]} controls={controls()} />)
      expect(container.querySelector('.done-card')).toBeNull()
    })

    it('arrives with tests excluded, and says nobody read them', () => {
      render(
        <ReadingPane
          files={[FILES[0]!]}
          controls={controls({
            left: 4,
            total: 16,
            scopeLeft: 0,
            scopeTotal: 12,
            excludedTests: 4,
            hideReviewed: false,
          })}
        />,
      )
      expect(screen.getByText("That's everything you asked to see")).toBeTruthy()
      expect(screen.queryByText(/all read/)).toBeNull()
      expect(screen.getByText(/12 of 16/)).toBeTruthy()
      expect(screen.getByText(/4 test files were hidden — nobody reviewed them/)).toBeTruthy()
    })

    it('names the round when that is what excluded things', () => {
      render(
        <ReadingPane
          files={[FILES[0]!]}
          controls={controls({
            left: 122,
            total: 125,
            scopeLeft: 0,
            scopeTotal: 3,
            excludedUnchanged: 122,
            hideReviewed: false,
          })}
        />,
      )
      expect(screen.getByText(/122 files are outside this round/)).toBeTruthy()
    })

    it('offers a way back that is narrower than Show all files', () => {
      const onIncludeExcluded = vi.fn()
      render(
        <ReadingPane
          files={[FILES[0]!]}
          controls={controls({
            left: 4,
            scopeLeft: 0,
            excludedTests: 4,
            hideReviewed: false,
            onIncludeExcluded,
          })}
        />,
      )
      fireEvent.click(screen.getByText('Review them too'))
      expect(onIncludeExcluded).toHaveBeenCalled()
    })

    it('says nothing about exclusions when nothing was excluded', () => {
      const { container } = render(
        <ReadingPane files={[FILES[0]!]} controls={controls({ left: 0, hideReviewed: false })} />,
      )
      expect(container.querySelector('.done-caveat')).toBeNull()
    })

    it('dismisses, and re-arms when the review is finished again', () => {
      const { container, rerender } = render(
        <ReadingPane files={[FILES[0]!]} controls={controls({ left: 0, hideReviewed: false })} />,
      )
      fireEvent.click(screen.getByLabelText('Dismiss'))
      expect(container.querySelector('.done-card')).toBeNull()

      rerender(
        <ReadingPane files={[FILES[0]!]} controls={controls({ left: 1, hideReviewed: false })} />,
      )
      expect(container.querySelector('.done-card')).toBeNull()

      rerender(
        <ReadingPane files={[FILES[0]!]} controls={controls({ left: 0, hideReviewed: false })} />,
      )
      expect(container.querySelector('.done-card')).toBeTruthy()
    })

    it('does not fire when scope is empty', () => {
      const { container } = render(
        <ReadingPane
          files={[]}
          controls={controls({ left: 12, scopeLeft: 0, scopeTotal: 0, excludedUnchanged: 12 })}
        />,
      )
      expect(container.querySelector('.pane-done')).toBeNull()
      expect(screen.getByText('12 files still to review')).toBeTruthy()
    })
  })

  describe('the sweep', () => {
    function stubLayout(sectionBottom: number) {
      const real = Element.prototype.getBoundingClientRect
      Element.prototype.getBoundingClientRect = function () {
        if (this.classList.contains('pane-bar')) return { bottom: 100, height: 100 } as DOMRect
        if (this.classList.contains('file-section')) {
          return { bottom: sectionBottom, height: 200 } as DOMRect
        }
        return real.call(this)
      }
      return () => {
        Element.prototype.getBoundingClientRect = real
      }
    }

    beforeEach(() => {
      vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
        cb(0)
        return 1
      })
      vi.stubGlobal('cancelAnimationFrame', () => {})
    })
    afterEach(() => vi.unstubAllGlobals())

    const file = FILES[0]!
    const readAll = new Set(file.hunks.map((h) => h.id))

    it('retires a read file once it has scrolled out of sight above', () => {
      const restore = stubLayout(10)
      const swept: string[] = []
      const { container } = render(
        <ReadingPane
          files={[file]}
          viewed={readAll}
          controls={controls({ pinned: new Set([file.path]), onSweep: (p) => swept.push(p) })}
        />,
      )
      fireEvent.scroll(container.querySelector('.reading-pane')!)
      expect(swept).toEqual([file.path])
      restore()
    })

    it('leaves it alone while any of it is still on screen', () => {
      const restore = stubLayout(400)
      const swept: string[] = []
      const { container } = render(
        <ReadingPane
          files={[file]}
          viewed={readAll}
          controls={controls({ pinned: new Set([file.path]), onSweep: (p) => swept.push(p) })}
        />,
      )
      fireEvent.scroll(container.querySelector('.reading-pane')!)
      expect(swept).toEqual([])
      restore()
    })

    it('never retires a pinned file the reviewer has not read', () => {
      const restore = stubLayout(10)
      const swept: string[] = []
      const { container } = render(
        <ReadingPane
          files={[file]}
          viewed={new Set()}
          controls={controls({ pinned: new Set([file.path]), onSweep: (p) => swept.push(p) })}
        />,
      )
      fireEvent.scroll(container.querySelector('.reading-pane')!)
      expect(swept).toEqual([])
      restore()
    })

    it('does nothing at all while Hide reviewed is off', () => {
      const restore = stubLayout(10)
      const swept: string[] = []
      const { container } = render(
        <ReadingPane
          files={[file]}
          viewed={readAll}
          controls={controls({
            hideReviewed: false,
            pinned: new Set([file.path]),
            onSweep: (p) => swept.push(p),
          })}
        />,
      )
      fireEvent.scroll(container.querySelector('.reading-pane')!)
      expect(swept).toEqual([])
      restore()
    })
  })
})
