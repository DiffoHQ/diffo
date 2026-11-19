import { plainRepo } from './plain.js'
import type { GraphRepo } from './repo.js'
import { RULES } from './rules.js'

/**
 * The repo of a change: the first one whose rule finds itself in the paths
 * of the changed files. A change of no known repo gets the plain repo.
 */
export function pickRepo(paths: readonly string[]): GraphRepo {
  return RULES.find((r) => r.detects(paths))?.repo ?? plainRepo
}

export { plainRepo }
