// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fixturePr } from '../../forge/fixture.js'
import type { ReviewThread } from '../../shared/review.js'
import type { FileChange, Hunk } from '../../shared/types.js'
import { fileMark } from '../fileMarks.js'
import { PrContext } from '../prMode.js'
import { type LayerView, ReadingPane } from './ReadingPane.js'

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
          partition: { byHunk: new Map(), byFile: new Map(), byLayer: new Map(), changeset: [] },
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
    // The file header's bubble only appears once the file has threads; the menu
    // trigger is the icon that is always there.
    expect(container.querySelector('.file-comment-btn')).toBeNull()
    expect(container.querySelector('.file-header svg[data-icon="more"]')).toBeTruthy()
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
    render(
      <ReadingPane
        files={[FILES[0]!]}
        collapsed={new Set(['src/b.ts'])}
        onToggleCollapsed={(p) => collapse.push(p)}
        comments={{
          partition: { byHunk: new Map(), byFile: new Map(), byLayer: new Map(), changeset: [] },
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
    fireEvent.click(screen.getByLabelText('More file actions'))
    fireEvent.click(screen.getByText('Comment on this file'))
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
      query: '',
      onClearQuery: () => {},
      hiddenQuery: 0,
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
    expect(screen.getByText('18 of 30 files')).toBeTruthy()
    const switches = [...container.querySelectorAll('.pane-bar [role="switch"]')]
    // On, a switch reports what it did; off, it offers.
    expect(switches.map((s) => s.textContent)).toEqual(['18 reviewed hidden', 'Hide 8 test files'])
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

  it('carries the size of the change beside the coverage, and never a −0', () => {
    render(
      <ReadingPane
        files={[FILES[0]!]}
        controls={controls({ stats: { additions: 1316, deletions: 0 } })}
      />,
    )
    const size = document.querySelector('.pane-size')!
    expect(size.textContent).toBe('+1,316')
  })

  it('hides a switch with nothing to say, and shows it again once it is on', () => {
    const { rerender } = render(
      <ReadingPane files={[FILES[0]!]} controls={controls({ testCount: 0, changedCount: 0 })} />,
    )
    expect(screen.queryByText('Hide tests')).toBeNull()
    expect(screen.queryByText('Only since review')).toBeNull()
    expect(screen.getByText(/reviewed hidden/)).toBeTruthy()

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
    // On with nothing to hide, a switch still offers rather than reporting "0 hidden".
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

  it('names the typed word first among the reasons files are missing', () => {
    render(
      <ReadingPane
        files={[FILES[0]!]}
        controls={controls({ query: 'auth', hiddenQuery: 3, hiddenTests: 4 })}
      />,
    )
    expect(screen.getByText(/3 not matching “auth”, 4 tests hidden/)).toBeTruthy()
  })

  it('blames the word, not the switches, when the word alone emptied the pane', () => {
    render(
      <ReadingPane files={[]} controls={controls({ left: 12, query: 'zzz', hiddenQuery: 30 })} />,
    )
    expect(screen.getByText('None of them match “zzz”.')).toBeTruthy()
  })

  it('blames both when the word and the switches each hid something', () => {
    render(
      <ReadingPane
        files={[]}
        controls={controls({ left: 12, query: 'zzz', hiddenQuery: 20, hiddenReviewed: 10 })}
      />,
    )
    expect(
      screen.getByText("They're hidden by “zzz” and the switches on the bar above."),
    ).toBeTruthy()
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
    expect(screen.getAllByText(/\+1,448/)[0]).toBeTruthy()
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
    expect(screen.getAllByText(/\+90/)[0]).toBeTruthy()
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
      // The bar says it too now ("12 of 16 files"); the payoff card is the one under test.
      expect(screen.getByText(/12 of 16/, { selector: '.done-stats *' })).toBeTruthy()
      expect(screen.getByText(/4 test files were hidden; nobody reviewed them/)).toBeTruthy()
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

describe('ReadingPane in layer mode', () => {
  // A review with files, all of them filtered out of this layer.
  const emptiedControls = {
    left: 1,
    total: 3,
    query: '',
    onClearQuery: () => {},
    hiddenQuery: 0,
    hideReviewed: true,
    onHideReviewed: () => {},
    hideTests: false,
    onHideTests: () => {},
    testCount: 0,
    onlyChanged: false,
    onOnlyChanged: () => {},
    changedCount: 0,
    hiddenTests: 0,
    hiddenReviewed: 1,
    hiddenUnchanged: 0,
    pinned: new Set<string>(),
    onSweep: () => {},
    onShowAll: () => {},
    scopeLeft: 1,
    scopeTotal: 3,
    excludedTests: 0,
    excludedUnchanged: 0,
    viewMode: 'unified' as const,
    onSetViewMode: () => {},
    allCollapsed: false,
    onToggleCollapseAll: () => {},
  }
  const view = (over: Partial<LayerView> = {}): LayerView => ({
    id: 'L3',
    kicker: 'Layer 3 of 6',
    title: 'Weekday resolution',
    mechanical: false,
    summary: 'A bare weekday resolves forward. Read `src/b.ts:9` first.',
    missing: ['src/gone.ts'],
    listed: 1,
    hidden: 0,
    onJump: vi.fn(),
    notes: new Map([['src/b.ts', 'delegates to resolveWeekday']]),
    knownPaths: ['src/b.ts'],
    ...over,
  })

  it('heads the files with the card: kicker, title, summary; only missing paths get chips', () => {
    const { container } = render(<ReadingPane files={[FILES[0]!]} layer={view()} />)
    const head = container.querySelector('.ch-head')!
    expect(head.querySelector('.ch-head-kicker')?.textContent).toBe('Layer 3 of 6')
    expect(head.querySelector('h2')?.textContent).toBe('Weekday resolution')
    expect(head.querySelector('.ch-kind')).toBeNull()
    expect(head.querySelector('.ch-summary')?.textContent).toContain(
      'A bare weekday resolves forward',
    )
    const chips = [...head.querySelectorAll('.ch-chip')]
    expect(chips.map((c) => c.textContent)).toEqual(['src/gone.ts'])
    expect(chips[0]!.className).toContain('ch-chip-done')
    // The card comes before the first file, in the reading column.
    expect(head.nextElementSibling?.className).toContain('file-section')
  })

  it('the card closes with the reading order: the words, then both orders as chips', () => {
    const onPick = vi.fn()
    const { container, unmount } = render(
      <ReadingPane files={[FILES[0]!]} layer={view({ reading: { kind: 'order', onPick } })} />,
    )
    const row = container.querySelector('.ch-head-order')!
    expect(row.querySelector('.ch-head-order-cap')?.textContent).toBe('Read the files in')
    const group = row.querySelector('[role="radiogroup"]')!
    // The label is the words in front of the chips, not a title to hover for.
    expect(group.getAttribute('aria-labelledby')).toBe(row.querySelector('.ch-head-order-cap')?.id)
    const [agent, folders] = [...group.querySelectorAll('[role="radio"]')]
    expect(agent!.textContent).toBe('the agent’s order')
    expect(folders!.textContent).toBe('folder order')
    expect(agent!.getAttribute('aria-checked')).toBe('true')
    expect(folders!.getAttribute('aria-checked')).toBe('false')
    fireEvent.click(folders!)
    expect(onPick).toHaveBeenCalledWith('tree')
    unmount()
    const { container: c2, unmount: u2 } = render(
      <ReadingPane files={[FILES[0]!]} layer={view({ reading: { kind: 'tree', onPick } })} />,
    )
    const chips = [...c2.querySelectorAll('.ch-head-order [role="radio"]')]
    expect(chips.map((c) => c.getAttribute('aria-checked'))).toEqual(['false', 'true'])
    fireEvent.click(chips[0]!)
    expect(onPick).toHaveBeenLastCalledWith('order')
    u2()
    // Nothing to order, nothing said.
    const { container: c3 } = render(<ReadingPane files={[FILES[0]!]} layer={view()} />)
    expect(c3.querySelector('.ch-head-order')).toBeNull()
  })

  it('a `path:line` reference in the summary jumps instead of navigating', () => {
    const v = view()
    const { container } = render(<ReadingPane files={[FILES[0]!]} layer={v} />)
    const link = container.querySelector<HTMLAnchorElement>('.ch-summary a')!
    expect(link.getAttribute('href')).toContain('#diffo-file:')
    expect(link.getAttribute('target')).toBeNull()
    fireEvent.click(link)
    expect(v.onJump).toHaveBeenCalledWith('src/b.ts', 9)
  })

  describe('a file the layer holds part of', () => {
    const consumers = { index: 2, title: 'Consumers', number: 3 }
    const parts = new Map([
      ['src/b.ts', { shown: new Set(['hunk-1']), elsewhere: new Map([['hunk-2', consumers]]) }],
    ])
    const cards = (c: Element) =>
      [...c.querySelectorAll('.hunk')].map((h) => h.getAttribute('data-hunk-id'))

    it('shows its hunks, folds the others into one row naming their step, and says how much', () => {
      const onGoLayer = vi.fn()
      const { container } = render(
        <ReadingPane files={[FILES[0]!]} layer={view({ parts, onGoLayer })} />,
      )
      expect(container.querySelector('.file-section')?.className).toContain('file-section-part')
      expect(container.querySelector('.file-header .file-part')?.textContent).toBe('1 of 2 hunks')
      expect(cards(container)).toEqual(['hunk-1'])
      const row = container.querySelector('.hunk-elsewhere')!
      expect(row.querySelector('.elsewhere-toggle')?.textContent).toContain('1 hunk in')
      expect(row.querySelector('.elsewhere-go')?.textContent).toBe('step 3 · Consumers')
      // The step's name goes there.
      fireEvent.click(row.querySelector('.elsewhere-go')!)
      expect(onGoLayer).toHaveBeenCalledWith(2)
      // The chevron opens the run in place, dimmed, and folds it again.
      fireEvent.click(row.querySelector('.elsewhere-toggle')!)
      expect(cards(container)).toEqual(['hunk-1', 'hunk-2'])
      expect(
        container.querySelector('.hunk-elsewhere-body .hunk')?.getAttribute('data-hunk-id'),
      ).toBe('hunk-2')
      fireEvent.click(container.querySelector('.elsewhere-toggle')!)
      expect(cards(container)).toEqual(['hunk-1'])
    })

    it('Viewed is the step’s, Whole file opens everything, and a jump into a folded run opens it', () => {
      const onToggleFileViewed = vi.fn()
      const { container, rerender } = render(
        <ReadingPane
          files={[FILES[0]!]}
          layer={view({ parts })}
          viewed={new Set(['hunk-1'])}
          onToggleFileViewed={onToggleFileViewed}
        />,
      )
      const toggle = container.querySelector('.file-viewed-toggle')!
      // The shown hunk is read, so the step's part is: pressed, whatever hunk-2 says.
      expect(toggle.getAttribute('aria-pressed')).toBe('true')
      expect(toggle.getAttribute('title')).toContain('step')
      fireEvent.click(toggle)
      expect(onToggleFileViewed).toHaveBeenCalledWith('src/b.ts')
      const whole = container.querySelector('.file-whole')!
      expect(whole.textContent).toContain('Whole file')
      fireEvent.click(whole)
      expect(cards(container)).toEqual(['hunk-1', 'hunk-2'])
      expect(container.querySelector('.hunk-elsewhere')).toBeNull()
      expect(container.querySelector('.elsewhere-tag')?.textContent).toBe('step 3 · Consumers')
      fireEvent.click(container.querySelector('.file-whole')!)
      expect(cards(container)).toEqual(['hunk-1'])
      // A jump lands on hunk-2: the run opens on its own.
      rerender(<ReadingPane files={[FILES[0]!]} layer={view({ parts })} selectedId="hunk-2" />)
      expect(cards(container)).toEqual(['hunk-1', 'hunk-2'])
    })

    it('the card offers the whole file when the outline splits something', () => {
      const onPick = vi.fn()
      const { container } = render(
        <ReadingPane
          files={[FILES[0]!]}
          layer={view({ scope: { kind: 'parts', offers: ['parts', 'whole'], onPick } })}
        />,
      )
      const row = container.querySelector('.ch-head-scope')!
      expect(row.querySelector('.ch-head-order-cap')?.textContent).toBe('Show')
      // Beside the reading order, on the same line — not a row of its own.
      expect(row.parentElement?.className).toBe('ch-head-order')
      const [parts, whole] = [...row.querySelectorAll('[role="radio"]')]
      expect(parts!.textContent).toBe('this step’s hunks')
      expect(whole!.textContent).toBe('the whole file')
      expect(parts!.getAttribute('aria-checked')).toBe('true')
      expect(whole!.getAttribute('aria-checked')).toBe('false')
      fireEvent.click(whole!)
      expect(onPick).toHaveBeenCalledWith('whole')
      // Nothing to choose between, nothing offered.
      const { container: c2 } = render(<ReadingPane files={[FILES[0]!]} layer={view()} />)
      expect(c2.querySelector('.ch-head-scope')).toBeNull()
    })

    it('a pick the step cannot show reads as this step’s hunks', () => {
      const { container } = render(
        <ReadingPane
          files={[FILES[0]!]}
          layer={view({
            scope: { kind: 'highlights', offers: ['parts', 'whole'], onPick: vi.fn() },
          })}
        />,
      )
      const chips = [...container.querySelectorAll('.ch-head-scope [role="radio"]')]
      expect(chips.map((c) => c.getAttribute('aria-checked'))).toEqual(['true', 'false'])
    })

    it('a whole file under the same layer is untouched', () => {
      const { container } = render(
        <ReadingPane files={[FILES[0]!]} layer={view({ parts: new Map() })} />,
      )
      expect(cards(container)).toEqual(['hunk-1', 'hunk-2'])
      expect(container.querySelector('.file-part')).toBeNull()
      expect(container.querySelector('.file-whole')).toBeNull()
    })
  })

  describe('highlighted lines', () => {
    const ALL_SCOPES = ['highlights', 'parts', 'whole'] as const
    const highlights = new Map([['src/b.ts', [{ from: 2, to: 2 }]]])
    const rows = (c: Element, cls: string) =>
      [...c.querySelectorAll(`.hunk[data-hunk-id="hunk-1"] tr.${cls} .line-code`)].map(
        (td) => td.textContent,
      )

    it('lights the highlighted lines and dims the rest of the file', () => {
      const { container } = render(<ReadingPane files={[FILES[0]!]} layer={view({ highlights })} />)
      // The deletion the added line replaced goes with it.
      expect(rows(container, 'line-lit')).toEqual(['const removed = 1', 'const added = 2'])
      expect(rows(container, 'line-unlit')).toEqual(['const keep = true'])
      expect(container.querySelector('.hunk[data-hunk-id="hunk-2"] tr.line-unlit')).toBeTruthy()
    })

    it('a file without a highlight dims nothing', () => {
      const { container } = render(<ReadingPane files={[FILES[0]!]} layer={view()} />)
      expect(container.querySelector('tr.line-lit, tr.line-unlit')).toBeNull()
    })

    it('the card offers the three scopes, narrowest first', () => {
      const onPick = vi.fn()
      const { container, rerender } = render(
        <ReadingPane
          files={[FILES[0]!]}
          layer={view({ highlights, scope: { kind: 'parts', offers: ALL_SCOPES, onPick } })}
        />,
      )
      const pick = container.querySelector('.ch-head-scope')!
      expect(pick.parentElement?.className).toBe('ch-head-order')
      expect(pick.querySelector('.ch-head-order-cap')?.textContent).toBe('Show')
      const group = pick.querySelector('[role="radiogroup"]')!
      expect(group.getAttribute('aria-labelledby')).toBe(
        pick.querySelector('.ch-head-order-cap')?.id,
      )
      const [only, hunks, whole] = [...group.querySelectorAll('[role="radio"]')]
      expect(only!.textContent).toBe('only highlights')
      expect(hunks!.textContent).toBe('this step’s hunks')
      expect(whole!.textContent).toBe('the whole file')
      expect(only!.getAttribute('aria-checked')).toBe('false')
      expect(hunks!.getAttribute('aria-checked')).toBe('true')
      expect(container.querySelector('tr.line-unlit-fold')).toBeNull()
      fireEvent.click(only!)
      expect(onPick).toHaveBeenCalledWith('highlights')
      rerender(
        <ReadingPane
          files={[FILES[0]!]}
          layer={view({ highlights, scope: { kind: 'highlights', offers: ALL_SCOPES, onPick } })}
        />,
      )
      // hunk-1 is short enough that its context keeps every line; hunk-2 has
      // nothing lit, so it folds whole.
      expect(rows(container, 'line')).toEqual([
        'const keep = true',
        'const removed = 1',
        'const added = 2',
      ])
      const folds = [...container.querySelectorAll('tr.line-unlit-fold')].map((r) => r.textContent)
      expect(folds).toEqual(['1 line outside the highlight'])
      const chips = [...container.querySelectorAll('.ch-head-scope [role="radio"]')]
      expect(chips.map((c) => c.getAttribute('aria-checked'))).toEqual(['true', 'false', 'false'])
      fireEvent.click(chips[1]!)
      expect(onPick).toHaveBeenLastCalledWith('parts')
    })

    it('only highlights keeps two lines of context around each highlight', () => {
      const long: FileChange = {
        ...FILES[0]!,
        path: 'src/long.ts',
        hunks: [
          hunk('src/long.ts', 'long-1', [
            ...[1, 2, 3].map((n) => ({
              kind: 'context' as const,
              oldNo: n,
              newNo: n,
              text: `c${n}`,
            })),
            { kind: 'add', oldNo: null, newNo: 4, text: 'lit' },
            ...[5, 6, 7, 8].map((n) => ({
              kind: 'context' as const,
              oldNo: n - 1,
              newNo: n,
              text: `c${n}`,
            })),
          ]),
        ],
      }
      const { container } = render(
        <ReadingPane
          files={[long]}
          layer={view({
            highlights: new Map([['src/long.ts', [{ from: 4, to: 4 }]]]),
            scope: { kind: 'highlights', offers: ALL_SCOPES, onPick: vi.fn() },
          })}
        />,
      )
      const shown = [...container.querySelectorAll('tr.line .line-code')].map(
        (td) => td.textContent,
      )
      expect(shown).toEqual(['c2', 'c3', 'lit', 'c5', 'c6'])
      const folds = [...container.querySelectorAll('tr.line-unlit-fold')].map((r) => r.textContent)
      expect(folds).toEqual(['1 line outside the highlight', '2 lines outside the highlight'])
      // The context reads as context: dimmed, not lit.
      expect(container.querySelectorAll('tr.line-lit')).toHaveLength(1)
    })
  })

  it('the per-file note renders after the path in the file header', () => {
    const { container } = render(<ReadingPane files={[FILES[0]!]} layer={view()} />)
    expect(container.querySelector('.file-header .ch-file-note')?.textContent).toBe(
      'delegates to resolveWeekday',
    )
  })

  it('a mechanical layer wears the chip', () => {
    const { container } = render(
      <ReadingPane files={[FILES[0]!]} layer={view({ mechanical: true })} />,
    )
    expect(container.querySelector('.ch-head h2 .ch-kind')?.textContent).toBe('mechanical')
  })

  it('on a layer the changeset strip is gone; on the Overview it is the whole pane, open', () => {
    const at = '2026-09-20T00:00:00Z'
    const guide = {
      id: 'g',
      anchor: { kind: 'changeset' as const },
      state: 'open' as const,
      codeContext: null,
      codeChanged: false,
      messages: [{ id: 'gm', author: 'agent' as const, text: 'Start here.', at }],
      createdAt: at,
      updatedAt: at,
    }
    const comments = {
      partition: { byHunk: new Map(), byFile: new Map(), byLayer: new Map(), changeset: [guide] },
      actions: {
        create: vi.fn(),
        reply: vi.fn(),
        send: vi.fn(),
        resolve: vi.fn(),
        reopen: vi.fn(),
        remove: vi.fn(),
      },
    }
    const { container, unmount } = render(
      <ReadingPane files={[FILES[0]!]} layer={view()} comments={comments} />,
    )
    expect(container.querySelector('.changeset-strip')).toBeNull()
    expect(container.querySelector('.ch-head')).toBeTruthy()
    unmount()
    const { container: c2 } = render(<ReadingPane files={[]} overview comments={comments} />)
    const strip = c2.querySelector('.changeset-strip')!
    expect(strip).toBeTruthy()
    expect(strip.querySelector('.strip-head')?.getAttribute('aria-expanded')).toBe('true')
    expect(c2.textContent).toContain('Start here.')
    expect(c2.querySelector('.ch-head')).toBeNull()
    expect(c2.querySelector('.empty-state')).toBeNull()
  })

  describe('a comment on the layer itself', () => {
    const at = '2026-09-20T00:00:00Z'
    const onLayer: ReviewThread = {
      id: 'lt',
      anchor: { kind: 'layer', layerId: 'L3', title: 'Weekday resolution' },
      state: 'sent',
      codeContext: null,
      anchoredLayer: { title: 'Weekday resolution', files: ['src/b.ts'] },
      codeChanged: false,
      messages: [{ id: 'm', author: 'reviewer', text: 'why is b.ts in this step?', at }],
      createdAt: at,
      updatedAt: at,
    }
    const comments = (threads: ReviewThread[] = []) => ({
      partition: {
        byHunk: new Map(),
        byFile: new Map(),
        byLayer: new Map(threads.length ? [['L3', threads]] : []),
        changeset: [],
      },
      actions: {
        create: vi.fn(async () => onLayer),
        reply: vi.fn(),
        send: vi.fn(async () => ({ delivered: true })),
        resolve: vi.fn(),
        reopen: vi.fn(),
        remove: vi.fn(),
      },
    })

    it('the card carries its threads and a way to add one, anchored to the layer', async () => {
      const c = comments([onLayer])
      const { container } = render(<ReadingPane files={[FILES[0]!]} layer={view()} comments={c} />)
      const head = container.querySelector('.ch-head')!
      const card = head.querySelector('[data-thread-id="lt"]')!
      expect(card.textContent).toContain('why is b.ts in this step?')
      expect(card.querySelector('.thread-where')!.textContent).toBe('Comment on this layer')
      fireEvent.click(screen.getByRole('button', { name: 'Comment on this layer' }))
      const box = screen.getByPlaceholderText(/Ask about this step/) as HTMLTextAreaElement
      expect(head.contains(box)).toBe(true)
      fireEvent.change(box, { target: { value: 'split this in two' } })
      fireEvent.click(screen.getByText('Add comment'))
      expect(c.actions.create).toHaveBeenCalledWith(
        { kind: 'layer', layerId: 'L3', title: 'Weekday resolution' },
        'split this in two',
        undefined,
      )
      // Submitting closes the composer; the button is back.
      expect(screen.queryByPlaceholderText(/Ask about this step/)).toBeNull()
      expect(screen.getByRole('button', { name: 'Comment on this layer' })).toBeTruthy()
    })

    it('Send to agent creates the thread and sends it in one go', async () => {
      const c = comments()
      render(<ReadingPane files={[FILES[0]!]} layer={view()} comments={c} />)
      fireEvent.click(screen.getByRole('button', { name: 'Comment on this layer' }))
      fireEvent.change(screen.getByPlaceholderText(/Ask about this step/), {
        target: { value: 'why here?' },
      })
      fireEvent.click(screen.getByText('Send to agent'))
      await Promise.resolve()
      await Promise.resolve()
      expect(c.actions.create).toHaveBeenCalledTimes(1)
      expect(c.actions.send).toHaveBeenCalledWith('lt')
    })

    it('the derived "Since your review" layer has no identity to comment on', () => {
      render(
        <ReadingPane
          files={[FILES[0]!]}
          layer={view({ id: null, kicker: 'Outside the outline', title: 'Since your review' })}
          comments={comments()}
        />,
      )
      expect(screen.queryByRole('button', { name: 'Comment on this layer' })).toBeNull()
    })

    it('on a pull request the composer is private to the agent — no GitHub side', () => {
      const c = comments()
      render(
        <PrContext.Provider value={fixturePr()}>
          <ReadingPane files={[FILES[0]!]} layer={view()} comments={c} />
        </PrContext.Provider>,
      )
      fireEvent.click(screen.getByRole('button', { name: 'Comment on this layer' }))
      expect(screen.queryByText('Add to review')).toBeNull()
      expect(document.querySelector('.cbox-agent')).toBeTruthy()
      fireEvent.change(screen.getByPlaceholderText(/Ask about this step/), {
        target: { value: 'private ask' },
      })
      fireEvent.click(screen.getByText('Send to agent'))
      expect(c.actions.create).toHaveBeenCalledWith(
        { kind: 'layer', layerId: 'L3', title: 'Weekday resolution' },
        'private ask',
        undefined,
      )
    })
  })

  it('a layer whose files all left the changeset says that instead', () => {
    const { container } = render(
      <ReadingPane files={[]} layer={view({ listed: 0 })} controls={emptiedControls} />,
    )
    expect(container.querySelector('.ch-head-empty')?.textContent).toContain(
      'Nothing this layer lists is in the changeset right now',
    )
  })

  it('a layer Hide tests emptied says so — its files are there, just hidden', () => {
    const { container } = render(
      <ReadingPane
        files={[]}
        layer={view({ listed: 2, hidden: 2 })}
        controls={{ ...emptiedControls, hideTests: true, hiddenTests: 2 }}
      />,
    )
    const note = container.querySelector('.ch-head-empty')?.textContent
    expect(note).toContain('All 2 files in this layer are tests, hidden by Hide tests')
    expect(note).not.toContain('not in the changeset')
    expect(container.querySelector('.empty-state')).toBeNull()
  })
})
