import type { Changeset } from '../shared/types.js'

export interface LiveDelta {
  freshHunkIds: ReadonlySet<string>
  changedViewedHunkIds: ReadonlySet<string>
}

export const EMPTY_DELTA: LiveDelta = {
  freshHunkIds: new Set(),
  changedViewedHunkIds: new Set(),
}

export function computeDelta(
  prev: Changeset | null,
  next: Changeset,
  viewed: ReadonlySet<string>,
): LiveDelta {
  if (!prev) return EMPTY_DELTA

  const prevAllIds = new Set<string>()
  const prevIdsByFile = new Map<string, Set<string>>()
  for (const file of prev.files) {
    const ids = new Set<string>()
    for (const hunk of file.hunks) {
      ids.add(hunk.id)
      prevAllIds.add(hunk.id)
    }
    prevIdsByFile.set(file.path, ids)
  }

  const freshHunkIds = new Set<string>()
  const changedViewedHunkIds = new Set<string>()
  for (const file of next.files) {
    const nextIds = new Set(file.hunks.map((h) => h.id))
    const prevIds = prevIdsByFile.get(file.path) ?? new Set<string>()
    const viewedVanished = [...prevIds].some((id) => viewed.has(id) && !nextIds.has(id))
    for (const hunk of file.hunks) {
      if (prevAllIds.has(hunk.id)) continue
      freshHunkIds.add(hunk.id)
      if (viewedVanished) changedViewedHunkIds.add(hunk.id)
    }
  }
  return { freshHunkIds, changedViewedHunkIds }
}
