import { useCallback, useEffect, useMemo, useState } from 'react'
import type { Changeset } from '../shared/types.js'
import { fileMarks, isFileViewed } from './fileMarks.js'
import { legacyStorageKey, loadViewed, saveViewed, storageKey } from './viewedStore.js'

export interface ViewedState {
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
  progress: { viewed: number; total: number }
  fileProgress: { viewed: number; total: number }
}

export function useViewed(changeset: Changeset | undefined): ViewedState {
  const key = changeset ? storageKey(changeset) : null
  // The pre-fix bucket, read once if the current one is empty. Never written, so the
  // two can't diverge.
  const legacyKey = changeset ? legacyStorageKey(changeset) : null
  const [viewed, setViewed] = useState<ReadonlySet<string>>(new Set())
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    if (!key) return
    const marks = loadViewed(key)
    if (marks.size === 0 && legacyKey !== null && legacyKey !== key) {
      const legacy = loadViewed(legacyKey)
      // Carry it forward under the right key rather than reading the old one forever;
      // the next save would strand it otherwise.
      if (legacy.size > 0) {
        saveViewed(key, legacy)
        setViewed(legacy)
        setLoaded(true)
        return
      }
    }
    setViewed(marks)
    setLoaded(true)
  }, [key, legacyKey])

  const toggleFile = useCallback(
    (path: string) => {
      const file = changeset?.files.find((f) => f.path === path)
      if (!file) return
      setViewed((prev) => {
        const next = new Set(prev)
        const marks = fileMarks(file)
        const complete = marks.every((m) => next.has(m))
        for (const mark of marks) {
          if (complete) next.delete(mark)
          else next.add(mark)
        }
        if (key) saveViewed(key, next)
        return next
      })
    },
    [changeset, key],
  )

  const setFiles = useCallback(
    (paths: readonly string[], mark: boolean) => {
      const wanted = new Set(paths)
      setViewed((prev) => {
        const next = new Set(prev)
        for (const file of changeset?.files ?? []) {
          if (!wanted.has(file.path)) continue
          for (const id of fileMarks(file)) {
            if (mark) next.add(id)
            else next.delete(id)
          }
        }
        if (key) saveViewed(key, next)
        return next
      })
    },
    [changeset, key],
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
    progress,
    fileProgress,
  }
}
