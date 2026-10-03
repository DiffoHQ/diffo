// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { FileChange } from '../../shared/types.js'
import type { ResolvedDecision } from '../layers.js'
import { Decisions } from './Decisions.js'

afterEach(cleanup)

const FILE: FileChange = {
  path: 'src/dueDate.ts',
  oldPath: null,
  status: 'modified',
  kind: 'text',
  staged: false,
  hunks: [],
}
const TEST_FILE: FileChange = { ...FILE, path: 'test/dueDate.test.ts' }

const DECISIONS: ResolvedDecision[] = [
  {
    decision: {
      text: 'Caches parsed dates per request',
      detail: 'The cache **dies with the request**.',
      at: [{ path: 'src/dueDate.ts', line: 12, endLine: 14 }],
    },
    places: [{ at: { path: 'src/dueDate.ts', line: 12, endLine: 14 }, file: FILE, hunkId: 'h1' }],
  },
  {
    decision: {
      text: 'Unknown ?due= returns 400',
      at: [
        { path: 'src/dueDate.ts', line: 45 },
        { path: 'test/dueDate.test.ts', line: 40 },
      ],
    },
    places: [
      { at: { path: 'src/dueDate.ts', line: 45 }, file: FILE, hunkId: 'h2' },
      { at: { path: 'test/dueDate.test.ts', line: 40 }, file: TEST_FILE, hunkId: 'h7' },
    ],
  },
  {
    decision: {
      text: 'Todos have a date, never a time',
      at: [{ path: 'src/model.ts' }],
    },
    places: [{ at: { path: 'src/model.ts' } }],
  },
]

function setup(open: number | null = null, withComment = true) {
  const onOpen = vi.fn()
  const onJump = vi.fn()
  const onComment = vi.fn()
  const utils = render(
    <Decisions
      decisions={DECISIONS}
      open={open}
      onOpen={onOpen}
      onJump={onJump}
      onComment={withComment ? onComment : undefined}
    />,
  )
  return { ...utils, onOpen, onJump, onComment }
}

describe('the Decisions strip', () => {
  it('is one line per decision, and nothing more while closed', () => {
    const { container } = setup()
    expect(screen.getByText('Decisions')).toBeTruthy()
    expect(screen.getByText('Caches parsed dates per request')).toBeTruthy()
    expect(container.querySelectorAll('.ch-dec-item').length).toBe(3)
    expect(container.querySelector('.ch-dec-card')).toBeNull()
  })

  it('clicking a line asks to open it; clicking the open one asks to close it', () => {
    const { onOpen, rerender } = setup()
    fireEvent.click(screen.getByText('Caches parsed dates per request'))
    expect(onOpen).toHaveBeenLastCalledWith(0)
    rerender(<Decisions decisions={DECISIONS} open={0} onOpen={onOpen} onJump={vi.fn()} />)
    fireEvent.click(screen.getByText('Caches parsed dates per request'))
    expect(onOpen).toHaveBeenLastCalledWith(null)
  })

  it('open: the sentence, the place as a chip, and Comment — no code of its own', () => {
    const { container, onJump, onComment } = setup(0)
    expect(screen.getByText('dies with the request').tagName).toBe('STRONG')
    expect(container.querySelector('table')).toBeNull()
    fireEvent.click(screen.getByTitle('src/dueDate.ts:12–14'))
    expect(onJump).toHaveBeenCalledWith('src/dueDate.ts', 12)
    fireEvent.click(screen.getByText('Comment'))
    expect(onComment).toHaveBeenCalledWith(0)
  })

  it('a decision in two places offers both by name', () => {
    const { onJump } = setup(1)
    fireEvent.click(screen.getByTitle('test/dueDate.test.ts:40'))
    expect(onJump).toHaveBeenCalledWith('test/dueDate.test.ts', 40)
    expect(screen.getByTitle('src/dueDate.ts:45')).toBeTruthy()
  })

  it('a place the changeset lacks has nowhere to go, and says so', () => {
    const { container } = setup(2)
    expect(container.querySelector('.ch-dec-place')).toBeNull()
    expect(screen.getByText('its file is not in the changeset now')).toBeTruthy()
    expect(screen.getByText('Comment')).toBeTruthy()
  })

  it('without a layer to comment on there is no Comment button', () => {
    setup(0, false)
    expect(screen.queryByText('Comment')).toBeNull()
    expect(screen.getByTitle('src/dueDate.ts:12–14')).toBeTruthy()
  })
})
