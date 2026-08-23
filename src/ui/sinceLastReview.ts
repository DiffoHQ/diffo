import type { LastFinish } from '../shared/review.js'
import type { Changeset, FileChange } from '../shared/types.js'

/**
 * What the agent moved since you last hit Finish and you have not caught up on —
 * the half the reviewer cannot see for themselves. Hunk ids are content-addressed,
 * so the last finish's ids are a complete record of what existed when you sent, and
 * anything outside that set is new work. No timestamp and no cooperation from the
 * agent needed.
 *
 * The viewed marks are part of the answer, not a separate one: reading a hunk the
 * agent moved settles it, so the round drains as you work through it and the "only
 * since review" lens switches itself off when you are caught up. Without that the
 * only way out of the round is another Finish — another prompt in the agent's
 * queue, for a round you had already read.
 */
export interface SinceLastReview {
  changedHunkIds: ReadonlySet<string>
  changedFiles: string[]
  changed: ReadonlySet<string>
}

export const NOTHING_SINCE: SinceLastReview = {
  changedHunkIds: new Set(),
  changedFiles: [],
  changed: new Set(),
}

const NOTHING_VIEWED: ReadonlySet<string> = new Set()

/** Files with no hunks (pure renames, binaries) can't be read, so they can't be
 * owed — the same cut `fileProgress` makes. */
const readable = (file: FileChange) => file.hunks.length > 0

export function computeSinceLastReview(
  changeset: Changeset | undefined,
  lastFinish: LastFinish | null | undefined,
  viewed: ReadonlySet<string> = NOTHING_VIEWED,
): SinceLastReview {
  if (!changeset || !lastFinish) return NOTHING_SINCE
  const baseline = new Set(lastFinish.hunkIds)
  const changedHunkIds = new Set<string>()
  const changedFiles: string[] = []
  for (const file of changeset.files) {
    if (!readable(file)) continue
    const owed = file.hunks.filter((h) => !baseline.has(h.id) && !viewed.has(h.id))
    if (owed.length === 0) continue
    for (const hunk of owed) changedHunkIds.add(hunk.id)
    changedFiles.push(file.path)
  }
  return { changedHunkIds, changedFiles, changed: new Set(changedFiles) }
}
