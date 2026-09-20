import { describe, expect, it } from 'vitest'
import { parseLayersInput, parseSuggestReason } from './layers.js'

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

  it('keeps the reserved path:from-to form verbatim, but validates the path part', () => {
    expect(ok([{ title: 'A', files: ['src/dates.ts:41-80'] }])[0]!.files).toEqual([
      'src/dates.ts:41-80',
    ])
    expect(err([{ title: 'A', files: ['/abs/dates.ts:1-2'] }])).toContain('absolute')
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
    expect(err([{ title: 'A', files: [42] }])).toContain('path string or { path, note? }')
    expect(err([{ title: 'A', files: [{ note: 'no path' }] }])).toContain('needs a "path"')
    expect(err([{ title: 'A', files: [{ path: 'a.ts', note: 7 }] }])).toContain('must be a string')
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
