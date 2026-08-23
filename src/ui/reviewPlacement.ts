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

/** Index in `lines` after which a hunk-anchored thread renders; -1 when the anchored
 * line isn't in the rendered window (thread renders at hunk end). */
export function lineIndexForAnchor(
  lines: DiffLine[],
  anchor: Extract<Anchor, { kind: 'hunk' }>,
): number {
  return lines.findIndex((l) =>
    anchor.side === 'old'
      ? l.kind !== 'add' && l.oldNo === anchor.line
      : l.kind !== 'del' && l.newNo === anchor.line,
  )
}

export function threadsByLine(
  lines: DiffLine[],
  threads: ReviewThread[],
): Map<number, ReviewThread[]> {
  const map = new Map<number, ReviewThread[]>()
  for (const thread of threads) {
    if (thread.anchor.kind !== 'hunk') continue
    const index = lineIndexForAnchor(lines, thread.anchor)
    const list = map.get(index)
    if (list) list.push(thread)
    else map.set(index, [thread])
  }
  return map
}
