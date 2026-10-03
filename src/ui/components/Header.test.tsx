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
  it('states the place in one line — repo, then the comparison; the size lives in the pane bar', () => {
    const { container } = render(<Header changeset={changeset()} />)
    const chip = container.querySelector('.cmp')!
    expect(chip.querySelector('.repo')!.textContent).toBe('Diffo')
    expect(chip.textContent).toContain('working tree')
    expect(chip.textContent).toContain('HEAD')
    expect(chip.textContent).not.toContain('+1,316')
    expect(container.querySelectorAll('.cmp')).toHaveLength(1)
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

    it('switches the companion, its state marked', () => {
      const onSetCritter = vi.fn()
      render(<Header changeset={changeset()} settings={{ critter: true, onSetCritter }} />)
      fireEvent.click(screen.getByLabelText('Settings'))
      const item = screen.getByText('Companion').closest('button')!
      expect(item.getAttribute('aria-checked')).toBe('true')
      fireEvent.click(item)
      expect(onSetCritter).toHaveBeenCalledWith(false)
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

  it('says where you are once: the branch and worktree ride in the hover, never as more chips', () => {
    const { unmount } = render(<Header changeset={changeset()} />)
    const line = document.querySelector('.cmp')!
    expect(line.querySelector('.repo')!.textContent).toBe('Diffo')
    expect(line.getAttribute('title')).toContain('on branch main')
    expect(line.getAttribute('title')).not.toContain('worktree')
    unmount()

    render(
      <Header
        changeset={changeset({
          repo: { path: '/tmp/demo', name: 'botify', branch: 'fix/scope', worktree: 'wt-fix' },
        })}
      />,
    )
    const line2 = document.querySelector('.cmp')!
    expect(screen.getByText('botify')).toBeTruthy()
    expect(line2.getAttribute('title')).toContain("linked worktree 'wt-fix'")
    expect(line2.getAttribute('title')).toContain('on branch fix/scope')
    expect(document.querySelector('.where-bit')).toBeNull()
  })

  it('the companion roams the header gap while an agent is in play, and leaves when switched off', () => {
    const on = render(<Header changeset={changeset()} agent={{ presence: 'listening' }} />)
    expect(on.container.querySelector('.critter-track svg.critter')).toBeTruthy()
    expect(on.container.querySelector('.critter')!.getAttribute('aria-hidden')).toBe('true')
    cleanup()
    const off = render(
      <Header
        changeset={changeset()}
        agent={{ presence: 'listening' }}
        settings={{ critter: false, onSetCritter: () => {} }}
      />,
    )
    expect(off.container.querySelector('.critter')).toBeNull()
    expect(off.container.querySelector('.grow')).toBeTruthy()
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
    expect(container.querySelector('.presence')!.textContent).toBe('Listening')
  })

  it('a working chip narrates the activity in place of the static label', () => {
    const { rerender, container } = render(
      <Header
        changeset={changeset()}
        agent={{ presence: 'working', activity: 'working on db.ts:42' }}
      />,
    )
    const label = () => container.querySelector('.presence-label')!.textContent
    expect(container.querySelector('.presence-verb')!.textContent).toBe('Working on')
    expect(container.querySelector('.presence-detail')!.textContent).toBe('db.ts:42')

    // No activity to report → the bare verb.
    rerender(<Header changeset={changeset()} agent={{ presence: 'working', activity: null }} />)
    expect(label()).toBe('Working')

    // Activity is the working state's voice alone — listening never borrows it.
    rerender(
      <Header
        changeset={changeset()}
        agent={{ presence: 'listening', activity: 'working on db.ts:42' }}
      />,
    )
    expect(label()).toBe('Listening')
  })

  it('wears the companion’s face: asleep, listening, writing — and happy when a batch is answered', () => {
    const eyes = () => {
      const face = document.querySelector('.presence-face svg.critter-face')!
      if (face.querySelector('.critter-face-open')) return 'open'
      return face.querySelector('.critter-face-eyes')!.getAttribute('d')
    }
    const { rerender } = render(<Header changeset={changeset()} agent={{ presence: 'waiting' }} />)
    expect(document.querySelector('.presence-face')!.getAttribute('aria-hidden')).toBe('true')
    expect(eyes()).toBe('M7.8 10.4h2.4M13.8 10.4h2.4')
    rerender(<Header changeset={changeset()} agent={{ presence: 'listening' }} />)
    expect(eyes()).toBe('open')
    rerender(
      <Header changeset={changeset()} agent={{ presence: 'working', reason: 'delivered' }} />,
    )
    expect(eyes()).toContain('M9 9v2.4')
    expect(document.querySelector('.presence-face-cheer')).toBeNull()
    rerender(<Header changeset={changeset()} agent={{ presence: 'working', reason: 'replied' }} />)
    expect(document.querySelector('.presence-face-cheer')).toBeTruthy()
    expect(eyes()).toContain('M7.8 11l1.2-1.4')
  })

  it('a batch fills the pill as threads come back, and says how far', () => {
    render(
      <Header
        changeset={changeset()}
        agent={{
          presence: 'working',
          activity: 'working on db.ts:42',
          batch: { segments: ['done', 'done', 'now', 'wait', 'wait'], done: 2 },
          onOpenMonitor: vi.fn(),
        }}
      />,
    )
    const chip = document.querySelector('.presence-batch')!
    expect((chip.querySelector('.presence-fill') as HTMLElement).style.width).toBe('40%')
    expect(chip.querySelector('.presence-batch-n')!.textContent).toBe('2/5')
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

describe('Header — the layers suggestion', () => {
  it('between polls the chip keeps the agent — no invite, and the tooltip says a send queues', () => {
    const { container } = render(
      <Header
        changeset={changeset()}
        agent={{ presence: 'working', reason: 'repolling', onInvite: vi.fn() }}
      />,
    )
    expect(container.querySelector('button.presence')).toBeNull()
    const chip = container.querySelector('.presence')!
    expect(chip.textContent).toBe('Paused sends wait')
    expect(chip.textContent).not.toContain('Invite')
    expect(chip.getAttribute('title')).toMatch(/polls again/)
  })

  it('an agent that opened the review but has not polled yet is here — reading, not absent', () => {
    const { container } = render(
      <Header
        changeset={changeset()}
        agent={{ presence: 'working', reason: 'arriving', since: Date.now(), onInvite: vi.fn() }}
      />,
    )
    expect(container.querySelector('button.presence')).toBeNull()
    const chip = container.querySelector('.presence')!
    expect(chip.textContent).toContain('Reading the change')
    expect(chip.textContent).not.toContain('Invite')
    expect(chip.textContent).not.toContain('No agent')
    expect(chip.getAttribute('title')).toMatch(/first poll/)
  })

  it('turns the presence chip into the call to action while the suggestion stands', () => {
    const onOutline = vi.fn()
    render(
      <Header
        changeset={changeset()}
        agent={{
          presence: 'listening',
          suggestion: { reason: 'the parser change explains the rest', onOutline },
        }}
      />,
    )
    const chip = screen.getByRole('button', { name: /Suggests layers/ })
    expect(chip.className).toContain('presence-suggests')
    expect(chip.querySelector('.presence-cta')?.textContent).toBe('Ask it')
    expect(chip.getAttribute('title')).toContain('“the parser change explains the rest”')
    fireEvent.click(chip)
    expect(onOutline).toHaveBeenCalled()
  })

  it('a live batch outranks it, and nobody attached means Invite, not Outline', () => {
    const { container, unmount } = render(
      <Header
        changeset={changeset()}
        agent={{
          presence: 'working',
          suggestion: { onOutline: vi.fn() },
          batch: { segments: ['now'], done: 0 },
          onOpenMonitor: vi.fn(),
        }}
      />,
    )
    expect(container.querySelector('.presence-suggests')).toBeNull()
    expect(container.querySelector('.presence-batch')).toBeTruthy()
    unmount()
    render(
      <Header
        changeset={changeset()}
        agent={{ presence: 'waiting', suggestion: { onOutline: vi.fn() }, onInvite: vi.fn() }}
      />,
    )
    expect(screen.getByRole('button', { name: /Invite/ })).toBeTruthy()
    expect(document.querySelector('.presence-suggests')).toBeNull()
  })
})
