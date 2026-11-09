import { useCallback, useEffect, useMemo, useState } from 'react'
import type { Changeset, Hunk } from '../shared/types.js'
import { applyMark, expandMarks, fileMarks, isFileViewed } from './fileMarks.js'
import { legacyStorageKey, loadViewed, saveViewed, storageKey } from './viewedStore.js'

export interface ViewedState {
  /** Hunk, line and file marks, each grain implied by the others (`expandMarks`). */
  viewed: ReadonlySet<string>
  /** The persisted marks have been read from storage. Until this flips, `viewed` is
   * an empty placeholder — anything derived from it must wait, or it bakes in the
   * wrong answer. */
  loaded: boolean
  /** Mark a whole file viewed, or clear it. Storage stays hunk-keyed so an edited
   * hunk rotates its id and the file honestly stops being fully-viewed; a file with
   * no hunks marks through the synthetic key in `fileMarks`. */
  toggleFile: (path: string) => void
  markFiles: (paths: readonly string[]) => void
  clearFiles: (paths: readonly string[]) => void
  /** Mark or clear raw marks — a commit's files, whose hunks need not be in the
   * cumulative diff, or a layer's highlighted lines. A hunk the two share is one
   * mark, read in both. */
  setMarks: (marks: readonly string[], on: boolean) => void
  progress: { viewed: number; total: number }
  fileProgress: { viewed: number; total: number }
}

export function useViewed(changeset: Changeset | undefined): ViewedState {
  const key = changeset ? storageKey(changeset) : null
  // The pre-fix bucket, read once if the current one is empty. Never written, so the
  // two can't diverge.
  const legacyKey = changeset ? legacyStorageKey(changeset) : null
  const [stored, setStored] = useState<ReadonlySet<string>>(new Set())
  const [loaded, setLoaded] = useState(false)
  const files = changeset?.files
  const viewed = useMemo(() => expandMarks(stored, files ?? []), [stored, files])
  const hunks = useMemo(
    () => new Map<string, Hunk>((files ?? []).flatMap((f) => f.hunks.map((h) => [h.id, h]))),
    [files],
  )

  useEffect(() => {
    if (!key) return
    const marks = loadViewed(key)
    if (marks.size === 0 && legacyKey !== null && legacyKey !== key) {
      const legacy = loadViewed(legacyKey)
      // Carry it forward under the right key rather than reading the old one forever;
      // the next save would strand it otherwise.
      if (legacy.size > 0) {
        saveViewed(key, legacy)
        setStored(legacy)
        setLoaded(true)
        return
      }
    }
    setStored(marks)
    setLoaded(true)
  }, [key, legacyKey])

  const toggleFile = useCallback(
    (path: string) => {
      const file = changeset?.files.find((f) => f.path === path)
      if (!file) return
      setStored((prev) => {
        const next = new Set(prev)
        const marks = fileMarks(file)
        const complete = isFileViewed(file, expandMarks(prev, [file]))
        for (const mark of marks) applyMark(next, mark, !complete, hunks)
        if (key) saveViewed(key, next)
        return next
      })
    },
    [changeset, key, hunks],
  )

  const setFiles = useCallback(
    (paths: readonly string[], mark: boolean) => {
      const wanted = new Set(paths)
      setStored((prev) => {
        const next = new Set(prev)
        for (const file of changeset?.files ?? []) {
          if (!wanted.has(file.path)) continue
          for (const id of fileMarks(file)) applyMark(next, id, mark, hunks)
        }
        if (key) saveViewed(key, next)
        return next
      })
    },
    [changeset, key, hunks],
  )

  const setMarks = useCallback(
    (marks: readonly string[], on: boolean) => {
      setStored((prev) => {
        const next = new Set(prev)
        for (const mark of marks) applyMark(next, mark, on, hunks)
        if (key) saveViewed(key, next)
        return next
      })
    },
    [key, hunks],
  )

  const markFiles = useCallback((paths: readonly string[]) => setFiles(paths, true), [setFiles])
  const clearFiles = useCallback((paths: readonly string[]) => setFiles(paths, false), [setFiles])

  const progress = useMemo(() => {
    let total = 0
    let seen = 0
    for (const file of changeset?.files ?? []) {
      for (const hunk of file.hunks) {
        total++
        if (viewed.has(hunk.id)) seen++
      }
    }
    return { viewed: seen, total }
  }, [changeset, viewed])

  // A file counts as read only when every mark it carries does — its hunks, or the
  // single synthetic mark a hunkless file stands on. Every file is in the
  // denominator; a rename you haven't looked at is still one you haven't looked at.
  const fileProgress = useMemo(() => {
    let total = 0
    let seen = 0
    for (const file of changeset?.files ?? []) {
      total++
      if (isFileViewed(file, viewed)) seen++
    }
    return { viewed: seen, total }
  }, [changeset, viewed])

  return {
    viewed,
    loaded,
    toggleFile,
    markFiles,
    clearFiles,
    setMarks,
    progress,
    fileProgress,
  }
}
