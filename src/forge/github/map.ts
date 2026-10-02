import type { Anchor, ReviewMessage, ReviewThread } from '../../shared/review.js'
import type { FileChange, PrInfo } from '../../shared/types.js'
import type {
  ImportedComment,
  ImportedInlineThread,
  ImportedThread,
  ReviewDraftComment,
} from '../types.js'

// Both directions between GitHub's shapes and Diffo's. Pure: files in, threads
// out — so the whole mapping is testable against fixtures.

/** Every thread that came from GitHub carries a stable id derived from its node
 * id, which is what makes a re-import an upsert rather than a duplicate. */
export function githubThreadId(nodeId: string): string {
  return `gh:${nodeId}`
}

export function descriptionThreadId(pr: Pick<PrInfo, 'nodeId'>): string {
  return `gh:description:${pr.nodeId}`
}

export function messageFromComment(c: ImportedComment): ReviewMessage {
  return {
    id: `gh:${c.id}`,
    author: 'github',
    text: c.body,
    at: c.at,
    github: { id: c.id, user: c.user, ...(c.url ? { url: c.url } : {}) },
  }
}

/**
 * Where an inline GitHub thread lands in the current diff. GitHub's `line` is
 * the last line of the range and `startLine` the first, both on `diffSide`.
 * Found ⇒ a hunk anchor; not found (the thread is outdated, or GitHub's diff
 * differs from ours) ⇒ the file, and `placed: false` so the caller can keep it
 * out of the file body.
 */
export function anchorForImported(
  thread: ImportedInlineThread,
  files: readonly FileChange[],
): { anchor: Anchor; placed: boolean } {
  const fallback = { anchor: { kind: 'file', path: thread.path } as Anchor, placed: false }
  if (thread.line === null) return fallback
  const side = thread.side === 'LEFT' ? 'old' : 'new'
  const file = files.find((f) => f.path === thread.path || f.oldPath === thread.path)
  if (!file) return fallback
  const end = thread.line
  const start = thread.startLine ?? end
  const hunk = file.hunks.find((h) =>
    h.lines.some((l) =>
      side === 'old' ? l.kind !== 'add' && l.oldNo === end : l.kind !== 'del' && l.newNo === end,
    ),
  )
  if (!hunk) return fallback
  return {
    anchor: {
      kind: 'hunk',
      hunkId: hunk.id,
      path: file.path,
      side,
      line: start,
      ...(end > start ? { endLine: end } : {}),
    },
    placed: true,
  }
}

/**
 * The pull request's conversation as Diffo threads: the description first, then
 * reviews with a body and general comments in time order, then inline threads.
 * All public, all with a `github` block; states follow GitHub (resolved or not).
 */
export function threadsFromGithub(
  pr: PrInfo,
  imported: readonly ImportedThread[],
  files: readonly FileChange[],
): ReviewThread[] {
  const now = new Date().toISOString()
  const out: ReviewThread[] = []
  const descriptionAt = pr.commits[0]?.at || pr.fetchedAt
  out.push({
    id: descriptionThreadId(pr),
    anchor: { kind: 'changeset' },
    state: 'sent',
    audience: 'pr',
    github: {
      threadId: 'description',
      kind: 'description',
      resolved: false,
      outdated: false,
      url: pr.url,
    },
    codeContext: null,
    codeChanged: false,
    messages: [
      {
        id: `${descriptionThreadId(pr)}:body`,
        author: 'github',
        text: pr.body.trim() === '' ? '_No description._' : pr.body,
        at: descriptionAt,
        github: { id: pr.nodeId, user: pr.author, url: pr.url },
      },
    ],
    createdAt: descriptionAt,
    updatedAt: descriptionAt,
  })
  const conversation = imported
    .filter((t): t is Exclude<ImportedThread, ImportedInlineThread> => t.kind !== 'inline')
    .sort((a, b) => a.comments[0].at.localeCompare(b.comments[0].at))
  for (const t of conversation) {
    const message = messageFromComment(t.comments[0])
    out.push({
      id: githubThreadId(t.id),
      anchor: { kind: 'changeset' },
      state: 'sent',
      audience: 'pr',
      github: {
        threadId: t.id,
        kind: t.kind,
        ...(t.kind === 'review' ? { reviewState: t.state } : {}),
        resolved: false,
        outdated: false,
        ...(t.comments[0].url ? { url: t.comments[0].url } : {}),
      },
      codeContext: null,
      codeChanged: false,
      messages: [message],
      createdAt: message.at || now,
      updatedAt: message.at || now,
    })
  }
  for (const t of imported) {
    if (t.kind !== 'inline') continue
    const { anchor, placed } = anchorForImported(t, files)
    const messages = t.comments.map(messageFromComment)
    const first = messages[0]
    const last = messages.at(-1)
    out.push({
      id: githubThreadId(t.id),
      anchor,
      state: t.resolved ? 'resolved' : 'sent',
      audience: 'pr',
      github: {
        threadId: t.id,
        kind: 'inline',
        resolved: t.resolved,
        // Our own verdict counts too: a thread we cannot place is outdated for
        // this diff whatever GitHub says.
        outdated: t.outdated || !placed,
        line: t.line,
        startLine: t.startLine,
        side: t.side,
        ...(t.comments[0]?.url ? { url: t.comments[0].url } : {}),
      },
      codeContext: null,
      codeChanged: false,
      messages,
      createdAt: first?.at || now,
      updatedAt: last?.at || now,
    })
  }
  return out
}

/**
 * A Diffo anchor as a GitHub review-comment position. A hunk anchor whose line
 * is still in the diff is a LINE comment (a range when it has one); a line the
 * diff no longer shows cannot be commented on at all, so it becomes a FILE
 * comment and says so. Changeset anchors have no position: they are the review
 * body, or a conversation comment.
 */
export function githubPosition(
  anchor: Anchor,
  body: string,
  files: readonly FileChange[],
): { draft: ReviewDraftComment; downgraded: boolean } | null {
  if (anchor.kind === 'changeset' || anchor.kind === 'layer') return null
  if (anchor.kind === 'file')
    return { draft: { path: anchor.path, body, subjectType: 'FILE' }, downgraded: false }
  const file = files.find((f) => f.path === anchor.path)
  const has = (n: number) =>
    file?.hunks.some((h) =>
      h.lines.some((l) =>
        anchor.side === 'old'
          ? l.kind !== 'add' && l.oldNo === n
          : l.kind !== 'del' && l.newNo === n,
      ),
    ) ?? false
  const end = anchor.endLine ?? anchor.line
  if (!has(end) || !has(anchor.line)) {
    return { draft: { path: anchor.path, body, subjectType: 'FILE' }, downgraded: true }
  }
  const side = anchor.side === 'old' ? 'LEFT' : 'RIGHT'
  return {
    draft: {
      path: anchor.path,
      body,
      subjectType: 'LINE',
      line: end,
      side,
      ...(anchor.endLine !== undefined ? { startLine: anchor.line, startSide: side } : {}),
    },
    downgraded: false,
  }
}
