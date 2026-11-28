import { describe, expect, it } from 'vitest'
import { capPatchText, isOutputOverflow, TOO_LARGE_MARKER } from './git.js'
import { parsePatch } from './parse.js'

const MB = 1024 * 1024

function modified(path: string, body: string[]): string {
  return [
    `diff --git a/${path} b/${path}`,
    'index 1111111..2222222 100644',
    `--- a/${path}`,
    `+++ b/${path}`,
    `@@ -1,${body.length} +1,${body.length} @@`,
    ...body,
  ].join('\n')
}

function added(path: string, lines: number, width: number): string {
  const line = `+${'x'.repeat(width)}`
  return [
    `diff --git a/${path} b/${path}`,
    'new file mode 100644',
    'index 0000000..3333333',
    '--- /dev/null',
    `+++ b/${path}`,
    `@@ -0,0 +1,${lines} @@`,
    ...Array.from({ length: lines }, () => line),
  ].join('\n')
}

describe('a diff too big to hold', () => {
  it('keeps the files that fit and leaves a note where one does not', () => {
    const small = modified('src/a.ts', ['-old', '+new'])
    const huge = added('vendor/bundle.js', 30_000, 60) // ~1.8MB, over the per-file cap
    const patch = [small, huge, modified('src/b.ts', ['-1', '+2'])].join('\n')
    const capped = capPatchText(patch)
    expect(capped).toContain(small)
    expect(capped).toContain(`+++ b/vendor/bundle.js\n${TOO_LARGE_MARKER}`)
    expect(capped.length).toBeLessThan(MB)

    const files = parsePatch(capped)
    expect(files.map((f) => f.path)).toEqual(['src/a.ts', 'vendor/bundle.js', 'src/b.ts'])
    const big = files[1]!
    expect(big).toMatchObject({ status: 'added', kind: 'binary', tooLarge: true, hunks: [] })
    expect(files[0]!.tooLarge).toBeUndefined()
    expect(files[2]!.hunks).toHaveLength(1)
  })

  it('stops keeping bodies once the total is reached', () => {
    // 40 files of ~0.9MB: each fits alone, all together are past the total.
    const patch = Array.from({ length: 40 }, (_, i) => added(`gen/${i}.txt`, 15_000, 60)).join('\n')
    const files = parsePatch(capPatchText(patch))
    expect(files).toHaveLength(40)
    expect(files[0]!.tooLarge).toBeUndefined()
    expect(files.at(-1)!.tooLarge).toBe(true)
  })

  it('passes a small patch through untouched', () => {
    const patch = modified('a.ts', ['-a', '+b', ' c'])
    expect(capPatchText(patch)).toBe(patch)
  })

  it('knows an overflow from any other failure', () => {
    expect(
      isOutputOverflow(Object.assign(new Error('spawnSync git ENOBUFS'), { code: 'ENOBUFS' })),
    ).toBe(true)
    expect(
      isOutputOverflow(
        Object.assign(new Error('x'), { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' }),
      ),
    ).toBe(true)
    expect(isOutputOverflow(new Error('stdout maxBuffer length exceeded'))).toBe(true)
    expect(isOutputOverflow(new Error('Command failed: git diff'))).toBe(false)
  })
})
