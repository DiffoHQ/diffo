// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Changeset } from '../../shared/types.js'
import { Header } from './Header.js'

afterEach(cleanup)

function changeset(over: Partial<Changeset> = {}): Changeset {
  return {
    version: 1,
    spec: { kind: 'working-tree' },
    repo: { path: '/tmp/demo', name: 'Diffo', branch: 'main', worktree: null },
    files: [],
    stats: { files: 22, additions: 1316, deletions: 157 },
    ...over,
  }
}

describe('Header dev badge', () => {
  afterEach(() => {
    document.head.querySelector('meta[name="diffo-env"]')?.remove()
  })

  const markDev = () => {
    const meta = document.createElement('meta')
    meta.setAttribute('name', 'diffo-env')
    meta.setAttribute('content', 'development')
    document.head.append(meta)
  }

  it('says nothing when the review came from the released CLI', () => {
    const { container } = render(<Header changeset={changeset()} />)
    expect(container.querySelector('.dev-badge')).toBeNull()
  })

  it('marks a checkout-served review, next to the wordmark', () => {
    markDev()
    const { container } = render(<Header changeset={changeset()} />)
    const badge = container.querySelector('.dev-badge')
    expect(badge?.textContent).toBe('dev')
    expect(container.querySelector('.mark')?.contains(badge!)).toBe(true)
    expect(badge?.getAttribute('title')).toMatch(/source checkout, not the released CLI/)
  })
})

describe('Header', () => {
  it('states the comparison outright, with thousands separators', () => {
    const { container } = render(<Header changeset={changeset()} />)
    const chip = container.querySelector('.cmp')!
    expect(chip.textContent).toContain('working tree')
    expect(chip.textContent).toContain('HEAD')
    expect(chip.textContent).toContain('+1,316')
    expect(chip.textContent).toContain('−157')
  })

  it('branch mode drops into the same shape — feature/x → main', () => {
    const { container } = render(
      <Header
        changeset={changeset({
          spec: { kind: 'branch', base: 'main' },
          repo: { path: '/tmp/demo', name: 'Diffo', branch: 'feature/ink', worktree: null },
        })}
      />,
    )
    const sides = [...container.querySelectorAll('.cmp-side')].map((s) => s.textContent)
    expect(sides).toEqual(['feature/ink', 'main'])
  })

  it('holds one action; everything rare is behind the single overflow', () => {
    const { container } = render(
      <Header changeset={changeset()} review={{ onFinishReview: () => {} }} />,
    )
    expect(container.querySelectorAll('.top > .btn:not(.btn-icon)')).toHaveLength(1)
    expect(screen.getByText('Finish review')).toBeTruthy()
  })

  describe('nothing here changes what is on screen', () => {
    it('does not offer the diff layout — that is the pane bar’s', () => {
      render(
        <Header changeset={changeset()} settings={{ theme: 'system', onSetTheme: () => {} }} />,
      )
      fireEvent.click(screen.getByLabelText('Settings'))
      expect(screen.queryByText('Split diff')).toBeNull()
      expect(screen.queryByText('Unified diff')).toBeNull()
    })

    it('does not offer fold-all, and keeps Settings as its only icon', () => {
      const { container } = render(<Header changeset={changeset()} />)
      expect(screen.queryByLabelText(/Collapse all files/)).toBeNull()
      expect(screen.queryByLabelText(/Expand all files/)).toBeNull()
      // Settings sits inside its own menu wrapper; the bar itself owns no bare icons.
      expect(container.querySelectorAll('.top > .btn-icon')).toHaveLength(0)
      expect(screen.getByLabelText('Settings')).toBeTruthy()
    })

    it('does not offer Add a note', () => {
      render(
        <Header changeset={changeset()} settings={{ theme: 'system', onSetTheme: () => {} }} />,
      )
      fireEvent.click(screen.getByLabelText('Settings'))
      expect(screen.queryByText('Add a note')).toBeNull()
    })

    it('states no coverage — the count lives on the pane bar and the rail', () => {
      const { container } = render(<Header changeset={changeset()} />)
      expect(container.querySelector('.prog-n')).toBeNull()
      expect(container.querySelector('.prog-track')).toBeNull()
    })
  })

  describe('the ⋯ is settings, not actions', () => {
    it('offers the theme trio, current choice marked', () => {
      const onSetTheme = vi.fn()
      render(<Header changeset={changeset()} settings={{ theme: 'system', onSetTheme }} />)
      fireEvent.click(screen.getByLabelText('Settings'))
      expect(screen.getByText('Theme')).toBeTruthy()
      expect(screen.getByText('System').closest('button')!.getAttribute('aria-checked')).toBe(
        'true',
      )
      expect(screen.getByText('Dark').closest('button')!.getAttribute('aria-checked')).toBe('false')
      fireEvent.click(screen.getByText('Dark'))
      expect(onSetTheme).toHaveBeenCalledWith('dark')
    })

    it('holds appearance and help, and nothing that acts on the review', () => {
      const { container } = render(
        <Header
          changeset={changeset()}
          settings={{ theme: 'system', onSetTheme: () => {}, onShowShortcuts: () => {} }}
        />,
      )
      fireEvent.click(screen.getByLabelText('Settings'))
      expect(screen.queryByText(/Clear threads/)).toBeNull()
      expect(container.querySelector('.menu-item-danger')).toBeNull()
      const items = [...container.querySelectorAll('.menu-item-label')].map((b) => b.textContent)
      expect(items).toEqual(['System', 'Light', 'Dark', 'Shortcuts'])
    })

    it('closes on Escape even with an item focused', () => {
      const { container } = render(
        <Header changeset={changeset()} settings={{ onShowShortcuts: () => {} }} />,
      )
      fireEvent.click(screen.getByLabelText('Settings'))
      const item = screen.getByText('Shortcuts').closest('button')!
      item.focus()
      fireEvent.keyDown(item, { key: 'Escape' })
      expect(container.querySelector('.menu-panel')).toBeNull()
    })
  })

  it('counts unsent comments on the finish action', () => {
    render(
      <Header changeset={changeset()} review={{ onFinishReview: () => {}, openComments: 3 }} />,
    )
    expect(screen.getByText('Finish review (3)')).toBeTruthy()
  })

  it('leaves the file list to the pane bar, and nothing precedes the wordmark', () => {
    const { container } = render(<Header changeset={changeset()} />)
    expect(screen.queryByLabelText(/the file list/)).toBeNull()
    expect(container.querySelector('.top')?.firstElementChild?.className).toBe('mark')
  })

  it('says where you are: repo, worktree, branch', () => {
    const { unmount } = render(<Header changeset={changeset()} />)
    expect(document.querySelector('.repo')!.textContent).toBe('Diffo')
    expect(screen.getByTitle('on branch main').textContent).toContain('main')
    expect(document.querySelector('.where-bit[title*="worktree"]')).toBeNull()
    unmount()

    render(
      <Header
        changeset={changeset({
          repo: { path: '/tmp/demo', name: 'botify', branch: 'fix/scope', worktree: 'wt-fix' },
        })}
      />,
    )
    expect(screen.getByText('botify')).toBeTruthy()
    expect(screen.getByTitle("linked worktree 'wt-fix'").textContent).toContain('wt-fix')
    expect(screen.getByTitle('on branch fix/scope').textContent).toContain('fix/scope')
  })

  it('presence with nothing attached offers the invite; attached states just state', () => {
    const onInvite = vi.fn()
    const { rerender, container } = render(
      <Header changeset={changeset()} agent={{ presence: 'waiting', onInvite }} />,
    )
    fireEvent.click(screen.getByTitle('bring your agent into this review'))
    expect(onInvite).toHaveBeenCalled()
    expect(screen.getByText('Invite')).toBeTruthy()

    rerender(<Header changeset={changeset()} agent={{ presence: 'listening', onInvite }} />)
    expect(container.querySelector('button.presence')).toBeNull()
    expect(container.querySelector('.presence')!.textContent).toContain('agent · listening')
  })

  it('without an invite handler the waiting chip stays a plain statement', () => {
    const { container } = render(<Header changeset={changeset()} agent={{ presence: 'waiting' }} />)
    expect(container.querySelector('button.presence')).toBeNull()
    expect(screen.queryByText('Invite')).toBeNull()
  })

  describe('what the header no longer carries', () => {
    it('says nothing about what the agent rewrote — the pane bar announces that', () => {
      const { container } = render(
        <Header changeset={changeset()} review={{ onFinishReview: () => {} }} />,
      )
      expect(container.querySelector('.prog-cta')).toBeNull()
      expect(screen.queryByText(/Review what changed/)).toBeNull()
    })

    it('leaves Finish review alone in the action slot, and never renames it', () => {
      const { rerender } = render(
        <Header changeset={changeset()} review={{ onFinishReview: () => {} }} />,
      )
      expect(screen.getByText('Finish review')).toBeTruthy()
      rerender(
        <Header changeset={changeset()} review={{ onFinishReview: () => {}, openComments: 2 }} />,
      )
      expect(screen.getByText('Finish review (2)')).toBeTruthy()
      expect(screen.queryByText(/Send round/)).toBeNull()
    })
  })
})
