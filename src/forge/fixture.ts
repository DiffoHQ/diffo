import type { PrInfo } from '../shared/types.js'
import type {
  AuthStatus,
  ForgeClient,
  ImportedComment,
  ImportedThread,
  PrRef,
  ReviewDraftComment,
  ReviewEvent,
} from './types.js'

// The forge every test talks to: a pull request in memory, mutations recorded
// and reflected, no network anywhere near it.

export interface FixtureCall {
  method: string
  args: unknown[]
}

export class FixtureForge implements ForgeClient {
  calls: FixtureCall[] = []
  /** Set to make every call fail — the partial-failure paths. */
  failNext: Error | null = null
  private seq = 0
  login = 'reviewer-x'
  auth: AuthStatus = { ok: true, login: 'reviewer-x' }

  constructor(
    public pr: PrInfo,
    public threads: ImportedThread[] = [],
  ) {}

  private record(method: string, args: unknown[]): void {
    this.calls.push({ method, args })
    if (this.failNext) {
      const err = this.failNext
      this.failNext = null
      throw err
    }
  }

  private nextId(prefix: string): string {
    this.seq++
    return `${prefix}_${this.seq}`
  }

  private mine(body: string, id: string): ImportedComment {
    return {
      id,
      user: { login: this.login, avatarUrl: '' },
      body,
      at: new Date().toISOString(),
      url: `${this.pr.url}#discussion_r${id}`,
    }
  }

  async authStatus(host: string): Promise<AuthStatus> {
    this.record('authStatus', [host])
    return this.auth
  }

  async getPr(ref: PrRef): Promise<PrInfo> {
    this.record('getPr', [ref])
    return structuredClone(this.pr)
  }

  async listThreads(ref: PrRef): Promise<ImportedThread[]> {
    this.record('listThreads', [ref])
    return structuredClone(this.threads)
  }

  async fetchPr(ref: PrRef): Promise<{ pr: PrInfo; threads: ImportedThread[] }> {
    this.record('fetchPr', [ref])
    return { pr: structuredClone(this.pr), threads: structuredClone(this.threads) }
  }

  async createPendingReview(ref: PrRef, prNodeId: string, headSha: string): Promise<string> {
    this.record('createPendingReview', [ref, prNodeId, headSha])
    const id = this.nextId('PRR')
    this.pr.viewer.pendingReviewId = id
    return id
  }

  async addReviewThread(
    ref: PrRef,
    reviewId: string,
    draft: ReviewDraftComment,
  ): Promise<{ threadId: string; commentId: string; url?: string }> {
    this.record('addReviewThread', [ref, reviewId, draft])
    const threadId = this.nextId('PRRT')
    const commentId = this.nextId('PRRC')
    this.threads.push({
      kind: 'inline',
      id: threadId,
      resolved: false,
      outdated: false,
      path: draft.path,
      line: draft.line ?? null,
      startLine: draft.startLine ?? null,
      side: draft.side ?? 'RIGHT',
      comments: [this.mine(draft.body, commentId)],
    })
    return { threadId, commentId, url: `${this.pr.url}#discussion_r${commentId}` }
  }

  async replyToThread(
    ref: PrRef,
    reviewId: string | null,
    threadId: string,
    body: string,
  ): Promise<{ commentId: string; url?: string }> {
    this.record('replyToThread', [ref, reviewId, threadId, body])
    const commentId = this.nextId('PRRC')
    const thread = this.threads.find((t) => t.kind === 'inline' && t.id === threadId)
    if (thread?.kind === 'inline') thread.comments.push(this.mine(body, commentId))
    return { commentId }
  }

  async addPrComment(
    ref: PrRef,
    prNodeId: string,
    body: string,
  ): Promise<{ commentId: string; url?: string }> {
    this.record('addPrComment', [ref, prNodeId, body])
    const commentId = this.nextId('IC')
    this.threads.push({ kind: 'comment', id: commentId, comments: [this.mine(body, commentId)] })
    return { commentId }
  }

  async setThreadResolved(ref: PrRef, threadId: string, resolved: boolean): Promise<void> {
    this.record('setThreadResolved', [ref, threadId, resolved])
    const thread = this.threads.find((t) => t.kind === 'inline' && t.id === threadId)
    if (thread?.kind === 'inline') thread.resolved = resolved
  }

  async submitReview(
    ref: PrRef,
    reviewId: string,
    event: ReviewEvent,
    body: string,
  ): Promise<{ url?: string }> {
    this.record('submitReview', [ref, reviewId, event, body])
    if (this.pr.viewer.isAuthor && event !== 'COMMENT') {
      throw new Error('Can not approve your own pull request')
    }
    this.pr.viewer.pendingReviewId = null
    const state =
      event === 'APPROVE'
        ? 'APPROVED'
        : event === 'REQUEST_CHANGES'
          ? 'CHANGES_REQUESTED'
          : 'COMMENTED'
    this.pr.reviews.push({
      id: reviewId,
      author: { login: this.login, avatarUrl: '' },
      state,
      at: new Date().toISOString(),
      hasBody: body.trim() !== '',
    })
    if (body.trim() !== '') {
      this.threads.push({
        kind: 'review',
        id: reviewId,
        state,
        comments: [this.mine(body, reviewId)],
      })
    }
    return { url: `${this.pr.url}#pullrequestreview-${reviewId}` }
  }
}

/** A small, plausible pull request for tests to start from. */
export function fixturePr(over: Partial<PrInfo> = {}): PrInfo {
  return {
    host: 'github.com',
    owner: 'acme',
    repo: 'widgets',
    number: 482,
    nodeId: 'PR_kwDO_482',
    url: 'https://github.com/acme/widgets/pull/482',
    title: 'Retry flaky uploads with jittered backoff',
    body: 'Uploads fail under load. This adds full jitter to the retry delay.',
    author: { login: 'mira-k', avatarUrl: '' },
    state: 'open',
    draft: false,
    base: { ref: 'main', sha: 'b'.repeat(40) },
    head: { ref: 'fix/upload-retry', sha: 'h'.repeat(40) },
    commits: [
      {
        sha: 'c'.repeat(40),
        subject: 'Add jitter to retry delay',
        author: { login: 'mira-k', avatarUrl: '' },
        at: '2026-09-20T10:00:00Z',
      },
    ],
    checks: { state: 'success' },
    reviews: [],
    approvals: 0,
    changesRequested: 0,
    viewer: { login: 'reviewer-x', isAuthor: false, pendingReviewId: null },
    fetchedAt: '2026-09-24T10:00:00Z',
    ...over,
  }
}
