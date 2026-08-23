import { execFile, execFileSync } from 'node:child_process'
import {
  closeSync,
  lstatSync,
  openSync,
  readFileSync,
  readlinkSync,
  readSync,
  realpathSync,
} from 'node:fs'
import { basename, join, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import type { ChangesetSpec } from '../shared/types.js'

const MAX_BUFFER = 50 * 1024 * 1024

const SNIFF_BYTES = 8192

/** Largest untracked file whose content the diff will inline. Deliberately not
 * `MAX_BUFFER`: that bounds a subprocess's stdout, and the two limits move for
 * different reasons. */
const MAX_INLINE_BYTES = 2 * 1024 * 1024

// Force plain unified diffs regardless of user git config (difftastic,
// color.ui=always, external diff drivers), with rename detection.
const DIFF_FLAGS = ['--no-ext-diff', '--no-color', '-M'] as const

function git(root: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: MAX_BUFFER,
  })
}

const execFileAsync = promisify(execFile)

/**
 * The same call, off the event loop. Every `git` here is the process waiting on a
 * child, which `execFileSync` spends blocking the loop — one recompute on a
 * 17,639-directory repo measured ~700ms of answering nothing.
 *
 * The sync twins stay: startup builds the first changeset before anything is
 * served, where blocking is free and an `await` in a constructor is not.
 */
async function gitAsync(root: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, {
    cwd: root,
    encoding: 'utf-8',
    maxBuffer: MAX_BUFFER,
  })
  return stdout
}

export function findRepoRoot(cwd: string): string | null {
  try {
    return git(cwd, ['rev-parse', '--show-toplevel']).trim()
  } catch {
    return null
  }
}

export function getRepoName(root: string): string {
  return basename(root)
}

export function getBranchName(root: string): string {
  try {
    return git(root, ['rev-parse', '--abbrev-ref', 'HEAD']).trim()
  } catch {
    return '' // e.g. repo with no commits
  }
}

/**
 * Does this branch still exist here? Answers **true** when git can't say: the
 * caller deletes the reviewer's threads on a false, so every ambiguous case has
 * to fall on the side of keeping them.
 */
export function branchExists(root: string, branch: string): boolean {
  try {
    git(root, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`])
    return true
  } catch (err) {
    // `show-ref --verify --quiet` exits 1 for "no such ref"; anything else means
    // git never got to look.
    return (err as { status?: number }).status !== 1
  }
}

/**
 * The name of the linked worktree we're in, or null in the main one. A linked
 * worktree's git dir is `<main>/.git/worktrees/<name>`, while the main worktree's
 * is a plain `.git`. Two worktrees of the same repo are otherwise
 * indistinguishable in the header.
 */
export function getWorktreeName(root: string): string | null {
  try {
    const gitDir = git(root, ['rev-parse', '--git-dir']).trim()
    const marker = `${sep}worktrees${sep}`
    if (!gitDir.includes(marker)) return null
    return basename(gitDir)
  } catch {
    return null
  }
}

export function getHeadSha(root: string): string | null {
  try {
    return git(root, ['rev-parse', 'HEAD']).trim()
  } catch {
    return null // e.g. repo with no commits
  }
}

/**
 * Is `ancestor` in `descendant`'s history? Null when git couldn't answer (a sha
 * it no longer knows, a transient failure) — the callers lean opposite ways on
 * ambiguity (keep a landed marker, but never stamp one), so the ambiguity has
 * to survive the return.
 */
export function isAncestor(root: string, ancestor: string, descendant: string): boolean | null {
  try {
    git(root, ['merge-base', '--is-ancestor', ancestor, descendant])
    return true
  } catch (err) {
    // exit 1 is git's "no"; anything else means git never got to answer.
    return (err as { status?: number }).status === 1 ? false : null
  }
}

export function getCommitSubject(root: string, sha: string): string {
  try {
    return git(root, ['log', '-1', '--format=%s', sha]).trim()
  } catch {
    return ''
  }
}

export function hasHead(root: string): boolean {
  try {
    git(root, ['rev-parse', '--verify', 'HEAD'])
    return true
  } catch {
    return false
  }
}

export class MissingBaseError extends Error {
  constructor(public base: string) {
    super(`base branch '${base}' not found`)
  }
}

/**
 * The base a clean working tree most likely wants reviewing against: the
 * remote's default branch when origin/HEAD names one, else main/master.
 * Null when the repo offers no candidate, when HEAD *is* the candidate, or
 * when nothing was committed since forking from it — no hint is owed then.
 */
export function suggestedBase(root: string): { base: string; commits: number } | null {
  try {
    const candidate = defaultBranch(root)
    if (candidate === null) return null
    const head = git(root, ['rev-parse', '--abbrev-ref', 'HEAD']).trim()
    if (candidate === head) return null
    const mergeBase = git(root, ['merge-base', candidate, 'HEAD']).trim()
    const commits = Number.parseInt(
      git(root, ['rev-list', '--count', `${mergeBase}..HEAD`]).trim(),
      10,
    )
    return Number.isInteger(commits) && commits > 0 ? { base: candidate, commits } : null
  } catch {
    return null
  }
}

function defaultBranch(root: string): string | null {
  const candidates: string[] = []
  try {
    const ref = git(root, ['rev-parse', '--abbrev-ref', 'origin/HEAD']).trim()
    const short = ref.replace(/^origin\//, '')
    // Prefer the local branch of that name; fall back to the remote ref itself.
    if (short) candidates.push(short, ref)
  } catch {
    // no origin/HEAD — a local-only repo, or a remote never fetched
  }
  candidates.push('main', 'master')
  for (const name of candidates) {
    try {
      git(root, ['rev-parse', '--verify', '--quiet', name])
      return name
    } catch {
      // not a ref in this repo
    }
  }
  return null
}

export function getRawDiff(root: string, spec: ChangesetSpec): string {
  if (spec.kind === 'working-tree') {
    if (!hasHead(root)) return '' // no commits: everything is untracked
    return git(root, ['diff', ...DIFF_FLAGS, 'HEAD'])
  }
  let mergeBase: string
  try {
    mergeBase = git(root, ['merge-base', spec.base, 'HEAD']).trim()
  } catch {
    throw new MissingBaseError(spec.base)
  }
  return git(root, ['diff', ...DIFF_FLAGS, mergeBase])
}

export function getStagedPaths(root: string): Set<string> {
  try {
    const out = git(root, ['diff', '--name-only', '--cached']).trim()
    return new Set(out ? out.split('\n') : [])
  } catch {
    return new Set()
  }
}

export function getUntrackedPaths(root: string): string[] {
  const out = git(root, ['ls-files', '--others', '--exclude-standard']).trim()
  return out ? out.split('\n') : []
}

function binaryStub(file: string): string {
  return [
    `diff --git a/${file} b/${file}`,
    'new file mode 100644',
    'index 0000000..0000001',
    `Binary files /dev/null and b/${file} differ`,
  ].join('\n')
}

/** One scratch page for the sniff below. 8KB is past `Buffer.poolSize / 2`, so a
 * fresh `allocUnsafe` per file misses the shared pool and mallocs. The sniff is
 * synchronous and never re-entered, so reuse is safe. */
const sniffBuffer = Buffer.allocUnsafe(SNIFF_BYTES)

/**
 * Git's own test: a NUL byte in the first 8KB means binary. Read 8KB, not the
 * file — `readFileSync` pulled the whole thing in to look at its first page, so
 * an untracked 2GB core dump cost a 2GB allocation on every recompute.
 */
function looksBinary(absPath: string, size: number): boolean {
  if (size === 0) return false
  let fd: number | null = null
  try {
    fd = openSync(absPath, 'r')
    const read = readSync(fd, sniffBuffer, 0, Math.min(size, SNIFF_BYTES), 0)
    for (let i = 0; i < read; i++) if (sniffBuffer[i] === 0) return true
    return false
  } catch {
    return true
  } finally {
    if (fd !== null) closeSync(fd)
  }
}

export function getUntrackedDiff(root: string): string {
  return patchesForUntracked(root, getUntrackedPaths(root))
}

function patchesForUntracked(root: string, files: readonly string[]): string {
  const patches: string[] = []
  for (const file of files) {
    const absPath = join(root, file)
    let stats: ReturnType<typeof lstatSync>
    try {
      stats = lstatSync(absPath)
    } catch {
      continue // vanished mid-scan; next recompute catches it
    }
    if (stats.isSymbolicLink()) {
      const target = readlinkSync(absPath, 'utf-8')
      patches.push(
        [
          `diff --git a/${file} b/${file}`,
          'new file mode 120000',
          'index 0000000..0000001',
          '--- /dev/null',
          `+++ b/${file}`,
          '@@ -0,0 +1 @@',
          `+${target}`,
          '\\ No newline at end of file',
        ].join('\n'),
      )
      continue
    }
    if (!stats.isFile()) continue
    // Oversize first, so a huge file is never opened: below this ceiling an
    // untracked file is read whole and rebuilt with a `+` per line, several times
    // its own size in memory.
    if (stats.size > MAX_INLINE_BYTES || looksBinary(absPath, stats.size)) {
      patches.push(binaryStub(file))
      continue
    }
    let content: string
    try {
      content = readFileSync(absPath, 'utf-8')
    } catch {
      continue
    }
    const trailingNewline = content.endsWith('\n')
    const lines = trailingNewline ? content.slice(0, -1).split('\n') : content.split('\n')
    if (content === '') {
      patches.push(
        [`diff --git a/${file} b/${file}`, 'new file mode 100644', 'index 0000000..0000001'].join(
          '\n',
        ),
      )
      continue
    }
    // One join, not `map` + spread: that built two more full copies of the file and
    // pushed a million arguments onto the stack for a million-line file.
    const body = `+${lines.join('\n+')}`
    patches.push(
      [
        `diff --git a/${file} b/${file}`,
        'new file mode 100644',
        'index 0000000..0000001',
        '--- /dev/null',
        `+++ b/${file}`,
        `@@ -0,0 +1,${lines.length} @@`,
        trailingNewline ? body : `${body}\n\\ No newline at end of file`,
      ].join('\n'),
    )
  }
  return patches.join('\n')
}

export function getFullDiff(root: string, spec: ChangesetSpec): string {
  return [getRawDiff(root, spec), getUntrackedDiff(root)].filter(Boolean).join('\n')
}

async function hasHeadAsync(root: string): Promise<boolean> {
  try {
    await gitAsync(root, ['rev-parse', '--verify', 'HEAD'])
    return true
  } catch {
    return false
  }
}

export async function getBranchNameAsync(root: string): Promise<string> {
  try {
    return (await gitAsync(root, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim()
  } catch {
    return '' // e.g. repo with no commits
  }
}

export async function getStagedPathsAsync(root: string): Promise<Set<string>> {
  try {
    const out = (await gitAsync(root, ['diff', '--name-only', '--cached'])).trim()
    return new Set(out ? out.split('\n') : [])
  } catch {
    return new Set()
  }
}

async function getRawDiffAsync(root: string, spec: ChangesetSpec): Promise<string> {
  if (spec.kind === 'working-tree') {
    if (!(await hasHeadAsync(root))) return '' // no commits: everything is untracked
    return gitAsync(root, ['diff', ...DIFF_FLAGS, 'HEAD'])
  }
  let mergeBase: string
  try {
    mergeBase = (await gitAsync(root, ['merge-base', spec.base, 'HEAD'])).trim()
  } catch {
    throw new MissingBaseError(spec.base)
  }
  return gitAsync(root, ['diff', ...DIFF_FLAGS, mergeBase])
}

/**
 * The untracked half. `ls-files` walks the worktree honouring gitignore — ~540ms
 * of the ~700ms on the repo that prompted this — so it goes async. The per-file
 * reads below it are bounded by `MAX_INLINE_BYTES` and stay synchronous.
 */
async function getUntrackedDiffAsync(root: string): Promise<string> {
  const paths = (await gitAsync(root, ['ls-files', '--others', '--exclude-standard'])).trim()
  return patchesForUntracked(root, paths ? paths.split('\n') : [])
}

export async function getFullDiffAsync(root: string, spec: ChangesetSpec): Promise<string> {
  const [raw, untracked] = await Promise.all([
    getRawDiffAsync(root, spec),
    getUntrackedDiffAsync(root),
  ])
  return [raw, untracked].filter(Boolean).join('\n')
}

function isSafeRepoPath(root: string, relPath: string): boolean {
  const full = resolve(root, relPath)
  return full.startsWith(resolve(root) + sep)
}

export function getHeadFileBytes(root: string, relPath: string): Buffer | null {
  if (!isSafeRepoPath(root, relPath)) return null
  const full = resolve(root, relPath)
  try {
    const stats = lstatSync(full)
    // A symlink at the final component is returned as its link text, not followed.
    if (stats.isSymbolicLink()) return Buffer.from(readlinkSync(full, 'utf-8'))
    if (!stats.isFile()) return null
    // The lexical `isSafeRepoPath` check is fooled by an intermediate symlinked
    // directory (e.g. `link -> /`), which would let a read escape the repo.
    // realpath resolves those links; re-check the real location is inside root.
    const realRoot = realpathSync(resolve(root))
    const real = realpathSync(full)
    if (real !== realRoot && !real.startsWith(realRoot + sep)) return null
    return readFileSync(full)
  } catch {
    return null
  }
}

export function getBaseFileBytes(root: string, ref: string, relPath: string): Buffer | null {
  if (!isSafeRepoPath(root, relPath)) return null
  try {
    return execFileSync('git', ['show', `${ref}:${relPath}`], {
      cwd: root,
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: MAX_BUFFER,
    })
  } catch {
    return null
  }
}

export function resolveBaseRef(root: string, spec: ChangesetSpec): string {
  if (spec.kind === 'working-tree') return 'HEAD'
  try {
    return git(root, ['merge-base', spec.base, 'HEAD']).trim()
  } catch {
    throw new MissingBaseError(spec.base)
  }
}
