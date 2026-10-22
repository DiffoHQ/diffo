import type { Anchor } from './review.js'
import type { DiffLine, FileChange, Hunk } from './types.js'

export type HunkAnchor = Extract<Anchor, { kind: 'hunk' }>

function findHunk(files: readonly FileChange[], id: string): Hunk | undefined {
  for (const file of files) {
    const hunk = file.hunks.find((h) => h.id === id)
    if (hunk) return hunk
  }
  return undefined
}

function indexOfSideLine(lines: readonly DiffLine[], side: 'old' | 'new', line: number): number {
  return lines.findIndex((l) =>
    side === 'old' ? l.kind !== 'add' && l.oldNo === line : l.kind !== 'del' && l.newNo === line,
  )
}

/**
 * The same hunk, numbered as another diff numbers it. A hunk id is
 * content-addressed — the path and the changed lines, not where they sit — so
 * the hunk a commit introduced and the one the full diff still shows are one
 * id with two sets of line numbers whenever a later commit grew the file
 * above it. A thread anchored in one numbering is renamed into the other by
 * position in the hunk: line k of the hunk here is line k of the hunk there.
 *
 * Unchanged when either diff lacks the hunk, or when the two copies differ in
 * shape (a context line more or less): then the numbers cannot be trusted and
 * the anchor is left as it was, for placement to re-home by line as usual.
 */
export function translateHunkAnchor(
  anchor: HunkAnchor,
  from: readonly FileChange[],
  to: readonly FileChange[],
): HunkAnchor {
  const src = findHunk(from, anchor.hunkId)
  const dst = findHunk(to, anchor.hunkId)
  if (!src || !dst || src === dst) return anchor
  if (src.lines.length !== dst.lines.length) return anchor
  if (src.lines.some((l, i) => l.kind !== dst.lines[i]!.kind)) return anchor
  const rename = (n: number): number | null => {
    const i = indexOfSideLine(src.lines, anchor.side, n)
    if (i === -1) return null
    const l = dst.lines[i]!
    return anchor.side === 'old' ? l.oldNo : l.newNo
  }
  const line = rename(anchor.line)
  if (line === null) return anchor
  if (anchor.endLine === undefined) return line === anchor.line ? anchor : { ...anchor, line }
  const endLine = rename(anchor.endLine)
  return endLine === null ? { ...anchor, line } : { ...anchor, line, endLine }
}
