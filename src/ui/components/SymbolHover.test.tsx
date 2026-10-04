// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { UsageGroup } from '../usages.js'
import { UsagesCard } from './SymbolHover.js'

afterEach(cleanup)

const GROUPS: UsageGroup[] = [
  {
    path: 'src/ui/usages.ts',
    usages: [
      {
        path: 'src/ui/usages.ts',
        hunkId: 'h1',
        line: 12,
        text: 'export function load() {',
        col: 16,
      },
      { path: 'src/ui/usages.ts', hunkId: 'h1', line: 40, text: '  return load()', col: 9 },
    ],
  },
  {
    path: 'main.ts',
    usages: [{ path: 'main.ts', hunkId: 'h2', line: 3, text: 'load()', col: 0 }],
  },
]

describe('UsagesCard', () => {
  it('counts the other usages and lists files collapsed, name first', () => {
    render(
      <UsagesCard
        word="load"
        side="head"
        groups={GROUPS}
        here={{ hunkId: 'h1', line: 12 }}
        onJump={() => {}}
      />,
    )
    expect(screen.getByText('2 other usages')).toBeTruthy()
    expect(screen.getByText('usages.ts')).toBeTruthy()
    expect(screen.getByText('src/ui')).toBeTruthy()
    expect(screen.getByText('main.ts')).toBeTruthy()
    // Two file rows, no line rows yet.
    expect(screen.getAllByRole('button')).toHaveLength(2)
    expect(screen.queryByText('40')).toBeNull()
  })

  it('tells the file holding the hovered line apart in its count', () => {
    render(
      <UsagesCard
        word="load"
        side="head"
        groups={GROUPS}
        here={{ hunkId: 'h1', line: 12 }}
        onJump={() => {}}
      />,
    )
    const row = screen.getByText('usages.ts').closest('button')!
    expect(row.textContent).toContain('1 + here')
  })

  it('opens a file to its lines and marks the hovered one', () => {
    render(
      <UsagesCard
        word="load"
        side="head"
        groups={GROUPS}
        here={{ hunkId: 'h1', line: 12 }}
        onJump={() => {}}
      />,
    )
    const file = screen.getByText('usages.ts').closest('button')!
    expect(file.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(file)
    expect(file.getAttribute('aria-expanded')).toBe('true')
    const here = screen
      .getAllByRole('button')
      .find((b) => b.getAttribute('aria-current') === 'location')
    expect(here?.textContent).toContain('12')
    expect(screen.getByText('40')).toBeTruthy()
    fireEvent.click(file)
    expect(screen.queryByText('40')).toBeNull()
  })

  it('jumps to the picked usage on its side', () => {
    const onJump = vi.fn()
    render(<UsagesCard word="load" side="base" groups={GROUPS} here={null} onJump={onJump} />)
    fireEvent.click(screen.getByText('usages.ts').closest('button')!)
    fireEvent.click(screen.getByText('40').closest('button')!)
    expect(onJump).toHaveBeenCalledWith({ path: 'src/ui/usages.ts', side: 'base', line: 40 })
    expect(screen.getByText('before')).toBeTruthy()
    expect(screen.getByText(/3 other usages/)).toBeTruthy()
  })

  it('says so when the name appears nowhere else', () => {
    render(
      <UsagesCard
        word="only"
        side="head"
        groups={[GROUPS[1]!]}
        here={{ hunkId: 'h2', line: 3 }}
        onJump={() => {}}
      />,
    )
    expect(screen.getByText('nowhere else in this change')).toBeTruthy()
  })

  it('lights the name inside each opened preview', () => {
    render(<UsagesCard word="load" side="head" groups={GROUPS} here={null} onJump={() => {}} />)
    fireEvent.click(screen.getByText('usages.ts').closest('button')!)
    const marks = document.querySelectorAll('mark')
    expect(marks).toHaveLength(2)
    for (const m of marks) expect(m.textContent).toBe('load')
  })
})
