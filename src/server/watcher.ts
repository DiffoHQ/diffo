import { type FSWatcher, watch } from 'node:fs'

const DEBOUNCE_MS = 300

const MAX_COOLDOWN_MS = 5_000

const GIT_STATE_FILES = new Set(['HEAD', 'index', 'packed-refs', 'logs/HEAD'])

/**
 * Which relative paths can change the diff. Watching the `.git` directory rather
 * than those four files is deliberate: git replaces HEAD and index by lockfile
 * rename, so a watch pinned to the file follows the old inode and goes deaf.
 *
 * Everything else passes, gitignored build output included — the cooldown below
 * bounds what a build storm costs, and the store's hash dedup keeps it correct.
 */
export function affectsDiff(rel: string): boolean {
  // Native recursive watch reports POSIX-ish separators on macOS and `\\` on Windows.
  const parts = rel.split(/[\\/]/)
  if (parts.includes('node_modules')) return false
  if (parts[0] !== '.git') return true
  return GIT_STATE_FILES.has(parts.slice(1).join('/'))
}

/**
 * Watch the repo for anything that can change the diff — working-tree writes, plus
 * the git state files behind commits, branch switches and staging. Events are
 * debounced into one `onChange` per burst.
 *
 * **One** watcher for the whole tree, via the platform's recursive watch: a
 * per-directory walk over a 17,639-directory monorepo opened ~16.5k descriptors and
 * hit `EMFILE`, leaving the server bound to its port and unable to accept a
 * connection. Recursive watch costs one descriptor however big the repo is.
 */
export function watchRepo(
  root: string,
  /** Awaited, so the cooldown below measures the real recompute. */
  onChange: () => unknown,
  debounceMs: number = DEBOUNCE_MS,
): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null
  /**
   * How long the last recompute took — the cooldown before the next one. A full
   * recompute measures ~700ms on a large repo and runs on the event loop, so a
   * debounce alone does not bound it: a build writing continuously buys another
   * stall per surviving burst. Charging the measured cost back as idle time caps the
   * duty cycle near 50%. Nothing is dropped — the trailing recompute is delayed,
   * never cancelled.
   */
  let cooldownUntil = 0
  const fire = () => {
    if (timer) clearTimeout(timer)
    const wait = Math.max(debounceMs, cooldownUntil - Date.now())
    timer = setTimeout(() => {
      timer = null
      // Never let a recompute failure escape a bare timer callback — an uncaught
      // throw here would take the whole server down.
      const started = Date.now()
      void Promise.resolve()
        .then(onChange)
        .catch((err: Error) => {
          console.error(`[diffo] changeset refresh failed: ${err.message}`)
        })
        .finally(() => {
          const ended = Date.now()
          cooldownUntil = ended + Math.min(ended - started, MAX_COOLDOWN_MS)
        })
    }, wait)
  }

  let watcher: FSWatcher | null = null
  /**
   * A watcher that cannot run gives up its handle and says so **once**, and the
   * server keeps answering with a changeset that no longer refreshes itself. Logging
   * per failure is what turned an EMFILE into 7,549 identical lines.
   */
  const giveUp = (err: unknown) => {
    if (!watcher) return
    watcher.close()
    watcher = null
    console.error(
      `[diffo] live updates off — file watcher failed: ${(err as Error).message}\n` +
        '[diffo] the review still serves; reload after a change to see it.',
    )
  }

  try {
    watcher = watch(root, { recursive: true, persistent: true })
    watcher.on('change', (_event, filename) => {
      // No filename means the platform could not say what moved. Recomputing is
      // debounced and cheap; missing a change is neither.
      if (filename == null) return fire()
      if (affectsDiff(String(filename))) fire()
    })
    watcher.on('error', giveUp)
  } catch (err) {
    giveUp(err)
  }

  return () => {
    if (timer) clearTimeout(timer)
    watcher?.close()
    watcher = null
  }
}
