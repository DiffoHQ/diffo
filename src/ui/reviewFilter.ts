import { useCallback, useMemo, useState } from 'react'
import type { FileChange } from '../shared/types.js'

export function isTestFile(path: string): boolean {
  return /\.(test|spec)\.[^/]+$/.test(path) || /(^|\/)__tests__\//.test(path)
}

/** Above this many files, Hide reviewed starts on — a review this size needs it
 * before the reviewer knows to look for it, and one click either way is remembered
 * forever after. Hide tests never auto-arms: retiring a whole category of file
 * unread is the reviewer's call. */
export const AUTO_HIDE_ABOVE = 25

const KEY_REVIEWED = 'diffo:ui:hideReviewed'
const KEY_TESTS = 'diffo:ui:hideTests'

/** `'1'` / `'0'` once chosen; absent means never chosen, so a default may. */
function storedChoice(key: string): boolean | null {
  const raw = localStorage.getItem(key)
  return raw === '1' ? true : raw === '0' ? false : null
}

export interface FilterSplit {
  visible: FileChange[]
  hiddenTests: number
  hiddenReviewed: number
  hiddenUnchanged: number
  hiddenQuery: number
}

/**
 * What "finished" means once the reviewer is allowed to exclude things.
 *
 * Completion is measured against **scope** — what you asked to see — because
 * `Hide tests` hides files rather than reading them. The excluded files are named
 * instead of quietly counted as done. `Hide reviewed` is not a scope: those files
 * are read, which is why they left. The typed query is not a scope either — a word
 * in a search box is a look-around, and must never make a review count as finished.
 */
export interface ReviewScope {
  left: number
  total: number
  excludedTests: number
  excludedUnchanged: number
  excludedPaths: string[]
}

export function reviewScope(
  files: readonly FileChange[],
  opts: {
    hideTests: boolean
    onlyChanged: boolean
    changed: ReadonlySet<string>
    pinned: ReadonlySet<string>
    isDone: (file: FileChange) => boolean
  },
): ReviewScope {
  let left = 0
  let total = 0
  let excludedTests = 0
  let excludedUnchanged = 0
  const excludedPaths: string[] = []
  for (const file of files) {
    const done = opts.isDone(file)
    if (!opts.pinned.has(file.path)) {
      if (opts.onlyChanged && !opts.changed.has(file.path)) {
        if (!done) {
          excludedUnchanged++
          excludedPaths.push(file.path)
        }
        continue
      }
      if (opts.hideTests && isTestFile(file.path)) {
        if (!done) {
          excludedTests++
          excludedPaths.push(file.path)
        }
        continue
      }
    }
    total++
    if (!done) left++
  }
  return { left, total, excludedTests, excludedUnchanged, excludedPaths }
}

/**
 * Apply all the filters, counting what each one took.
 *
 * `pinned` wins over all of them, and that is the escape hatch: a rail click, a `J`
 * or a thread jump names a path here and it renders regardless of what is switched
 * on. A tick never pins — the filter keeps its word, and the file goes.
 *
 * The query is answered first: a typed word is the most deliberate narrowing on the
 * bar, so a file it drops is reported as "doesn't match", whatever else would also
 * have hidden it. Tests are counted before reviewed so a reviewed test file reports
 * as one hidden test rather than being claimed twice.
 */
export function splitFiles(
  files: readonly FileChange[],
  opts: {
    query: string
    hideReviewed: boolean
    hideTests: boolean
    onlyChanged: boolean
    changed: ReadonlySet<string>
    pinned: ReadonlySet<string>
    isDone: (file: FileChange) => boolean
  },
): FilterSplit {
  const visible: FileChange[] = []
  const q = opts.query.trim().toLowerCase()
  let hiddenTests = 0
  let hiddenReviewed = 0
  let hiddenUnchanged = 0
  let hiddenQuery = 0
  for (const file of files) {
    if (opts.pinned.has(file.path)) {
      visible.push(file)
      continue
    }
    if (q !== '' && !file.path.toLowerCase().includes(q)) {
      hiddenQuery++
      continue
    }
    // The narrowing is answered next, and wins over the hides: "only what came
    // back" is a scope rather than a hide, so everything outside it is out for
    // that reason.
    if (opts.onlyChanged && !opts.changed.has(file.path)) {
      hiddenUnchanged++
      continue
    }
    if (opts.hideTests && isTestFile(file.path)) {
      hiddenTests++
      continue
    }
    if (opts.hideReviewed && opts.isDone(file)) {
      hiddenReviewed++
      continue
    }
    visible.push(file)
  }
  return { visible, hiddenTests, hiddenReviewed, hiddenUnchanged, hiddenQuery }
}

export interface ReviewFilter {
  query: string
  setQuery: (q: string) => void
  hideReviewed: boolean
  hideTests: boolean
  setHideReviewed: (on: boolean) => void
  setHideTests: (on: boolean) => void
  onlyChanged: boolean
  setOnlyChanged: (on: boolean) => void
  files: FileChange[]
  hiddenTests: number
  hiddenReviewed: number
  hiddenUnchanged: number
  hiddenQuery: number
  testCount: number
  changedCount: number
  scope: ReviewScope
  pinned: ReadonlySet<string>
  pin: (path: string) => void
  unpin: (path: string) => void
  showAll: () => void
}

export function useReviewFilter(
  files: readonly FileChange[],
  isDone: (file: FileChange) => boolean,
  since: { on: boolean; changed: ReadonlySet<string>; set: (on: boolean) => void },
): ReviewFilter {
  // `null` until the reviewer decides, so the size-based default can apply on this
  // changeset and still lose to a click, permanently, on the next one.
  const [reviewedChoice, setReviewedChoice] = useState<boolean | null>(() =>
    storedChoice(KEY_REVIEWED),
  )
  const [testsChoice, setTestsChoice] = useState<boolean | null>(() => storedChoice(KEY_TESTS))
  const [pinned, setPinned] = useState<ReadonlySet<string>>(new Set())
  // The typed filter is one shared narrowing: the rail's box edits it and the pane
  // obeys it, so the tree is always a map of what the pane renders. Deliberately
  // transient — a word you typed for this look-around must not survive a reload
  // the way the switches do.
  const [query, setQueryState] = useState('')

  const setQuery = useCallback((q: string) => {
    setQueryState(q)
    // Stale pins would defeat a fresh narrowing — same reset the switches do.
    setPinned((prev) => (prev.size === 0 ? prev : new Set()))
  }, [])

  const hideReviewed = reviewedChoice ?? files.length > AUTO_HIDE_ABOVE
  const hideTests = testsChoice ?? false

  const setHideReviewed = useCallback((on: boolean) => {
    localStorage.setItem(KEY_REVIEWED, on ? '1' : '0')
    setReviewedChoice(on)
    setPinned(new Set())
  }, [])

  const setHideTests = useCallback((on: boolean) => {
    localStorage.setItem(KEY_TESTS, on ? '1' : '0')
    setTestsChoice(on)
  }, [])

  const pin = useCallback((path: string) => {
    setPinned((prev) => (prev.has(path) ? prev : new Set(prev).add(path)))
  }, [])

  const unpin = useCallback((path: string) => {
    setPinned((prev) => {
      if (!prev.has(path)) return prev
      const next = new Set(prev)
      next.delete(path)
      return next
    })
  }, [])

  const setSince = since.set
  const showAll = useCallback(() => {
    localStorage.setItem(KEY_REVIEWED, '0')
    localStorage.setItem(KEY_TESTS, '0')
    setReviewedChoice(false)
    setTestsChoice(false)
    setPinned(new Set())
    setQueryState('')
    setSince(false)
  }, [setSince])

  const split = useMemo(
    () =>
      splitFiles(files, {
        query,
        hideReviewed,
        hideTests,
        onlyChanged: since.on,
        changed: since.changed,
        pinned,
        isDone,
      }),
    [files, query, hideReviewed, hideTests, since.on, since.changed, pinned, isDone],
  )

  const testCount = useMemo(() => files.filter((f) => isTestFile(f.path)).length, [files])

  const scope = useMemo(
    () =>
      reviewScope(files, {
        hideTests,
        onlyChanged: since.on,
        changed: since.changed,
        pinned,
        isDone,
      }),
    [files, hideTests, since.on, since.changed, pinned, isDone],
  )

  return {
    query,
    setQuery,
    hideReviewed,
    hideTests,
    setHideReviewed,
    setHideTests,
    onlyChanged: since.on,
    setOnlyChanged: setSince,
    files: split.visible,
    hiddenTests: split.hiddenTests,
    hiddenReviewed: split.hiddenReviewed,
    hiddenUnchanged: split.hiddenUnchanged,
    hiddenQuery: split.hiddenQuery,
    testCount,
    changedCount: since.changed.size,
    scope,
    pinned,
    pin,
    unpin,
    showAll,
  }
}
