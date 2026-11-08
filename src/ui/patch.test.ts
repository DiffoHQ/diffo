import { describe, expect, it } from 'vitest'
import { langForPath, tokenizeLines } from './highlight.js'
import { patchRuns, targetFromPatchName } from './patch.js'

const runs = (lines: string[], fallback: string | null = null) =>
  patchRuns(lines, fallback, langForPath)

describe('targetFromPatchName', () => {
  it('reads the target off a name that carries one', () => {
    expect(targetFromPatchName('patches/chrome-browser-foo.cc.patch')).toBe(
      'patches/chrome-browser-foo.cc',
    )
    expect(targetFromPatchName('fix.py.diff')).toBe('fix.py')
    expect(targetFromPatchName('patches/.gitignore.patch')).toBe('patches/.gitignore')
  })

  it('gives nothing for a name that does not', () => {
    expect(targetFromPatchName('debian/patches/0001-fix-crash.patch')).toBeNull()
    expect(targetFromPatchName('src/foo.cc')).toBeNull()
  })
})

describe('patchRuns', () => {
  it('groups code lines in the language the headers name', () => {
    const result = runs([
      'diff --git a/base/file.cc b/base/file.cc',
      'index 5b3019f..8fe8bb3 100644',
      '--- a/base/file.cc',
      '+++ b/base/file.cc',
      '@@ -1,3 +1,3 @@',
      ' int a = 1;',
      '-int b = 2;',
      '+int b = 3;',
    ])
    expect(result).toEqual([{ lang: 'cpp', old: [5, 6], new: [5, 7] }])
  })

  it('switches language at each file of a multi-file patch', () => {
    const result = runs([
      '--- a/x.py',
      '+++ b/x.py',
      '@@ -1 +1 @@',
      '+import os',
      '--- a/y.go',
      '+++ b/y.go',
      '@@ -1 +1 @@',
      '+package y',
    ])
    expect(result.map((r) => [r.lang, r.new])).toEqual([
      ['python', [3]],
      ['go', [7]],
    ])
  })

  it('keeps the old path for a deleted file', () => {
    const result = runs(['--- a/gone.rs', '+++ /dev/null', '@@ -1 +0,0 @@', '-fn main() {}'])
    expect(result).toEqual([{ lang: 'rust', old: [3], new: [] }])
  })

  it('falls back to the patch name when the slice shows no header', () => {
    expect(runs([' int a;', '+int b;'], 'cpp')).toEqual([{ lang: 'cpp', old: [0], new: [0, 1] }])
  })

  it('starts a new run after each hunk marker', () => {
    expect(runs(['+a', '@@ -9 +9 @@', '+b'], 'cpp')).toEqual([
      { lang: 'cpp', old: [], new: [0] },
      { lang: 'cpp', old: [], new: [2] },
    ])
  })

  it('reads a lone `--- ` as a deleted line, not a header', () => {
    expect(runs(['--- a SQL comment', '+select 1;'], 'sql')).toEqual([
      { lang: 'sql', old: [0], new: [1] },
    ])
  })

  it('leaves commit prose and the signature out of any run', () => {
    expect(runs(['Subject: [PATCH] fix', '-- ', '2.43.0'], 'cpp')).toEqual([])
  })

  it('makes no run when no target is known', () => {
    expect(runs(['+anything'])).toEqual([])
  })
})

describe('tokenizeLines on a patch', () => {
  it('highlights the code past each marker in the target language', async () => {
    const lines = ['--- a/a.ts', '+++ b/a.ts', '@@ -1 +1 @@', '-const x = 1', '+const x = 2']
    const tokens = await tokenizeLines(lines, 'fix.patch', false)
    expect(tokens).not.toBeNull()
    for (const [i, line] of lines.entries()) {
      expect(tokens![i]!.map((t) => t.content).join('')).toBe(line)
    }
    const added = tokens![4]!
    expect(added[0]!.content).toBe('+')
    const keyword = added.find((t) => t.content === 'const')
    const literal = added.find((t) => t.content === '2')
    expect(keyword?.color).toBeDefined()
    expect(literal?.color).toBeDefined()
    expect(keyword!.color).not.toBe(literal!.color)
  })

  it('falls back to the diff grammar when no target is known', async () => {
    const tokens = await tokenizeLines(['+anything', '-else'], 'notes.patch', false)
    expect(tokens).toHaveLength(2)
    expect(tokens![0]!.map((t) => t.content).join('')).toBe('+anything')
  })
})
