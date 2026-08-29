import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { CHECKOUT_ROOT, IS_DEV } from './server/prompt.js'

/**
 * A fingerprint of the dev checkout's source. The dev CLI runs `src/` straight
 * through tsx, so "which build is this?" isn't answered by the package version —
 * every edit is a new build with the same version string. The stamp is what
 * changes instead: the server reports the stamp of the source it loaded, the
 * next `diffo` open compares it to the source on disk, and a mismatch retires
 * the server exactly like a version bump would.
 *
 * Tests are skipped — they never run inside the server — and `index.html` is
 * included because the client bundle is built from it.
 */
export function computeSrcStamp(checkoutRoot: string): string {
  const hash = createHash('sha256')
  const file = (path: string, name: string) => {
    hash.update(name)
    hash.update('\0')
    hash.update(readFileSync(path))
    hash.update('\0')
  }
  const walk = (dir: string, prefix: string) => {
    const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )
    for (const entry of entries) {
      if (entry.name.endsWith('.test.ts') || entry.name.endsWith('.test.tsx')) continue
      const path = join(dir, entry.name)
      const name = `${prefix}${entry.name}`
      if (entry.isDirectory()) walk(path, `${name}/`)
      else if (entry.isFile()) file(path, name)
    }
  }
  walk(join(checkoutRoot, 'src'), 'src/')
  try {
    file(join(checkoutRoot, 'index.html'), 'index.html')
  } catch {
    // no client entry in this checkout — the src tree alone is the stamp
  }
  return hash.digest('hex').slice(0, 16)
}

/**
 * This process's stamp, captured at import — for the server that means the
 * source it actually loaded, not whatever is on disk by the time someone asks.
 * Null outside dev (a published build has no `src/` to stamp, and its version
 * string already does this job).
 */
export const SRC_STAMP: string | null = (() => {
  if (!IS_DEV) return null
  try {
    return computeSrcStamp(CHECKOUT_ROOT)
  } catch {
    return null
  }
})()
