export type ChangesetSpec = { kind: 'working-tree' } | { kind: 'branch'; base: string }

export type LineKind = 'context' | 'add' | 'del'

export interface DiffLine {
  kind: LineKind
  /** 1-based line number in the base version; null for added lines. */
  oldNo: number | null
  /** 1-based line number in the head version; null for deleted lines. */
  newNo: number | null
  text: string
}

export interface Hunk {
  /** Stable content-addressed ID: hash(path + changed lines + occurrence). */
  id: string
  path: string
  oldStart: number
  newStart: number
  lines: DiffLine[]
  /**
   * The enclosing scope git itself prints after the `@@ … @@`. Absent when git had
   * nothing to say. Deliberately *not* part of the hunk id: a hunk must not rotate
   * its identity because the function above it was renamed.
   */
  context?: string
}

export type FileStatus = 'added' | 'modified' | 'deleted' | 'renamed'
export type FileKind = 'text' | 'binary' | 'image' | 'symlink'

export interface FileChange {
  path: string
  oldPath: string | null
  status: FileStatus
  kind: FileKind
  staged: boolean
  hunks: Hunk[]
  /**
   * Head-side line count, filled in server-side when the head file is readable
   * text. Sizes the expandable gap below the last hunk; null/absent means unknown
   * and that gap simply isn't offered.
   */
  newLineCount?: number | null
}

export interface ChangesetStats {
  files: number
  additions: number
  deletions: number
}

export interface Changeset {
  version: number
  spec: ChangesetSpec
  repo: { path: string; name: string; branch: string; worktree: string | null }
  files: FileChange[]
  stats: ChangesetStats
  /**
   * Present only when the server was opened on a pull request. The diff itself
   * is an ordinary branch diff inside a Diffo-owned worktree; this block is what
   * the UI and the prompts add on top. Refreshed by the forge puller, never by
   * the fs watcher.
   */
  pr?: PrInfo
}

export interface GhUser {
  login: string
  avatarUrl: string
}

export interface PrCommit {
  sha: string
  subject: string
  author: GhUser | null
  at: string
}

/** CI on the head commit. `none` is GitHub saying there are no checks;
 * `unknown` is Diffo not being allowed to ask. */
export type PrCheckState = 'pending' | 'success' | 'failure' | 'none' | 'unknown'

export interface PrReviewEvent {
  /** GraphQL node id — what replies and resolves address. */
  id: string
  author: GhUser
  state: 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED' | 'DISMISSED' | 'PENDING'
  at: string
  hasBody: boolean
}

export interface PrInfo {
  host: string
  owner: string
  repo: string
  number: number
  /** GraphQL node id of the pull request — the subject for a general comment
   * and the anchor for a new review. */
  nodeId: string
  url: string
  title: string
  body: string
  author: GhUser
  state: 'open' | 'closed' | 'merged'
  draft: boolean
  base: { ref: string; sha: string }
  head: { ref: string; sha: string }
  commits: PrCommit[]
  checks: { state: PrCheckState; url?: string }
  reviews: PrReviewEvent[]
  approvals: number
  changesRequested: number
  viewer: { login: string; isAuthor: boolean; pendingReviewId: string | null }
  fetchedAt: string
}

/** The working-tree edits a branch review also carries, listed after the
 * commits as one more step to read. Not a sha, so it can never collide with one. */
export const UNCOMMITTED = 'uncommitted'

/** One commit in the changeset, as the Commits tab lists it — or the
 * `UNCOMMITTED` pseudo-entry, which has no author or date of its own. */
export interface CommitInfo {
  sha: string
  short: string
  subject: string
  body: string
  author: string | null
  at: string | null
  stats: ChangesetStats
}

export interface CommitsResponse {
  /** Oldest first: the order the change was written in. Merges are left out —
   * their first-parent diff is the base branch, not the change. */
  commits: CommitInfo[]
}

/** One commit's own diff — `sha^..sha`, not the cumulative one. */
export interface CommitChangeset {
  sha: string
  files: FileChange[]
}
