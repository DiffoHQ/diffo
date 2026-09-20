// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Layers, ReviewThread } from '../../shared/review.js'
import type { FileChange, Hunk } from '../../shared/types.js'
import { resolveLayers } from '../layers.js'
import { LayerRail } from './LayerRail.js'

afterEach(cleanup)

const hunk = (path: string, n: number): Hunk => ({
  id: `${path}#${n}`,
  path,
  oldStart: 1,
  newStart: 1,
  lines: [],
})

function file(path: string, hunks = 1, over: Partial<FileChange> = {}): FileChange {
  return {
    path,
    oldPath: null,
    status: 'modified',
    kind: 'text',
    staged: false,
    hunks: Array.from({ length: hunks }, (_, i) => hunk(path, i + 1)),
    ...over,
  }
}

const FILES = [
  file('src/parse.ts', 2),
  file('src/dates.ts', 3),
  file('src/weekday.ts', 2, { status: 'added' }),
  file('src/cli.ts'),
  file('README.md'),
]

const LAYERS: Layers = {
  postedAt: '2026-09-20T00:00:00Z',
  items: [
    { id: 'l1', title: 'Parser contract', files: ['src/parse.ts'] },
    {
      id: 'l2',
      title: 'Weekday resolution',
      files: [{ path: 'src/dates.ts', note: 'delegates to resolveWeekday' }, 'src/weekday.ts'],
    },
    { id: 'l3', title: 'Rename parseDate → parseDue', kind: 'mechanical', files: ['src/cli.ts'] },
  ],
}

const resolved = resolveLayers(LAYERS, FILES)

const at = '2026-09-20T00:00:00Z'
const guide: ReviewThread = {
  id: 'g',
  anchor: { kind: 'changeset' },
  state: 'open',
  codeContext: null,
  codeChanged: false,
  messages: [{ id: 'gm', author: 'agent', text: 'Start here.\n```mermaid\nflowchart LR\n```', at }],
  createdAt: at,
  updatedAt: at,
}

const rows = () => [...document.querySelectorAll('.row-layer:not(.row-layer-overview)')]
const subOf = (row: Element) => row.querySelector('.ch-sub')?.textContent

describe('LayerRail', () => {
  it('one row per layer, file counts under the title; the derived one below a rule', () => {
    render(<LayerRail layers={resolved} activeIndex={-1} onPick={() => {}} viewed={new Set()} />)
    const titles = rows().map((r) => r.querySelector('.row-base')?.textContent)
    expect(titles).toEqual([
      'Parser contract',
      'Weekday resolution',
      'Rename parseDate → parseDue',
      'Since your review',
    ])
    expect(subOf(rows()[0]!)).toBe('1 file')
    expect(subOf(rows()[1]!)).toBe('2 files')
    expect(subOf(rows()[2]!)).toBe('1 file · mechanical')
    expect(rows()[3]!.className).toContain('row-layer-since')
    expect(rows()[3]!.previousElementSibling?.className).toBe('rail-rule')
  })

  it('progress is derived from hunk marks, and a read layer dims and reads "read"', () => {
    const viewed = new Set(['src/dates.ts#1', 'src/dates.ts#2', 'src/parse.ts#1', 'src/parse.ts#2'])
    render(<LayerRail layers={resolved} activeIndex={-1} onPick={() => {}} viewed={viewed} />)
    expect(subOf(rows()[0]!)).toBe('1 file · read')
    expect(rows()[0]!.className).toContain('row-done')
    expect(rows()[0]!.querySelector('[role="checkbox"]')?.getAttribute('aria-checked')).toBe('true')
    expect(subOf(rows()[1]!)).toBe('2 files')
    expect(rows()[1]!.querySelector('[role="checkbox"]')?.getAttribute('aria-checked')).toBe(
      'mixed',
    )
    const bar = rows()[1]!.querySelector<HTMLElement>('.prog-track i')!
    expect(bar.style.width).toBe('40%')
  })

  it('the leading mark is the directory control: mark what is unread, clear when all read', () => {
    const onMarkFiles = vi.fn()
    const onClearFiles = vi.fn()
    const viewed = new Set(['src/dates.ts#1', 'src/dates.ts#2', 'src/dates.ts#3'])
    render(
      <LayerRail
        layers={resolved}
        activeIndex={-1}
        onPick={() => {}}
        viewed={viewed}
        onMarkFiles={onMarkFiles}
        onClearFiles={onClearFiles}
      />,
    )
    fireEvent.click(screen.getByLabelText('Mark 1 file in Weekday resolution reviewed'))
    expect(onMarkFiles).toHaveBeenCalledWith(['src/weekday.ts'])
    cleanup()
    render(
      <LayerRail
        layers={resolved}
        activeIndex={-1}
        onPick={() => {}}
        viewed={new Set([...viewed, 'src/weekday.ts#1', 'src/weekday.ts#2'])}
        onMarkFiles={onMarkFiles}
        onClearFiles={onClearFiles}
      />,
    )
    fireEvent.click(screen.getByLabelText('Mark Weekday resolution not reviewed'))
    expect(onClearFiles).toHaveBeenCalledWith(['src/dates.ts', 'src/weekday.ts'])
  })

  it('files start folded, the active layer included; the chevron opens and shuts them', () => {
    render(<LayerRail layers={resolved} activeIndex={1} onPick={() => {}} viewed={new Set()} />)
    const files = () =>
      [...document.querySelectorAll('.ch-files .row .row-base')].map((n) => n.textContent)
    expect(files()).toEqual([])
    fireEvent.click(screen.getByLabelText('Show the files in Parser contract'))
    fireEvent.click(screen.getByLabelText('Show the files in Weekday resolution'))
    expect(files()).toEqual(['parse.ts', 'dates.ts', 'weekday.ts'])
    fireEvent.click(screen.getByLabelText('Hide the files in Weekday resolution'))
    expect(files()).toEqual(['parse.ts'])
  })

  it('the whole title-and-count block is the pick target; the chevron is not', () => {
    const onPick = vi.fn()
    render(<LayerRail layers={resolved} activeIndex={-1} onPick={onPick} viewed={new Set()} />)
    const row = rows()[1]!
    expect(row.querySelector('.row-pick .ch-sub')).toBeTruthy()
    fireEvent.click(row.querySelector('.ch-sub')!)
    expect(onPick).toHaveBeenCalledWith(1)
    fireEvent.click(screen.getByLabelText('Show the files in Weekday resolution'))
    expect(onPick).toHaveBeenCalledTimes(1)
  })

  it('an opened layer lists its file rows, notes as tooltips; a pick reports up', () => {
    const onPick = vi.fn()
    const onPickFile = vi.fn()
    render(
      <LayerRail
        layers={resolved}
        activeIndex={1}
        onPick={onPick}
        onPickFile={onPickFile}
        viewed={new Set()}
      />,
    )
    expect(rows()[1]!.getAttribute('aria-current')).toBe('true')
    fireEvent.click(screen.getByLabelText('Show the files in Weekday resolution'))
    const files = [...document.querySelectorAll('.ch-files .row .row-base')].map(
      (n) => n.textContent,
    )
    expect(files).toEqual(['dates.ts', 'weekday.ts'])
    const dates = document.querySelector('.ch-files .row .row-pick')!
    expect(dates.getAttribute('title')).toContain('— delegates to resolveWeekday')
    fireEvent.click(dates)
    expect(onPickFile).toHaveBeenCalledWith('src/dates.ts')
    fireEvent.click(screen.getByTitle('Parser contract'))
    expect(onPick).toHaveBeenCalledWith(0)
  })

  it('a thread count sits on the right only when there is one', () => {
    const threads = new Map<string, ReviewThread[]>([['src/dates.ts', [guide, guide]]])
    render(
      <LayerRail
        layers={resolved}
        activeIndex={-1}
        onPick={() => {}}
        viewed={new Set()}
        threads={threads}
      />,
    )
    expect(rows()[1]!.querySelector('.row-count')?.textContent).toBe('2')
    expect(rows()[0]!.querySelector('.row-count')).toBeNull()
  })

  it('row 0 is the guide, not markable, and opens it', () => {
    const onOpenGuide = vi.fn()
    render(
      <LayerRail
        layers={resolved}
        activeIndex={-1}
        onPick={() => {}}
        viewed={new Set()}
        guide={guide}
        onOpenGuide={onOpenGuide}
      />,
    )
    const overview = document.querySelector('.row-layer-overview')!
    expect(overview.querySelector('.row-base')?.textContent).toBe('Overview')
    expect(overview.querySelector('[role="checkbox"]')).toBeNull()
    expect(subOf(overview)).toBe('guide · agent · with diagram')
    fireEvent.click(overview.querySelector('.row-pick')!)
    expect(onOpenGuide).toHaveBeenCalled()
  })

  it('a layer whose files all left says so, and its mark is inert', () => {
    const ghost = resolveLayers(
      { postedAt: at, items: [{ id: 'x', title: 'Ghost', files: ['gone.ts'] }] },
      [],
    )
    render(
      <LayerRail
        layers={ghost}
        activeIndex={0}
        onPick={() => {}}
        viewed={new Set()}
        onMarkFiles={vi.fn()}
      />,
    )
    expect(subOf(rows()[0]!)).toBe('1 listed file not in the changeset')
    expect(rows()[0]!.querySelector<HTMLButtonElement>('[role="checkbox"]')?.disabled).toBe(true)
    expect(document.querySelector('.ch-files')).toBeNull()
  })

  it('offers refresh only when the app can honour it', () => {
    const { unmount } = render(
      <LayerRail layers={resolved} activeIndex={-1} onPick={() => {}} viewed={new Set()} />,
    )
    expect(screen.queryByText('refresh')).toBeNull()
    unmount()
    render(
      <LayerRail
        layers={resolved}
        activeIndex={-1}
        onPick={() => {}}
        viewed={new Set()}
        onRefresh={() => {}}
      />,
    )
    expect(screen.getByText('refresh')).toBeTruthy()
  })
})
