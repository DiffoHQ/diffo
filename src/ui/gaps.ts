import type { DiffLine, FileChange, Hunk } from '../shared/types.js'

export const EXPAND_STEP = 20

/**
 * A run of unchanged lines the diff hides: above the first hunk, between two hunks,
 * or after the last one. Coordinates are head-side; every line's old number differs
 * by the same `offset`, because nothing inside a gap changed.
 */
export interface Gap {
  /** Keyed by the neighbouring hunk ids, so editing either neighbour retires the
   * gap — and any expansion state stored under its key — with it. */
  key: string
  /** Index of the hunk just above / below; null at the file top / tail. */
  above: number | null
  below: number | null
  /** First and last hidden head-side line numbers, inclusive. */
  startNewNo: number
  endNewNo: number
  /** newNo − oldNo for every line in the gap. */
  offset: number
}

/** How much of a gap the reviewer has opened: `fromTop` lines eaten downward from
 * its top edge (glued below the hunk above), `fromBottom` upward from its bottom
 * edge (glued above the hunk below). */
export interface GapExpansion {
  fromTop: number
  fromBottom: number
}

export const NO_EXPANSION: GapExpansion = { fromTop: 0, fromBottom: 0 }

function newCount(hunk: Hunk): number {
  return hunk.lines.filter((l) => l.kind !== 'del').length
}

function oldCount(hunk: Hunk): number {
  return hunk.lines.filter((l) => l.kind !== 'add').length
}

// git prints start = the line *before* the hunk when that side has zero lines.
function effNewStart(hunk: Hunk): number {
  return newCount(hunk) === 0 ? hunk.newStart + 1 : hunk.newStart
}

function effOldStart(hunk: Hunk): number {
  return oldCount(hunk) === 0 ? hunk.oldStart + 1 : hunk.oldStart
}

function firstNewNo(hunk: Hunk): number {
  return effNewStart(hunk)
}

function lastNewNo(hunk: Hunk): number {
  return effNewStart(hunk) + newCount(hunk) - 1
}

/** Offset of the unchanged region just above the hunk. */
function startOffset(hunk: Hunk): number {
  return effNewStart(hunk) - effOldStart(hunk)
}

/** Offset of the unchanged region just below the hunk. */
function endOffset(hunk: Hunk): number {
  return effNewStart(hunk) + newCount(hunk) - (effOldStart(hunk) + oldCount(hunk))
}

/** Every hidden region of a file, in reading order. The tail gap exists only when
 * the server could count the head file's lines (`newLineCount`). */
export function fileGaps(file: FileChange): Gap[] {
  const hunks = file.hunks
  if (hunks.length === 0) return []
  const gaps: Gap[] = []
  const first = hunks[0]!
  if (firstNewNo(first) > 1) {
    gaps.push({
      key: `top:${first.id}`,
      above: null,
      below: 0,
      startNewNo: 1,
      endNewNo: firstNewNo(first) - 1,
      offset: startOffset(first),
    })
  }
  for (let i = 1; i < hunks.length; i++) {
    const a = hunks[i - 1]!
    const b = hunks[i]!
    const start = lastNewNo(a) + 1
    const end = firstNewNo(b) - 1
    if (end >= start) {
      gaps.push({
        key: `${a.id}:${b.id}`,
        above: i - 1,
        below: i,
        startNewNo: start,
        endNewNo: end,
        offset: startOffset(b),
      })
    }
  }
  const last = hunks[hunks.length - 1]!
  const total = file.newLineCount
  if (typeof total === 'number' && total > lastNewNo(last)) {
    gaps.push({
      key: `${last.id}:tail`,
      above: hunks.length - 1,
      below: null,
      startNewNo: lastNewNo(last) + 1,
      endNewNo: total,
      offset: endOffset(last),
    })
  }
  return gaps
}

export function gapSize(gap: Gap): number {
  return gap.endNewNo - gap.startNewNo + 1
}

export function gapRemaining(gap: Gap, exp: GapExpansion): number {
  return Math.max(0, gapSize(gap) - exp.fromTop - exp.fromBottom)
}

/** Context rows for a head-side line range inside a gap. Clamps to what the fetched
 * file actually has, so a live edit degrades to fewer lines, never to wrong ones. */
function gapSlice(headLines: string[], gap: Gap, fromNewNo: number, toNewNo: number): DiffLine[] {
  const lines: DiffLine[] = []
  const start = Math.max(gap.startNewNo, fromNewNo)
  const end = Math.min(gap.endNewNo, toNewNo, headLines.length)
  for (let newNo = start; newNo <= end; newNo++) {
    const text = headLines[newNo - 1]
    if (text === undefined) break
    lines.push({ kind: 'context', oldNo: newNo - gap.offset, newNo, text })
  }
  return lines
}

/** What an expansion makes visible: lines glued below the hunk above (`top`), lines
 * glued above the hunk below (`bottom`), and whether the gap is fully open. A merged
 * gap puts everything on whichever neighbour exists, so the run stays contiguous. */
export function materializeGap(
  headLines: string[],
  gap: Gap,
  exp: GapExpansion,
): { top: DiffLine[]; bottom: DiffLine[]; merged: boolean } {
  if (gapRemaining(gap, exp) === 0) {
    const all = gapSlice(headLines, gap, gap.startNewNo, gap.endNewNo)
    return gap.below !== null
      ? { top: [], bottom: all, merged: true }
      : { top: all, bottom: [], merged: true }
  }
  const top =
    exp.fromTop > 0
      ? gapSlice(headLines, gap, gap.startNewNo, gap.startNewNo + exp.fromTop - 1)
      : []
  const bottom =
    exp.fromBottom > 0
      ? gapSlice(headLines, gap, gap.endNewNo - exp.fromBottom + 1, gap.endNewNo)
      : []
  return { top, bottom, merged: false }
}
