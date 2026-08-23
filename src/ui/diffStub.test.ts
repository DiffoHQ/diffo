import { describe, expect, it } from 'vitest'
import type { DiffLine, FileChange } from '../shared/types.js'
import { changedLineCount, LARGE_DIFF_LINES, stubReason } from './diffStub.js'

function fileWith(path: string, changed: number, context = 3): FileChange {
  const lines: DiffLine[] = [
    ...Array.from(
      { length: context },
      (_, i): DiffLine => ({ kind: 'context', oldNo: i + 1, newNo: i + 1, text: 'ctx' }),
    ),
    ...Array.from(
      { length: changed },
      (_, i): DiffLine => ({ kind: 'add', oldNo: null, newNo: context + i + 1, text: `new ${i}` }),
    ),
  ]
  return {
    path,
    oldPath: null,
    status: 'modified',
    kind: 'text',
    staged: false,
    hunks: [{ id: 'h', path, oldStart: 1, newStart: 1, lines }],
  }
}

describe('stubReason', () => {
  it('counts changed lines only — context is free', () => {
    expect(changedLineCount(fileWith('a.ts', 10, 50))).toBe(10)
  })

  it('stubs a file past the changed-line threshold, not at it', () => {
    expect(stubReason(fileWith('a.ts', LARGE_DIFF_LINES))).toBeNull()
    expect(stubReason(fileWith('a.ts', LARGE_DIFF_LINES + 1))).toBe('large')
  })

  it('always stubs lockfiles and minified bundles, however small the diff', () => {
    for (const path of [
      'pnpm-lock.yaml',
      'nested/dir/package-lock.json',
      'yarn.lock',
      'Cargo.lock',
      'vendor/jquery.min.js',
      'dist/app.js.map',
      'src/__snapshots__/thing.test.ts.snap',
    ]) {
      expect(stubReason(fileWith(path, 1)), path).toBe('generated')
    }
  })

  it('does not confuse look-alikes for generated files', () => {
    expect(stubReason(fileWith('src/locks/yarn.lock.ts', 1))).toBeNull()
    expect(stubReason(fileWith('docs/min.js.md', 1))).toBeNull()
  })

  it('leaves hunkless files (binary, images, pure renames) to their own stubs', () => {
    const binary = { ...fileWith('data.bin', 0), kind: 'binary' as const, hunks: [] }
    expect(stubReason(binary)).toBeNull()
  })
})
