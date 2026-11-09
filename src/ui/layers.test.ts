import { describe, expect, it } from 'vitest'
import type { Layers, ReviewThread } from '../shared/review.js'
import type { FileChange, Hunk } from '../shared/types.js'
import { expandMarks, fileMark } from './fileMarks.js'
import {
  entryMarks,
  entryViewed,
  findDescription,
  findGuide,
  hideLayerFiles,
  layerByHunk,
  layerByPath,
  layerDone,
  layerKey,
  layerLineStats,
  layerLinkHref,
  layerProgress,
  layersByPath,
  linkPaths,
  outlineSplitsFiles,
  parseLayerLink,
  resolveLayers,
  SINCE_TITLE,
  startingLayer,
  stepLayer,
} from './layers.js'

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
  file('src/cli.ts'),
  file('src/api.ts'),
  file('src/weekday.ts', 3, { status: 'added' }),
  file('README.md'),
]

const layers = (items: Layers['items']): Layers => ({ items, postedAt: '2026-09-20T00:00:00Z' })

const paths = (files: { file: FileChange }[]) => files.map((f) => f.file.path)

describe('resolveLayers', () => {
  it('no layers means no layer mode — an empty list, not a derived catch-all', () => {
    expect(resolveLayers(undefined, FILES)).toEqual([])
    expect(resolveLayers(layers([]), FILES)).toEqual([])
  })

  it('resolves each listed path to its file, in the order listed, numbered from 1', () => {
    const out = resolveLayers(
      layers([
        { id: 'a', title: 'Contract', files: ['src/parse.ts'] },
        {
          id: 'b',
          title: 'Callers',
          kind: 'mechanical',
          summary: 'follow the rename',
          files: ['src/api.ts', { path: 'src/cli.ts', note: 'entry point' }],
        },
        { id: 'c', title: 'Docs', files: ['README.md'] },
        { id: 'd', title: 'Weekday', files: ['src/weekday.ts'] },
      ]),
      FILES,
    )
    expect(out.map((l) => [l.number, l.title, paths(l.files)])).toEqual([
      [1, 'Contract', ['src/parse.ts']],
      [2, 'Callers', ['src/api.ts', 'src/cli.ts']],
      [3, 'Docs', ['README.md']],
      [4, 'Weekday', ['src/weekday.ts']],
    ])
    expect(out[1]).toMatchObject({ id: 'b', kind: 'mechanical', summary: 'follow the rename' })
    expect(out[1]!.files[1]).toMatchObject({ note: 'entry point' })
    expect(out[0]).not.toHaveProperty('kind')
    expect(out[0]).not.toHaveProperty('summary')
    // Every file was listed: nothing to derive.
    expect(out.some((l) => l.derived)).toBe(false)
  })

  it('files no layer lists land in a derived trailing layer, in the order given', () => {
    const out = resolveLayers(
      layers([{ id: 'a', title: 'Contract', files: ['src/cli.ts'] }]),
      FILES,
    )
    expect(out).toHaveLength(2)
    const since = out[1]!
    expect(since).toMatchObject({ id: null, number: null, title: SINCE_TITLE, derived: true })
    expect(paths(since.files)).toEqual([
      'src/parse.ts',
      'src/api.ts',
      'src/weekday.ts',
      'README.md',
    ])
  })

  it('a path the changeset lacks contributes nothing and is reported as missing', () => {
    const out = resolveLayers(
      layers([{ id: 'a', title: 'Contract', files: ['src/gone.ts', 'src/parse.ts'] }]),
      FILES,
    )
    expect(paths(out[0]!.files)).toEqual(['src/parse.ts'])
    expect(out[0]!.missing).toEqual(['src/gone.ts'])
  })

  it('a layer whose paths all resolved to nothing is empty, and done', () => {
    const out = resolveLayers(layers([{ id: 'a', title: 'Ghost', files: ['x.ts', 'y.ts'] }]), FILES)
    expect(out[0]!.files).toEqual([])
    expect(out[0]!.missing).toEqual(['x.ts', 'y.ts'])
    expect(layerDone(out[0]!, new Set())).toBe(true)
  })

  describe('a path:from-to entry holds the hunks its lines touch', () => {
    // src/big.ts shows three hunks on the head side: 10-14, 40-42, 88-90.
    const spanned = (path: string, n: number, newStart: number, count: number): Hunk => ({
      id: `${path}#${n}`,
      path,
      oldStart: newStart,
      newStart,
      lines: Array.from({ length: count }, (_, i) => ({
        kind: 'add' as const,
        oldNo: null,
        newNo: newStart + i,
        text: '',
      })),
    })
    const big: FileChange = {
      ...file('src/big.ts'),
      hunks: [
        spanned('src/big.ts', 1, 10, 5),
        spanned('src/big.ts', 2, 40, 3),
        spanned('src/big.ts', 3, 88, 3),
      ],
    }
    const out = resolveLayers(
      layers([
        { id: 'a', title: 'Contract', files: ['src/big.ts:10-14', 'src/cli.ts'] },
        { id: 'b', title: 'Consumers', files: [{ path: 'src/big.ts:41-41', note: 'the call' }] },
      ]),
      [big, ...FILES],
    )

    it('each step shows its part, flagged partial, with the note; whole files are not partial', () => {
      const [a, b] = out
      expect(a!.files.map((f) => [f.file.path, f.hunks.map((h) => h.id), f.partial])).toEqual([
        ['src/big.ts', ['src/big.ts#1'], true],
        ['src/cli.ts', ['src/cli.ts#1'], false],
      ])
      expect(b!.files[0]).toMatchObject({ note: 'the call', partial: true })
      expect(b!.files[0]!.hunks.map((h) => h.id)).toEqual(['src/big.ts#2'])
    })

    it('the hunks no range claimed land in the derived layer, as a partial entry', () => {
      const since = out.at(-1)!
      expect(since.derived).toBe(true)
      const rest = since.files.find((f) => f.file.path === 'src/big.ts')!
      expect(rest.partial).toBe(true)
      expect(rest.hunks.map((h) => h.id)).toEqual(['src/big.ts#3'])
      // Unlisted files are there whole, as before.
      expect(since.files.find((f) => f.file.path === 'README.md')).toMatchObject({ partial: false })
    })

    it('progress and size count the entry’s hunks, not the file’s', () => {
      const a = out[0]!
      expect(layerProgress(a, new Set())).toEqual({
        files: 2,
        doneFiles: 0,
        marks: 2,
        doneMarks: 0,
      })
      const read = new Set(['src/big.ts#1'])
      expect(layerProgress(a, read)).toMatchObject({ doneFiles: 1, doneMarks: 1 })
      expect(layerDone(a, new Set(['src/big.ts#1', 'src/cli.ts#1']))).toBe(true)
      // Reading the other steps' hunks does nothing here.
      expect(layerProgress(a, new Set(['src/big.ts#2', 'src/big.ts#3']))).toMatchObject({
        doneMarks: 0,
      })
      expect(layerLineStats(a)).toEqual({ additions: 5, deletions: 0 })
      expect(entryMarks(a.files[0]!)).toEqual(['src/big.ts#1'])
      expect(entryViewed(a.files[0]!, read)).toBe(true)
    })

    it('a range the code moved from under is reported missing, by its range', () => {
      const drifted = resolveLayers(
        layers([{ id: 'a', title: 'Contract', files: ['src/big.ts:500-520', 'src/big.ts:10-10'] }]),
        [big],
      )
      // One of two ranges still lands: the entry stands and nothing is missing.
      expect(drifted[0]!.files[0]!.hunks.map((h) => h.id)).toEqual(['src/big.ts#1'])
      expect(drifted[0]!.missing).toEqual([])
      const gone = resolveLayers(
        layers([{ id: 'a', title: 'Contract', files: ['src/big.ts:500-520'] }]),
        [big],
      )
      expect(gone[0]!.files).toEqual([])
      expect(gone[0]!.missing).toEqual(['src/big.ts:500-520'])
      // The whole file is then in the derived layer.
      expect(gone[1]!.files[0]).toMatchObject({ partial: false })
    })

    it('a highlight keeps only the hunks it lights; the rest read where another step lights them', () => {
      const outline = layers([
        { id: 'a', title: 'Contract', files: [{ path: 'src/big.ts', highlight: ['10-14'] }] },
        {
          id: 'b',
          title: 'Consumers',
          files: [{ path: 'src/big.ts', highlight: ['40-42', '88-90'] }],
        },
      ])
      const [a, b, since] = resolveLayers(outline, [big])
      expect(a!.files[0]!.hunks.map((h) => h.id)).toEqual(['src/big.ts#1'])
      expect(a!.files[0]!.partial).toBe(true)
      expect(b!.files[0]!.hunks.map((h) => h.id)).toEqual(['src/big.ts#2', 'src/big.ts#3'])
      expect(since).toBeUndefined()
    })

    it('changed lines no step claims land in the derived layer, lit; the whole-file switch claims them back', () => {
      const outline = layers([
        { id: 'a', title: 'Contract', files: [{ path: 'src/big.ts', highlight: ['11'] }] },
      ])
      const rest = resolveLayers(outline, [big]).at(-1)!.files[0]!
      expect(rest.hunks.map((h) => h.id)).toEqual(['src/big.ts#1', 'src/big.ts#2', 'src/big.ts#3'])
      expect(rest.highlight).toEqual([
        { from: 10, to: 10 },
        { from: 12, to: 14 },
        { from: 40, to: 42 },
        { from: 88, to: 90 },
      ])
      const whole = resolveLayers(outline, [big], { wholeFiles: true })
      expect(whole).toHaveLength(1)
      expect(whole[0]!.files[0]).toMatchObject({
        partial: false,
        highlight: [{ from: 11, to: 11 }],
      })
    })

    it('a highlight within a range narrows it, and one that lights nothing is ignored', () => {
      const narrowed = resolveLayers(
        layers([{ id: 'a', title: 'A', files: [{ path: 'src/big.ts:10-42', highlight: ['40'] }] }]),
        [big],
      )
      expect(narrowed[0]!.files[0]!.hunks.map((h) => h.id)).toEqual(['src/big.ts#2'])
      const drifted = resolveLayers(
        layers([{ id: 'a', title: 'A', files: [{ path: 'src/big.ts', highlight: ['300'] }] }]),
        [big],
      )
      expect(drifted[0]!.files[0]!.partial).toBe(false)
      expect(drifted).toHaveLength(1)
    })

    it('a ranged entry whose ranges cover every hunk is simply the whole file', () => {
      const all = resolveLayers(layers([{ id: 'a', title: 'All', files: ['src/big.ts:1-100'] }]), [
        big,
      ])
      expect(all[0]!.files[0]!.partial).toBe(false)
      expect(all).toHaveLength(1)
    })

    it('the split switch off: every range is ignored and the file is whole in each step', () => {
      const whole = resolveLayers(
        layers([
          { id: 'a', title: 'Contract', files: ['src/big.ts:10-14', 'src/cli.ts'] },
          { id: 'b', title: 'Consumers', files: [{ path: 'src/big.ts:41-41', note: 'the call' }] },
        ]),
        [big, ...FILES],
        { wholeFiles: true },
      )
      expect(whole[0]!.files[0]).toMatchObject({ partial: false })
      expect(whole[0]!.files[0]!.hunks).toHaveLength(3)
      expect(whole[1]!.files[0]).toMatchObject({ partial: false, note: 'the call' })
      // Nothing of big.ts is left for the derived layer.
      expect(whole.at(-1)!.files.some((f) => f.file.path === 'src/big.ts')).toBe(false)
      expect(
        outlineSplitsFiles(layers([{ id: 'a', title: 'A', files: ['src/big.ts:10-14'] }])),
      ).toBe(true)
      expect(outlineSplitsFiles(layers([{ id: 'a', title: 'A', files: ['src/big.ts'] }]))).toBe(
        false,
      )
      expect(outlineSplitsFiles(undefined)).toBe(false)
    })

    it('layerByHunk and layersByPath know where each part reads', () => {
      const byHunk = layerByHunk(out)
      expect(byHunk.get('src/big.ts#1')!.title).toBe('Contract')
      expect(byHunk.get('src/big.ts#2')!.title).toBe('Consumers')
      expect(byHunk.get('src/big.ts#3')!.derived).toBe(true)
      expect(
        layersByPath(out)
          .get('src/big.ts')!
          .map((l) => l.title),
      ).toEqual(['Contract', 'Consumers', SINCE_TITLE])
      expect(
        layersByPath(out)
          .get('src/cli.ts')!
          .map((l) => l.title),
      ).toEqual(['Contract'])
    })
  })

  it('a path listed twice in one layer counts once; across layers it appears in both', () => {
    const out = resolveLayers(
      layers([
        { id: 'a', title: 'A', files: ['src/cli.ts', 'src/cli.ts'] },
        { id: 'b', title: 'B', files: ['src/cli.ts', 'src/api.ts'] },
      ]),
      FILES,
    )
    expect(paths(out[0]!.files)).toEqual(['src/cli.ts'])
    expect(paths(out[1]!.files)).toEqual(['src/cli.ts', 'src/api.ts'])
    // Listed somewhere ⇒ not derived, even though listed twice.
    expect(paths(out.at(-1)!.files)).not.toContain('src/cli.ts')
  })

  it('a renamed file is matched by its new path only — the old name lands in the derived layer', () => {
    const renamed = file('src/due.ts', 1, { status: 'renamed', oldPath: 'src/dates.ts' })
    const out = resolveLayers(layers([{ id: 'a', title: 'A', files: ['src/dates.ts'] }]), [renamed])
    expect(out[0]!.files).toEqual([])
    expect(out[0]!.missing).toEqual(['src/dates.ts'])
    expect(out[1]).toMatchObject({ derived: true })
    expect(paths(out[1]!.files)).toEqual(['src/due.ts'])
  })

  it('an empty changeset resolves every layer to nothing and derives nothing', () => {
    const out = resolveLayers(layers([{ id: 'a', title: 'A', files: ['src/cli.ts'] }]), [])
    expect(out).toHaveLength(1)
    expect(out[0]!.files).toEqual([])
    expect(out[0]!.missing).toEqual(['src/cli.ts'])
  })
})

describe('highlights', () => {
  it('resolve onto the entry, folded across entries of one path, and survive the whole-file switch', () => {
    const outline = layers([
      {
        id: 'a',
        title: 'A',
        files: [
          { path: 'src/parse.ts:1-1', highlight: ['3-4'] },
          { path: 'src/parse.ts:1-1', highlight: ['9'] },
          'src/cli.ts',
        ],
      },
    ])
    const parse: FileChange = {
      ...file('src/parse.ts'),
      hunks: [
        {
          ...hunk('src/parse.ts', 1),
          lines: Array.from({ length: 10 }, (_, i) => ({
            kind: 'add' as const,
            oldNo: null,
            newNo: i + 1,
            text: '',
          })),
        },
      ],
    }
    const files = [parse, ...FILES.slice(1)]
    const [a] = resolveLayers(outline, files)
    expect(a!.files[0]!.highlight).toEqual([
      { from: 3, to: 4 },
      { from: 9, to: 9 },
    ])
    expect(a!.files[1]!.highlight).toBeUndefined()
    const [whole] = resolveLayers(outline, files, { wholeFiles: true })
    expect(whole!.files[0]!.highlight).toHaveLength(2)
  })
})

describe('highlight read marks', () => {
  const SHARED = '0123456789abcdef'
  const added = (newNo: number) => ({ kind: 'add' as const, oldNo: null, newNo, text: 'x' })
  const promises: FileChange = {
    ...file('src/promises.rs'),
    hunks: [
      {
        id: SHARED,
        path: 'src/promises.rs',
        oldStart: 10,
        newStart: 10,
        lines: [added(10), added(11), added(12), added(13)],
      },
      {
        id: 'fedcba9876543210',
        path: 'src/promises.rs',
        oldStart: 40,
        newStart: 40,
        lines: [added(40)],
      },
    ],
  }
  const outline = layers([
    {
      id: 'contract',
      title: 'Contract',
      files: [{ path: 'src/promises.rs', highlight: ['10-11'] }],
    },
    {
      id: 'callers',
      title: 'Callers',
      files: [{ path: 'src/promises.rs', highlight: ['12-13', '40'] }],
    },
  ])

  it('reading one step reads its lines of a shared hunk, not the other step’s', () => {
    const [contract, callers] = resolveLayers(outline, [promises])
    expect(entryMarks(contract!.files[0]!)).toEqual([`${SHARED}:0`, `${SHARED}:1`])
    const viewed = expandMarks(new Set(entryMarks(contract!.files[0]!)), [promises])
    expect(entryViewed(contract!.files[0]!, viewed)).toBe(true)
    expect(entryViewed(callers!.files[0]!, viewed)).toBe(false)
    expect(viewed.has(SHARED)).toBe(false)

    const both = expandMarks(new Set([...viewed, ...entryMarks(callers!.files[0]!)]), [promises])
    expect(both.has(SHARED)).toBe(true)
  })

  it('a hunk the step holds with no line lit reads whole', () => {
    const [contract] = resolveLayers(outline, [promises], { wholeFiles: true })
    expect(entryMarks(contract!.files[0]!)).toEqual([
      `${SHARED}:0`,
      `${SHARED}:1`,
      'fedcba9876543210',
    ])
  })
})

describe('layerByPath', () => {
  it('maps each file to the first layer that lists it; unlisted files to the derived one', () => {
    const out = resolveLayers(
      layers([
        { id: 'a', title: 'A', files: ['src/cli.ts'] },
        { id: 'b', title: 'B', files: ['src/cli.ts', 'src/api.ts'] },
      ]),
      FILES,
    )
    const by = layerByPath(out)
    expect(by.get('src/cli.ts')?.number).toBe(1)
    expect(by.get('src/api.ts')?.number).toBe(2)
    expect(by.get('README.md')?.derived).toBe(true)
    expect(by.get('nope.ts')).toBeUndefined()
  })
})

describe('layerProgress / layerDone', () => {
  const out = resolveLayers(
    layers([
      { id: 'a', title: 'A', files: ['src/parse.ts', 'src/cli.ts'] },
      { id: 'b', title: 'B', files: ['src/weekday.ts'] },
    ]),
    [...FILES, file('img.png', 0, { kind: 'image' })],
  )

  it('counts hunks as marks and rolls them up per file', () => {
    const viewed = new Set(['src/parse.ts#1', 'src/cli.ts#1'])
    expect(layerProgress(out[0]!, viewed)).toEqual({
      files: 2,
      doneFiles: 1,
      marks: 3,
      doneMarks: 2,
    })
    expect(layerDone(out[0]!, viewed)).toBe(false)
    expect(layerDone(out[0]!, new Set([...viewed, 'src/parse.ts#2']))).toBe(true)
  })

  it('a hunkless file counts as one synthetic mark, so it can be read too', () => {
    const since = out.at(-1)!
    expect(since.derived).toBe(true)
    const image = since.files.find((f) => f.file.path === 'img.png')!.file
    const before = layerProgress(since, new Set())
    const after = layerProgress(since, new Set([fileMark(image)]))
    expect(after.doneMarks - before.doneMarks).toBe(1)
    expect(after.doneFiles - before.doneFiles).toBe(1)
  })
})

describe('layerLineStats', () => {
  const lines = (adds: number, dels: number): Hunk['lines'] => [
    ...Array.from({ length: adds }, (_, i) => ({
      kind: 'add' as const,
      oldNo: null,
      newNo: i + 1,
      text: '',
    })),
    ...Array.from({ length: dels }, (_, i) => ({
      kind: 'del' as const,
      oldNo: i + 1,
      newNo: null,
      text: '',
    })),
    { kind: 'context' as const, oldNo: 9, newNo: 9, text: '' },
  ]
  const sized = [
    { ...file('src/parse.ts'), hunks: [{ ...hunk('src/parse.ts', 1), lines: lines(240, 2) }] },
    { ...file('src/cli.ts'), hunks: [{ ...hunk('src/cli.ts', 1), lines: lines(3, 3) }] },
    { ...file('src/api.ts'), hunks: [{ ...hunk('src/api.ts', 1), lines: lines(0, 7) }] },
  ]
  const out = resolveLayers(
    layers([
      { id: 'a', title: 'A', files: ['src/parse.ts', 'src/cli.ts'] },
      { id: 'b', title: 'B', files: ['src/api.ts', 'src/missing.ts'] },
    ]),
    sized,
  )

  it('sums added and removed lines over the layer’s files; context lines do not count', () => {
    expect(layerLineStats(out[0]!)).toEqual({ additions: 243, deletions: 5 })
    expect(layerLineStats(out[1]!)).toEqual({ additions: 0, deletions: 7 })
  })

  it('a file the filter hid is not counted — the size matches what is shown', () => {
    const shown = hideLayerFiles(out, (f) => f.path === 'src/cli.ts')
    expect(layerLineStats(shown[0]!)).toEqual({ additions: 240, deletions: 2 })
  })
})

describe('stepLayer / startingLayer', () => {
  const out = resolveLayers(
    layers([
      { id: 'a', title: 'A', files: ['src/parse.ts'] },
      { id: 'b', title: 'B', files: ['src/cli.ts'] },
      { id: 'c', title: 'C', files: ['src/api.ts'] },
    ]),
    FILES,
  )

  it('walks forward and back, and reports the end as null', () => {
    expect(stepLayer(out, 0, 1)).toBe(1)
    expect(stepLayer(out, 1, -1)).toBe(0)
    expect(stepLayer(out, out.length - 1, 1)).toBeNull()
    expect(stepLayer(out, 0, -1)).toBeNull()
  })

  it('skips the layers the caller rules out — a filter that left nothing', () => {
    expect(stepLayer(out, 0, 1, (l) => l.title === 'B')).toBe(2)
    expect(stepLayer(out, 0, 1, () => true)).toBeNull()
  })

  it('opens on the first layer with something unread, else the first', () => {
    expect(startingLayer(out, new Set())).toBe(0)
    expect(startingLayer(out, new Set(['src/parse.ts#1', 'src/parse.ts#2']))).toBe(1)
    const all = new Set(FILES.flatMap((f) => f.hunks.map((h) => h.id)))
    expect(startingLayer(out, all)).toBe(0)
  })
})

describe('hideLayerFiles', () => {
  const resolved = resolveLayers(
    layers([
      { id: 'a', title: 'A', files: ['src/parse.ts', 'src/cli.ts'] },
      { id: 'b', title: 'B', files: ['src/api.ts'], summary: 'the api' },
    ]),
    FILES,
  )

  it('drops the files the filter names, counts them, and leaves the rest of the layer intact', () => {
    const out = hideLayerFiles(resolved, (f) => f.path === 'src/cli.ts')
    expect(paths(out[0]!.files)).toEqual(['src/parse.ts'])
    expect(out[0]!.hidden).toBe(1)
    expect(out[0]!.title).toBe('A')
    expect(out[1]!.summary).toBe('the api')
    // The derived layer is a layer like any other.
    expect(paths(out[2]!.files)).toEqual(['src/weekday.ts', 'README.md'])
  })

  it('a layer nothing was taken from is the same object, with no count', () => {
    const out = hideLayerFiles(resolved, (f) => f.path === 'src/cli.ts')
    expect(out[1]).toBe(resolved[1])
    expect(out[1]!.hidden).toBeUndefined()
    expect(hideLayerFiles(resolved, () => false)).toEqual(resolved)
  })

  it('a layer emptied by the filter is skipped by the walk and never the start', () => {
    const out = hideLayerFiles(resolved, (f) => f.path === 'src/api.ts')
    expect(out[1]!.files).toEqual([])
    expect(out[1]!.hidden).toBe(1)
    expect(out[1]!.missing).toEqual([])
    const emptied = (l: { files: unknown[] }) => l.files.length === 0
    expect(stepLayer(out, 0, 1, emptied)).toBe(2)
    expect(startingLayer(out, new Set(['src/parse.ts#1', 'src/parse.ts#2', 'src/cli.ts#1']))).toBe(
      2,
    )
  })
})

describe('layerKey / findGuide', () => {
  it('keys a layer by its id, and the derived one by a fixed name', () => {
    const out = resolveLayers(layers([{ id: 'a', title: 'A', files: ['src/cli.ts'] }]), FILES)
    expect(layerKey(out[0]!)).toBe('a')
    expect(layerKey(out[1]!)).toBe('since')
  })

  it('the guide is the newest agent thread on the whole changeset', () => {
    const at = '2026-09-20T00:00:00Z'
    const thread = (id: string, anchor: ReviewThread['anchor'], author: 'agent' | 'reviewer') =>
      ({
        id,
        anchor,
        state: 'open',
        codeContext: null,
        codeChanged: false,
        messages: [{ id: `${id}-m`, author, text: 'hi', at }],
        createdAt: at,
        updatedAt: at,
      }) as ReviewThread
    expect(findGuide([])).toBeUndefined()
    expect(findGuide([thread('r', { kind: 'changeset' }, 'reviewer')])).toBeUndefined()
    expect(findGuide([thread('f', { kind: 'file', path: 'a.ts' }, 'agent')])).toBeUndefined()
    const guides = [
      thread('g1', { kind: 'changeset' }, 'agent'),
      thread('r', { kind: 'changeset' }, 'reviewer'),
      thread('g2', { kind: 'changeset' }, 'agent'),
    ]
    expect(findGuide(guides)?.id).toBe('g2')
  })
})

describe('summary references', () => {
  const known = ['src/weekday.ts', 'src/dates.ts', 'src/a/util.ts', 'src/b/util.ts']

  it('turns a code span naming a changeset file into a link the card can intercept', () => {
    const out = linkPaths('Read `src/weekday.ts` first.', known)
    expect(out).toBe(`Read [\`src/weekday.ts\`](${layerLinkHref('src/weekday.ts', null)}) first.`)
  })

  it('resolves a basename when exactly one file has it, and leaves an ambiguous one alone', () => {
    expect(linkPaths('see `weekday.ts`', known)).toContain(layerLinkHref('src/weekday.ts', null))
    expect(linkPaths('see `util.ts`', known)).toBe('see `util.ts`')
    expect(linkPaths('see `nope.ts`', known)).toBe('see `nope.ts`')
  })

  it('carries a line, and reads a range as its first line', () => {
    expect(linkPaths('`dates.ts:42`', known)).toContain(layerLinkHref('src/dates.ts', 42))
    expect(linkPaths('`src/dates.ts:41-80`', known)).toContain(layerLinkHref('src/dates.ts', 41))
  })

  it('never touches a fenced block — a diagram must not be rewritten under itself', () => {
    const fence = '```mermaid\nflowchart LR\n  A["`weekday.ts`"] --> B\n```'
    const text = `Before \`weekday.ts\`.\n${fence}\nAfter \`dates.ts\`.`
    const out = linkPaths(text, known)
    expect(out).toContain(fence)
    expect(out).toContain(layerLinkHref('src/weekday.ts', null))
    expect(out).toContain(layerLinkHref('src/dates.ts', null))
  })

  it('leaves prose outside backticks alone, and code that is not a path', () => {
    expect(linkPaths('src/weekday.ts is first', known)).toBe('src/weekday.ts is first')
    expect(linkPaths('call `resolveWeekday(name)`', known)).toBe('call `resolveWeekday(name)`')
    expect(linkPaths('anything', [])).toBe('anything')
  })

  it('round-trips through the href', () => {
    expect(parseLayerLink(layerLinkHref('src/a b.ts', null))).toEqual({
      path: 'src/a b.ts',
      line: null,
    })
    expect(parseLayerLink(layerLinkHref('src/dates.ts', 42))).toEqual({
      path: 'src/dates.ts',
      line: 42,
    })
    expect(parseLayerLink('#other')).toBeNull()
    expect(parseLayerLink('https://example.com')).toBeNull()
  })

  it('leaves a span alone when it already sits inside a link', () => {
    const known = ['src/weekday.ts']
    const linked = 'see [`weekday.ts`](https://example.com/weekday) for the rest'
    expect(linkPaths(linked, known)).toBe(linked)
    // Prose after the link is still ours.
    expect(linkPaths(`${linked} and \`weekday.ts\``, known)).toContain(
      `${linked} and [\`weekday.ts\`](${layerLinkHref('src/weekday.ts', null)})`,
    )
  })
})

describe('findDescription', () => {
  it('is the thread GitHub imported as the pull request description', () => {
    const at = '2026-09-20T00:00:00Z'
    const base = {
      anchor: { kind: 'changeset' as const },
      state: 'open' as const,
      codeContext: null,
      codeChanged: false,
      messages: [{ id: 'm', author: 'github' as const, text: 'What this does', at }],
      createdAt: at,
      updatedAt: at,
      audience: 'pr' as const,
    }
    const comment: ReviewThread = {
      ...base,
      id: 'c',
      github: { threadId: 'c', kind: 'comment', resolved: false, outdated: false },
    }
    const description: ReviewThread = {
      ...base,
      id: 'd',
      github: { threadId: 'description', kind: 'description', resolved: false, outdated: false },
    }
    expect(findDescription([])).toBeUndefined()
    expect(findDescription([comment])).toBeUndefined()
    expect(findDescription([comment, description])).toBe(description)
  })
})

describe('decisions', () => {
  const dueDate: FileChange = file('src/dueDate.ts', 0, {
    hunks: [
      {
        id: 'dd#1',
        path: 'src/dueDate.ts',
        oldStart: 10,
        newStart: 10,
        lines: [
          { kind: 'context', oldNo: 10, newNo: 10, text: 'export function parseDue() {' },
          { kind: 'add', oldNo: null, newNo: 11, text: '  const cache = requestCache()' },
          { kind: 'add', oldNo: null, newNo: 12, text: '  return cache.get(key)' },
        ],
      },
      { id: 'dd#2', path: 'src/dueDate.ts', oldStart: 30, newStart: 35, lines: [] },
    ],
  })
  const test: FileChange = file('test/dueDate.test.ts', 0, {
    hunks: [
      {
        id: 'tt#1',
        path: 'test/dueDate.test.ts',
        oldStart: 40,
        newStart: 40,
        lines: [{ kind: 'add', oldNo: null, newNo: 40, text: "it('caches per request')" }],
      },
    ],
  })
  const at = (path: string, line?: number, endLine?: number) => ({
    path,
    ...(line === undefined ? {} : { line }),
    ...(endLine === undefined ? {} : { endLine }),
  })

  it('resolves each place to its file and the hunk showing its line', () => {
    const [layer] = resolveLayers(
      layers([
        {
          id: 'a',
          title: 'A',
          files: ['src/dueDate.ts', 'test/dueDate.test.ts'],
          decisions: [
            {
              text: 'Caches per request',
              at: [at('src/dueDate.ts', 11, 12), at('test/dueDate.test.ts', 40)],
            },
            { text: 'No clock on todos', at: [at('src/model.ts')] },
            { text: 'Nothing to point at' },
          ],
        },
      ]),
      [dueDate, test],
    )
    const [cache, clock, bare] = layer!.decisions!
    expect(cache!.places).toEqual([
      { at: at('src/dueDate.ts', 11, 12), file: dueDate, hunkId: 'dd#1' },
      { at: at('test/dueDate.test.ts', 40), file: test, hunkId: 'tt#1' },
    ])
    // A file the changeset lacks: the place stands, with nowhere to go.
    expect(clock!.places).toEqual([{ at: at('src/model.ts') }])
    expect(bare!.places).toEqual([])
  })

  it('a line outside the diff keeps its file but has no hunk; a file-only place has neither line nor hunk', () => {
    const [layer] = resolveLayers(
      layers([
        {
          id: 'a',
          title: 'A',
          files: ['src/dueDate.ts'],
          decisions: [
            { text: 'gone', at: [at('src/dueDate.ts', 99)] },
            { text: 'whole', at: [at('src/dueDate.ts')] },
          ],
        },
      ]),
      [dueDate],
    )
    expect(layer!.decisions![0]!.places[0]).toEqual({ at: at('src/dueDate.ts', 99), file: dueDate })
    expect(layer!.decisions![1]!.places[0]).toEqual({ at: at('src/dueDate.ts'), file: dueDate })
  })

  it('a layer without decisions carries none, so the card shows nothing', () => {
    const [layer] = resolveLayers(layers([{ id: 'a', title: 'A', files: ['src/cli.ts'] }]), FILES)
    expect(layer).not.toHaveProperty('decisions')
  })
})
