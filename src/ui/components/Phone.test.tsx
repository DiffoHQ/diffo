// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ReviewThread } from '../../shared/review.js'
import type { Hunk } from '../../shared/types.js'
import { PhoneContext } from '../phone.js'
import { HunkCard } from './HunkCard.js'
import { PhoneLayerBar } from './PhoneLayerBar.js'
import { PhoneOutline } from './PhoneOutline.js'
import { type ReviewActions, ThreadCard } from './Threads.js'

vi.mock('../highlight.js', () => ({
  tokenizeLines: async () => null,
  langForPath: () => null,
  patchLineKind: () => null,
}))

afterEach(cleanup)

const onPhone = (ui: ReactNode) => <PhoneContext.Provider value>{ui}</PhoneContext.Provider>

const HUNK: Hunk = {
  id: 'h1',
  path: 'src/a.ts',
  oldStart: 1,
  newStart: 1,
  lines: [
    { kind: 'context', oldNo: 1, newNo: 1, text: 'const a = 1' },
    { kind: 'del', oldNo: 2, newNo: null, text: 'const b = 1' },
    { kind: 'add', oldNo: null, newNo: 2, text: 'const b = 2' },
    { kind: 'add', oldNo: null, newNo: 3, text: 'const c = 3' },
  ],
}

function actionsStub(): ReviewActions {
  return {
    create: vi.fn().mockResolvedValue({ id: 't' }),
    reply: vi.fn(),
    send: vi.fn().mockResolvedValue({ delivered: true }),
    resolve: vi.fn(),
    reopen: vi.fn(),
  }
}

describe('the phone diff', () => {
  it('draws one gutter: the number a line has now, or the old one for a removed line', () => {
    const { container } = render(onPhone(<HunkCard hunk={HUNK} reviewActions={actionsStub()} />))
    const rows = [...container.querySelectorAll('tr.line')]
    expect(rows.map((r) => r.querySelectorAll('td.line-no').length)).toEqual([1, 1, 1, 1])
    expect(rows.map((r) => r.querySelector('td.line-no')!.textContent)).toEqual([
      '1',
      '2',
      '2',
      '3',
    ])
    expect(container.querySelector('.line-marker')).toBeNull()
  })

  it('a tap picks a line, a second tap stretches the pick, and Comment opens on the range', async () => {
    const actions = actionsStub()
    const { container } = render(onPhone(<HunkCard hunk={HUNK} reviewActions={actions} />))
    fireEvent.click(screen.getAllByLabelText('select line 1 to comment')[0]!)
    expect(screen.getByRole('toolbar', { name: 'Picked lines' }).textContent).toContain('1 line')
    fireEvent.click(screen.getByLabelText('select line 3 to comment'))
    expect(screen.getByRole('toolbar').textContent).toContain('4 lines')
    expect(container.querySelectorAll('tr.line-sel')).toHaveLength(4)

    fireEvent.click(screen.getByRole('button', { name: 'Comment' }))
    expect(screen.queryByRole('toolbar', { name: 'Picked lines' })).toBeNull()
    // The composer is a sheet, with the picked lines quoted above the words.
    const sheet = screen.getByRole('dialog')
    expect(sheet.querySelectorAll('.cbox-quote-line')).toHaveLength(4)
    fireEvent.change(sheet.querySelector('textarea')!, { target: { value: 'why?' } })
    fireEvent.click(screen.getByRole('button', { name: /Add comment/ }))
    expect(actions.create).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'hunk', line: 1, endLine: 3 }),
      'why?',
      undefined,
    )
  })

  it('a tap anywhere on a line picks it, not only on its number', () => {
    const { container } = render(onPhone(<HunkCard hunk={HUNK} reviewActions={actionsStub()} />))
    fireEvent.click(container.querySelectorAll('tr.line')[3]!.querySelector('.line-code')!)
    expect(screen.getByRole('toolbar', { name: 'Picked lines' }).textContent).toContain('1 line')
  })

  it('the composer keeps only what writing needs', () => {
    render(onPhone(<HunkCard hunk={HUNK} reviewActions={actionsStub()} />))
    fireEvent.click(screen.getByLabelText('select line 3 to comment'))
    fireEvent.click(screen.getByRole('button', { name: 'Comment' }))
    const sheet = screen.getByRole('dialog')
    expect(sheet.querySelector('.scope-chip')).toBeNull()
    expect(sheet.querySelector('.cbox-rich')).toBeNull()
    expect(sheet.querySelector('.cbox-intent')).toBeNull()
    expect(
      [...sheet.querySelectorAll('.cbox-actions button')].map((b) => b.textContent?.trim()),
    ).toEqual(['Send to agent', 'Add comment⌘↵'])
  })

  it('tapping a lone picked line again lets it go', () => {
    render(onPhone(<HunkCard hunk={HUNK} reviewActions={actionsStub()} />))
    const tap = () => fireEvent.click(screen.getByLabelText('select line 3 to comment'))
    tap()
    expect(screen.getByRole('toolbar', { name: 'Picked lines' })).toBeTruthy()
    tap()
    expect(screen.queryByRole('toolbar', { name: 'Picked lines' })).toBeNull()
  })

  it('keeps the two gutters and the hover button off a phone', () => {
    const { container } = render(<HunkCard hunk={HUNK} reviewActions={actionsStub()} />)
    expect(container.querySelector('tr.line')!.querySelectorAll('td.line-no')).toHaveLength(2)
    expect(container.querySelector('.line-tap')).toBeNull()
  })
})

const THREAD: ReviewThread = {
  id: 't1',
  anchor: { kind: 'hunk', hunkId: 'h1', path: 'src/a.ts', side: 'new', line: 3 },
  state: 'open',
  codeContext: null,
  codeChanged: false,
  messages: [
    {
      id: 'm1',
      author: 'reviewer',
      text: 'Is this the right default?\nmore',
      at: '2026-11-26T00:00:00Z',
    },
  ],
  createdAt: '2026-11-26T00:00:00Z',
  updatedAt: '2026-11-26T00:00:00Z',
}

describe('a thread on a phone', () => {
  it('sits in the diff as a one-line chip and opens as a sheet', () => {
    render(onPhone(<ThreadCard thread={THREAD} actions={actionsStub()} />))
    const chip = screen.getByRole('button', { name: /Is this the right default\?/ })
    expect(chip.className).toContain('thread-chip')
    expect(screen.queryByRole('dialog')).toBeNull()

    fireEvent.click(chip)
    const sheet = screen.getByRole('dialog')
    expect(sheet.className).toContain('psheet-thread')
    expect(sheet.textContent).toContain('Is this the right default?')
    fireEvent.click(screen.getAllByRole('button', { name: 'Close' }).at(-1)!)
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})

describe('the phone layer bar', () => {
  const layer = (over = {}) => ({
    text: 'layer 2 / 3',
    title: '',
    progress: 0,
    prev: { title: 'Bottom sheets', onGo: vi.fn() },
    next: { title: 'Files as a list', onGo: vi.fn() },
    ...over,
  })

  it('goes back and on, each way named by its layer', () => {
    const l = layer()
    render(<PhoneLayerBar layer={l} />)
    fireEvent.click(screen.getByLabelText('Previous layer: Bottom sheets'))
    fireEvent.click(screen.getByLabelText('Next layer: Files as a list'))
    expect(l.prev.onGo).toHaveBeenCalledOnce()
    expect(l.next.onGo).toHaveBeenCalledOnce()
  })

  it('shows only the way there is, and nothing on a lone layer', () => {
    const { container, rerender } = render(<PhoneLayerBar layer={layer({ prev: null })} />)
    expect(screen.queryByLabelText(/^Previous/)).toBeNull()
    rerender(<PhoneLayerBar layer={layer({ prev: null, next: null })} />)
    expect(container.querySelector('.phone-layer-bar')).toBeNull()
  })
})

describe('the phone home outline', () => {
  it('lists the steps with what is left, and opens the one tapped', () => {
    const onPick = vi.fn()
    render(
      <PhoneOutline
        steps={[
          { number: 1, title: 'Phone mode', files: 2, done: 2 },
          { number: 2, title: 'Bottom sheets', files: 3, done: 1 },
        ]}
        onPick={onPick}
      />,
    )
    const [first, second] = screen.getAllByRole('button')
    expect(first!.textContent).toContain('2 files · read')
    expect(second!.textContent).toContain('3 files · 2 left')
    fireEvent.click(second!)
    expect(onPick).toHaveBeenCalledWith(1)
  })
})
