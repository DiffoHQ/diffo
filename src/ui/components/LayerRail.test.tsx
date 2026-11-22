// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Layers, ReviewThread } from '../../shared/review.js'
import type { FileChange, Hunk } from '../../shared/types.js'
import { hideLayerFiles, resolveLayers } from '../layers.js'
import { LayerRail } from './LayerRail.js'

afterEach(cleanup)

// The "Layer again" sheet, and a button in it by its words.
const sheet = () => screen.getByRole('dialog', { name: 'Layer again' })
/** The rail's head: what the layers follow, a button that opens to why. */
const HEAD = () => screen.getByRole('button', { name: /^Layered by/ })
const sheetButton = (name: string) =>
  [...sheet().querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === name)!

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

const rows = () => [...document.querySelectorAll('.row-layer')]
const subOf = (row: Element) => row.querySelector('.ch-sub')?.textContent

describe('LayerRail', () => {
  it('one row per layer, file counts under the title; the derived one under its own label', () => {
    render(<LayerRail layers={resolved} activeIndex={-1} onPick={() => {}} viewed={new Set()} />)
    const titles = rows().map((r) => r.querySelector('.row-base')?.textContent)
    expect(titles).toEqual([
      'Parser contract',
      'Weekday resolution',
      'Rename parseDate → parseDue',
      'Not in any layer',
    ])
    expect(subOf(rows()[0]!)).toBe('1 file')
    expect(subOf(rows()[1]!)).toBe('2 files')
    expect(subOf(rows()[2]!)).toBe('1 file · mechanical')
    expect(rows()[3]!.className).toContain('row-layer-since')
    expect(document.querySelector('.lr-sec-since')?.textContent).toBe('Since your review')
  })

  it('the size sits after the file count, added and removed in the diff’s colours', () => {
    const line = (kind: 'add' | 'del') => ({
      kind,
      oldNo: kind === 'del' ? 1 : null,
      newNo: kind === 'add' ? 1 : null,
      text: '',
    })
    const sized = resolveLayers(LAYERS, [
      { ...FILES[0]!, hunks: [{ ...hunk('src/parse.ts', 1), lines: [line('add'), line('add')] }] },
      { ...FILES[1]!, hunks: [{ ...hunk('src/dates.ts', 1), lines: [line('add'), line('del')] }] },
      { ...FILES[2]!, hunks: [{ ...hunk('src/weekday.ts', 1), lines: [line('add')] }] },
      { ...FILES[3]!, hunks: [{ ...hunk('src/cli.ts', 1), lines: [line('del')] }] },
      FILES[4]!,
    ])
    render(
      <LayerRail
        layers={sized}
        activeIndex={-1}
        onPick={() => {}}
        viewed={new Set(['src/parse.ts#1'])}
      />,
    )
    expect(subOf(rows()[0]!)).toBe('1 file · +2 · read')
    expect(subOf(rows()[1]!)).toBe('2 files · +2 −1')
    expect(subOf(rows()[2]!)).toBe('1 file · −1 · mechanical')
    // A layer with no changed lines says nothing about size — `+0 −0` is noise.
    expect(subOf(rows()[3]!)).toBe('1 file')
    expect(rows()[1]!.querySelector('.ch-sub .stat-add')?.textContent).toBe('+2')
    expect(rows()[1]!.querySelector('.ch-sub .stat-del')?.textContent).toBe('−1')
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

  it('an unstarted layer draws no bar — an empty track reads as broken', () => {
    render(
      <LayerRail
        layers={resolved}
        activeIndex={-1}
        onPick={() => {}}
        viewed={new Set(['src/dates.ts#1'])}
      />,
    )
    expect(rows()[0]!.querySelector('.prog-track')).toBeNull()
    expect(rows()[1]!.querySelector('.prog-track')).not.toBeNull()
  })

  it('a hidden file is counted under the title, and a layer left with none says why', () => {
    const shown = hideLayerFiles(
      resolved,
      (f) => f.path === 'src/dates.ts' || f.path === 'src/cli.ts',
    )
    const onMarkFiles = vi.fn()
    render(
      <LayerRail
        layers={shown}
        activeIndex={-1}
        onPick={() => {}}
        viewed={new Set()}
        onMarkFiles={onMarkFiles}
      />,
    )
    expect(subOf(rows()[1]!)).toBe('1 file · 1 hidden')
    // Emptied by the switch, not by the changeset: a different sentence, and
    // nothing to mark or unfold.
    expect(subOf(rows()[2]!)).toBe('1 test hidden')
    expect(rows()[2]!.querySelector('[role="checkbox"]')?.hasAttribute('disabled')).toBe(true)
    expect(rows()[2]!.querySelector('.ch-fold')).toBeNull()
    // The roll-up marks what is shown; a hidden file is excluded, not read.
    fireEvent.click(rows()[1]!.querySelector('[role="checkbox"]')!)
    expect(onMarkFiles).toHaveBeenCalledWith(['src/weekday.ts'], expect.anything())
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
    expect(onMarkFiles).toHaveBeenCalledWith(['src/weekday.ts'], expect.anything())
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
    expect(onClearFiles).toHaveBeenCalledWith(['src/dates.ts', 'src/weekday.ts'], expect.anything())
  })

  it('files start folded, the active layer included; the chevron opens and shuts them', () => {
    render(<LayerRail layers={resolved} activeIndex={1} onPick={() => {}} viewed={new Set()} />)
    const files = () =>
      [...document.querySelectorAll('.ch-files .row:not(.row-dir) .row-base')].map(
        (n) => n.textContent,
      )
    expect(files()).toEqual([])
    fireEvent.click(screen.getByLabelText('Show the files in Parser contract'))
    fireEvent.click(screen.getByLabelText('Show the files in Weekday resolution'))
    expect(files()).toEqual(['parse.ts', 'dates.ts', 'weekday.ts'])
    fireEvent.click(screen.getByLabelText('Hide the files in Weekday resolution'))
    expect(files()).toEqual(['parse.ts'])
  })

  it('an opened layer is the Files tree: folders fold, and their mark rolls the layer up', () => {
    const onMarkFiles = vi.fn()
    render(
      <LayerRail
        layers={resolved}
        activeIndex={1}
        onPick={() => {}}
        viewed={new Set()}
        onMarkFiles={onMarkFiles}
      />,
    )
    // No reading-order control of its own: that switch lives on the layer card
    // and moves the pane, never this tree.
    expect(screen.queryByRole('radiogroup')).toBeNull()
    const names = () =>
      [...document.querySelectorAll('.ch-files .row .row-base')].map((n) => n.textContent)
    fireEvent.click(screen.getByLabelText('Show the files in Weekday resolution'))
    // By folder, files by basename under it — not the flat list the agent
    // posted. The pane keeps the agent's order; the tree is the map.
    expect(names()).toEqual(['src', 'dates.ts', 'weekday.ts'])
    const dir = document.querySelector('.ch-files .row-dir')!
    expect(dir.querySelector('.dir-ico')).toBeTruthy()
    // Folded and unfolded on the folder's own row, independent of the layer's chevron.
    fireEvent.click(dir.querySelector('.row-pick')!)
    expect(names()).toEqual(['src'])
    fireEvent.click(dir.querySelector('.row-pick')!)
    expect(names()).toEqual(['src', 'dates.ts', 'weekday.ts'])
    // The folder's box is the same roll-up the Files tab has.
    fireEvent.click(screen.getByLabelText('Mark 2 files in src reviewed'))
    expect(onMarkFiles).toHaveBeenCalledWith(['src/dates.ts', 'src/weekday.ts'], expect.anything())
    // The trailing layer's root file needs no folder: it sits at the top level.
    fireEvent.click(screen.getByLabelText('Show the files in Since your review'))
    expect(names().slice(3)).toEqual(['README.md'])
    expect(document.querySelectorAll('.ch-files .row-dir')).toHaveLength(1)
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
    // The row's own padding picks too — the whole row is the target, once.
    fireEvent.click(row)
    expect(onPick).toHaveBeenCalledTimes(2)
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
    const files = [...document.querySelectorAll('.ch-files .row:not(.row-dir) .row-base')].map(
      (n) => n.textContent,
    )
    expect(files).toEqual(['dates.ts', 'weekday.ts'])
    const dates = document.querySelector('.ch-files .row:not(.row-dir) .row-pick')!
    expect(dates.getAttribute('title')).toContain(', delegates to resolveWeekday')
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

  it('the guide is the Overview: a button in the head, not a row, and it opens it', () => {
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
    const overview = document.querySelector('.lr-head .lr-ov')!
    expect(overview.getAttribute('aria-label')).toBe('Overview')
    expect(overview.getAttribute('title')).toBe('Overview: the agent’s guide')
    expect(overview.hasAttribute('aria-current')).toBe(false)
    // Not a row of the list: the list is the layers and nothing else.
    expect(document.querySelector('.rail-scroll')!.textContent).not.toContain('Overview')
    fireEvent.click(overview)
    expect(onOpenGuide).toHaveBeenCalled()
  })

  it('on a pull request the description alone makes the Overview', () => {
    const description: ReviewThread = {
      ...guide,
      id: 'd',
      github: { threadId: 'description', kind: 'description', resolved: false, outdated: false },
    }
    render(
      <LayerRail
        layers={resolved}
        activeIndex={-1}
        onPick={() => {}}
        viewed={new Set()}
        description={description}
        onOpenGuide={() => {}}
      />,
    )
    const overview = document.querySelector('.lr-head .lr-ov')!
    expect(overview.getAttribute('title')).toBe('Overview: the pull request description')
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

  const rail = (over: Partial<Parameters<typeof LayerRail>[0]> = {}) =>
    render(
      <LayerRail
        layers={resolved}
        activeIndex={-1}
        onPick={() => {}}
        viewed={new Set()}
        {...over}
      />,
    )

  const menuItems = () =>
    [...document.querySelectorAll<HTMLButtonElement>('.menu-panel .menu-item')].map(
      (i) => `${i.textContent}${i.disabled ? ' (off)' : ''}`,
    )
  const openMore = () =>
    fireEvent.click(screen.getByRole('button', { name: 'More for these layers' }))
  it('"Add to layers" sits on the Since your review label; "Layer again" is in the more menu', () => {
    const onRefresh = vi.fn()
    const onAsk = vi.fn()
    const onPick = vi.fn()
    const { unmount } = rail({ onRefresh, onAsk, onPick })
    const act = screen.getByRole('button', { name: 'Add to layers' })
    expect(act.closest('.lr-sec-since')).toBeTruthy()
    // The light ask goes as it is: the agent places what is outside, no sheet.
    fireEvent.click(act)
    expect(onAsk).toHaveBeenCalledWith({ add: true })
    expect(onPick).not.toHaveBeenCalled()
    expect(screen.queryByRole('dialog')).toBeNull()
    // A new split never starts on its own: the sheet opens, and its button asks.
    openMore()
    expect(menuItems()).toEqual(['Layer again'])
    fireEvent.click(screen.getByRole('menuitem', { name: 'Layer again' }))
    // The menu closes on a choice.
    expect(document.querySelector('.menu-panel')).toBeNull()
    fireEvent.click(sheetButton('Cancel'))
    expect(onAsk).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('button', { name: 'More for these layers' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Layer again' }))
    fireEvent.click(sheetButton('Layer again'))
    expect(onAsk).toHaveBeenCalledTimes(2)
    expect(onRefresh).not.toHaveBeenCalled()
    unmount()
    // No agent: nothing on the label, and the menu's item is there but off.
    rail({ onRemove: vi.fn() })
    expect(screen.queryByRole('button', { name: 'Add to layers' })).toBeNull()
    openMore()
    expect(menuItems()).toEqual(['Layer again (off)', 'Remove layers'])
  })

  it('Remove layers is in the more menu and asks first, in a dialog', async () => {
    const onRemove = vi.fn()
    rail({ onRefresh: vi.fn(), onRemove })
    openMore()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Remove layers' }))
    const dialog = screen.getByRole('dialog', { name: 'Remove layers' })
    expect(dialog.textContent).toContain('Your read marks and threads stay')
    expect(onRemove).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    openMore()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Remove layers' }))
    fireEvent.click(screen.getByRole('dialog').querySelector<HTMLButtonElement>('.btn-danger')!)
    await waitFor(() => expect(onRemove).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  it('a re-outline in flight: the head says so, and nothing offers to ask again', () => {
    const { unmount } = rail({ onAsk: vi.fn(), request: 'outlining' })
    expect(document.querySelector('.lr-status')?.textContent).toContain('Layering again…')
    expect(screen.queryByRole('button', { name: 'Add to layers' })).toBeNull()
    openMore()
    expect(menuItems()).toEqual(['Layer again (off)'])
    unmount()
    // Parked behind open threads: not "outlining".
    const parked = rail({ onRefresh: vi.fn(), request: 'queued' })
    expect(document.querySelector('.lr-status')?.textContent).toContain(
      'Asked · after the agent’s open threads',
    )
    parked.unmount()
    // Stalled: the head says so and gives the ask back.
    const onRefresh = vi.fn()
    rail({ onRefresh, request: 'stalled' })
    expect(document.querySelector('.lr-status')?.textContent).toContain('No layers came back.')
    fireEvent.click(screen.getByRole('button', { name: 'Ask again' }))
    expect(onRefresh).toHaveBeenCalledTimes(1)
  })

  it('"Layer again" opens the sheet on what the layers follow; only its button asks, with the note', () => {
    const onAsk = vi.fn()
    rail({
      onAsk,
      preset: { id: 'importance', name: 'Importance', blurb: 'the core' },
      presets: [
        { id: 'concept', name: 'Concept' },
        { id: 'importance', name: 'Importance' },
      ],
      note: 'tests in background',
    })
    // The head stays one line, and opens to the note these layers carry.
    expect(document.querySelector('.lr-head')?.textContent).toBe('Layered byImportance')
    fireEvent.click(HEAD())
    expect(document.querySelector('.lr-about-note')?.textContent).toBe(
      'Your note: tests in background',
    )
    fireEvent.click(HEAD())
    // Changing the preset is "Layer again": the sheet opens on what the layers
    // follow, and nothing is asked until its button.
    fireEvent.click(screen.getByRole('button', { name: 'More for these layers' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Layer again' }))
    const picker = screen.getByRole('button', { name: 'What the layers are for' })
    expect(picker.textContent).toBe('Importance')
    fireEvent.click(picker)
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Concept' }))
    expect(onAsk).not.toHaveBeenCalled()
    expect(picker.textContent).toBe('Concept')
    // The note comes along, and can be changed for this ask.
    const noteBox = screen.getByLabelText('For this change only (optional)') as HTMLTextAreaElement
    expect(noteBox.value).toBe('tests in background')
    fireEvent.change(noteBox, { target: { value: 'migration first' } })
    fireEvent.click(sheetButton('Layer again'))
    expect(onAsk).toHaveBeenCalledWith({ preset: 'concept', note: 'migration first' })
    // One-time instructions: no preset, and the button waits for the words.
    fireEvent.click(screen.getByRole('button', { name: 'More for these layers' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Layer again' }))
    fireEvent.click(screen.getByRole('button', { name: 'What the layers are for' }))
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'One-time instructions' }))
    fireEvent.change(screen.getByLabelText('Your instructions for this change'), {
      target: { value: '' },
    })
    expect(sheetButton('Layer again').disabled).toBe(true)
    fireEvent.change(screen.getByLabelText('Your instructions for this change'), {
      target: { value: 'only the database' },
    })
    fireEvent.click(sheetButton('Layer again'))
    expect(onAsk).toHaveBeenLastCalledWith({ preset: null, note: 'only the database' })
  })

  it('the light ask says "adding" while it is on its way', () => {
    const { rerender } = rail({ onAsk: vi.fn() })
    fireEvent.click(screen.getByRole('button', { name: 'Add to layers' }))
    rerender(
      <LayerRail
        layers={resolved}
        activeIndex={-1}
        onPick={() => {}}
        viewed={new Set()}
        onAsk={vi.fn()}
        request="outlining"
      />,
    )
    expect(document.querySelector('.lr-status')?.textContent).toContain('Adding to the layers…')
  })

  it('the sheet links to the Layers dialog, and closes on the way', () => {
    const onOpenPresets = vi.fn()
    rail({ onAsk: vi.fn(), onOpenPresets, presets: [] })
    fireEvent.click(screen.getByRole('button', { name: 'More for these layers' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Layer again' }))
    fireEvent.click(sheetButton('Manage presets'))
    expect(onOpenPresets).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('the more menu opens the Layers presets dialog too, above Remove layers', () => {
    const onOpenPresets = vi.fn()
    rail({ onAsk: vi.fn(), onOpenPresets, onRemove: vi.fn(), presets: [] })
    fireEvent.click(screen.getByRole('button', { name: 'More for these layers' }))
    expect(screen.getAllByRole('menuitem').map((m) => m.textContent)).toEqual([
      'Layer again',
      'Manage presets',
      'Remove layers',
    ])
    fireEvent.click(screen.getByRole('menuitem', { name: 'Manage presets' }))
    expect(onOpenPresets).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('layers by the reviewer’s own words alone: the head says so, and the words are one click away', () => {
    rail({ onAsk: vi.fn(), presets: [], note: 'only the database' })
    expect(HEAD().textContent).toBe('Layered byyour instructions')
    expect(document.querySelector('.lr-about')).toBeNull()
    fireEvent.click(HEAD())
    expect(document.querySelector('.lr-about')?.textContent).toBe('only the database')
  })

  it('the hair of progress under the head waits for the first mark', () => {
    const { unmount } = rail()
    expect(document.querySelector('.lr-prog')).toBeNull()
    unmount()
    rail({ viewed: new Set(resolved[0]!.files.flatMap((f) => f.hunks.map((h) => h.id))) })
    expect(document.querySelector('.lr-prog')?.getAttribute('role')).toBe('progressbar')
  })
})

describe('LayerRail — presets and background', () => {
  const line = (kind: 'add' | 'del') => ({
    kind,
    oldNo: kind === 'del' ? 1 : null,
    newNo: kind === 'add' ? 1 : null,
    text: '',
  })
  const files = [
    { ...FILES[0]!, hunks: [{ ...hunk('src/parse.ts', 1), lines: [line('add'), line('add')] }] },
    { ...FILES[1]!, hunks: [{ ...hunk('src/dates.ts', 1), lines: [line('add'), line('del')] }] },
    { ...FILES[3]!, hunks: [{ ...hunk('src/cli.ts', 1), lines: [line('add')] }] },
  ]
  const withBackground = resolveLayers(
    {
      postedAt: at,
      items: [
        { id: 'l1', title: 'Parser contract', files: ['src/parse.ts'] },
        { id: 'b1', title: 'Implementation', kind: 'background', files: ['src/dates.ts'] },
        { id: 'b2', title: 'Tests', kind: 'background', files: ['src/cli.ts'] },
      ],
    },
    files,
  )

  beforeEach(() => localStorage.clear())

  const sections = () =>
    [...document.querySelectorAll<HTMLButtonElement>('button.lr-sec')].map((b) => ({
      text: b.textContent,
      open: b.getAttribute('aria-expanded') === 'true',
    }))

  const menuItems = () =>
    [...document.querySelectorAll<HTMLButtonElement>('.menu-panel .menu-item')].map(
      (i) => `${i.textContent}${i.disabled ? ' (off)' : ''}`,
    )
  const presets = [
    { id: 'concept', name: 'Concept' },
    { id: 'importance', name: 'Importance' },
  ]

  it('the head names what the layers follow, and opens on a click to why', () => {
    const { rerender } = render(
      <LayerRail layers={resolved} activeIndex={-1} onPick={() => {}} viewed={new Set()} />,
    )
    // Layers that follow nothing: a plain title, nothing to open.
    expect(document.querySelector('.lr-title')?.textContent).toBe('Layers')
    expect(document.querySelector('.lr-preset')).toBeNull()
    rerender(
      <LayerRail
        layers={resolved}
        activeIndex={-1}
        onPick={() => {}}
        viewed={new Set()}
        preset={{
          id: 'importance',
          name: 'Importance',
          blurb: 'the code that drives the change',
          picked: true,
          why: 'a large feature',
        }}
        presets={presets}
        onAsk={vi.fn()}
        onOpenPresets={vi.fn()}
      />,
    )
    expect(HEAD().textContent).toBe('Layered byImportance')
    expect(HEAD().getAttribute('aria-expanded')).toBe('false')
    expect(document.querySelector('.lr-about')).toBeNull()
    // The head is not a menu: a click opens what the preset shows and who
    // picked it, and a second click closes it.
    fireEvent.click(HEAD())
    expect(screen.queryByRole('menu')).toBeNull()
    expect(HEAD().getAttribute('aria-expanded')).toBe('true')
    expect(document.querySelector('.lr-about-blurb')?.textContent).toBe(
      'The code that drives the change.',
    )
    expect(document.querySelector('.lr-about-by')?.textContent).toBe(
      'The agent picked it: a large feature.',
    )
    fireEvent.click(HEAD())
    expect(document.querySelector('.lr-about')).toBeNull()
    // The chevron at the row's end does the same, after the "more".
    const row = document.querySelector('.lr-head-row')!
    expect(row.lastElementChild?.className).toBe('lr-head-chev')
    expect(row.lastElementChild?.previousElementSibling?.className).toBe('menu')
    fireEvent.click(row.lastElementChild!)
    expect(document.querySelector('.lr-about')).toBeTruthy()
    fireEvent.click(row.lastElementChild!)
    // The more menu no longer carries it: what is left acts on the layers.
    fireEvent.click(screen.getByRole('button', { name: 'More for these layers' }))
    expect(menuItems()).toEqual(['Layer again', 'Manage presets'])
  })

  it('a preset the reviewer took from the agent’s suggestion says the agent suggested it', () => {
    const about = (preset: { suggested?: boolean; why?: string }) => {
      cleanup()
      render(
        <LayerRail
          layers={resolved}
          activeIndex={-1}
          onPick={() => {}}
          viewed={new Set()}
          preset={{ id: 'importance', name: 'Importance', blurb: 'what matters', ...preset }}
        />,
      )
      fireEvent.click(HEAD())
      return document.querySelector('.lr-about-by')?.textContent
    }
    expect(about({ suggested: true, why: '53 files, mostly implementation' })).toBe(
      'The agent suggested it: 53 files, mostly implementation.',
    )
    expect(about({ suggested: true })).toBe('The agent suggested it.')
    expect(about({})).toBe('You picked it.')
  })

  it('among sections the Overview stays in the head, lit while the pane is on it', () => {
    const guide = {
      id: 'g',
      anchor: { kind: 'changeset' as const },
      state: 'open' as const,
      messages: [],
      createdAt: at,
      updatedAt: at,
    }
    render(
      <LayerRail
        layers={withBackground}
        activeIndex={-1}
        onPick={() => {}}
        viewed={new Set()}
        guide={guide as never}
        onOpenGuide={() => {}}
        overviewActive
      />,
    )
    const scroll = document.querySelector('.rail-scroll')!
    // The list opens on its first section: the Overview is the book in the head.
    expect(scroll.children[0]!.className).toBe('lr-sec')
    expect(scroll.textContent).not.toContain('Overview')
    const overview = document.querySelector('.lr-head .lr-ov')!
    expect(overview.querySelector('svg')).toBeTruthy()
    expect(overview.getAttribute('title')).toContain('the agent’s guide')
    expect(overview.getAttribute('aria-current')).toBe('true')
    // The head is outside the scroller, so its menus are never clipped by the list.
    expect(scroll.querySelector('.lr-head')).toBeNull()
    expect(scroll.previousElementSibling?.className).toBe('lr-head')
  })

  it('sections are quiet labels with a count and the lines; Other changes starts folded', () => {
    const onPick = vi.fn()
    render(
      <LayerRail layers={withBackground} activeIndex={-1} onPick={onPick} viewed={new Set()} />,
    )
    expect(sections()).toEqual([
      { text: 'Key changes1+2', open: true },
      { text: 'Other changes2+2 −1', open: false },
    ])
    const titles = () => rows().map((r) => r.querySelector('.row-base')?.textContent)
    expect(titles()).toEqual(['Parser contract'])
    // Opening Other changes lists its layers; the tag is the section, not the row.
    fireEvent.click(screen.getByRole('button', { name: /^Other changes/ }))
    expect(titles()).toEqual(['Parser contract', 'Implementation', 'Tests'])
    expect(document.querySelectorAll('.lr-bg .row-layer')).toHaveLength(2)
    expect(subOf(rows()[1]!)).toBe('1 file · +1 −1')
    // A background layer keeps its place in the outline, so picking it reads it.
    fireEvent.click(rows()[2]!.querySelector('.row-pick')!)
    expect(onPick).toHaveBeenCalledWith(2)
    // Folding Key changes hides its layers; the choice is remembered.
    fireEvent.click(screen.getByRole('button', { name: /^Key changes/ }))
    expect(titles()).toEqual(['Implementation', 'Tests'])
    expect(JSON.parse(localStorage.getItem('diffo:ui:layerSections')!)).toEqual({
      read: false,
      background: true,
    })
  })

  it('a folded section the reviewer moves into shows their place', () => {
    render(
      <LayerRail layers={withBackground} activeIndex={1} onPick={() => {}} viewed={new Set()} />,
    )
    expect(sections()[1]).toEqual({ text: 'Other changes2+2 −1', open: true })
    expect(rows()).toHaveLength(3)
    expect(rows()[1]!.getAttribute('aria-current')).toBe('true')
  })

  it('a click on the header folds a section over the active layer, until the reviewer moves', () => {
    const rail = (active: number) => (
      <LayerRail
        layers={withBackground}
        activeIndex={active}
        onPick={() => {}}
        viewed={new Set()}
      />
    )
    const { rerender } = render(rail(0))
    const titles = () => rows().map((r) => r.querySelector('.row-base')?.textContent)
    expect(titles()).toEqual(['Parser contract'])
    // The active layer is in Key changes, and the header still folds it.
    fireEvent.click(screen.getByRole('button', { name: /^Key changes/ }))
    expect(sections()[0]).toEqual({ text: 'Key changes1+2', open: false })
    expect(titles()).toEqual([])
    // A second click opens it again.
    fireEvent.click(screen.getByRole('button', { name: /^Key changes/ }))
    expect(titles()).toEqual(['Parser contract'])
    // Other changes was never opened: moving into it shows the place, a click
    // on its header folds it, and moving on shows the new place.
    rerender(rail(1))
    expect(sections()[1]!.open).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: /^Other changes/ }))
    expect(sections()[1]!.open).toBe(false)
    rerender(rail(2))
    expect(sections()[1]!.open).toBe(true)
  })

  it('under the layers, a line offers a different split and opens the sheet', () => {
    const onAsk = vi.fn()
    const { rerender } = render(
      <LayerRail
        layers={resolved}
        activeIndex={-1}
        onPick={() => {}}
        viewed={new Set()}
        onAsk={onAsk}
      />,
    )
    const cta = document.querySelector('.lr-cta')!
    expect(cta.textContent).toBe('Layers not quite right?Change the preset or tell the agent')
    // The last thing in the list, after every layer.
    expect(cta.parentElement!.lastElementChild).toBe(cta)
    fireEvent.click(screen.getByRole('button', { name: 'Change the preset or tell the agent' }))
    // Nothing is asked until the sheet's own button.
    expect(onAsk).not.toHaveBeenCalled()
    expect(screen.getByRole('dialog', { name: 'Layer again' })).toBeTruthy()
    // No agent to ask, or an ask on its way: no offer.
    rerender(<LayerRail layers={resolved} activeIndex={-1} onPick={() => {}} viewed={new Set()} />)
    expect(document.querySelector('.lr-cta')).toBeNull()
    rerender(
      <LayerRail
        layers={resolved}
        activeIndex={-1}
        onPick={() => {}}
        viewed={new Set()}
        onAsk={onAsk}
        request="outlining"
      />,
    )
    expect(document.querySelector('.lr-cta')).toBeNull()
  })

  it('what moved since the outline comes last of all, after the background section', () => {
    // A fourth file no layer lists: the derived trailing layer.
    const moved = resolveLayers(
      {
        postedAt: at,
        items: [
          { id: 'l1', title: 'Parser contract', files: ['src/parse.ts'] },
          { id: 'b1', title: 'Tests', kind: 'background', files: ['src/cli.ts'] },
        ],
      },
      [...files, { ...FILES[2]!, hunks: [{ ...hunk(FILES[2]!.path, 1), lines: [line('add')] }] }],
    )
    render(<LayerRail layers={moved} activeIndex={-1} onPick={() => {}} viewed={new Set()} />)
    fireEvent.click(screen.getByRole('button', { name: /^Other changes/ }))
    const titles = rows().map((r) => r.querySelector('.row-base')?.textContent)
    expect(titles).toEqual(['Parser contract', 'Tests', 'Not in any layer'])
    expect(rows()[2]!.className).toContain('row-layer-since')
    expect(document.querySelectorAll('.lr-bg .row-layer')).toHaveLength(1)
    // Folding Other changes leaves the trailing layer in sight.
    fireEvent.click(screen.getByRole('button', { name: /^Other changes/ }))
    expect(rows().map((r) => r.querySelector('.row-base')?.textContent)).toEqual([
      'Parser contract',
      'Not in any layer',
    ])
  })

  it('without background layers there are no sections', () => {
    render(<LayerRail layers={resolved} activeIndex={-1} onPick={() => {}} viewed={new Set()} />)
    expect(document.querySelector('button.lr-sec')).toBeNull()
    expect(rows()).toHaveLength(resolved.length)
  })
})

describe('LayerRail — one head row with the Steps / Commits switch', () => {
  it('gives the head row to the switch, and heads the list with what the layers follow', () => {
    render(
      <LayerRail
        layers={[]}
        activeIndex={0}
        onPick={vi.fn()}
        viewed={new Set()}
        preset={{ name: 'Concept', blurb: 'one idea per layer' }}
        source={<div data-testid="switch" />}
      />,
    )
    const row = document.querySelector('.lr-head-row')!
    expect(row.firstElementChild).toBe(screen.getByTestId('switch'))
    expect(row.querySelector('.lr-preset')).toBeNull()
    expect(document.querySelector('.lr-head-chev')).toBeNull()
    const by = document.querySelector('.rail-scroll')!.firstElementChild as HTMLElement
    expect(by.classList.contains('lr-sec-by')).toBe(true)
    expect(by.textContent).toBe('Layered by Concept')
    // A label with its explanation on hover: nothing to click, nothing folds.
    expect(by.tagName).toBe('DIV')
    expect(by.querySelector('.chevron')).toBeNull()
    expect(by.getAttribute('data-tip')).toBe('One idea per layer. You picked it.')
    expect(document.querySelector('.lr-about')).toBeNull()
  })

  it('without the switch the head reads as it always did', () => {
    render(
      <LayerRail
        layers={[]}
        activeIndex={0}
        onPick={vi.fn()}
        viewed={new Set()}
        preset={{ name: 'Concept', blurb: 'one idea per layer' }}
      />,
    )
    expect(document.querySelector('.lr-preset')?.textContent).toBe('Layered byConcept')
    expect(document.querySelector('.lr-head-chev')).toBeTruthy()
  })
})
