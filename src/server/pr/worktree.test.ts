import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { PrRef } from '../../forge/types.js'
import { DiffoDb } from '../db.js'
import { revParse } from '../git.js'
import {
  advanceWorktree,
  prBranch,
  prepareWorktree,
  remoteForPr,
  removeWorktree,
  servedWorktreeFor,
  sweepWorktrees,
  worktreePathFor,
} from './worktree.js'

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const fn of cleanups.splice(0)) fn()
})

function git(dir: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd: dir,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

/**
 * Name a remote by its GitHub URL while git talks to a local bare repo: the
 * configured URL is what `remoteForPr` matches, the `insteadOf` rewrite is
 * where the fetch actually goes.
 */
function githubRemote(repo: string, name: string, ownerRepo: string, local: string): void {
  const url = `https://github.com/${ownerRepo}.git`
  git(repo, 'remote', name === 'origin' ? 'set-url' : 'add', name, url)
  git(repo, 'config', `url.${local}.insteadOf`, url)
}

/**
 * A bare "GitHub" with `refs/pull/7/head`, and a clone of it as the user's
 * checkout: what `diffo <pr>` finds on a developer's machine.
 */
function scenario() {
  const base = mkdtempSync(join(tmpdir(), 'diffo-wt-'))
  cleanups.push(() => rmSync(base, { recursive: true, force: true }))
  const origin = join(base, 'origin.git')
  const seed = join(base, 'seed')
  git(base, 'init', '-q', '-b', 'main', seed)
  git(seed, 'config', 'user.email', 't@e.com')
  git(seed, 'config', 'user.name', 'T')
  git(seed, 'config', 'commit.gpgsign', 'false')
  writeFileSync(join(seed, 'app.ts'), 'const a = 1\n')
  git(seed, 'add', '-A')
  git(seed, 'commit', '-q', '-m', 'seed')
  git(base, 'clone', '-q', '--bare', seed, origin)
  // The PR branch: one commit on top of main, published as pull/7/head.
  git(seed, 'checkout', '-q', '-b', 'feature')
  writeFileSync(join(seed, 'app.ts'), 'const a = 2\n')
  git(seed, 'commit', '-q', '-am', 'change a')
  git(seed, 'push', '-q', origin, 'feature:refs/pull/7/head')
  // Two more PRs at the same head, for the sweep.
  git(seed, 'push', '-q', origin, 'feature:refs/pull/8/head', 'feature:refs/pull/9/head')
  const clone = join(base, 'clone')
  git(base, 'clone', '-q', origin, clone)
  githubRemote(clone, 'origin', 'acme/widgets', origin)
  const db = new DiffoDb(join(base, 'db', 'diffo.db'))
  cleanups.push(() => db.close())
  const ref: PrRef = { host: 'github.com', owner: 'acme', repo: 'widgets', number: 7 }
  return { base, origin, seed, clone, db, ref, home: join(base, 'home') }
}

describe('prepareWorktree', () => {
  it('fetches the PR head and checks it out on a diffo branch outside the repo', () => {
    const { clone, db, ref, home } = scenario()
    const prepared = prepareWorktree(clone, ref, 'main', db, home)
    expect(prepared.created).toBe(true)
    expect(prepared.path).toBe(worktreePathFor(clone, 7, home))
    expect(prepared.path.startsWith(join(home, '.diffo', 'worktrees'))).toBe(true)
    expect(prepared.branch).toBe(prBranch(7))
    expect(prepared.base).toBe('origin/main')
    expect(git(prepared.path, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe('diffo/pr-7')
    expect(git(prepared.path, 'diff', '--name-only', 'origin/main').trim()).toBe('app.ts')
    // The user's checkout is untouched.
    expect(git(clone, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe('main')
    expect(git(clone, 'status', '--porcelain').trim()).toBe('')
    expect(db.getWorktree(prepared.path)?.prKey).toBe('github.com/acme/widgets#7')
  })

  it('is idempotent: a second open reuses the worktree and moves it to a new head', () => {
    const { seed, origin, clone, db, ref, home } = scenario()
    const first = prepareWorktree(clone, ref, 'main', db, home)
    writeFileSync(join(seed, 'app.ts'), 'const a = 3\n')
    git(seed, 'commit', '-q', '-am', 'change a again')
    git(seed, 'push', '-q', '-f', origin, 'feature:refs/pull/7/head')
    const second = prepareWorktree(clone, ref, 'main', db, home)
    expect(second.created).toBe(false)
    expect(second.headSha).not.toBe(first.headSha)
    expect(revParse(second.path, 'HEAD')).toBe(second.headSha)
  })

  it('leaves a dirty worktree where it is', () => {
    const { seed, origin, clone, db, ref, home } = scenario()
    const first = prepareWorktree(clone, ref, 'main', db, home)
    writeFileSync(join(first.path, 'scratch.txt'), 'agent notes\n')
    writeFileSync(join(seed, 'app.ts'), 'const a = 3\n')
    git(seed, 'commit', '-q', '-am', 'again')
    git(seed, 'push', '-q', '-f', origin, 'feature:refs/pull/7/head')
    const second = prepareWorktree(clone, ref, 'main', db, home)
    expect(second.keptDirty).toBe(true)
    expect(revParse(second.path, 'HEAD')).toBe(first.headSha)
  })

  it("fetches from the remote that names the PR's repo — upstream in a clone of a fork", () => {
    const { base, origin, clone, db, ref, home } = scenario()
    // The fork has no pull/7/head at all: fetching from it would find nothing.
    const fork = join(base, 'fork.git')
    git(base, 'init', '-q', '--bare', fork)
    githubRemote(clone, 'origin', 'forker/widgets', fork)
    githubRemote(clone, 'upstream', 'acme/widgets', origin)
    expect(remoteForPr(clone, ref)).toBe('upstream')
    const prepared = prepareWorktree(clone, ref, 'main', db, home)
    expect(prepared.base).toBe('upstream/main')
    expect(git(prepared.path, 'diff', '--name-only', 'upstream/main').trim()).toBe('app.ts')
    expect(db.getWorktree(prepared.path)?.base).toBe('upstream/main')
  })

  it('refuses to guess when no remote points at the PR repo, naming both sides', () => {
    const { clone, db, ref, home } = scenario()
    const elsewhere = { ...ref, owner: 'someone-else' }
    expect(() => prepareWorktree(clone, elsewhere, 'main', db, home)).toThrow(
      /github\.com\/someone-else\/widgets.*origin → https:\/\/github\.com\/acme\/widgets\.git/,
    )
    git(clone, 'remote', 'remove', 'origin')
    expect(() => remoteForPr(clone, ref)).toThrow(/no remotes/)
  })
})

describe('advanceWorktree', () => {
  it('moves a clean worktree when the head moved and reports when it did not', async () => {
    const { seed, origin, clone, db, ref, home } = scenario()
    const prepared = prepareWorktree(clone, ref, 'main', db, home)
    expect(await advanceWorktree(clone, prepared.path, ref, prepared.headSha)).toEqual({
      sha: prepared.headSha,
      moved: false,
    })
    writeFileSync(join(seed, 'app.ts'), 'const a = 4\n')
    git(seed, 'commit', '-q', '-am', 'four')
    git(seed, 'push', '-q', '-f', origin, 'feature:refs/pull/7/head')
    const next = git(seed, 'rev-parse', 'HEAD').trim()
    const moved = await advanceWorktree(clone, prepared.path, ref, next)
    expect(moved).toEqual({ sha: next, moved: true })
    expect(revParse(prepared.path, 'HEAD')).toBe(next)
  })

  it('fetches only when the reported head is not here yet', async () => {
    const { clone, db, ref, home } = scenario()
    const prepared = prepareWorktree(clone, ref, 'main', db, home)
    // With the remote gone a fetch cannot succeed: the tick that needs none
    // still answers, the one that does fails, and says which remote it wanted.
    git(clone, 'remote', 'remove', 'origin')
    expect(await advanceWorktree(clone, prepared.path, ref, prepared.headSha)).toEqual({
      sha: prepared.headSha,
      moved: false,
    })
    await expect(advanceWorktree(clone, prepared.path, ref, 'f'.repeat(40))).rejects.toThrow(
      /no remote points at github\.com\/acme\/widgets/,
    )
  })
})

describe('removeWorktree and sweepWorktrees', () => {
  it('removes the worktree, its branch, and its row', () => {
    const { clone, db, ref, home } = scenario()
    const prepared = prepareWorktree(clone, ref, 'main', db, home)
    const record = db.getWorktree(prepared.path)!
    expect(removeWorktree(db, record, false)).toBe('removed')
    expect(existsSync(prepared.path)).toBe(false)
    expect(db.getWorktree(prepared.path)).toBeNull()
    expect(revParse(clone, 'diffo/pr-7')).toBeNull()
    expect(revParse(clone, 'refs/diffo/pr/7')).toBeNull()
    // The per-repo parent goes once it holds nothing.
    expect(existsSync(join(home, '.diffo', 'worktrees'))).toBe(true)
    expect(existsSync(dirname(prepared.path))).toBe(false)
  })

  it('keeps a dirty worktree unless forced', () => {
    const { clone, db, ref, home } = scenario()
    const prepared = prepareWorktree(clone, ref, 'main', db, home)
    writeFileSync(join(prepared.path, 'wip.txt'), 'x\n')
    const record = db.getWorktree(prepared.path)!
    expect(removeWorktree(db, record, false)).toBe('dirty')
    expect(existsSync(prepared.path)).toBe(true)
    expect(removeWorktree(db, record, true)).toBe('removed')
  })

  it('sweeps closed PRs and pruned reviews, keeps the live ones', () => {
    const { clone, db, ref, home } = scenario()
    const live = prepareWorktree(clone, ref, 'main', db, home)
    db.setReview(
      { repoPath: live.path, branch: live.branch, base: live.base },
      '{"version":1,"threads":[]}',
    )
    const closed = prepareWorktree(clone, { ...ref, number: 8 }, 'main', db, home)
    db.setReview(
      { repoPath: closed.path, branch: closed.branch, base: closed.base },
      '{"version":1,"threads":[]}',
    )
    db.markWorktreeClosed(closed.path)
    // A worktree with no review row yet is a review nobody has commented on: it
    // stays. Only once it is old enough for the TTL prune to have taken its row
    // does the missing row mean the review is over.
    const quiet = prepareWorktree(clone, { ...ref, number: 9 }, 'main', db, home)
    const result = sweepWorktrees(db, clone)
    const byNumber = new Map(result.map((e) => [e.record.prKey.split('#')[1], e]))
    expect(byNumber.get('7')).toMatchObject({ reason: 'kept', outcome: null })
    expect(byNumber.get('8')).toMatchObject({ reason: 'closed', outcome: 'removed' })
    expect(byNumber.get('9')).toMatchObject({ reason: 'kept', outcome: null })
    expect(existsSync(live.path)).toBe(true)
    expect(existsSync(closed.path)).toBe(false)
    expect(existsSync(quiet.path)).toBe(true)

    const later = sweepWorktrees(db, clone, { now: Date.now() + 61 * 86_400_000 })
    const then = new Map(later.map((e) => [e.record.prKey.split('#')[1], e]))
    expect(then.get('7')).toMatchObject({ reason: 'kept', outcome: null })
    expect(then.get('9')).toMatchObject({ reason: 'review-pruned', outcome: 'removed' })
    expect(existsSync(quiet.path)).toBe(false)
  })

  it('never sweeps a worktree a live server is reviewing in, unless forced', () => {
    const { clone, db, ref, home } = scenario()
    const served = prepareWorktree(clone, ref, 'main', db, home)
    db.markWorktreeClosed(served.path)
    // The merged PR's server is this very process: it stays up until the
    // reviewer lets the review go, and so does its worktree.
    db.claimServer(served.path, 4949, process.pid)
    const kept = sweepWorktrees(db, clone)
    expect(kept[0]).toMatchObject({ reason: 'serving', outcome: null })
    expect(existsSync(served.path)).toBe(true)
    // `diffo clean --force` is the one caller allowed to pull it out from under.
    const forced = sweepWorktrees(db, clone, { force: true })
    expect(forced[0]).toMatchObject({ reason: 'serving', outcome: 'removed' })
    expect(existsSync(served.path)).toBe(false)
  })

  it('a command from the checkout finds the worktree a live server is reviewing in', () => {
    const { clone, db, ref, home } = scenario()
    const served = prepareWorktree(clone, ref, 'main', db, home)
    // No server anywhere yet: nothing to follow.
    expect(servedWorktreeFor(db, clone)).toBeNull()
    // A registration a dead process left behind is not a server.
    db.claimServer(served.path, 4950, 2_147_483_647)
    expect(servedWorktreeFor(db, clone)).toBeNull()
    db.removeServer(served.path, 4950)
    db.claimServer(served.path, 4949, process.pid)
    const found = servedWorktreeFor(db, clone)
    expect(found?.record.worktreePath).toBe(served.path)
    expect(found?.server.port).toBe(4949)
    // Another checkout's worktrees are not this one's.
    expect(servedWorktreeFor(db, join(clone, '..', 'elsewhere'))).toBeNull()
  })

  it('a dead server holds nothing: its worktree sweeps like any other', () => {
    const { clone, db, ref, home } = scenario()
    const closed = prepareWorktree(clone, ref, 'main', db, home)
    db.markWorktreeClosed(closed.path)
    db.claimServer(closed.path, 4949, 2 ** 22 - 1)
    expect(sweepWorktrees(db, clone)[0]).toMatchObject({ reason: 'closed', outcome: 'removed' })
  })

  it('never sweeps the worktree being opened, whatever its state', () => {
    const { clone, db, ref, home } = scenario()
    const own = prepareWorktree(clone, ref, 'main', db, home)
    db.markWorktreeClosed(own.path)
    const result = sweepWorktrees(db, clone, { except: own.path })
    expect(result[0]).toMatchObject({ reason: 'kept', outcome: null })
    expect(existsSync(own.path)).toBe(true)
  })

  it("an rm -rf'd worktree still gets its branch, ref, and git entry cleaned on the next sweep", () => {
    const { base, clone, ref, home } = scenario()
    const dbPath = join(base, 'db', 'diffo.db')
    const first = new DiffoDb(dbPath)
    const prepared = prepareWorktree(clone, ref, 'main', first, home)
    first.close()
    rmSync(prepared.path, { recursive: true, force: true })
    // A fresh open must keep the row: it is what finds the git side to clean.
    const db = new DiffoDb(dbPath)
    cleanups.push(() => db.close())
    expect(db.getWorktree(prepared.path)).not.toBeNull()
    expect(sweepWorktrees(db, clone)[0]).toMatchObject({ reason: 'gone', outcome: 'missing' })
    expect(db.getWorktree(prepared.path)).toBeNull()
    expect(git(clone, 'worktree', 'list')).not.toContain('pr-7')
    expect(revParse(clone, 'diffo/pr-7')).toBeNull()
    expect(revParse(clone, 'refs/diffo/pr/7')).toBeNull()
  })

  it('tells "could not check" from "dirty", and a failed remove keeps the row', () => {
    const { clone, db, ref, home } = scenario()
    const prepared = prepareWorktree(clone, ref, 'main', db, home)
    const record = db.getWorktree(prepared.path)!
    // The main repo is gone: git can neither read the worktree's status nor
    // remove it, and neither should read as "uncommitted changes".
    rmSync(clone, { recursive: true, force: true })
    expect(removeWorktree(db, record, false)).toBe('unchecked')
    expect(removeWorktree(db, record, true)).toBe('failed')
    expect(existsSync(prepared.path)).toBe(true)
    expect(db.getWorktree(prepared.path)).not.toBeNull()
  })
})
