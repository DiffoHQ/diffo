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
}
