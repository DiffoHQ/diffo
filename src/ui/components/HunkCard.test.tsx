// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Hunk } from '../../shared/types.js'
import { HunkCard } from './HunkCard.js'

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
