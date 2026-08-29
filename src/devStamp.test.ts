import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { computeSrcStamp } from './devStamp.js'

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const fn of cleanups.splice(0)) fn()
})

function checkout(): string {
  const root = mkdtempSync(join(tmpdir(), 'diffo-stamp-'))
  cleanups.push(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(join(root, 'src', 'server'), { recursive: true })
  writeFileSync(join(root, 'src', 'cli.ts'), 'export const a = 1\n')
  writeFileSync(join(root, 'src', 'server', 'index.ts'), 'export const b = 2\n')
  writeFileSync(join(root, 'index.html'), '<html></html>\n')
  return root
}

describe('computeSrcStamp', () => {
  it('is deterministic for the same tree', () => {
    const root = checkout()
    expect(computeSrcStamp(root)).toBe(computeSrcStamp(root))
  })

  it('changes when a source file changes', () => {
    const root = checkout()
    const before = computeSrcStamp(root)
    writeFileSync(join(root, 'src', 'server', 'index.ts'), 'export const b = 3\n')
    expect(computeSrcStamp(root)).not.toBe(before)
  })

  it('changes when a source file is added', () => {
    const root = checkout()
    const before = computeSrcStamp(root)
    writeFileSync(join(root, 'src', 'new.ts'), 'export const c = 1\n')
    expect(computeSrcStamp(root)).not.toBe(before)
  })

  it('changes when index.html changes — the client bundle is built from it', () => {
    const root = checkout()
    const before = computeSrcStamp(root)
    writeFileSync(join(root, 'index.html'), '<html><body/></html>\n')
    expect(computeSrcStamp(root)).not.toBe(before)
  })

  it('ignores test files — they never run inside the server', () => {
    const root = checkout()
    const before = computeSrcStamp(root)
    writeFileSync(join(root, 'src', 'cli.test.ts'), 'it.todo("x")\n')
    writeFileSync(join(root, 'src', 'ui.test.tsx'), 'it.todo("y")\n')
    expect(computeSrcStamp(root)).toBe(before)
  })

  it('survives a checkout with no index.html', () => {
    const root = checkout()
    rmSync(join(root, 'index.html'))
    expect(computeSrcStamp(root)).toMatch(/^[0-9a-f]{16}$/)
  })
})
