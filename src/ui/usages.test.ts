import { describe, expect, it } from 'vitest'
import type { FileChange } from '../shared/types.js'
import { countUsages, findUsages, isSymbolWord, wordAt } from './usages.js'

function file(path: string, lines: FileChange['hunks'][number]['lines'], id = path): FileChange {
  return {
    path,
    oldPath: null,
    status: 'modified',
    kind: 'text',
    staged: false,
    hunks: [{ id, path, oldStart: 1, newStart: 1, lines }],
  }
}

describe('wordAt', () => {
  it('finds the identifier around an offset, inclusive of its end', () => {
    expect(wordAt('const fooBar = baz', 8)).toEqual({ word: 'fooBar', start: 6, end: 12 })
    expect(wordAt('const fooBar = baz', 12)).toEqual({ word: 'fooBar', start: 6, end: 12 })
    expect(wordAt('const fooBar = baz', 6)).toEqual({ word: 'fooBar', start: 6, end: 12 })
  })

  it('returns null between words and inside numbers', () => {
    expect(wordAt('a  b', 1)?.word).toBe('a')
    expect(wordAt('a  b', 2)).toBeNull()
    expect(wordAt('a   b', 3)).toBeNull()
    expect(wordAt('x = 1234', 6)).toBeNull()
  })

  it('treats $ and _ as identifier characters', () => {
    expect(wordAt('$el._x', 3)?.word).toBe('$el')
    expect(wordAt('$el._x', 5)?.word).toBe('_x')
  })
})

describe('isSymbolWord', () => {
  it('rejects reserved words, case-sensitively', () => {
    expect(isSymbolWord('return')).toBe(false)
    expect(isSymbolWord('None')).toBe(false)
    expect(isSymbolWord('none')).toBe(true)
    expect(isSymbolWord('findUsages')).toBe(true)
  })
})

describe('findUsages', () => {
  const files: FileChange[] = [
    file('src/a.ts', [
      { kind: 'context', oldNo: 1, newNo: 1, text: 'import { load } from "./b.js"' },
      { kind: 'del', oldNo: 2, newNo: null, text: 'const x = loadAll()' },
      { kind: 'add', oldNo: null, newNo: 2, text: 'const x = load()' },
      { kind: 'add', oldNo: null, newNo: 3, text: 'load.cache = x' },
    ]),
    file('src/b.ts', [
      { kind: 'add', oldNo: null, newNo: 10, text: 'export function load() {}' },
      { kind: 'context', oldNo: 9, newNo: 11, text: '// reload is not load' },
    ]),
    {
      path: 'img.png',
      oldPath: null,
      status: 'added',
      kind: 'image',
      staged: false,
      hunks: [
        {
          id: 'img',
          path: 'img.png',
          oldStart: 0,
          newStart: 0,
          lines: [{ kind: 'add', oldNo: null, newNo: 1, text: 'load' }],
        },
      ],
    },
  ]

  it('matches whole identifiers only, on the head side', () => {
    const groups = findUsages(files, 'load', 'head')
    expect(groups.map((g) => g.path)).toEqual(['src/a.ts', 'src/b.ts'])
    expect(groups[0]!.usages.map((u) => u.line)).toEqual([1, 2, 3])
    expect(groups[1]!.usages.map((u) => u.line)).toEqual([10, 11])
    expect(groups[0]!.usages[2]).toMatchObject({
      col: 0,
      hunkId: 'src/a.ts',
      text: 'load.cache = x',
    })
    expect(countUsages(groups)).toBe(5)
  })

  it('searches the base version for a name on a deleted line', () => {
    const groups = findUsages(files, 'loadAll', 'base')
    expect(groups).toHaveLength(1)
    expect(groups[0]!.usages).toEqual([
      { path: 'src/a.ts', hunkId: 'src/a.ts', line: 2, text: 'const x = loadAll()', col: 10 },
    ])
    expect(findUsages(files, 'loadAll', 'head')).toEqual([])
  })

  it('numbers base-side usages by old line and skips added lines', () => {
    const groups = findUsages(files, 'load', 'base')
    expect(groups[0]!.usages.map((u) => u.line)).toEqual([1])
    expect(groups[1]!.usages.map((u) => u.line)).toEqual([9])
  })

  it('skips non-text files and the empty word', () => {
    expect(findUsages(files, 'load', 'head').some((g) => g.path === 'img.png')).toBe(false)
    expect(findUsages(files, '', 'head')).toEqual([])
  })

  it('escapes $ in the name', () => {
    const f = [file('x.js', [{ kind: 'add', oldNo: null, newNo: 1, text: 'const $el = $("a")' }])]
    expect(findUsages(f, '$el', 'head')[0]!.usages[0]!.col).toBe(6)
    expect(findUsages(f, '$', 'head')[0]!.usages[0]!.col).toBe(12)
  })
})
