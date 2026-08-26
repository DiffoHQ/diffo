import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { VERSION } from './version.js'

describe('VERSION', () => {
  // The walk-up matches package.json by name, so a package rename silently
  // drops every build to the 0.0.0 fallback — which the CLI reads as "same
  // build as any other", so stale servers stop being replaced. 0.0.1 and
  // 0.0.2 shipped that way.
  it('reports the real package version, not the fallback', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf-8')) as {
      version: string
    }
    expect(VERSION).toBe(pkg.version)
  })
})
