import { execFile } from 'node:child_process'
import type { GhUser, PrCheckState, PrCommit, PrInfo, PrReviewEvent } from '../../shared/types.js'
import type {
  AuthStatus,
  ForgeClient,
  ImportedComment,
  ImportedThread,
  PrRef,
  ReviewDraftComment,
  ReviewEvent,
} from '../types.js'
import {
  ADD_COMMENT,
  ADD_REVIEW,
  ADD_THREAD,
  ADD_THREAD_REPLY,
  CHECKS_QUERY,
  COMMENTS_QUERY,
  PR_QUERY,
  RESOLVE_THREAD,
  REVIEWS_QUERY,
  SUBMIT_REVIEW,
  THREADS_QUERY,
  UNRESOLVE_THREAD,
} from './queries.js'

// The GitHub client, and the only place in Diffo that reaches the network — and
// even here not directly: every call is the user's own `gh`, so Diffo holds no
// token and honours whatever host `gh` is signed in to.

const MAX_BUFFER = 20 * 1024 * 1024

/** Run `gh` with these arguments and return stdout. Injectable for tests. */
export type GhExec = (args: string[]) => Promise<string>

export class GhError extends Error {
  constructor(
    message: string,
    readonly code?: string,
  ) {
    super(message)
    this.name = 'GhError'
  }
}

export const execGh: GhExec = (args) =>
  new Promise((resolvePromise, reject) => {
    execFile(
      'gh',
      args,
      {
        encoding: 'utf-8',
        maxBuffer: MAX_BUFFER,
        env: { ...process.env, GH_PROMPT_DISABLED: '1' },
      },
      (err, stdout, stderr) => {
        if (err) {
          const code = (err as NodeJS.ErrnoException).code
          if (code === 'ENOENT') {
            reject(
              new GhError('the GitHub CLI (`gh`) is not installed: https://cli.github.com', code),
            )
            return
          }
          const said = (stderr || stdout || err.message).trim().split('\n').slice(-3).join(' ')
          reject(new GhError(said || `gh exited with ${(err as { code?: unknown }).code}`))
          return
        }
        resolvePromise(stdout)
      },
    )
  })

const GHOST: GhUser = { login: 'ghost', avatarUrl: '' }

function user(raw: unknown): GhUser {
  if (typeof raw !== 'object' || raw === null) return GHOST
  const u = raw as { login?: unknown; avatarUrl?: unknown }
  return {
    login: typeof u.login === 'string' ? u.login : GHOST.login,
    avatarUrl: typeof u.avatarUrl === 'string' ? u.avatarUrl : '',
  }
}

function checkState(raw: unknown): PrCheckState {
  switch (raw) {
    case 'SUCCESS':
      return 'success'
    case 'FAILURE':
    case 'ERROR':
      return 'failure'
    case 'PENDING':
    case 'EXPECTED':
      return 'pending'
    default:
      return 'none'
  }
}

type Json = Record<string, unknown>

/** A GraphQL connection as the queries here shape it: one page. */
interface Page {
  pageInfo?: { hasNextPage?: boolean; endCursor?: string }
  nodes?: Json[]
}

export class GhClient implements ForgeClient {
  constructor(private exec: GhExec = execGh) {}

  private async graphql<T>(host: string, query: string, variables: Json): Promise<T> {
    const args = ['api', 'graphql', '--hostname', host, '-f', `query=${query}`]
    for (const [key, value] of Object.entries(variables)) {
      if (value === undefined || value === null) continue
      // -F types numbers and booleans; -f keeps a string a string, digits included.
      args.push(typeof value === 'string' ? '-f' : '-F', `${key}=${String(value)}`)
    }
    const out = await this.exec(args)
    let parsed: { data?: T; errors?: { message: string }[] }
    try {
      parsed = JSON.parse(out) as typeof parsed
    } catch {
      throw new GhError(`gh returned something that is not JSON: ${out.slice(0, 200)}`)
    }
    if (parsed.errors?.length) throw new GhError(parsed.errors.map((e) => e.message).join('; '))
    if (!parsed.data) throw new GhError('gh returned no data')
    return parsed.data
  }

  async authStatus(host: string): Promise<AuthStatus> {
    try {
      const out = await this.exec(['api', '--hostname', host, 'user', '--jq', '.login'])
      const login = out.trim()
      if (!login) return { ok: false, message: `gh is signed in to ${host} but reported no login` }
      return { ok: true, login }
    } catch (err) {
      const message = err instanceof GhError ? err.message : String(err)
      if (err instanceof GhError && err.code === 'ENOENT') return { ok: false, message }
      return {
        ok: false,
        message: `not signed in to ${host} with gh; run \`gh auth login --hostname ${host}\` (${message})`,
      }
    }
  }

  /**
   * The rest of a connection the PR query opened: `first` is its first page,
   * the query fetches the ones after it. A pending review past the first hundred
   * reviews, or the hundred-and-first comment, is otherwise simply not there.
   */
  private async allPages(
    ref: PrRef,
    query: string,
    connection: 'reviews' | 'comments',
    first: Page | undefined,
  ): Promise<Json[]> {
    const nodes: Json[] = [...(first?.nodes ?? [])]
    let info = first?.pageInfo
    while (info?.hasNextPage && info.endCursor) {
      const page = await this.graphql<{ repository: { pullRequest: Json | null } | null }>(
        ref.host,
        query,
        { owner: ref.owner, name: ref.repo, number: ref.number, cursor: info.endCursor },
      )
      const next = page.repository?.pullRequest?.[connection] as Page | undefined
      if (!next) break
      nodes.push(...(next.nodes ?? []))
      info = next.pageInfo
    }
    return nodes
  }

  /** The PR query's answer: the pull request, with the first page of its
   * reviews and comments riding along. Both public reads start here. */
  private async head(ref: PrRef): Promise<{ viewer: string; pr: Json; reviewNodes: Json[] }> {
    const data = await this.graphql<{
      viewer: { login: string }
      repository: { pullRequest: Json | null } | null
    }>(ref.host, PR_QUERY, { owner: ref.owner, name: ref.repo, number: ref.number })
    const pr = data.repository?.pullRequest
    if (!pr) throw new GhError(`no pull request #${ref.number} in ${ref.owner}/${ref.repo}`)
    const reviewNodes = await this.allPages(ref, REVIEWS_QUERY, 'reviews', pr.reviews as Page)
    return { viewer: data.viewer.login, pr, reviewNodes }
  }

  /** CI on the head commit, best effort: a token without the checks scope
   * gets `unknown` and the review opens anyway. Never throws. */
  private async checks(ref: PrRef): Promise<PrCheckState> {
    try {
      const data = await this.graphql<{
        repository: { pullRequest: { commits: { nodes: Json[] } } | null } | null
      }>(ref.host, CHECKS_QUERY, { owner: ref.owner, name: ref.repo, number: ref.number })
      const commit = data.repository?.pullRequest?.commits.nodes.at(-1)?.commit as Json | undefined
      const rollup = commit?.statusCheckRollup as Json | null | undefined
      return checkState(rollup?.state)
    } catch {
      return 'unknown'
    }
  }

  async getPr(ref: PrRef): Promise<PrInfo> {
    const [{ viewer, pr, reviewNodes }, checks] = await Promise.all([
      this.head(ref),
      this.checks(ref),
    ])
    return prInfo(ref, viewer, pr, reviewNodes, checks)
  }

  async listThreads(ref: PrRef): Promise<ImportedThread[]> {
    const { pr, reviewNodes } = await this.head(ref)
    return this.conversation(ref, pr, reviewNodes)
  }

  async fetchPr(ref: PrRef): Promise<{ pr: PrInfo; threads: ImportedThread[] }> {
    const [{ viewer, pr, reviewNodes }, checks] = await Promise.all([
      this.head(ref),
      this.checks(ref),
    ])
    return {
      pr: prInfo(ref, viewer, pr, reviewNodes, checks),
      threads: await this.conversation(ref, pr, reviewNodes),
    }
  }

  /** Reviews with a body and the conversation's comments from the PR query's
   * pages; inline threads paginate on their own. */
  private async conversation(ref: PrRef, pr: Json, reviewNodes: Json[]): Promise<ImportedThread[]> {
    const out: ImportedThread[] = []
    for (const r of reviewNodes) {
      if (r.state === 'PENDING' || typeof r.body !== 'string' || r.body.trim() === '') continue
      out.push({
        kind: 'review',
        id: String(r.id),
        state: r.state as 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED' | 'DISMISSED',
        comments: [comment(r, 'submittedAt')],
      })
    }
    for (const c of await this.allPages(ref, COMMENTS_QUERY, 'comments', pr.comments as Page)) {
      out.push({ kind: 'comment', id: String(c.id), comments: [comment(c, 'createdAt')] })
    }
    let cursor: string | null = null
    for (;;) {
      const page: { repository: { pullRequest: Json | null } | null } = await this.graphql(
        ref.host,
        THREADS_QUERY,
        { owner: ref.owner, name: ref.repo, number: ref.number, cursor },
      )
      const threads = page.repository?.pullRequest?.reviewThreads as Json | undefined
      if (!threads) break
      for (const t of (threads.nodes as Json[]) ?? []) {
        const comments = (((t.comments as Json).nodes as Json[]) ?? []).map((c) =>
          comment(c, 'createdAt'),
        )
        if (comments.length === 0) continue
        out.push({
          kind: 'inline',
          id: String(t.id),
          resolved: t.isResolved === true,
          outdated: t.isOutdated === true,
          path: String(t.path),
          line: typeof t.line === 'number' ? t.line : null,
          startLine: typeof t.startLine === 'number' ? t.startLine : null,
          side: t.diffSide === 'LEFT' ? 'LEFT' : 'RIGHT',
          comments,
        })
      }
      const info = threads.pageInfo as { hasNextPage?: boolean; endCursor?: string } | undefined
      if (!info?.hasNextPage || !info.endCursor) break
      cursor = info.endCursor
    }
    return out
  }

  async createPendingReview(ref: PrRef, prNodeId: string, headSha: string): Promise<string> {
    const data = await this.graphql<{
      addPullRequestReview: { pullRequestReview: { id: string } }
    }>(ref.host, ADD_REVIEW, { pullRequestId: prNodeId, commitOID: headSha })
    return data.addPullRequestReview.pullRequestReview.id
  }
  async addReviewThread(
    ref: PrRef,
    reviewId: string,
    draft: ReviewDraftComment,
  ): Promise<{ threadId: string; commentId: string; url?: string }> {
    const data = await this.graphql<{
      addPullRequestReviewThread: {
        thread: { id: string; comments: { nodes: { id: string; url?: string }[] } }
      }
    }>(ref.host, ADD_THREAD, {
      reviewId,
      path: draft.path,
      body: draft.body,
      subjectType: draft.subjectType,
      ...(draft.subjectType === 'LINE'
        ? {
            line: draft.line,
            side: draft.side ?? 'RIGHT',
            ...(draft.startLine !== undefined
              ? { startLine: draft.startLine, startSide: draft.startSide ?? draft.side ?? 'RIGHT' }
              : {}),
          }
        : {}),
    })
    const thread = data.addPullRequestReviewThread.thread
    const first = thread.comments.nodes[0]
    return {
      threadId: thread.id,
      commentId: first?.id ?? '',
      ...(first?.url ? { url: first.url } : {}),
    }
  }

  async replyToThread(
    ref: PrRef,
    reviewId: string | null,
    threadId: string,
    body: string,
  ): Promise<{ commentId: string; url?: string }> {
    const data = await this.graphql<{
      addPullRequestReviewThreadReply: { comment: { id: string; url?: string } }
    }>(ref.host, ADD_THREAD_REPLY, { reviewId, threadId, body })
    const c = data.addPullRequestReviewThreadReply.comment
    return { commentId: c.id, ...(c.url ? { url: c.url } : {}) }
  }

  async addPrComment(
    ref: PrRef,
    prNodeId: string,
    body: string,
  ): Promise<{ commentId: string; url?: string }> {
    const data = await this.graphql<{
      addComment: { commentEdge: { node: { id: string; url?: string } } }
    }>(ref.host, ADD_COMMENT, { subjectId: prNodeId, body })
    const n = data.addComment.commentEdge.node
    return { commentId: n.id, ...(n.url ? { url: n.url } : {}) }
  }

  async setThreadResolved(ref: PrRef, threadId: string, resolved: boolean): Promise<void> {
    await this.graphql(ref.host, resolved ? RESOLVE_THREAD : UNRESOLVE_THREAD, { threadId })
  }

  async submitReview(
    ref: PrRef,
    reviewId: string,
    event: ReviewEvent,
    body: string,
  ): Promise<{ url?: string }> {
    const data = await this.graphql<{
      submitPullRequestReview: { pullRequestReview: { id: string; url?: string } }
    }>(ref.host, SUBMIT_REVIEW, { reviewId, event, body })
    const r = data.submitPullRequestReview.pullRequestReview
    return r.url ? { url: r.url } : {}
  }
}

/** The PR query's answer as a PrInfo, with every review page in hand. */
function prInfo(
  ref: PrRef,
  viewer: string,
  pr: Json,
  reviewNodes: Json[],
  checks: PrCheckState,
): PrInfo {
  const commitNodes = ((pr.commits as Json).nodes as Json[]) ?? []
  const commits: PrCommit[] = commitNodes.map((n) => {
    const c = n.commit as Json
    const author = c.author as Json | null
    return {
      sha: String(c.oid),
      subject: String(c.messageHeadline ?? ''),
      author: author?.user ? user(author.user) : null,
      at: String(c.committedDate ?? ''),
    }
  })
  const reviews: PrReviewEvent[] = reviewNodes.map((r) => ({
    id: String(r.id),
    author: user(r.author),
    state: r.state as PrReviewEvent['state'],
    at: String(r.submittedAt ?? ''),
    hasBody: typeof r.body === 'string' && r.body.trim() !== '',
  }))
  // Approval counts follow GitHub's rule: one vote per reviewer, the latest wins.
  const latest = new Map<string, PrReviewEvent['state']>()
  for (const r of reviews) {
    if (r.state === 'APPROVED' || r.state === 'CHANGES_REQUESTED' || r.state === 'DISMISSED') {
      latest.set(r.author.login, r.state)
    }
  }
  const pending = reviews.find((r) => r.state === 'PENDING' && r.author.login === viewer)
  const author = user(pr.author)
  return {
    host: ref.host,
    owner: ref.owner,
    repo: ref.repo,
    number: ref.number,
    nodeId: String(pr.id),
    url: String(pr.url),
    title: String(pr.title ?? ''),
    body: String(pr.body ?? ''),
    author,
    state: pr.merged === true ? 'merged' : pr.state === 'CLOSED' ? 'closed' : 'open',
    draft: pr.isDraft === true,
    base: { ref: String(pr.baseRefName), sha: String(pr.baseRefOid) },
    head: { ref: String(pr.headRefName), sha: String(pr.headRefOid) },
    commits,
    checks: { state: checks },
    reviews: reviews.filter((r) => r.state !== 'PENDING'),
    approvals: [...latest.values()].filter((s) => s === 'APPROVED').length,
    changesRequested: [...latest.values()].filter((s) => s === 'CHANGES_REQUESTED').length,
    viewer: {
      login: viewer,
      isAuthor: author.login === viewer,
      pendingReviewId: pending?.id ?? null,
    },
    fetchedAt: new Date().toISOString(),
  }
}

function comment(raw: Json, atField: 'createdAt' | 'submittedAt'): ImportedComment {
  return {
    id: String(raw.id),
    user: user(raw.author),
    body: String(raw.body ?? ''),
    at: String(raw[atField] ?? ''),
    ...(typeof raw.url === 'string' ? { url: raw.url } : {}),
  }
}
