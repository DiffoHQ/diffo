import { describe, expect, it } from 'vitest'
import { parsePatch } from './parse.js'

function patch(path: string, hunks: string[], header: string[] = []): string {
  return [
    `diff --git a/${path} b/${path}`,
    ...header,
    `--- a/${path}`,
    `+++ b/${path}`,
    ...hunks,
    '',
  ].join('\n')
}

const HUNK_A = [
  '@@ -10,3 +10,4 @@',
  ' const a = 1',
  '-const b = 2',
  '+const b = 20',
  '+const c = 3',
  ' export {}',
]

describe('hunk ID invariants (v2 stands on these)', () => {
  it('edit elsewhere in the file leaves the ID unchanged', () => {
    const before = parsePatch(patch('src/a.ts', HUNK_A))
    const shifted = [
      '@@ -42,3 +47,4 @@',
      ' const shifted_context = true',
      '-const b = 2',
      '+const b = 20',
      '+const c = 3',
      ' other_context()',
    ]
    const after = parsePatch(patch('src/a.ts', shifted))
    expect(after[0]!.hunks[0]!.id).toBe(before[0]!.hunks[0]!.id)
  })

  it('editing the hunk itself mints a new ID', () => {
    const before = parsePatch(patch('src/a.ts', HUNK_A))
    const edited = [
      '@@ -10,3 +10,4 @@',
      ' const a = 1',
      '-const b = 2',
      '+const b = 21',
      '+const c = 3',
      ' export {}',
    ]
    const after = parsePatch(patch('src/a.ts', edited))
    expect(after[0]!.hunks[0]!.id).not.toBe(before[0]!.hunks[0]!.id)
  })

  it('two identical hunks in one file get distinct, stable IDs', () => {
    const twice = [
      '@@ -1,2 +1,2 @@',
      '-let x = 1',
      '+let x = 2',
      ' fn()',
      '@@ -30,2 +30,2 @@',
      '-let x = 1',
      '+let x = 2',
      ' fn()',
    ]
    const first = parsePatch(patch('src/a.ts', twice))
    const ids = first[0]!.hunks.map((h) => h.id)
    expect(ids[0]).not.toBe(ids[1])
    const second = parsePatch(patch('src/a.ts', twice))
    expect(second[0]!.hunks.map((h) => h.id)).toEqual(ids)
  })

  it('same content in a different file is a different ID', () => {
    const inA = parsePatch(patch('src/a.ts', HUNK_A))
    const inB = parsePatch(patch('src/b.ts', HUNK_A))
    expect(inA[0]!.hunks[0]!.id).not.toBe(inB[0]!.hunks[0]!.id)
  })

  it('context-only differences do not change the ID', () => {
    const moreContext = [
      '@@ -9,5 +9,6 @@',
      ' import x from "y"',
      ' const a = 1',
      '-const b = 2',
      '+const b = 20',
      '+const c = 3',
      ' export {}',
      ' // trailing',
    ]
    const a = parsePatch(patch('src/a.ts', HUNK_A))
    const b = parsePatch(patch('src/a.ts', moreContext))
    expect(b[0]!.hunks[0]!.id).toBe(a[0]!.hunks[0]!.id)
  })
})

describe('parsePatch — an image that is really text', () => {
  const SVG = [
    'diff --git a/assets/logo.svg b/assets/logo.svg',
    'new file mode 100644',
    'index 0000000..0000001',
    '--- /dev/null',
    '+++ b/assets/logo.svg',
    '@@ -0,0 +1,2 @@',
    '+<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">',
    '+</svg>',
  ].join('\n')

  it('keeps the hunks of an SVG — only a binary patch has none', () => {
    const [file] = parsePatch(SVG)
    expect(file!.hunks).toHaveLength(1)
    expect(file!.hunks[0]!.lines.map((l) => l.text)).toEqual([
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">',
      '</svg>',
    ])
    expect(file!.kind).toBe('image')
  })

  it('a genuinely binary image still has no hunks', () => {
    const [file] = parsePatch(
      [
        'diff --git a/logo.png b/logo.png',
        'new file mode 100644',
        'index 0000000..0000001',
        'Binary files /dev/null and b/logo.png differ',
      ].join('\n'),
    )
    expect(file!.kind).toBe('image')
    expect(file!.hunks).toEqual([])
  })
})

describe('parsePatch', () => {
  it('parses a modified file with line numbers', () => {
    const files = parsePatch(patch('src/a.ts', HUNK_A))
    expect(files).toHaveLength(1)
    const file = files[0]!
    expect(file).toMatchObject({
      path: 'src/a.ts',
      oldPath: null,
      status: 'modified',
      kind: 'text',
    })
    const lines = file.hunks[0]!.lines
    expect(lines).toEqual([
      { kind: 'context', oldNo: 10, newNo: 10, text: 'const a = 1' },
      { kind: 'del', oldNo: 11, newNo: null, text: 'const b = 2' },
      { kind: 'add', oldNo: null, newNo: 11, text: 'const b = 20' },
      { kind: 'add', oldNo: null, newNo: 12, text: 'const c = 3' },
      { kind: 'context', oldNo: 12, newNo: 13, text: 'export {}' },
    ])
  })

  it('parses added and deleted files', () => {
    const added = [
      'diff --git a/new.ts b/new.ts',
      'new file mode 100644',
      'index 0000000..1111111',
      '--- /dev/null',
      '+++ b/new.ts',
      '@@ -0,0 +1,2 @@',
      '+line one',
      '+line two',
      '',
    ].join('\n')
    const deleted = [
      'diff --git a/old.ts b/old.ts',
      'deleted file mode 100644',
      'index 1111111..0000000',
      '--- a/old.ts',
      '+++ /dev/null',
      '@@ -1,2 +0,0 @@',
      '-line one',
      '-line two',
      '',
    ].join('\n')
    const files = parsePatch(added + deleted)
    expect(files[0]).toMatchObject({ path: 'new.ts', status: 'added' })
    expect(files[1]).toMatchObject({ path: 'old.ts', status: 'deleted' })
  })

  it('parses a pure rename (no hunks) that parse-diff drops', () => {
    const pureRename = [
      'diff --git a/src/old-name.ts b/src/new-name.ts',
      'similarity index 100%',
      'rename from src/old-name.ts',
      'rename to src/new-name.ts',
      '',
    ].join('\n')
    const files = parsePatch(pureRename)
    expect(files[0]).toMatchObject({
      path: 'src/new-name.ts',
      oldPath: 'src/old-name.ts',
      status: 'renamed',
      hunks: [],
    })
  })

  it('parses a rename with edits', () => {
    const renameWithEdit = [
      'diff --git a/a.ts b/b.ts',
      'similarity index 90%',
      'rename from a.ts',
      'rename to b.ts',
      'index 1111111..2222222 100644',
      '--- a/a.ts',
      '+++ b/b.ts',
      '@@ -1,2 +1,2 @@',
      '-old line',
      '+new line',
      ' context',
      '',
    ].join('\n')
    const files = parsePatch(renameWithEdit)
    expect(files[0]).toMatchObject({ path: 'b.ts', oldPath: 'a.ts', status: 'renamed' })
    expect(files[0]!.hunks).toHaveLength(1)
  })

  it('classifies binary, image, and symlink files', () => {
    const binary = [
      'diff --git a/data.bin b/data.bin',
      'new file mode 100644',
      'index 0000000..0000001',
      'Binary files /dev/null and b/data.bin differ',
      '',
    ].join('\n')
    const image = [
      'diff --git a/logo.png b/logo.png',
      'index 1111111..2222222 100644',
      'Binary files a/logo.png and b/logo.png differ',
      '',
    ].join('\n')
    const symlink = [
      'diff --git a/link b/link',
      'new file mode 120000',
      'index 0000000..0000001',
      '--- /dev/null',
      '+++ b/link',
      '@@ -0,0 +1 @@',
      '+target/path',
      '\\ No newline at end of file',
      '',
    ].join('\n')
    const files = parsePatch(binary + image + symlink)
    expect(files[0]).toMatchObject({ path: 'data.bin', kind: 'binary', hunks: [] })
    expect(files[1]).toMatchObject({ path: 'logo.png', kind: 'image', hunks: [] })
    expect(files[2]).toMatchObject({ path: 'link', kind: 'symlink', status: 'added' })
  })

  it('returns [] for an empty patch', () => {
    expect(parsePatch('')).toEqual([])
    expect(parsePatch('\n')).toEqual([])
  })
})

describe('unified diff format', () => {
  it('reads the scope git prints after the position', () => {
    const files = parsePatch(
      patch('src/a.ts', ['@@ -77,3 +75,3 @@ function foo() {', ' a', '-x', '+y']),
    )
    expect(files[0]!.hunks[0]!.context).toBe('function foo() {')
  })

  it('leaves context unset when the header has no scope', () => {
    const files = parsePatch(patch('src/a.ts', HUNK_A))
    expect(files[0]!.hunks[0]!.context).toBeUndefined()
  })

  it('treats an omitted line count as 1 (`@@ -1 +1 @@`)', () => {
    const files = parsePatch(patch('src/a.ts', ['@@ -1 +1 @@', '-x', '+y']))
    expect(files[0]!.hunks[0]!.lines).toEqual([
      { kind: 'del', oldNo: 1, newNo: null, text: 'x' },
      { kind: 'add', oldNo: null, newNo: 1, text: 'y' },
    ])
  })

  it('does not read a `+++`/`---` line of file content as a path header', () => {
    const files = parsePatch(
      patch('doc.md', ['@@ -1,3 +1,3 @@', ' intro', '+++ nested bullet', '--- rule', ' tail']),
    )
    expect(files[0]!.path).toBe('doc.md')
    expect(files[0]!.hunks[0]!.lines).toEqual([
      { kind: 'context', oldNo: 1, newNo: 1, text: 'intro' },
      { kind: 'add', oldNo: null, newNo: 2, text: '++ nested bullet' },
      { kind: 'del', oldNo: 2, newNo: null, text: '-- rule' },
      { kind: 'context', oldNo: 3, newNo: 3, text: 'tail' },
    ])
  })

  it('keeps a blank context line, and drops the no-newline marker', () => {
    const files = parsePatch(
      patch('src/a.ts', ['@@ -1,3 +1,3 @@', ' a', '', '-x', '\\ No newline at end of file', '+y']),
    )
    expect(files[0]!.hunks[0]!.lines).toEqual([
      { kind: 'context', oldNo: 1, newNo: 1, text: 'a' },
      { kind: 'context', oldNo: 2, newNo: 2, text: '' },
      { kind: 'del', oldNo: 3, newNo: null, text: 'x' },
      { kind: 'add', oldNo: null, newNo: 3, text: 'y' },
    ])
  })

  it('ends a hunk at the next header even if the counts overrun', () => {
    const files = parsePatch(
      patch('src/a.ts', ['@@ -1,9 +1,9 @@', '-x', '+y', '@@ -30,1 +30,1 @@', '-p', '+q']),
    )
    expect(files[0]!.hunks).toHaveLength(2)
    expect(files[0]!.hunks[0]!.lines).toEqual([
      { kind: 'del', oldNo: 1, newNo: null, text: 'x' },
      { kind: 'add', oldNo: null, newNo: 1, text: 'y' },
    ])
    expect(files[0]!.hunks[1]!.lines).toEqual([
      { kind: 'del', oldNo: 30, newNo: null, text: 'p' },
      { kind: 'add', oldNo: null, newNo: 30, text: 'q' },
    ])
  })

  it('reads paths off tab-suffixed ---/+++ lines', () => {
    const files = parsePatch(
      [
        'diff --git a/src/a.ts b/src/a.ts',
        '--- a/src/a.ts\t2026-01-01 10:00:00',
        '+++ b/src/a.ts\t2026-01-02 10:00:00',
        '@@ -1 +1 @@',
        '-x',
        '+y',
        '',
      ].join('\n'),
    )
    expect(files[0]).toMatchObject({ path: 'src/a.ts', status: 'modified' })
  })

  it('handles a mode-only change with no hunks', () => {
    const files = parsePatch(
      ['diff --git a/s.sh b/s.sh', 'old mode 100644', 'new mode 100755', ''].join('\n'),
    )
    expect(files[0]).toMatchObject({ path: 's.sh', status: 'modified', hunks: [] })
  })
})
