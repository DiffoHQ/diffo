import type { Anchor, ReviewThread } from '../shared/review.js'
import type { DiffLine, FileChange, Hunk } from '../shared/types.js'

// Pure placement logic: which threads render where. Content-addressed hunk ids mean
// a thread can outlive its anchor — an edited hunk has a new id, so the thread falls
// back to its file, or to the changeset when the file is gone from the diff.

export interface ThreadPartition {
  byHunk: Map<string, ReviewThread[]>
  byFile: Map<string, ReviewThread[]>
  changeset: ReviewThread[]
}

export function partitionThreads(files: FileChange[], threads: ReviewThread[]): ThreadPartition {
  const hunkIds = new Set(files.flatMap((f) => f.hunks.map((h) => h.id)))
  const paths = new Set(files.map((f) => f.path))
  const byHunk = new Map<string, ReviewThread[]>()
  const byFile = new Map<string, ReviewThread[]>()
  const changeset: ReviewThread[] = []

  const push = <K>(map: Map<K, ReviewThread[]>, key: K, thread: ReviewThread) => {
    const list = map.get(key)
    if (list) list.push(thread)
    else map.set(key, [thread])
  }

  for (const thread of threads) {
    const anchor = thread.anchor
    if (anchor.kind === 'changeset') changeset.push(thread)
    else if (anchor.kind === 'file') {
      if (paths.has(anchor.path)) push(byFile, anchor.path, thread)
      else changeset.push(thread)
    } else if (hunkIds.has(anchor.hunkId)) push(byHunk, anchor.hunkId, thread)
    else {
      const rehomed = rehome(files, anchor)
      if (rehomed !== null) push(byHunk, rehomed, thread)
      else if (paths.has(anchor.path)) push(byFile, anchor.path, thread)
      else changeset.push(thread)
    }
  }
  return { byHunk, byFile, changeset }
}

/**
 * The hunk that now holds an orphaned anchor's line, or null if nothing does.
 *
 * A hunk id rotates the moment the agent edits the hunk — which is exactly when the
 * reviewer most wants to see their comment against the code, and exactly when the
 * thread used to be demoted to the top of the file card, a screen away from the line
 * it is about. The line number still points somewhere, so follow it: same side, same
 * number, in whichever hunk covers it now. The thread keeps its `code changed since
 * this comment` badge, so a re-homed card never pretends the lines under it are the
 * ones that were commented on.
 */
function rehome(files: FileChange[], anchor: Extract<Anchor, { kind: 'hunk' }>): string | null {
  const file = files.find((f) => f.path === anchor.path)
  if (!file) return null
  return file.hunks.find((h) => lineIndexForAnchor(h.lines, anchor) !== -1)?.id ?? null
}

export function threadsByFile(
  files: FileChange[],
  partition: ThreadPartition,
): Map<string, ReviewThread[]> {
  const map = new Map<string, ReviewThread[]>()
  for (const file of files) {
    const list = [...(partition.byFile.get(file.path) ?? [])]
    for (const hunk of file.hunks) list.push(...(partition.byHunk.get(hunk.id) ?? []))
    if (list.length > 0) map.set(file.path, list)
  }
  return map
}

/** Anchor for a comment on a rendered diff line. Typed as the hunk variant
 * specifically — a line anchor is always one, and callers need `line`. */
export function anchorForLine(
  hunkId: string,
  path: string,
  line: DiffLine,
): Extract<Anchor, { kind: 'hunk' }> | null {
  if (line.kind === 'del') {
    return line.oldNo === null
      ? null
      : { kind: 'hunk', hunkId, path, side: 'old', line: line.oldNo }
  }
  return line.newNo === null ? null : { kind: 'hunk', hunkId, path, side: 'new', line: line.newNo }
}

export function anchorForHunk(hunk: Hunk): Anchor | null {
  const line = hunk.lines.find((l) => l.kind !== 'context') ?? hunk.lines[0]
  return line ? anchorForLine(hunk.id, hunk.path, line) : null
}

/**
 * Anchor for a comment on a dragged run of rendered lines. The *first* line in the
 * run that carries a number picks the side — so a drag that starts on a deletion is
 * an old-side range, and everything else is new-side. Lines with no number on that
 * side (the other half of the diff, interleaved) don't break the range; they just
 * can't be its endpoints, so the range clamps inward to the nearest line that counts.
 * A range that clamps down to one line is a plain single-line anchor.
 */
export function anchorForRange(
  hunkId: string,
  path: string,
  lines: DiffLine[],
  from: number,
  to: number,
): Extract<Anchor, { kind: 'hunk' }> | null {
  const lo = Math.max(0, Math.min(from, to))
  const hi = Math.min(lines.length - 1, Math.max(from, to))
  let start: Extract<Anchor, { kind: 'hunk' }> | null = null
  for (let i = lo; i <= hi && !start; i++) start = anchorForLine(hunkId, path, lines[i]!)
  if (!start) return null
  const numberOn = (l: DiffLine) =>
    start!.side === 'old' ? (l.kind !== 'add' ? l.oldNo : null) : l.kind !== 'del' ? l.newNo : null
  let end = start.line
  for (let i = hi; i > lo; i--) {
    const n = numberOn(lines[i]!)
    if (n !== null) {
      end = n
      break
    }
  }
  return end > start.line ? { ...start, endLine: end } : start
}

function indexOfSideLine(lines: DiffLine[], side: 'old' | 'new', line: number): number {
  return lines.findIndex((l) =>
    side === 'old' ? l.kind !== 'add' && l.oldNo === line : l.kind !== 'del' && l.newNo === line,
  )
}

/** Index in `lines` after which a hunk-anchored thread renders; -1 when the anchored
 * line isn't in the rendered window (thread renders at hunk end). */
export function lineIndexForAnchor(
  lines: DiffLine[],
  anchor: Extract<Anchor, { kind: 'hunk' }>,
): number {
  return indexOfSideLine(lines, anchor.side, anchor.line)
}

/** Where the thread's card actually sits: under the *last* line of a range (so the
 * conversation reads below the code it is about), falling back to the start line
 * when the end has been edited away, then to -1 like a single-line anchor. */
export function placementIndexForAnchor(
  lines: DiffLine[],
  anchor: Extract<Anchor, { kind: 'hunk' }>,
): number {
  if (anchor.endLine !== undefined) {
    const end = indexOfSideLine(lines, anchor.side, anchor.endLine)
    if (end !== -1) return end
  }
  return lineIndexForAnchor(lines, anchor)
}

export function threadsByLine(
  lines: DiffLine[],
  threads: ReviewThread[],
): Map<number, ReviewThread[]> {
  const map = new Map<number, ReviewThread[]>()
  for (const thread of threads) {
    if (thread.anchor.kind !== 'hunk') continue
    const index = placementIndexForAnchor(lines, thread.anchor)
    const list = map.get(index)
    if (list) list.push(thread)
    else map.set(index, [thread])
  }
  return map
}

/** Rendered rows covered by some range-anchored thread — the quiet gutter bar that
 * says "this conversation is about more than one line". Single-line anchors don't
 * mark rows: their card already sits directly under the line. */
export function rangedRows(lines: DiffLine[], threads: ReviewThread[]): Set<number> {
  const rows = new Set<number>()
  for (const thread of threads) {
    const anchor = thread.anchor
    if (anchor.kind !== 'hunk' || anchor.endLine === undefined) continue
    const start = lineIndexForAnchor(lines, anchor)
    const end = placementIndexForAnchor(lines, anchor)
    if (start === -1 || end === -1) continue
    for (let i = Math.min(start, end); i <= Math.max(start, end); i++) rows.add(i)
  }
  return rows
}

/** The first rendered row of each range-anchored thread — where the gutter glyph
 * sits, the IDE-style "a conversation starts here" shape that survives every row
 * tint. Single-line anchors don't get one; their card is already adjacent. */
export function rangeStartRows(lines: DiffLine[], threads: ReviewThread[]): Set<number> {
  const rows = new Set<number>()
  for (const thread of threads) {
    const anchor = thread.anchor
    if (anchor.kind !== 'hunk' || anchor.endLine === undefined) continue
    const start = lineIndexForAnchor(lines, anchor)
    const end = placementIndexForAnchor(lines, anchor)
    if (start === -1 || end === -1) continue
    rows.add(Math.min(start, end))
  }
  return rows
}
