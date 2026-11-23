import { describe, expect, it } from 'vitest'
import { capProse, findArtifacts, proseLength } from './artifacts.js'
import {
  checkGraphs,
  findGraphs,
  GRAPH_LIMITS,
  type Graph,
  graphProblems,
  parseGraph,
  parseGraphInfo,
} from './graphs.js'
import type { FileChange } from './types.js'

const fence = (info: string, body: string) => `\`\`\`${info}\n${body}\n\`\`\``
const graph = (value: unknown) => parseGraph(JSON.stringify(value))
const errors = (value: unknown): string[] => {
  const parsed = graph(value)
  return parsed.ok ? [] : parsed.errors
}

const SAVE = {
  cards: [
    { id: 'user', note: 'The reviewer', text: 'Presses Save.' },
    { id: 'save', hunk: 'src/save.ts:12-40', title: 'save()' },
    { id: 'tests', hunk: 'src/save.test.ts' },
    { id: 'disk', code: 'src/disk.ts:80-95' },
  ],
  boxes: [
    { title: 'Server', color: 'blue', cards: ['save'], boxes: [{ title: 'IO', cards: ['disk'] }] },
  ],
  arrows: [
    { from: 'user', to: 'save', label: 'presses Save' },
    { from: 'save', to: 'disk' },
  ],
  order: ['user', 'save', 'disk'],
}

describe('parseGraphInfo', () => {
  it('reads the title and names what it does not know', () => {
    expect(parseGraphInfo('graph title="How a save reaches the disk" size=l')).toEqual({
      title: 'How a save reaches the disk',
      unknown: ['size'],
    })
    expect(parseGraphInfo('graph').title).toBeNull()
  })
})

describe('parseGraph', () => {
  it('reads the three kinds of card, the boxes, the arrows and the order', () => {
    const parsed = graph(SAVE)
    expect(parsed).toEqual({
      ok: true,
      graph: {
        cards: [
          { kind: 'note', id: 'user', title: 'The reviewer', text: 'Presses Save.' },
          {
            kind: 'hunk',
            id: 'save',
            at: { path: 'src/save.ts', line: 12, endLine: 40 },
            title: 'save()',
          },
          // A hunk card with no lines is all the changed lines of the file.
          { kind: 'hunk', id: 'tests', at: { path: 'src/save.test.ts' } },
          { kind: 'code', id: 'disk', at: { path: 'src/disk.ts', line: 80, endLine: 95 } },
        ],
        boxes: [
          {
            title: 'Server',
            color: 'blue',
            cards: ['save'],
            boxes: [{ title: 'IO', cards: ['disk'], boxes: [] }],
          },
        ],
        arrows: [
          { from: 'user', to: 'save', label: 'presses Save' },
          { from: 'save', to: 'disk' },
        ],
        order: ['user', 'save', 'disk'],
      } satisfies Graph,
    })
  })

  it('takes cards only', () => {
    expect(graph({ cards: [{ id: 'a', note: 'A' }] })).toEqual({
      ok: true,
      graph: { cards: [{ kind: 'note', id: 'a', title: 'A' }], boxes: [], arrows: [], order: [] },
    })
  })

  it('refuses text that is not a graph', () => {
    expect(parseGraph('{ cards: [').ok).toBe(false)
    expect(errors([])).toEqual(['is { cards, boxes?, arrows?, order? }'])
    expect(errors({ cards: [] })).toEqual(['needs a non-empty "cards" list'])
    expect(errors({ cards: [{ id: 'a', note: 'A' }], nodes: [] })[0]).toContain(
      'does not know "nodes"',
    )
  })

  it('names the card that is wrong', () => {
    expect(errors({ cards: [{ note: 'A' }] })[0]).toContain('card 1: needs an "id"')
    expect(errors({ cards: [{ id: 'Bad Id', note: 'A' }] })[0]).toContain('card 1: needs an "id"')
    expect(errors({ cards: [{ id: 'a' }] })).toEqual([
      'card 1 ("a"): needs exactly one of "hunk", "code" or "note"',
    ])
    expect(errors({ cards: [{ id: 'a', note: 'A', code: 'x.ts:1-2' }] })[0]).toContain(
      'exactly one',
    )
    expect(
      errors({
        cards: [
          { id: 'a', note: 'A' },
          { id: 'a', note: 'B' },
        ],
      }),
    ).toEqual(['card 2: the id "a" is used two times'])
  })

  it('asks a code card for lines, and not too many', () => {
    expect(errors({ cards: [{ id: 'a', code: 'src/a.ts' }] })).toEqual([
      'card 1 ("a"): "code" needs lines, as "path:from-to"',
    ])
    expect(errors({ cards: [{ id: 'a', code: 'src/a.ts:1-200' }] })[0]).toContain(
      '200 lines of code',
    )
    expect(graph({ cards: [{ id: 'a', code: `src/a.ts:1-${GRAPH_LIMITS.codeLines}` }] }).ok).toBe(
      true,
    )
    expect(graph({ cards: [{ id: 'a', code: 'src/a.ts:7' }] }).ok).toBe(true)
  })

  it('refuses an arrow, a box or an order with an id that no card has', () => {
    const cards = [
      { id: 'a', note: 'A' },
      { id: 'b', note: 'B' },
    ]
    expect(errors({ cards, arrows: [{ from: 'a', to: 'c' }] })).toEqual([
      'arrow 1: no card has the id "c"',
    ])
    expect(errors({ cards, arrows: [{ from: 'a', to: 'a' }] })).toEqual([
      'arrow 1: goes from "a" to itself',
    ])
    expect(errors({ cards, boxes: [{ title: 'X', cards: ['z'] }] })[0]).toContain(
      'no card has the id "z"',
    )
    expect(errors({ cards, order: ['b', 'q'] })).toEqual(['order: no card has the id "q"'])
  })

  it('puts a card in one box only, and refuses an empty box', () => {
    const cards = [{ id: 'a', note: 'A' }]
    expect(
      errors({
        cards,
        boxes: [
          { title: 'One', cards: ['a'] },
          { title: 'Two', cards: ['a'] },
        ],
      })[0],
    ).toContain('the card "a" is already in the box "One"')
    expect(errors({ cards, boxes: [{ title: 'Empty' }] })).toEqual([
      'boxes box 1 ("Empty"): a box needs "cards" or "boxes"',
    ])
    expect(errors({ cards, boxes: [{ title: 'X', cards: ['a'], color: 'gold' }] })[0]).toContain(
      '"color" is one of',
    )
  })

  it('reports each problem, so one post can fix them all', () => {
    const found = errors({
      cards: [{ id: 'a', note: 'A' }, { id: 'b' }],
      arrows: [{ from: 'a', to: 'x' }],
      order: ['y'],
    })
    expect(found).toHaveLength(3)
  })

  it('keeps one arrow of two that are the same', () => {
    const parsed = graph({
      cards: [
        { id: 'a', note: 'A' },
        { id: 'b', note: 'B' },
      ],
      arrows: [
        { from: 'a', to: 'b' },
        { from: 'a', to: 'b' },
        { from: 'a', to: 'b', label: 'again' },
      ],
    })
    expect(parsed.ok && parsed.graph.arrows).toHaveLength(2)
  })
})

describe('graphProblems', () => {
  const line = (kind: 'add' | 'context', no: number) => ({
    kind,
    oldNo: kind === 'add' ? null : no,
    newNo: no,
    text: '',
  })
  // One hunk: the lines 10 to 12 are context, 13 and 14 are added.
  const files: FileChange[] = [
    {
      path: 'src/save.ts',
      oldPath: null,
      status: 'modified',
      kind: 'text',
      staged: false,
      hunks: [
        {
          id: 'h1',
          path: 'src/save.ts',
          oldStart: 10,
          newStart: 10,
          lines: [
            line('context', 10),
            line('context', 11),
            line('context', 12),
            line('add', 13),
            line('add', 14),
          ],
        },
      ],
    },
  ]
  const problems = (cards: unknown[]) => {
    const parsed = graph({ cards })
    return parsed.ok ? graphProblems(parsed.graph, files) : ['did not parse']
  }

  it('finds no problem when each card has its code', () => {
    expect(
      problems([
        { id: 'a', hunk: 'src/save.ts:12-14' },
        { id: 'b', hunk: 'src/save.ts' },
        { id: 'c', code: 'src/save.ts:10-11' },
        { id: 'd', code: 'src/other.ts:1-5' },
        { id: 'e', note: 'E' },
      ]),
    ).toEqual([])
  })

  it('names a hunk card with no changed line, and a file that is not in the change', () => {
    const found = problems([
      { id: 'a', hunk: 'src/save.ts:10-12' },
      { id: 'b', hunk: 'src/other.ts:1-5' },
    ])
    expect(found).toHaveLength(2)
    expect(found[0]).toContain('card "a": the change has no changed line at src/save.ts:10-12')
    expect(found[1]).toContain('card "b": src/other.ts is not a file of the change')
  })

  it('names a code card on lines that the change touches', () => {
    expect(problems([{ id: 'a', code: 'src/save.ts:12-13' }])[0]).toContain('make it a "hunk" card')
  })
})

describe('findGraphs and checkGraphs', () => {
  const body = JSON.stringify(SAVE, null, 2)

  it('finds a graph fence, and an artifact fence is not one', () => {
    const text = `Intro\n\n${fence('graph title="Save"', body)}\n\n${fence('artifact title="x"', '<p>hi</p>')}`
    const found = findGraphs(text)
    expect(found).toHaveLength(1)
    expect(found[0]).toMatchObject({ index: 0, line: 3, closed: true, info: { title: 'Save' } })
    expect(findArtifacts(text)).toHaveLength(1)
  })

  it('passes a good graph', () => {
    expect(checkGraphs(fence('graph title="Save"', body))).toMatchObject({
      errors: [],
      warnings: [],
    })
  })

  it('asks for a title and a closed fence, and names the graph in each message', () => {
    expect(checkGraphs(fence('graph', body)).errors[0]).toContain('needs a title')
    expect(checkGraphs(`\`\`\`graph title="Save"\n${body}`).errors[0]).toContain('is never closed')
    expect(checkGraphs(fence('graph title="Save"', '{"cards":[{"id":"a"}]}')).errors).toEqual([
      'graph "Save" card 1 ("a"): needs exactly one of "hunk", "code" or "note"',
    ])
    expect(checkGraphs(fence('graph title="Save" size=l', body)).warnings[0]).toContain('size=')
  })

  it('is not cut by the cap of the prose around it', () => {
    const text = `Intro.\n\n${fence('graph title="Save"', body)}\n\n${'word '.repeat(60)}`
    // The graph is much longer than the cap, and it does not count.
    expect(body.length).toBeGreaterThan(400)
    expect(proseLength(text)).toBeLessThan(320)
    const capped = capProse(text, 100)
    // The prose is cut, and the graph is whole.
    expect(capped.length).toBeLessThan(text.length)
    expect(checkGraphs(capped)).toMatchObject({ errors: [] })
    expect(findGraphs(capped)[0]?.json).toBe(body)
  })

  it('does not read a graph inside a list or an example fence', () => {
    const inList = `- item\n\n  ${fence('graph title="x"', body).replace(/\n/g, '\n  ')}`
    expect(findGraphs(inList)).toHaveLength(0)
    expect(
      findGraphs(`\`\`\`\`markdown\n${fence('graph title="x"', body)}\n\`\`\`\``),
    ).toHaveLength(0)
  })
})
