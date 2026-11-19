import { describe, expect, it } from 'vitest'
import type { GraphStep } from '../../components/ReadingPane.js'
import type { GraphNode } from '../basic/build.js'
import { AGENT, agentEdges, agentOrder, cardAt, noteId, stepsOfCards } from './agent.js'

const node = (
  id: string,
  path: string,
  name: string | null,
  from: number,
  to: number,
): GraphNode => ({
  id,
  path,
  name,
  lines: Array.from({ length: to - from + 1 }, (_, i) => ({
    kind: 'add' as const,
    oldNo: null,
    newNo: from + i,
    text: '',
  })),
  hunkIds: [`${path}:h`],
  realm: 'logic',
  group: '',
})

// One file with its top level (lines 1 to 30) and two functions in it.
const top = node('top', 'a.ts', null, 1, 30)
const load = node('load', 'a.ts', 'load', 5, 9)
const save = node('save', 'a.ts', 'save', 12, 20)
const other = node('other', 'b.ts', 'other', 1, 4)
const nodes = [top, load, save, other]

const step = (key: string, more: Partial<GraphStep>): GraphStep => ({
  key,
  number: 1,
  title: key,
  mechanical: false,
  parts: [],
  ...more,
})

describe('the card at a place', () => {
  it('is the function with the line, not the top level around it', () => {
    expect(cardAt(nodes, { path: 'a.ts', line: 6 })?.id).toBe('load')
    expect(cardAt(nodes, { path: 'a.ts', line: 14, endLine: 18 })?.id).toBe('save')
  })

  it('is the top level for a line outside each function', () => {
    expect(cardAt(nodes, { path: 'a.ts', line: 25 })?.id).toBe('top')
  })

  it('is the first card of the file for a place with no line', () => {
    expect(cardAt(nodes, { path: 'b.ts' })?.id).toBe('other')
    expect(cardAt(nodes, { path: 'none.ts', line: 1 })).toBeUndefined()
  })
})

describe('the arrows and the order of the agent', () => {
  it('makes one arrow between the cards at two places', () => {
    const steps = [
      step('s1', {
        arrows: [
          { from: { path: 'a.ts', line: 6 }, to: { path: 'a.ts', line: 14 }, label: 'then' },
          // The same two cards and line a second time, and an arrow of a
          // card to itself: no arrow.
          { from: { path: 'a.ts', line: 6 }, to: { path: 'a.ts', line: 15 } },
          { from: { path: 'a.ts', line: 6 }, to: { path: 'a.ts', line: 7 } },
          { from: { path: 'a.ts', line: 6 }, to: { path: 'gone.ts', line: 1 } },
        ],
      }),
    ]
    expect(agentEdges(nodes, steps)).toEqual([
      {
        from: 'load',
        to: 'save',
        line: 6,
        method: 'syntax',
        kind: AGENT.id,
        via: 'then',
        added: true,
      },
    ])
  })

  it('joins a note of the step with a card', () => {
    const note = {
      ...node(noteId('s1', 'why'), '', 'why', 1, 1),
      agent: { step: 's1', note: true },
    }
    const steps = [
      step('s1', { arrows: [{ from: { note: 'why' }, to: { path: 'b.ts', line: 2 } }] }),
    ]
    const edges = agentEdges([...nodes, note], steps)
    expect(edges.map((e) => [e.from, e.to])).toEqual([[note.id, 'other']])
  })

  it('reads the cards in the order of the steps, each card one time', () => {
    const steps = [
      step('s1', {
        order: [
          { path: 'a.ts', line: 14 },
          { path: 'a.ts', line: 15 },
        ],
      }),
      step('s2', {
        order: [
          { path: 'b.ts', line: 1 },
          { path: 'a.ts', line: 14 },
          { path: 'a.ts', line: 6 },
        ],
      }),
    ]
    expect(agentOrder(nodes, steps)).toEqual(['save', 'other', 'load'])
  })
})

describe('the steps of a card', () => {
  it('puts a card in each step that holds a line of it', () => {
    const steps = [
      step('s1', { parts: [{ path: 'a.ts', hunkIds: ['a.ts:h'], ranges: [{ from: 5, to: 9 }] }] }),
      step('s2', { parts: [{ path: 'a.ts', hunkIds: ['a.ts:h'] }] }),
    ]
    const of = stepsOfCards(nodes, steps)
    expect(of.get('load')?.map((s) => s.key)).toEqual(['s1', 's2'])
    expect(of.get('save')?.map((s) => s.key)).toEqual(['s2'])
    expect(of.has('other')).toBe(false)
  })
})
