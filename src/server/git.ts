import { execFile, execFileSync } from 'node:child_process'
import {
  closeSync,
  createReadStream,
  lstatSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readlinkSync,
  readSync,
  realpathSync,
  rmSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve, sep } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
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

// `windowsHide` on every child: the daemon runs with no console (`detached` is
// `DETACHED_PROCESS` on Windows), so each `git` would otherwise be handed a
// brand-new cmd window that flashes open and shut. A no-op elsewhere.
function git(root: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: MAX_BUFFER,
    windowsHide: true,
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
    windowsHide: true,
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

/** {@link branchExists}, off the event loop, for the daemon's background sweep
 * over every repo it has ever reviewed. Same lean: true unless git said no. */
export async function branchExistsAsync(root: string, branch: string): Promise<boolean> {
  try {
    await execFileAsync('git', ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], {
      cwd: root,
      encoding: 'utf-8',
      maxBuffer: MAX_BUFFER,
      windowsHide: true,
    })
    return true
  } catch (err) {
    return (err as { code?: number | string }).code !== 1
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

export async function getHeadShaAsync(root: string): Promise<string | null> {
  try {
    return (await gitAsync(root, ['rev-parse', 'HEAD'])).trim()
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
    return diffWithin(root, 'HEAD')
  }
  let mergeBase: string
  try {
    mergeBase = git(root, ['merge-base', spec.base, 'HEAD']).trim()
  } catch {
    throw new MissingBaseError(spec.base)
  }
  return diffWithin(root, mergeBase)
}

// ---------- a diff too big to hold ----------

/** Once the whole diff has outgrown `MAX_BUFFER`, a file whose own patch is over
 * this is shown as a note instead: past it no page renders it usefully. */
const MAX_FILE_PATCH_BYTES = 1024 * 1024
/** What a capped diff keeps in all: under `MAX_BUFFER`, with room for the
 * untracked half beside it. Files past it are notes too. */
const MAX_CAPPED_BYTES = 32 * 1024 * 1024
/** The line a capped file's section carries instead of its hunks. A diff line
 * inside a hunk always starts with ` `, `+`, `-` or `\`, so git never prints it. */
export const TOO_LARGE_MARKER = '# diffo: too large to show'

/** The diff's output outgrew the buffer it was read into. */
export function isOutputOverflow(err: unknown): boolean {
  const e = err as { code?: unknown; message?: unknown } | null
  return (
    e?.code === 'ENOBUFS' ||
    e?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' ||
    (typeof e?.message === 'string' && /maxBuffer length exceeded|ENOBUFS/.test(e.message))
  )
}

/**
 * Splits a patch into one section per file as it streams by, keeping each
 * section's header and, while it fits, its body. A section past
 * `MAX_FILE_PATCH_BYTES`, or past the total, keeps only its header and the
 * marker: the header is what names the file and says it was added, deleted or
 * renamed. Nothing past the caps is ever held.
 */
class PatchCapper {
  private readonly out: string[] = []
  private total = 0
  private header: string[] | null = null
  private body: string[] = []
  private bodyBytes = 0
  private inBody = false
  private oversize = false
  private partial = ''

  push(text: string): void {
    const lines = (this.partial + text).split('\n')
    this.partial = lines.pop() ?? ''
    for (const line of lines) this.line(line)
  }

  finish(): string {
    if (this.partial) this.line(this.partial)
    this.flush()
    return this.out.join('\n')
  }

  private line(line: string): void {
    if (line.startsWith('diff --git ')) {
      this.flush()
      this.header = [line]
      return
    }
    if (this.header === null) return
    if (
      !this.inBody &&
      (line.startsWith('@@') || line.startsWith('Binary files ') || line === 'GIT binary patch')
    ) {
      this.inBody = true
    }
    if (!this.inBody) {
      this.header.push(line)
      return
    }
    if (this.oversize) return
    this.bodyBytes += line.length + 1
    if (this.bodyBytes > MAX_FILE_PATCH_BYTES) {
      this.oversize = true
      this.body = []
      return
    }
    this.body.push(line)
  }

  private flush(): void {
    if (this.header === null) return
    const head = this.header.join('\n')
    const fits = !this.oversize && this.total + head.length + this.bodyBytes <= MAX_CAPPED_BYTES
    const section = fits ? [head, ...this.body].join('\n') : `${head}\n${TOO_LARGE_MARKER}`
    this.out.push(section)
    this.total += section.length + 1
    this.header = null
    this.body = []
    this.bodyBytes = 0
    this.inBody = false
    this.oversize = false
  }
}

/** The capping on its own, over a patch already in hand: tests. */
export function capPatchText(patch: string): string {
  const capper = new PatchCapper()
  capper.push(patch)
  return capper.finish()
}

function withPatchFile<T>(run: (file: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'diffo-diff-'))
  const done = () => rmSync(dir, { recursive: true, force: true })
  let result: T
  try {
    result = run(join(dir, 'patch'))
  } catch (err) {
    done()
    throw err
  }
  if (result instanceof Promise) return result.finally(done) as T
  done()
  return result
}

/**
 * `git diff <rev>`, or when that outgrows the buffer, the same diff written to a
 * file by git itself and read back capped, so one generated file or vendored
 * tree opens as a review with a note instead of killing the server.
 */
function diffWithin(root: string, rev: string): string {
  try {
    return git(root, ['diff', ...DIFF_FLAGS, rev])
  } catch (err) {
    if (!isOutputOverflow(err)) throw err
  }
  return withPatchFile((file) => {
    git(root, ['diff', ...DIFF_FLAGS, `--output=${file}`, rev])
    const capper = new PatchCapper()
    const decoder = new StringDecoder('utf-8')
    const chunk = Buffer.allocUnsafe(1024 * 1024)
    const fd = openSync(file, 'r')
    try {
      for (let read = readSync(fd, chunk); read > 0; read = readSync(fd, chunk)) {
        capper.push(decoder.write(chunk.subarray(0, read)))
      }
    } finally {
      closeSync(fd)
    }
    capper.push(decoder.end())
    return capper.finish()
  })
}

async function diffWithinAsync(root: string, rev: string): Promise<string> {
  try {
    return await gitAsync(root, ['diff', ...DIFF_FLAGS, rev])
  } catch (err) {
    if (!isOutputOverflow(err)) throw err
  }
  return withPatchFile(async (file) => {
    await gitAsync(root, ['diff', ...DIFF_FLAGS, `--output=${file}`, rev])
    const capper = new PatchCapper()
    for await (const text of createReadStream(file, { encoding: 'utf-8' })) {
      capper.push(text as string)
    }
    return capper.finish()
  })
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
    return diffWithinAsync(root, 'HEAD')
  }
  let mergeBase: string
  try {
    mergeBase = (await gitAsync(root, ['merge-base', spec.base, 'HEAD'])).trim()
  } catch {
    throw new MissingBaseError(spec.base)
  }
  return diffWithinAsync(root, mergeBase)
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

// ---------- commits: the changeset one step at a time ----------

const COMMIT_FIELDS = ['%H', '%h', '%an', '%aI', '%s', '%b'].join('%x1f')

export interface RawCommit {
  sha: string
  short: string
  author: string
  at: string
  subject: string
  body: string
  stats: { files: number; additions: number; deletions: number }
}

/** `3 files changed, 10 insertions(+), 2 deletions(-)` — any part may be absent. */
function parseShortstat(line: string): RawCommit['stats'] {
  const n = (re: RegExp) => Number.parseInt(re.exec(line)?.[1] ?? '0', 10)
  return {
    files: n(/(\d+) files? changed/),
    additions: n(/(\d+) insertions?\(\+\)/),
    deletions: n(/(\d+) deletions?\(-\)/),
  }
}

/**
 * The commits a branch review spans, oldest first. A working-tree review has
 * none: its changeset is not made of commits. Merges are skipped — what they
 * bring in is the base branch, which this review is not about.
 */
async function branchStart(root: string, base: string): Promise<string> {
  try {
    return (await gitAsync(root, ['merge-base', base, 'HEAD'])).trim()
  } catch {
    throw new MissingBaseError(base)
  }
}

/** Just the shas of `listCommitsAsync`, in the same order: a `rev-list`, no
 * per-commit stats, so a route that only needs to know whether a sha is in the
 * changeset does not pay for diffing every commit. */
export async function listCommitShasAsync(root: string, spec: ChangesetSpec): Promise<string[]> {
  if (spec.kind !== 'branch') return []
  const mergeBase = await branchStart(root, spec.base)
  const out = await gitAsync(root, ['rev-list', '--reverse', '--no-merges', `${mergeBase}..HEAD`])
  return out.split('\n').filter((sha) => sha !== '')
}

export async function listCommitsAsync(root: string, spec: ChangesetSpec): Promise<RawCommit[]> {
  if (spec.kind !== 'branch') return []
  const mergeBase = await branchStart(root, spec.base)
  const out = await gitAsync(root, [
    'log',
    '--reverse',
    '--no-merges',
    '--no-color',
    `--format=%x1e${COMMIT_FIELDS}%x1f`,
    '--shortstat',
    `${mergeBase}..HEAD`,
  ])
  return out
    .split('\x1e')
    .filter((chunk) => chunk.trim() !== '')
    .map((chunk) => {
      const [sha = '', short = '', author = '', at = '', subject = '', body = '', stat = ''] =
        chunk.split('\x1f')
      return { sha, short, author, at, subject, body: body.trim(), stats: parseShortstat(stat) }
    })
}

export async function getCommitMessageAsync(
  root: string,
  sha: string,
): Promise<{ subject: string; body: string }> {
  const out = await gitAsync(root, ['log', '-1', '--no-color', '--format=%s%x1f%b', sha])
  const [subject = '', body = ''] = out.split('\x1f')
  return { subject: subject.trim(), body: body.trim() }
}

/** One commit's own patch, against its first parent — or against nothing, for
 * a root commit, which `git show` handles where `sha^` would not resolve. */
export async function getCommitDiffAsync(root: string, sha: string): Promise<string> {
  return gitAsync(root, ['show', '--format=', '--patch', ...DIFF_FLAGS, sha])
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
      windowsHide: true,
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

// ---------- pull requests: refs, worktrees ----------

/**
 * The main checkout a path belongs to: itself for an ordinary repo, the repo
 * a linked worktree hangs off otherwise. `--git-common-dir` is the shared
 * `.git`, whose parent is that checkout.
 */
export function mainRepoOf(root: string): string {
  try {
    const common = git(root, ['rev-parse', '--path-format=absolute', '--git-common-dir']).trim()
    if (common.endsWith(`${sep}.git`) || common.endsWith('/.git')) return resolve(common, '..')
    return resolve(root)
  } catch {
    return resolve(root)
  }
}

/** The `origin` URL, or null when the repo has no such remote. */
export function getRemoteUrl(root: string, remote = 'origin'): string | null {
  try {
    const url = git(root, ['remote', 'get-url', remote]).trim()
    return url === '' ? null : url
  } catch {
    return null
  }
}

/** Every remote and the URL as configured — not the `insteadOf`-rewritten one
 * `get-url` reports, which is what git will talk to, not what it names. */
export function listRemotes(root: string): { name: string; url: string }[] {
  let out: string
  try {
    out = git(root, ['config', '--get-regexp', String.raw`^remote\..*\.url$`])
  } catch {
    return [] // no remotes at all: git exits 1 with nothing to say
  }
  const remotes: { name: string; url: string }[] = []
  for (const line of out.split('\n')) {
    const match = /^remote\.(.+)\.url (.+)$/.exec(line.trim())
    if (match) remotes.push({ name: match[1]!, url: match[2]! })
  }
  return remotes
}

/** Where a pull request's head lands locally: a Diffo-owned ref, never a branch
 * of the user's. */
export function prHeadRef(number: number): string {
  return `refs/diffo/pr/${number}`
}

/** Fetch `refs/pull/N/head` into {@link prHeadRef}. Forced: a force-push to
 * the PR must move the ref. Fully qualified on purpose — an unqualified
 * `pull/N/head` goes through git's ref guessing, which on a repeat fetch into an
 * existing destination resolves to nothing and deletes the local ref. */
/** A fetch talks to the network, and a network that answers nothing must not
 * hold a process forever: git itself has no timeout on a stalled transport, so
 * the child is killed after this long and the call fails like any other. No
 * prompt either — a daemon has no terminal to type a passphrase into. */
const FETCH_TIMEOUT_MS = 60_000
const FETCH_ENV = { ...process.env, GIT_TERMINAL_PROMPT: '0' }

function fetchSync(root: string, args: string[]): void {
  execFileSync('git', ['fetch', '--quiet', ...args], {
    cwd: root,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: MAX_BUFFER,
    windowsHide: true,
    timeout: FETCH_TIMEOUT_MS,
    env: FETCH_ENV,
  })
}

/** Opening a pull request fetches before anything is served — blocking is
 * free there. The daemon's periodic fetch is `fetchPrHeadAsync`: a sync fetch
 * on a stalled network once froze a server for twenty hours, tab and all. */
export function fetchPrHead(root: string, number: number, remote = 'origin'): void {
  fetchSync(root, [remote, `+refs/pull/${number}/head:${prHeadRef(number)}`])
}

export async function fetchPrHeadAsync(
  root: string,
  number: number,
  remote = 'origin',
): Promise<void> {
  await execFileAsync(
    'git',
    ['fetch', '--quiet', remote, `+refs/pull/${number}/head:${prHeadRef(number)}`],
    {
      cwd: root,
      encoding: 'utf-8',
      maxBuffer: MAX_BUFFER,
      windowsHide: true,
      timeout: FETCH_TIMEOUT_MS,
      env: FETCH_ENV,
    },
  )
}

/** Refresh `origin/<branch>` so the merge-base is against the remote's truth. */
export function fetchBranch(root: string, branch: string, remote = 'origin'): void {
  fetchSync(root, [remote, branch])
}

export async function fetchBranchAsync(
  root: string,
  branch: string,
  remote = 'origin',
): Promise<void> {
  await execFileAsync('git', ['fetch', '--quiet', remote, branch], {
    cwd: root,
    encoding: 'utf-8',
    maxBuffer: MAX_BUFFER,
    windowsHide: true,
    timeout: FETCH_TIMEOUT_MS,
    env: FETCH_ENV,
  })
}

export function revParse(root: string, ref: string): string | null {
  try {
    return git(root, ['rev-parse', '--verify', '--quiet', ref]).trim() || null
  } catch {
    return null
  }
}

/** `git worktree add -B <branch> <path> <ref>`: a fresh branch at the ref, or
 * the existing one reset there. */
export function worktreeAdd(root: string, path: string, branch: string, ref: string): void {
  git(root, ['worktree', 'add', '--quiet', '-B', branch, path, ref])
}

/** Remove a linked worktree. `force` discards uncommitted changes; without it a
 * dirty worktree makes git refuse, and this returns false. */
export function worktreeRemove(root: string, path: string, force: boolean): boolean {
  try {
    git(root, ['worktree', 'remove', ...(force ? ['--force'] : []), path])
    return true
  } catch {
    return false
  }
}

export function worktreePrune(root: string): void {
  try {
    git(root, ['worktree', 'prune'])
  } catch {
    // nothing to prune, or not a repo any more — either way nothing is owed
  }
}

/** Drop a Diffo-owned ref (`refs/diffo/pr/N`) once its worktree is gone. */
export function deleteRef(root: string, ref: string): void {
  try {
    git(root, ['update-ref', '-d', ref])
  } catch {
    // already gone — nothing owed
  }
}

export function deleteBranch(root: string, branch: string): void {
  try {
    git(root, ['branch', '-D', '--quiet', branch])
  } catch {
    // already gone, or checked out elsewhere — the worktree removal is what mattered
  }
}

/** No uncommitted changes and no untracked files: safe to move HEAD under.
 * Null when git cannot say (the main repo is gone, the path is not a
 * worktree): not clean, but not known dirty either. */
export function isWorktreeClean(path: string): boolean | null {
  try {
    return git(path, ['status', '--porcelain']).trim() === ''
  } catch {
    return null
  }
}

export function resetHard(path: string, ref: string): void {
  git(path, ['reset', '--hard', '--quiet', ref])
}
