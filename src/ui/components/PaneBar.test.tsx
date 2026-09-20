// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PaneBar } from './PaneBar.js'

afterEach(cleanup)

function bar(over: Partial<Parameters<typeof PaneBar>[0]> = {}) {
  return (
    <PaneBar
      left={3}
      total={9}
      hideReviewed={false}
      onHideReviewed={() => {}}
      hideTests={false}
      onHideTests={() => {}}
      testCount={0}
      onlyChanged={false}
      onOnlyChanged={() => {}}
      changedCount={0}
      viewMode="unified"
      onSetViewMode={() => {}}
      allCollapsed={false}
      onToggleCollapseAll={() => {}}
      {...over}
    />
  )
}

describe('the file-list toggle', () => {
  it('is the bar’s first control — it sits at the edge of the panel it opens', () => {
    const { container } = render(bar({ navHidden: false, onToggleNav: () => {} }))
    expect(container.querySelector('.pane-bar')?.firstElementChild?.className).toContain('pane-nav')
  })

  it('says what the click will do, not what the state is', () => {
    const onToggleNav = vi.fn()
    const { rerender } = render(bar({ navHidden: false, onToggleNav }))
    fireEvent.click(screen.getByLabelText('Hide the file list'))
    expect(onToggleNav).toHaveBeenCalled()

    rerender(bar({ navHidden: true, onToggleNav }))
    expect(screen.getByLabelText('Show the file list')).toBeTruthy()
  })

  it('reports the panel’s state to a screen reader', () => {
    const { rerender } = render(bar({ navHidden: false, onToggleNav: () => {} }))
    expect(screen.getByLabelText('Hide the file list').getAttribute('aria-pressed')).toBe('true')
    rerender(bar({ navHidden: true, onToggleNav: () => {} }))
    expect(screen.getByLabelText('Show the file list').getAttribute('aria-pressed')).toBe('false')
  })

  it('stays out of the bar entirely when there is no panel to toggle', () => {
    const { container } = render(bar())
    expect(container.querySelector('.pane-nav')).toBeNull()
    expect(container.querySelector('.pane-bar')?.firstElementChild?.className).toContain(
      'prog-track',
    )
  })
})

describe('the typed-filter chip', () => {
  it('echoes the rail’s word, and the whole chip is its own clear', () => {
    const onClearQuery = vi.fn()
    render(bar({ query: 'auth', onClearQuery }))
    const chip = screen.getByLabelText('Clear the file filter “auth”')
    expect(chip.textContent).toContain('auth')
    fireEvent.click(chip)
    expect(onClearQuery).toHaveBeenCalled()
  })

  it('is not there with nothing typed — whitespace included', () => {
    const { container, rerender } = render(bar({ query: '', onClearQuery: () => {} }))
    expect(container.querySelector('.pane-q')).toBeNull()
    rerender(bar({ query: '   ', onClearQuery: () => {} }))
    expect(container.querySelector('.pane-q')).toBeNull()
  })
})

describe('the layer pager', () => {
  const layer = (over: Partial<NonNullable<Parameters<typeof PaneBar>[0]['layer']>> = {}) => ({
    text: 'layer 3 / 6 · 3 files · 2 left',
    title: '1 of 3 files in this layer marked reviewed',
    progress: 0.4,
    prev: { title: 'Callers adapted', onGo: vi.fn() },
    next: { title: 'Relative phrases', onGo: vi.fn() },
    ...over,
  })

  it('the burndown reads the layer, not the review', () => {
    const { container } = render(bar({ layer: layer() }))
    expect(container.querySelector('.pane-left')?.textContent).toBe(
      'layer 3 / 6 · 3 files · 2 left',
    )
    expect(container.querySelector<HTMLElement>('.prog-track i')?.style.width).toBe('40%')
  })

  it('prev and next sit on the bar with their titles and the ] hint, and go where they say', () => {
    const l = layer()
    render(bar({ layer: l }))
    fireEvent.click(screen.getByLabelText('Previous layer: Callers adapted'))
    expect(l.prev!.onGo).toHaveBeenCalled()
    const next = screen.getByLabelText('Next layer: Relative phrases')
    expect(next.querySelector('.kbd')?.textContent).toBe(']')
    fireEvent.click(next)
    expect(l.next!.onGo).toHaveBeenCalled()
  })

  it('the ends of the outline drop the button that has nowhere to go', () => {
    const { container, unmount } = render(bar({ layer: layer({ prev: null }) }))
    expect(screen.queryByLabelText(/Previous layer/)).toBeNull()
    expect(screen.getByLabelText(/Next layer/)).toBeTruthy()
    unmount()
    render(bar({ layer: layer({ next: null }) }))
    expect(screen.queryByLabelText(/Next layer/)).toBeNull()
    expect(container).toBeTruthy()
  })

  it('says exactly the line the app composed', () => {
    const { container } = render(
      bar({ layer: layer({ text: 'since your review · 1 file · read', progress: 1 }) }),
    )
    expect(container.querySelector('.pane-left')?.textContent).toBe(
      'since your review · 1 file · read',
    )
    expect(container.querySelector<HTMLElement>('.prog-track i')?.style.width).toBe('100%')
  })

  it('the filters step aside in layer mode — a layer shows all of its files', () => {
    const { container, unmount } = render(
      bar({ testCount: 3, query: 'x', onClearQuery: () => {}, onAddNote: () => {} }),
    )
    expect(container.querySelectorAll('[role="switch"]').length).toBeGreaterThan(0)
    expect(container.querySelector('.pane-q')).toBeTruthy()
    expect(screen.getByText('Note')).toBeTruthy()
    unmount()
    const { container: c2 } = render(
      bar({
        layer: layer(),
        testCount: 3,
        query: 'x',
        onClearQuery: () => {},
        onAddNote: () => {},
      }),
    )
    expect(c2.querySelectorAll('[role="switch"]')).toHaveLength(0)
    expect(c2.querySelector('.pane-q')).toBeNull()
    // The Overview's strip carries the changeset note in layer mode.
    expect(screen.queryByText('Note')).toBeNull()
  })
})
