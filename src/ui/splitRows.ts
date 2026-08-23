import type { DiffLine } from '../shared/types.js'

/** One row of a side-by-side diff. `idx` points back into the hunk's original line
 * array so syntax tokens (computed per original line) still apply. */
export interface SplitRow {
  left: { line: DiffLine; idx: number } | null
  right: { line: DiffLine; idx: number } | null
}

/** Pair a unified hunk into split rows: context lines span both sides; a run of
 * deletions pairs row-by-row with the run of additions that follows it (git's unified
 * format always emits del-run then add-run for a replacement). */
export function toSplitRows(lines: DiffLine[]): SplitRow[] {
  const rows: SplitRow[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]!
    if (line.kind === 'context') {
      rows.push({ left: { line, idx: i }, right: { line, idx: i } })
      i++
      continue
    }
    const dels: { line: DiffLine; idx: number }[] = []
    const adds: { line: DiffLine; idx: number }[] = []
    while (i < lines.length && lines[i]!.kind === 'del') {
      dels.push({ line: lines[i]!, idx: i })
      i++
    }
    while (i < lines.length && lines[i]!.kind === 'add') {
      adds.push({ line: lines[i]!, idx: i })
      i++
    }
    const n = Math.max(dels.length, adds.length)
    for (let r = 0; r < n; r++) {
      rows.push({ left: dels[r] ?? null, right: adds[r] ?? null })
    }
  }
  return rows
}
