import type { GhUser, PrInfo } from '../shared/types.js'

// The forge seam. Core talks to this interface only; `github/` is the first
// implementation and `fixture.ts` is what tests use. Every method takes typed
// arguments — nothing from PR content ever selects a command or a flag.

export interface PrRef {
  host: string
  owner: string
  repo: string
  number: number
}

/** `github.com/DiffoHQ/diffo#482` — the one spelling every table and log uses. */
export function prRefKey(ref: PrRef): string {
  return `${ref.host}/${ref.owner}/${ref.repo}#${ref.number}`
}

export interface ImportedComment {
  /** GraphQL node id. */
  id: string
  user: GhUser
  body: string
  at: string
  url?: string
}

/** An inline review thread on the pull request. */
export interface ImportedInlineThread {
  kind: 'inline'
  id: string
  resolved: boolean
  outdated: boolean
  path: string
  /** GitHub's `line` is the LAST line of a range; `startLine` the first. Null on
   * an outdated thread whose line left the diff. */
  line: number | null
  startLine: number | null
  side: 'LEFT' | 'RIGHT'
  comments: ImportedComment[]
}

/** A review with a body: approved, changes requested, or just commented. */
export interface ImportedReviewBody {
  kind: 'review'
  id: string
  state: 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED' | 'DISMISSED'
  comments: [ImportedComment]
}

/** A general comment on the pull request's conversation. */
export interface ImportedIssueComment {
  kind: 'comment'
  id: string
  comments: [ImportedComment]
}

export type ImportedThread = ImportedInlineThread | ImportedReviewBody | ImportedIssueComment

export type ReviewEvent = 'COMMENT' | 'APPROVE' | 'REQUEST_CHANGES'

/** One new review comment, positioned the way GitHub wants it. */
export interface ReviewDraftComment {
  path: string
  body: string
  subjectType: 'LINE' | 'FILE'
  /** LINE only: the (last) line and its side; `startLine` opens a range. */
  line?: number
  side?: 'LEFT' | 'RIGHT'
  startLine?: number
  startSide?: 'LEFT' | 'RIGHT'
}

export type AuthStatus = { ok: true; login: string } | { ok: false; message: string }

export interface ForgeClient {
  /** Is the user signed in for this host, and as whom? Never throws: a missing
   * CLI or a signed-out host comes back as `{ ok: false, message }`. */
  authStatus(host: string): Promise<AuthStatus>
  getPr(ref: PrRef): Promise<PrInfo>
  listThreads(ref: PrRef): Promise<ImportedThread[]>
  /** Both of the above from one read of the pull request: what a poll asks. */
  fetchPr(ref: PrRef): Promise<{ pr: PrInfo; threads: ImportedThread[] }>
  /** Open a pending review at `headSha`; returns its node id. */
  createPendingReview(ref: PrRef, prNodeId: string, headSha: string): Promise<string>
  addReviewThread(
    ref: PrRef,
    reviewId: string,
    draft: ReviewDraftComment,
  ): Promise<{ threadId: string; commentId: string; url?: string }>
  /** `reviewId` null replies outside a pending review (posted at once). */
  replyToThread(
    ref: PrRef,
    reviewId: string | null,
    threadId: string,
    body: string,
  ): Promise<{ commentId: string; url?: string }>
  /** A general comment on the PR conversation. */
  addPrComment(
    ref: PrRef,
    prNodeId: string,
    body: string,
  ): Promise<{ commentId: string; url?: string }>
  setThreadResolved(ref: PrRef, threadId: string, resolved: boolean): Promise<void>
  submitReview(
    ref: PrRef,
    reviewId: string,
    event: ReviewEvent,
    body: string,
  ): Promise<{ url?: string }>
}
