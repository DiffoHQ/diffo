// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ReviewThread } from '../../shared/review.js'
import type { ThreadItem } from '../threads.js'
import { Monitor } from './Monitor.js'

afterEach(cleanup)

const item = (over: Partial<ThreadItem> & { id: string }): ThreadItem => ({
  thread: { id: over.id } as ReviewThread,
  turn: 'agent',
  question: 'a question',
  answer: null,
  anchor: 'src/a.ts:1',
  path: 'src/a.ts',
  updatedAt: '2026-08-15T10:00:00Z',
  ...over,
})

const WORKING = item({
  id: 'w1',
  question: 'truncate() splits surrogate pairs',
  anchor: 'src/format.ts:10',
  working: true,
})
const QUEUED = item({
  id: 'q1',
  question: 'clickable div needs keyboard handling',
  anchor: 'src/UserCard.tsx:12',
  queued: 1,
})
const FIXED = item({
  id: 'f1',
  turn: 'yours',
  outcome: 'fixed',
  question: 'retry loop swallows non-retryable errors',
  answer: 'Added isRetryable() — only 5xx and network errors retry.',
  anchor: 'src/client.ts:21',
  durationMs: 56_000,
})
const SILENT = item({
  id: 's1',
  turn: 'unanswered',
  outcome: 'no-answer',
  question: 'why the two passes?',
})

function show(over: Partial<Parameters<typeof Monitor>[0]> = {}) {
  const props = {
    stillTo: over.stillTo ?? [WORKING, QUEUED],
    back: over.back ?? [FIXED],
    onOpen: over.onOpen ?? vi.fn(),
    onClose: over.onClose ?? vi.fn(),
  }
  return { ...props, ...render(<Monitor {...props} />) }
}

describe('Monitor — the chip unfolded: bar, counts, threads, nothing else', () => {
  it('splits the send into still-to-answer on top and answered below', () => {
    show()
    const groups = Array.from(document.querySelectorAll('.monitor-group')).map(
      (el) => el.textContent,
    )
    expect(groups).toEqual(['Still to answer · 2', 'Answered · 1'])
    expect(screen.getByText('working on it')).toBeTruthy()
    expect(screen.getByText('next in line')).toBeTruthy()
    expect(screen.getByText('fixed')).toBeTruthy()
  })

  it('one bar segment per comment, coloured by where it is', () => {
    show()
    const segs = Array.from(document.querySelectorAll('.monitor-qbar i')).map((el) => el.className)
    expect(segs).toEqual(['q-done', 'q-now', 'q-wait'])
    expect(screen.getByText('1 answered · 1 in progress · 1 waiting')).toBeTruthy()
  })

  it('carries no title, no close button, no call to action — the rows are the actions', () => {
    show()
    expect(screen.queryByRole('heading')).toBeNull()
    const buttons = Array.from(document.querySelectorAll('.monitor button'))
    expect(buttons.length).toBe(3)
    expect(buttons.every((b) => b.classList.contains('monitor-row'))).toBe(true)
  })

  it('an answer shows in place, with how long it took', () => {
    show()
    expect(screen.getByText(/Added isRetryable/)).toBeTruthy()
    expect(screen.getByText('56.0s')).toBeTruthy()
  })

  it('a row is the way back to its thread', () => {
    const onOpen = vi.fn()
    show({ onOpen })
    fireEvent.click(screen.getByText(/retry loop swallows/))
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ thread: { id: 'f1' } }))
  })

  it('silence is labelled as silence, never as an answer', () => {
    show({ stillTo: [], back: [FIXED, SILENT] })
    expect(screen.getByText('no answer')).toBeTruthy()
  })

  it('settled is one green line — the rows already offer the way in', () => {
    show({ stillTo: [], back: [FIXED] })
    expect(screen.queryByText(/Still to answer/)).toBeNull()
    const counts = screen.getByText('all 1 answered')
    expect(counts.className).toContain('monitor-counts-done')
    expect(screen.queryByText(/Your turn/)).toBeNull()
  })

  it('closes from Escape — the same way out every menu offers', () => {
    const onClose = vi.fn()
    show({ onClose })
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
