import { threadsFromGithub } from '../../forge/github/map.js'
import type { ForgeClient, PrRef } from '../../forge/types.js'
import type { PrInfo } from '../../shared/types.js'
import type { DiffoDb } from '../db.js'
import type { ReviewStore } from '../review.js'
import type { ChangesetStore } from '../store.js'
import { advanceWorktree } from './worktree.js'

// The pull request's pulse. Every tick asks the forge what the PR looks like
// now, moves the worktree when the head moved (the fs watcher then does what it
// does for any edit), and upserts the conversation. The diff itself is never
// touched here — that is git's and the watcher's job.

export const PULL_INTERVAL_MS = 45_000

export interface PullerDeps {
  forge: ForgeClient
  ref: PrRef
  /** The user's checkout the worktree hangs off. */
  mainRepo: string
  /** The worktree the server runs in. */
  worktree: string
  store: ChangesetStore
  review: ReviewStore
  db: DiffoDb
  intervalMs?: number
  log?: (message: string) => void
}

/** Everything about a PR that is worth a new changeset version. `fetchedAt`
 * changes every tick and means nothing. */
function fingerprint(pr: PrInfo): string {
  const { fetchedAt: _at, ...rest } = pr
  return JSON.stringify(rest)
}

export class PrPuller {
  private timer: ReturnType<typeof setInterval> | null = null
  private inFlight: Promise<void> | null = null
  private lastFingerprint: string | null = null
  private lastError: string | null = null
  /** Kept apart from `lastError`: a fetch that keeps failing while the forge
   * keeps answering must still log once, not once per tick. */
  private lastFetchError: string | null = null
  private closedNoted = false

  constructor(private deps: PullerDeps) {
    // The open already read the PR once and seeded the store; the first tick
    // then bumps the changeset only if GitHub says something new.
    const seeded = deps.store.get().pr
    if (seeded) this.lastFingerprint = fingerprint(seeded)
  }

  start(): void {
    if (this.timer) return
    void this.tick()
    const timer = setInterval(() => void this.tick(), this.deps.intervalMs ?? PULL_INTERVAL_MS)
    timer.unref?.()
    this.timer = timer
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  /** One pass, coalesced: a tick that lands mid-tick joins it. */
  tick(): Promise<void> {
    this.inFlight ??= this.pass()
      .catch((err: Error) => {
        // Say it once per distinct failure — a flaky network must not fill the log.
        if (err.message !== this.lastError) {
          this.lastError = err.message
          this.deps.log?.(`pull request refresh failed: ${err.message}`)
        }
      })
      .finally(() => {
        this.inFlight = null
      })
    return this.inFlight
  }

  private async pass(): Promise<void> {
    const { forge, ref, store, review, db, log } = this.deps
    // One read for the PR block and its conversation: the PR query is the
    // expensive half of both, and a tick is not the place to run it twice.
    const { pr, threads: imported } = await forge.fetchPr(ref)
    this.lastError = null
    const print = fingerprint(pr)
    const before = store.get().pr
    if (print !== this.lastFingerprint) {
      this.lastFingerprint = print
      store.setPr(pr)
    }
    if (before && before.head.sha !== pr.head.sha) {
      log?.(`pull request head moved ${before.head.sha.slice(0, 7)} → ${pr.head.sha.slice(0, 7)}`)
    }
    // The head moved (or the worktree was never at it): fetch and advance. A
    // dirty worktree stays put — the agent is mid-edit — and the header shows
    // the newer sha it is not yet at.
    // A fetch that fails (network, a remote that vanished) must not cost the
    // conversation below: say so, keep the diff where it is, import anyway.
    try {
      const moved = await advanceWorktree(this.deps.mainRepo, this.deps.worktree, ref, pr.head.sha)
      this.lastFetchError = null
      if (moved?.moved) {
        log?.(`worktree advanced to ${moved.sha.slice(0, 7)}`)
        await store.refresh()
      }
    } catch (err) {
      const message = `could not fetch the pull request head: ${(err as Error).message.split('\n')[0]}`
      if (message !== this.lastFetchError) {
        this.lastFetchError = message
        log?.(message)
      }
    }
    const { added, updated } = review.importGithubThreads(
      threadsFromGithub(pr, imported, store.get().files),
    )
    if (added > 0 || updated > 0) log?.(`github conversation: ${added} new, ${updated} updated`)
    if (pr.state !== 'open' && !this.closedNoted) {
      this.closedNoted = true
      db.markWorktreeClosed(this.deps.worktree)
      if (!review.get().landed) {
        review.markLanded({
          sha: pr.head.sha,
          subject: pr.title,
          at: new Date().toISOString(),
        })
        log?.(`pull request #${pr.number} ${pr.state}, offering a fresh start`)
      }
    }
  }
}
