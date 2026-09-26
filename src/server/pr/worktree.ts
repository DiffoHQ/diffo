import { createHash } from 'node:crypto'
import { existsSync, readdirSync, rmdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { parseRemoteUrl } from '../../forge/target.js'
import { type PrRef, prRefKey } from '../../forge/types.js'
import { type DiffoDb, REVIEW_TTL_DAYS, type ServerRecord, type WorktreeRecord } from '../db.js'
import {
  deleteBranch,
  deleteRef,
  fetchBranch,
  fetchPrHead,
  fetchPrHeadAsync,
  isWorktreeClean,
  listRemotes,
  prHeadRef,
  resetHard,
  revParse,
  worktreeAdd,
  worktreePrune,
  worktreeRemove,
} from '../git.js'

// The worktree a pull-request review runs in. It is an ordinary linked worktree
// of the user's checkout, on a Diffo-named branch, outside the repo; the review
// is scoped to it like any branch review, so the two live and die together.

export function prBranch(number: number): string {
  return `diffo/pr-${number}`
}

/** `~/.diffo/worktrees/<repo>-<hash>/pr-<n>` — the hash keeps two clones of one
 * repo apart, the basename keeps the path readable. */
export function worktreePathFor(
  repoPath: string,
  number: number,
  home: string = homedir(),
): string {
  const abs = resolve(repoPath)
  const hash = createHash('sha256').update(abs).digest('hex').slice(0, 8)
  return join(home, '.diffo', 'worktrees', `${basename(abs)}-${hash}`, `pr-${number}`)
}

/**
 * The remote that serves this pull request: the one whose URL names the PR's
 * repo. In a clone of a fork that is `upstream`, not `origin` — fetching
 * `refs/pull/N/head` from the fork would check out a different PR's code, or
 * nothing, without a word. No match is an error that names both sides.
 */
export function remoteForPr(root: string, ref: PrRef): string {
  const remotes = listRemotes(root)
  const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()
  for (const remote of remotes) {
    const parsed = parseRemoteUrl(remote.url)
    if (
      parsed &&
      same(parsed.host, ref.host) &&
      same(parsed.owner, ref.owner) &&
      same(parsed.repo, ref.repo)
    ) {
      return remote.name
    }
  }
  const found =
    remotes.length === 0
      ? 'this repo has no remotes'
      : `remotes here: ${remotes.map((r) => `${r.name} → ${r.url}`).join(', ')}`
  throw new Error(
    `no remote points at ${ref.host}/${ref.owner}/${ref.repo}, the pull request's repo (${found}); add one, or run diffo from a clone of it`,
  )
}

export interface PreparedWorktree {
  path: string
  branch: string
  /** The base as the diff sees it: `<remote>/<branch>`, on the PR's remote. */
  base: string
  headSha: string
  created: boolean
  /** The worktree existed with uncommitted changes, so its HEAD was left alone. */
  keptDirty: boolean
}

/**
 * Fetch the PR head and the base, then make sure the worktree exists at that
 * head. Idempotent: an existing clean worktree is moved to the fetched head; a
 * dirty one is kept where it is and says so. Registers the worktree in the DB.
 */
export function prepareWorktree(
  repoPath: string,
  ref: PrRef,
  baseBranch: string,
  db: DiffoDb,
  home: string = homedir(),
): PreparedWorktree {
  const root = resolve(repoPath)
  const remote = remoteForPr(root, ref)
  fetchPrHead(root, ref.number, remote)
  fetchBranch(root, baseBranch, remote)
  const head = prHeadRef(ref.number)
  const headSha = revParse(root, head)
  if (headSha === null) throw new Error(`could not fetch pull request #${ref.number}'s head`)
  const path = worktreePathFor(root, ref.number, home)
  const branch = prBranch(ref.number)
  const base = `${remote}/${baseBranch}`
  let created = false
  let keptDirty = false
  if (existsSync(join(path, '.git'))) {
    if (isWorktreeClean(path)) resetHard(path, head)
    else keptDirty = true
  } else {
    // A leftover directory with no .git is not a worktree; git refuses to add
    // over it, and that refusal is the right answer — say so plainly.
    if (existsSync(path)) {
      throw new Error(
        `${path} exists but is not a worktree; remove it, or run \`diffo clean --force\``,
      )
    }
    worktreePrune(root)
    worktreeAdd(root, path, branch, head)
    created = true
  }
  db.registerWorktree({
    worktreePath: path,
    repoPath: root,
    prKey: prRefKey(ref),
    branch,
    base,
    createdAt: new Date().toISOString(),
  })
  return { path, branch, base, headSha, created, keptDirty }
}

/**
 * Move an existing worktree to the pull request's head, if it is clean.
 * `headSha` is what the forge just reported: the fetch runs only when the
 * local ref is not there yet, so a quiet PR costs no network on any tick.
 */
export async function advanceWorktree(
  repoPath: string,
  worktreePath: string,
  ref: PrRef,
  headSha: string,
): Promise<{ sha: string; moved: boolean } | null> {
  const root = resolve(repoPath)
  const head = prHeadRef(ref.number)
  if (revParse(root, head) !== headSha) {
    // Off the loop: this runs inside the daemon, and a fetch that waits on
    // the network must not stop the server answering meanwhile.
    await fetchPrHeadAsync(root, ref.number, remoteForPr(root, ref))
  }
  const sha = revParse(root, head)
  if (sha === null) return null
  const at = revParse(worktreePath, 'HEAD')
  if (at === sha) return { sha, moved: false }
  if (isWorktreeClean(worktreePath) !== true) return { sha, moved: false }
  resetHard(worktreePath, head)
  return { sha, moved: true }
}

/**
 * The pull-request worktree a live server is reviewing in, for a command run
 * from the user's checkout. The agent is invited from that checkout and runs
 * `diffo poll` there, but the review it was invited to lives in the worktree;
 * without this it would find no server and open a plain review of the checkout
 * instead. The newest server wins when several pull requests are open.
 */
export function servedWorktreeFor(
  db: DiffoDb,
  mainRepo: string,
): { record: WorktreeRecord; server: ServerRecord } | null {
  let best: { record: WorktreeRecord; server: ServerRecord } | null = null
  for (const record of db.listWorktrees(resolve(mainRepo))) {
    const server = db.liveServer(resolve(record.worktreePath))
    if (server && (best === null || server.startedAt > best.server.startedAt)) {
      best = { record, server }
    }
  }
  return best
}

/** `unchecked`: git could not say whether it is dirty (the main repo is gone),
 * so it is kept like a dirty one. `failed`: git refused to remove it; the
 * directory and the row both stay, so the next sweep sees it again. */
export type RemoveOutcome = 'removed' | 'dirty' | 'unchecked' | 'failed' | 'missing'

/** Remove one of Diffo's worktrees, its branch, and its row. Dirty worktrees are
 * kept unless forced: uncommitted work is never deleted by a sweep. */
export function removeWorktree(db: DiffoDb, record: WorktreeRecord, force: boolean): RemoveOutcome {
  const root = record.repoPath
  if (!existsSync(record.worktreePath)) {
    db.removeWorktree(record.worktreePath)
    forget(root, record)
    return 'missing'
  }
  if (!force) {
    const clean = isWorktreeClean(record.worktreePath)
    if (clean === null) return 'unchecked'
    if (!clean) return 'dirty'
  }
  if (!worktreeRemove(root, record.worktreePath, force)) return 'failed'
  db.removeWorktree(record.worktreePath)
  forget(root, record)
  return 'removed'
}

/** Everything a worktree left in the main repo and on disk besides itself: git's
 * stale entry, the `diffo/pr-N` branch, the `refs/diffo/pr/N` ref, and the
 * per-repo parent directory once it is empty. */
function forget(root: string, record: WorktreeRecord): void {
  worktreePrune(root)
  deleteBranch(root, record.branch)
  const number = Number.parseInt(record.prKey.split('#').at(-1) ?? '', 10)
  if (Number.isInteger(number)) deleteRef(root, prHeadRef(number))
  const parent = dirname(record.worktreePath)
  try {
    if (readdirSync(parent).length === 0) rmdirSync(parent)
  } catch {
    // gone already, or not ours to remove
  }
}

export interface SweepEntry {
  record: WorktreeRecord
  /** `serving`: a running server is reviewing in it, so it stayed — or, with
   * `force`, went out from under that server. */
  reason: 'gone' | 'closed' | 'review-pruned' | 'serving' | 'kept'
  outcome: RemoveOutcome | null
}

/**
 * Reap the worktrees whose review is over: the directory vanished, the PR was
 * seen merged or closed, or the review row was pruned (the 60-day TTL). Runs at
 * every open in a repo and behind `diffo clean`. A worktree a live server is
 * registered for is never swept — a merged PR's review stays open until the
 * reviewer lets it go — unless `force`d. `force` takes dirty ones too; `all`
 * ignores the reasons and removes every worktree Diffo owns.
 */
export function sweepWorktrees(
  db: DiffoDb,
  repoPath: string | undefined,
  options: { force?: boolean; all?: boolean; except?: string; now?: number } = {},
): SweepEntry[] {
  const out: SweepEntry[] = []
  // A review row appears on the review's first write, not at the open — a fresh
  // worktree with nothing commented has none. Only a worktree old enough for
  // the TTL to have taken its row reads as pruned; younger ones are just quiet.
  const pruneAge = (options.now ?? Date.now()) - REVIEW_TTL_DAYS * 86_400_000
  for (const record of db.listWorktrees(repoPath === undefined ? undefined : resolve(repoPath))) {
    if (options.except !== undefined && resolve(record.worktreePath) === resolve(options.except)) {
      out.push({ record, reason: 'kept', outcome: null })
      continue
    }
    const scope = { repoPath: record.worktreePath, branch: record.branch, base: record.base }
    let reason: SweepEntry['reason'] = !existsSync(record.worktreePath)
      ? 'gone'
      : record.closedAt !== null
        ? 'closed'
        : !db.hasReview(scope) && Date.parse(record.createdAt) < pruneAge
          ? 'review-pruned'
          : 'kept'
    if (reason === 'kept' && !options.all) {
      out.push({ record, reason, outcome: null })
      continue
    }
    if (reason !== 'gone' && db.liveServer(resolve(record.worktreePath)) !== null) {
      reason = 'serving'
      if (!options.force) {
        out.push({ record, reason, outcome: null })
        continue
      }
    }
    out.push({ record, reason, outcome: removeWorktree(db, record, options.force === true) })
  }
  return out
}
