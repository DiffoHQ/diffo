import { describe, expect, it } from 'vitest'
import {
  formatSpan,
  highlightedRows,
  hunkHeadSpan,
  parseDecisionAt,
  parseLayersInput,
  parseSuggestReason,
  rangeTouchesHunk,
  sharedByLayers,
  sharedLine,
  uncoveredByLayers,
} from './layers.js'
import type { FileChange, Hunk } from './types.js'

const ok = (raw: unknown) => {
  const parsed = parseLayersInput(raw)
  if (!parsed.ok) throw new Error(parsed.error)
  return parsed.items
}

const err = (raw: unknown) => {
  const parsed = parseLayersInput(raw)
  if (parsed.ok) throw new Error('expected a validation error')
  return parsed.error
}

describe('parseLayersInput', () => {
  it('accepts the documented shape and normalises the optional fields', () => {
    const items = ok([
      {
        title: '  Parser contract  ',
        summary: '\nparse() returns null now.\n',
        files: ['src/parse.ts', { path: 'src/parse.test.ts', note: 'pins the boundary\nignored' }],
      },
      { title: 'Callers', kind: 'mechanical', files: ['src/cli.ts'] },
    ])
    expect(items).toEqual([
      {
        title: 'Parser contract',
        summary: 'parse() returns null now.',
        files: ['src/parse.ts', { path: 'src/parse.test.ts', note: 'pins the boundary' }],
      },
      { title: 'Callers', kind: 'mechanical', files: ['src/cli.ts'] },
    ])
  })

  it('ignores an id the agent sends — the server mints them', () => {
    const [layer] = ok([{ id: 'mine', title: 'A', files: ['a.ts'] }])
    expect(layer).not.toHaveProperty('id')
  })

  it('keeps a path:from-to range, normalised, and validates the path part', () => {
    expect(ok([{ title: 'A', files: ['src/dates.ts:41-80'] }])[0]!.files).toEqual([
      'src/dates.ts:41-80',
    ])
    // `from` first, and a single line is the one-line range.
    expect(
      ok([{ title: 'A', files: ['src/dates.ts:80-41', { path: 'src/a.ts:7' }] }])[0]!.files,
    ).toEqual(['src/dates.ts:41-80', { path: 'src/a.ts:7-7' }])
    expect(err([{ title: 'A', files: ['/abs/dates.ts:1-2'] }])).toContain('absolute')
    expect(err([{ title: 'A', files: ['src/a.ts:0-4'] }])).toContain('must start at 1')
  })

  it('refuses a path listed whole in one layer and by range in another, naming both', () => {
    expect(
      err([
        { title: 'Contract', files: ['src/a.ts'] },
        { title: 'Consumers', files: ['src/a.ts:40-60'] },
      ]),
    ).toBe(
      'layer 2 ("Consumers"): "src/a.ts" is listed by range here and whole in layer 1 ("Contract") — range it in every step that has a part of it, or list it whole once',
    )
    expect(
      err([
        { title: 'Contract', files: ['src/a.ts:1-10'] },
        { title: 'Consumers', files: [{ path: 'src/a.ts', note: 'rest' }] },
      ]),
    ).toContain('listed whole here and by range in layer 1 ("Contract")')
    // Ranged in both, or whole once: both fine.
    expect(
      ok([
        { title: 'Contract', files: ['src/a.ts:1-10'] },
        { title: 'Consumers', files: ['src/a.ts:40-60', 'src/a.ts:70-72'] },
      ]),
    ).toHaveLength(2)
  })

  it('refuses what is not a list of layers', () => {
    expect(err(null)).toContain('JSON array')
    expect(err({ title: 'A', files: ['a'] })).toContain('JSON array')
    expect(err([])).toContain('at least one layer')
    expect(err(['A'])).toContain('layer 1: each layer is an object')
  })

  it('requires a title and a non-empty file list, naming the layer at fault', () => {
    expect(err([{ files: ['a.ts'] }])).toBe('layer 1: needs a non-empty "title"')
    expect(err([{ title: '   ', files: ['a.ts'] }])).toContain('layer 1')
    expect(err([{ title: 'A', files: ['a.ts'] }, { title: 'B' }])).toBe(
      'layer 2 ("B"): needs a non-empty "files" list',
    )
    expect(err([{ title: 'B', files: [] }])).toContain('non-empty "files"')
  })

  it('refuses paths that could never name a repo file', () => {
    expect(err([{ title: 'A', files: [''] }])).toContain('is empty')
    expect(err([{ title: 'A', files: ['/etc/passwd'] }])).toContain('absolute')
    expect(err([{ title: 'A', files: ['C:\\x\\y.ts'] }])).toContain('absolute')
    expect(err([{ title: 'A', files: ['../secrets.ts'] }])).toContain('escapes the repo')
    expect(err([{ title: 'A', files: [42] }])).toContain(
      'path string or { path, note?, highlight? }',
    )
    expect(err([{ title: 'A', files: [{ note: 'no path' }] }])).toContain('needs a "path"')
    expect(err([{ title: 'A', files: [{ path: 'a.ts', note: 7 }] }])).toContain('must be a string')
  })

  it('normalises a highlight to head-side spans, from first', () => {
    const [layer] = ok([
      {
        title: 'A',
        files: [
          { path: 'a.ts', highlight: ['18-12', ' 40 '] },
          { path: 'b.ts', highlight: '7' },
        ],
      },
    ])
    expect(layer!.files).toEqual([
      { path: 'a.ts', highlight: ['12-18', '40'] },
      { path: 'b.ts', highlight: ['7'] },
    ])
    expect(ok([{ title: 'A', files: [{ path: 'a.ts', highlight: [] }] }])[0]!.files).toEqual([
      { path: 'a.ts' },
    ])
  })

  it('refuses a highlight that is not lines, starts at 0, or names too many', () => {
    expect(err([{ title: 'A', files: [{ path: 'a.ts', highlight: 'a.ts:3' }] }])).toContain(
      '"highlight" on a.ts is a head-side line or range',
    )
    expect(err([{ title: 'A', files: [{ path: 'a.ts', highlight: [3] }] }])).toContain(
      'head-side line or range',
    )
    expect(err([{ title: 'A', files: [{ path: 'a.ts', highlight: '0-4' }] }])).toContain(
      'lines start at 1',
    )
    const many = Array.from({ length: 31 }, (_, i) => `${i + 1}`)
    expect(err([{ title: 'A', files: [{ path: 'a.ts', highlight: many }] }])).toContain(
      'keep it to 30',
    )
  })

  it('accepts unknown paths — the file may land later', () => {
    expect(ok([{ title: 'A', files: ['does/not/exist.ts'] }])).toHaveLength(1)
  })

  it('refuses a kind other than mechanical rather than dropping it', () => {
    expect(err([{ title: 'A', kind: 'risky', files: ['a.ts'] }])).toContain('"kind" can only be')
  })

  it('refuses a summary that is not a string', () => {
    expect(err([{ title: 'A', summary: ['x'], files: ['a.ts'] }])).toContain('"summary"')
  })

  it('refuses two layers with the same title — ids are preserved by title', () => {
    expect(
      err([
        { title: 'A', files: ['a.ts'] },
        { title: 'A', files: ['b.ts'] },
      ]),
    ).toContain('used twice')
  })

  it('caps a note to one short line and a summary to a backstop length', () => {
    const [layer] = ok([
      { title: 'A', summary: 'x'.repeat(5000), files: [{ path: 'a.ts', note: 'y'.repeat(300) }] },
    ])
    expect(layer!.summary).toHaveLength(4000)
    const note = (layer!.files[0] as { note: string }).note
    expect(note.length).toBeLessThanOrEqual(200)
    expect(note.endsWith('…')).toBe(true)
  })
})

describe('parseSuggestReason', () => {
  it('keeps the first line, trimmed; nothing usable is undefined', () => {
    expect(parseSuggestReason('  the parser change explains the rest\nmore')).toBe(
      'the parser change explains the rest',
    )
    expect(parseSuggestReason('   ')).toBeUndefined()
    expect(parseSuggestReason(42)).toBeUndefined()
    expect(parseSuggestReason(undefined)).toBeUndefined()
  })
})

describe('decisions on a layer', () => {
  const layer = (decisions: unknown) => ({ title: 'A', files: ['src/a.ts'], decisions })

  it('normalises the text and parses where they point', () => {
    const [l] = ok([
      layer([
        {
          text: '  Caches parsed dates per request\nsecond line dropped',
          at: 'src/a.ts:12-18',
        },
        {
          text: 'Unknown ?due= returns 400',
          detail: '  A typo fails loudly.  ',
          at: 'src/a.ts:45',
        },
        { text: 'Todos have a date, never a time', at: 'src/model.ts' },
      ]),
    ])
    expect(l!.decisions).toEqual([
      {
        text: 'Caches parsed dates per request',
        at: [{ path: 'src/a.ts', line: 12, endLine: 18 }],
      },
      {
        text: 'Unknown ?due= returns 400',
        detail: 'A typo fails loudly.',
        at: [{ path: 'src/a.ts', line: 45 }],
      },
      { text: 'Todos have a date, never a time', at: [{ path: 'src/model.ts' }] },
    ])
  })

  it('a decision may point at nothing: no "at" is fine, an empty list is dropped', () => {
    const [l] = ok([layer([{ text: 'Tests not run: no node_modules here' }])])
    expect(l!.decisions).toEqual([{ text: 'Tests not run: no node_modules here' }])
    expect(ok([layer([])])[0]).not.toHaveProperty('decisions')
  })

  it('refuses a sixth decision, naming the layer', () => {
    const six = Array.from({ length: 6 }, (_, i) => ({ text: `f${i}` }))
    expect(err([layer(six)])).toBe(
      'layer 1 ("A"): keep "decisions" to 5 — the ones a reviewer could want done differently, not a retelling of the diff',
    )
  })

  it('refuses a missing text and a malformed "at"', () => {
    expect(err([layer([{}])])).toBe('layer 1 ("A") decision 1: needs a non-empty "text"')
    expect(err([layer([{ text: 'x', at: { path: 3 } }])])).toContain('"at" is a string')
    expect(err([layer([{ text: 'x', at: [] }])])).toContain('at least one place')
    expect(err([layer([{ text: 'x', at: ['a.ts', 'b.ts', 'c.ts', 'd.ts'] }])])).toContain(
      'keep it to 3',
    )
    expect(err([layer([{ text: 'x', at: '/abs/a.ts:3' }])])).toContain('absolute')
    expect(err([layer([{ text: 'x', at: 'a.ts:0' }])])).toContain('1 or more')
    expect(err([layer(['not an object'])])).toContain('each decision is an object')
    expect(err([layer('nope')])).toContain('"decisions" must be a list')
  })

  it('a decision may name up to three places, for a rule and the test that pins it', () => {
    const [l] = ok([layer([{ text: 'x', at: ['src/a.ts:45-47', 'test/a.test.ts:12'] }])])
    expect(l!.decisions![0]!.at).toEqual([
      { path: 'src/a.ts', line: 45, endLine: 47 },
      { path: 'test/a.test.ts', line: 12 },
    ])
  })

  it('accepts its own output: the CLI validates before the server, and the store re-validates on load', () => {
    const once = ok([
      layer([
        { text: 'ranged', at: 'src/a.ts:12-18' },
        { text: 'lined', at: 'src/a.ts:45' },
        { text: 'pathed', at: 'src/model.ts' },
      ]),
    ])
    expect(ok(once)).toEqual(once)
    // An object that is not the parser's own shape is still refused.
    expect(err([layer([{ text: 'x', at: { line: 3 } }])])).toContain('"at" is a string')
    expect(err([layer([{ text: 'x', at: { path: 'a.ts', line: '3' } }])])).toContain(
      '"at" is a string',
    )
  })

  it('a reversed range is put the right way round; a one-line range is a line', () => {
    expect(parseDecisionAt('a.ts:18-12')).toEqual({ path: 'a.ts', line: 12, endLine: 18 })
    expect(parseDecisionAt('a.ts:7-7')).toEqual({ path: 'a.ts', line: 7 })
  })

  it('caps the text to one line and the detail to a backstop length', () => {
    const [l] = ok([layer([{ text: 'x'.repeat(300), detail: 'y'.repeat(900) }])])
    expect(l!.decisions![0]!.text.length).toBeLessThanOrEqual(120)
    expect(l!.decisions![0]!.text.endsWith('…')).toBe(true)
    expect(l!.decisions![0]!.detail).toHaveLength(400)
  })
})

describe('ranges against hunks', () => {
  const hunk = (path: string, id: string, newStart: number, kinds: string): Hunk => ({
    id,
    path,
    oldStart: newStart,
    newStart,
    lines: [...kinds].map((k, i) => ({
      kind: k === '+' ? 'add' : k === '-' ? 'del' : 'context',
      oldNo: k === '+' ? null : newStart + i,
      newNo: k === '-' ? null : newStart + i,
      text: '',
    })),
  })
  const file = (path: string, hunks: Hunk[]): FileChange => ({
    path,
    oldPath: null,
    status: 'modified',
    kind: 'text',
    staged: false,
    hunks,
  })
  // a.ts: context+adds at 12-16, a pure deletion after line 40, and a hunk at 88-90.
  const a = file('src/a.ts', [
    hunk('src/a.ts', 'a1', 12, ' ++  '),
    hunk('src/a.ts', 'a2', 40, '--'),
    hunk('src/a.ts', 'a3', 88, ' + '),
  ])
  const b = file('src/b.ts', [hunk('src/b.ts', 'b1', 1, '+')])
  const img = file('logo.png', [])

  it('a hunk spans the head lines it shows; a pure deletion is the line before it', () => {
    expect(hunkHeadSpan(a.hunks[0]!)).toEqual({ from: 12, to: 16 })
    expect(hunkHeadSpan(a.hunks[1]!)).toEqual({ from: 40, to: 40 })
    expect(hunkHeadSpan(hunk('x', 'x', 0, '-'))).toEqual({ from: 1, to: 1 })
    expect(formatSpan({ from: 12, to: 16 })).toBe('12-16')
    expect(formatSpan({ from: 40, to: 40 })).toBe('40')
  })

  it('a range claims every hunk it overlaps, by a line or by all of them', () => {
    expect(rangeTouchesHunk({ from: 16, to: 30 }, a.hunks[0]!)).toBe(true)
    expect(rangeTouchesHunk({ from: 17, to: 30 }, a.hunks[0]!)).toBe(false)
    expect(rangeTouchesHunk({ from: 1, to: 200 }, a.hunks[2]!)).toBe(true)
    expect(rangeTouchesHunk({ from: 40, to: 40 }, a.hunks[1]!)).toBe(true)
  })

  it('reports the hunks no layer claims and the files no layer lists', () => {
    const out = uncoveredByLayers(
      [{ files: ['src/a.ts:12-16'] }, { files: [{ path: 'src/a.ts:88-88' }] }],
      [a, b, img],
    )
    expect(out).toEqual([
      { path: 'src/a.ts', unlisted: false, hunks: [a.hunks[1]], lines: [{ from: 40, to: 40 }] },
      { path: 'src/b.ts', unlisted: true, hunks: [], lines: [] },
      { path: 'logo.png', unlisted: true, hunks: [], lines: [] },
    ])
  })

  it('a whole-file entry claims every hunk; a full outline leaves nothing', () => {
    expect(
      uncoveredByLayers(
        [{ files: ['src/a.ts', 'logo.png'] }, { files: ['src/b.ts:1-1'] }],
        [a, b, img],
      ),
    ).toEqual([])
  })

  it('a highlight claims only the changed lines it lights, and the post hears of the rest', () => {
    const out = uncoveredByLayers(
      [{ files: [{ path: 'src/a.ts', highlight: ['13'] }, 'src/b.ts', 'logo.png'] }],
      [a, b, img],
    )
    expect(out).toEqual([
      {
        path: 'src/a.ts',
        unlisted: false,
        hunks: a.hunks,
        lines: [
          { from: 14, to: 14 },
          { from: 40, to: 40 },
          { from: 89, to: 89 },
        ],
      },
    ])
  })
})

describe('highlighted lines', () => {
  const line = (kind: 'add' | 'del' | 'context', oldNo: number | null, newNo: number | null) => ({
    kind,
    oldNo,
    newNo,
    text: '',
  })

  it('light head-side lines, and a deleted run goes with the head line after it', () => {
    const lines = [
      line('context', 9, 9),
      line('del', 10, null),
      line('del', 11, null),
      line('add', null, 10),
      line('context', 12, 11),
      line('del', 13, null),
    ]
    expect([...highlightedRows(lines, [{ from: 10, to: 10 }])]).toEqual([1, 2, 3])
    expect([...highlightedRows(lines, [{ from: 9, to: 9 }])]).toEqual([0])
    // A trailing deletion has no head line after it: it goes with the one before.
    expect([...highlightedRows(lines, [{ from: 11, to: 11 }])]).toEqual([4, 5])
    expect(highlightedRows(lines, []).size).toBe(0)
  })

  // b.ts: two changes in one hunk, lines 2 and 5 (with line 4 deleted before 5).
  const b: FileChange = {
    path: 'src/b.ts',
    oldPath: null,
    status: 'modified',
    kind: 'text',
    staged: false,
    hunks: [
      {
        id: 'b1',
        path: 'src/b.ts',
        oldStart: 1,
        newStart: 1,
        lines: [
          line('context', 1, 1),
          line('add', null, 2),
          line('context', 2, 3),
          line('del', 3, null),
          line('add', null, 4),
          line('add', null, 5),
          line('context', 4, 6),
        ],
      },
    ],
  }

  it('names the changed lines no layer claims, a deletion by the head line it goes with', () => {
    expect(uncoveredByLayers([{ files: [{ path: 'src/b.ts', highlight: ['2'] }] }], [b])).toEqual([
      { path: 'src/b.ts', unlisted: false, hunks: b.hunks, lines: [{ from: 4, to: 5 }] },
    ])
  })

  it('covers a hunk across layers, each claiming its own lines', () => {
    const split = [
      { files: [{ path: 'src/b.ts', highlight: ['2'] }] },
      { files: [{ path: 'src/b.ts', highlight: ['4-5'] }] },
    ]
    expect(uncoveredByLayers(split, [b])).toEqual([])
    expect(sharedByLayers(split, [b])).toEqual([])
  })

  it('a hunk held without a highlight claims every changed line in it', () => {
    const outline = [{ files: [{ path: 'src/b.ts', highlight: ['2'] }] }, { files: ['src/b.ts'] }]
    expect(uncoveredByLayers(outline, [b])).toEqual([])
    const shared = sharedByLayers(outline, [b])
    expect(shared).toEqual([{ path: 'src/b.ts', layers: [0, 1], lines: [{ from: 2, to: 2 }] }])
    expect(sharedLine(shared)).toBe('src/b.ts:2 (layers 1, 2)')
  })

  it('a highlight that lights only context is ignored, so the hunk is claimed whole', () => {
    expect(uncoveredByLayers([{ files: [{ path: 'src/b.ts', highlight: ['3'] }] }], [b])).toEqual(
      [],
    )
  })

  it('two highlights of one line in different layers are shared; in one layer they are not', () => {
    const twice = [
      { files: [{ path: 'src/b.ts', highlight: ['2', '4-5'] }] },
      { files: [{ path: 'src/b.ts', highlight: ['5'] }] },
    ]
    expect(sharedByLayers(twice, [b])).toEqual([
      { path: 'src/b.ts', layers: [0, 1], lines: [{ from: 5, to: 5 }] },
    ])
    const once = [
      {
        files: [
          { path: 'src/b.ts', highlight: ['2', '5'] },
          { path: 'src/b.ts', highlight: ['5'] },
        ],
      },
    ]
    expect(sharedByLayers(once, [b])).toEqual([])
  })
})
