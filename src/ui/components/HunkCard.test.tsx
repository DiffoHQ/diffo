// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Hunk } from '../../shared/types.js'
import { HunkCard } from './HunkCard.js'
import type { ReviewActions } from './Threads.js'

vi.mock('../highlight.js', () => ({
  tokenizeLines: async () => null,
  langForPath: () => null,
}))

afterEach(cleanup)

const HUNK: Hunk = {
  id: 'h4',
  path: 'src/server/index.ts',
  oldStart: 677,
  newStart: 713,
  lines: [
    { kind: 'context', oldNo: 677, newNo: 713, text: 'console.log(a)' },
    { kind: 'add', oldNo: null, newNo: 714, text: '  const unsubscribeBatch = 1' },
  ],
}

const WIDE_HUNK: Hunk = {
  id: 'h9',
  path: 'src/a.ts',
  oldStart: 1,
  newStart: 1,
  lines: [
    { kind: 'context', oldNo: 1, newNo: 1, text: 'const a = 1' },
    { kind: 'add', oldNo: null, newNo: 2, text: 'const b = 2' },
    { kind: 'add', oldNo: null, newNo: 3, text: 'const c = 3' },
    { kind: 'context', oldNo: 2, newNo: 4, text: 'export {}' },
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

describe('multi-line comments', () => {
  it('a gutter drag opens the composer on the range, and the anchor carries it', () => {
    const actions = actionsStub()
    const { container } = render(<HunkCard hunk={WIDE_HUNK} reviewActions={actions} />)
    const rows = [...container.querySelectorAll('tr.line')]
    fireEvent.mouseDown(rows[1]!.querySelector('.line-no')!, { button: 0 })
    fireEvent.mouseEnter(rows[2]!)
    fireEvent.mouseUp(document)

    // The dragged rows are marked, and the chip names the span.
    expect(container.querySelectorAll('tr.line-sel').length).toBe(2)
    expect(screen.getByText('a.ts:2-3')).toBeTruthy()

    fireEvent.change(screen.getByPlaceholderText('Leave a comment…'), {
      target: { value: 'these two belong together' },
    })
    fireEvent.click(screen.getByText('Add comment'))
    expect(actions.create).toHaveBeenCalledWith(
      { kind: 'hunk', hunkId: 'h9', path: 'src/a.ts', side: 'new', line: 2, endLine: 3 },
      'these two belong together',
      undefined,
    )
  })

  it('an upward drag lands the composer under the bottom line all the same', () => {
    const actions = actionsStub()
    const { container } = render(<HunkCard hunk={WIDE_HUNK} reviewActions={actions} />)
    const rows = [...container.querySelectorAll('tr.line')]
    fireEvent.mouseDown(rows[2]!.querySelector('.line-no')!, { button: 0 })
    fireEvent.mouseEnter(rows[1]!)
    fireEvent.mouseUp(document)
    expect(screen.getByText('a.ts:2-3')).toBeTruthy()
    // The composer row sits after the range's last line, not its first.
    const composerRow = container.querySelector('.thread-row')!
    expect(composerRow.previousElementSibling).toBe(rows[2])
  })

  it('the steppers walk one free edge through the anchor — every press reversible', () => {
    const actions = actionsStub()
    const { container } = render(<HunkCard hunk={WIDE_HUNK} reviewActions={actions} />)
    const rows = [...container.querySelectorAll('tr.line')]
    fireEvent.mouseDown(rows[2]!.querySelector('.line-no')!, { button: 0 })
    fireEvent.mouseUp(document)
    expect(screen.getByText('a.ts:3')).toBeTruthy()

    // Up: the edge climbs above the anchor; the composer stays on the anchor row.
    fireEvent.click(screen.getByLabelText('range edge one line up'))
    expect(screen.getByText('a.ts:2-3')).toBeTruthy()
    expect(container.querySelector('.thread-row')!.previousElementSibling).toBe(rows[2])
    fireEvent.click(screen.getByLabelText('range edge one line up'))
    expect(screen.getByText('a.ts:1-3')).toBeTruthy()

    // Down is up's exact inverse…
    fireEvent.click(screen.getByLabelText('range edge one line down'))
    expect(screen.getByText('a.ts:2-3')).toBeTruthy()
    fireEvent.click(screen.getByLabelText('range edge one line down'))
    expect(screen.getByText('a.ts:3')).toBeTruthy()

    // …and past the anchor it keeps going: anchor as top, edge below.
    fireEvent.click(screen.getByLabelText('range edge one line down'))
    expect(screen.getByText('a.ts:3-4')).toBeTruthy()
    expect(container.querySelector('.thread-row')!.previousElementSibling).toBe(rows[3])
    // The edge sits on the hunk's last rendered line — down is out of road.
    expect(screen.getByLabelText('range edge one line down')).toHaveProperty('disabled', true)
  })

  it('walking the edge below moves the composer down without eating the draft', () => {
    const actions = actionsStub()
    const { container } = render(<HunkCard hunk={WIDE_HUNK} reviewActions={actions} />)
    const rows = [...container.querySelectorAll('tr.line')]
    fireEvent.mouseDown(rows[1]!.querySelector('.line-no')!, { button: 0 })
    fireEvent.mouseUp(document)
    fireEvent.change(screen.getByPlaceholderText('Leave a comment…'), {
      target: { value: 'half a thought' },
    })

    fireEvent.click(screen.getByLabelText('range edge one line down'))
    expect(screen.getByText('a.ts:2-3')).toBeTruthy()
    // The composer re-parented under the new last line — and the words survived.
    expect(container.querySelector('.thread-row')!.previousElementSibling).toBe(rows[2])
    expect(screen.getByPlaceholderText('Leave a comment…')).toHaveProperty(
      'value',
      'half a thought',
    )
  })

  it('shift-click puts the free edge on the clicked line; the anchor never moves', () => {
    const actions = actionsStub()
    const { container } = render(<HunkCard hunk={WIDE_HUNK} reviewActions={actions} />)
    const rows = [...container.querySelectorAll('tr.line')]
    fireEvent.mouseDown(rows[3]!.querySelector('.line-no')!, { button: 0 })
    fireEvent.mouseUp(document)
    fireEvent.mouseDown(rows[1]!.querySelector('.line-no')!, { button: 0, shiftKey: true })
    expect(screen.getByText('a.ts:2-4')).toBeTruthy()
    expect(container.querySelectorAll('tr.line-sel').length).toBe(3)

    // A second shift-click just moves the same edge again — the anchor holds.
    fireEvent.mouseDown(rows[2]!.querySelector('.line-no')!, { button: 0, shiftKey: true })
    expect(screen.getByText('a.ts:3-4')).toBeTruthy()
    expect(container.querySelectorAll('tr.line-sel').length).toBe(2)
  })

  it('rows spanned by an existing range thread carry the quiet gutter mark', () => {
    const { container } = render(
      <HunkCard
        hunk={WIDE_HUNK}
        reviewActions={actionsStub()}
        threads={[
          {
            id: 'r',
            anchor: {
              kind: 'hunk',
              hunkId: 'h9',
              path: 'src/a.ts',
              side: 'new',
              line: 2,
              endLine: 4,
            },
            state: 'open',
            codeContext: null,
            codeChanged: false,
            messages: [{ id: 'm', author: 'reviewer', text: 'span', at: '2026-01-01' }],
            createdAt: '2026-01-01',
            updatedAt: '2026-01-01',
          },
        ]}
      />,
    )
    expect(container.querySelectorAll('tr.line-ranged').length).toBe(3)
    // The glyph sits on the range's first line only.
    const glyphs = container.querySelectorAll('.line-range-glyph')
    expect(glyphs.length).toBe(1)
    expect(glyphs[0]!.closest('tr')).toBe(container.querySelectorAll('tr.line')[1])
    // And the card renders under the range's last line, with the bracket's spine
    // carried through its own row.
    const rows = [...container.querySelectorAll('tr.line')]
    const cardRow = container.querySelector('tr.thread-row')!
    expect(cardRow.previousElementSibling).toBe(rows[3])
    expect(cardRow.classList.contains('thread-row-ranged')).toBe(true)

    // Hovering the card lights the whole range it spans — spine included.
    fireEvent.mouseEnter(container.querySelector('.thread-anchor-scope')!)
    expect(container.querySelectorAll('tr.line-sel').length).toBe(3)
    expect(cardRow.classList.contains('thread-row-lit')).toBe(true)
    fireEvent.mouseLeave(container.querySelector('.thread-anchor-scope')!)
    expect(container.querySelectorAll('tr.line-sel').length).toBe(0)
    expect(cardRow.classList.contains('thread-row-lit')).toBe(false)
  })
})

describe('changed since your last review', () => {
  it('marks the hunk durably with the bar alone — the words live in the file header', () => {
    const { container } = render(<HunkCard hunk={HUNK} changedSinceReview />)
    expect(container.querySelector('.hunk-since-review')).toBeTruthy()
    expect(screen.queryByText('the agent changed this')).toBeNull()
    expect(container.querySelector('.hunk-boundary')?.getAttribute('title')).toContain(
      'the agent changed this',
    )
    expect(container.querySelector('.hunk-fresh')).toBeNull()
  })

  it('clears when you read it, never on a timer', () => {
    const { container } = render(<HunkCard hunk={HUNK} changedSinceReview viewed />)
    expect(container.querySelector('.hunk-since-review')).toBeNull()
    expect(container.querySelector('.hunk-boundary')?.getAttribute('title')).toBeNull()
  })

  it('silences the frame-to-frame badge where both hold', () => {
    const { container } = render(<HunkCard hunk={HUNK} changedSinceReview changedSinceViewed />)
    expect(container.querySelector('.hunk-since-review')).toBeTruthy()
    expect(screen.queryByText(/changed since you read it/)).toBeNull()
  })

  it('says nothing at all before a first Finish', () => {
    const { container } = render(<HunkCard hunk={HUNK} />)
    expect(container.querySelector('.hunk-since-review')).toBeNull()
    expect(container.querySelector('.hunk-boundary')?.getAttribute('title')).toBeNull()
  })
})
