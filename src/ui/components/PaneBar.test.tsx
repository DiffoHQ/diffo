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
