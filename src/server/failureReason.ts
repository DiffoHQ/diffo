/**
 * Why an open failed, as one fixed word for `review_failed`. The step says
 * where it stopped; this says what went wrong there. Read from the error's
 * code and shape, never sent as its text: the text can name a path, a branch,
 * or a pull request, and nothing outside this list ever leaves the machine.
 */
export type FailureReason =
  /** The review server was still starting when the CLI stopped waiting. */
  | 'timeout'
  /** The review server exited before it was ready, for a reason not below. */
  | 'exited'
  /** A server from another build would not step aside. */
  | 'stuck'
  /** A git command's output outgrew the buffer (ENOBUFS / maxBuffer). */
  | 'too_large'
  /** `git` itself could not be run. */
  | 'git_missing'
  /** `git fetch` ran out of time. */
  | 'fetch_timeout'
  /** `git fetch` failed. */
  | 'fetch'
  /** `git worktree` failed. */
  | 'git_worktree'
  /** `git reset` failed. */
  | 'git_reset'
  /** `git diff` failed. */
  | 'git_diff'
  /** Another git command failed. */
  | 'git'
  /** No remote points at the pull request's repository. */
  | 'no_remote'
  /** The worktree's directory is there but is not a worktree. */
  | 'dir_exists'
  /** The fetch ran but the pull request's head is not there. */
  | 'head_missing'
  /** Diffo's own SQLite database. */
  | 'db'
  /** Too many open files. */
  | 'files'
  /** The OS refused access. */
  | 'permission'
  | 'other'

/** git subcommands with a word of their own; the rest are `git`. */
const GIT_SUBCOMMANDS: Record<string, FailureReason> = {
  fetch: 'fetch',
  worktree: 'git_worktree',
  reset: 'git_reset',
  diff: 'git_diff',
}

interface ErrorShape {
  message?: unknown
  code?: unknown
  path?: unknown
  spawnargs?: unknown
}

/**
 * One word for an error, or for the text a crashed daemon left in its log
 * (the CLI only sees the daemon's last line, never its error object).
 */
export function failureReason(err: unknown): FailureReason {
  const e: ErrorShape = typeof err === 'object' && err !== null ? (err as ErrorShape) : {}
  const message = typeof err === 'string' ? err : typeof e.message === 'string' ? e.message : ''
  const code = typeof e.code === 'string' ? e.code : ''
  const args = Array.isArray(e.spawnargs) ? e.spawnargs : []
  // `spawnargs` is ['git', 'fetch', …] for execFile and ['fetch', …] in some
  // spawnSync errors; the message is `Command failed: git fetch …` for both.
  const sub =
    (args[0] === 'git' ? args[1] : e.path === 'git' ? args[0] : undefined) ??
    /(?:Command failed: |spawnSync |spawn )git (\S+)/.exec(message)?.[1]
  const isGit = e.path === 'git' || args[0] === 'git' || /\bgit\b/.test(message)

  if (code === 'ENOBUFS' || code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return 'too_large'
  if (/ENOBUFS|maxBuffer length exceeded/.test(message)) return 'too_large'
  if ((code === 'ENOENT' && isGit) || /spawn(?:Sync)? git ENOENT/.test(message)) {
    return 'git_missing'
  }
  if (code === 'EMFILE' || /\bEMFILE\b/.test(message)) return 'files'
  if (code === 'EACCES' || code === 'EPERM' || /\b(?:EACCES|EPERM)\b/.test(message)) {
    return 'permission'
  }
  if (code.startsWith('SQLITE') || code === 'ERR_SQLITE_ERROR') return 'db'
  if (/\bSQLITE_|no such table|database is locked|database disk image/i.test(message)) return 'db'
  if (/would not step aside/.test(message)) return 'stuck'
  if (/^no remote points at |: no remote points at /.test(message)) return 'no_remote'
  if (/exists but is not a worktree/.test(message)) return 'dir_exists'
  if (/could not fetch pull request #\d+'s head/.test(message)) return 'head_missing'
  if (sub === 'fetch' && (code === 'ETIMEDOUT' || /ETIMEDOUT/.test(message))) {
    return 'fetch_timeout'
  }
  if (typeof sub === 'string' && isGit) return GIT_SUBCOMMANDS[sub] ?? 'git'
  return 'other'
}
