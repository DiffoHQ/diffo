import { describe, expect, it } from 'vitest'
import type { Layers } from '../shared/review.js'
import type { FileChange, Hunk } from '../shared/types.js'
import { fileMark } from './fileMarks.js'
import {
  layerByPath,
  layerDone,
  layerProgress,
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

  it('the reserved path:from-to form resolves to the whole file in v1', () => {
    const out = resolveLayers(
      layers([
        { id: 'a', title: 'Slice', files: ['src/parse.ts:1-40', { path: 'src/cli.ts:2-3' }] },
      ]),
      FILES,
    )
    expect(paths(out[0]!.files)).toEqual(['src/parse.ts', 'src/cli.ts'])
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
