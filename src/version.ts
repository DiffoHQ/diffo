import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * This build's version, read from our own package.json. The CLI and the server both
 * report it, and the CLI compares the two: a running server from another build gets
 * replaced, not reused.
 *
 * The walk-up exists because this module sits at a different depth in dev (src/) and
 * in the bundle (dist/); the name check keeps a stray package.json out of it.
 */
export const VERSION: string = (() => {
  let dir = dirname(fileURLToPath(import.meta.url))
  for (let depth = 0; depth < 3; depth++) {
    dir = resolve(dir, '..')
    try {
      const pkg = JSON.parse(readFileSync(resolve(dir, 'package.json'), 'utf-8')) as {
        name?: string
        version?: string
      }
      if (pkg.name === '@diffohq/diffo' && typeof pkg.version === 'string') return pkg.version
    } catch {
      // keep climbing
    }
  }
  return '0.0.0'
})()
