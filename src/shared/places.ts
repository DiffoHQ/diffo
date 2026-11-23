import type { DecisionAt } from './review.js'

/** A place in the repo, as the agent writes it: a path, with or without
 * head lines. Layers and graphs read it in one way. */

const REPO_PATH = /^[^\0]+$/

/**
 * Paths are relative to the repo root: no leading slash, no `..` segment, no
 * Windows drive. Unknown paths are fine — the file may land later — but a path
 * that could never name a file in this repo is a mistake worth naming now.
 */
export function badPath(path: string): string | null {
  if (path === '' || !REPO_PATH.test(path)) return 'is empty'
  if (path.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(path))
    return 'is absolute; use a repo-relative path'
  if (path.split('/').some((seg) => seg === '..')) return 'escapes the repo with `..`'
  return null
}

/**
 * Where a decision points: `path`, `path:line` or `path:from-to`, the same
 * spelling a file reference in a summary uses. Lines are head-side and
 * 1-based; a range is normalised so `from` never exceeds `to`.
 */
export function parseDecisionAt(raw: string): DecisionAt | string {
  const m = /^(.*?)(?::(\d+)(?:-(\d+))?)?$/.exec(raw.trim())
  const path = m?.[1] ?? ''
  const why = badPath(path)
  if (why) return `"at" path "${raw}" ${why}`
  if (m?.[2] === undefined) return { path }
  const a = Number.parseInt(m[2], 10)
  const b = m[3] === undefined ? a : Number.parseInt(m[3], 10)
  if (a < 1 || b < 1) return `"at" line in "${raw}" must be 1 or more`
  const [line, endLine] = a <= b ? [a, b] : [b, a]
  return endLine === line ? { path, line } : { path, line, endLine }
}
