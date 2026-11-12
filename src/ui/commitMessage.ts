import type { Anchor, ReviewThread } from '../shared/review.js'
import type { Hunk } from '../shared/types.js'

type CommitAnchor = Extract<Anchor, { kind: 'commit' }>
type HunkAnchor = Extract<Anchor, { kind: 'hunk' }>

/**
 * A commit message rendered as a hunk, so it reads and takes line comments
 * exactly like code. Its lines are head-side only (no base number), and the
 * id names no real hunk: nothing outside the message card ever sees it.
 */
export function messageHunk(sha: string, lines: readonly string[]): Hunk {
  return {
    id: `message:${sha}`,
    path: 'commit message',
    oldStart: 1,
    newStart: 1,
    lines: lines.map((text, i) => ({ kind: 'context', oldNo: null, newNo: i + 1, text })),
  }
}

export function onMessageLine(thread: ReviewThread, hunk: Hunk): ReviewThread {
  const anchor = thread.anchor
  if (anchor.kind !== 'commit' || anchor.line === undefined) return thread
  return {
    ...thread,
    anchor: {
      kind: 'hunk',
      hunkId: hunk.id,
      path: hunk.path,
      side: 'new',
      line: anchor.line,
      ...(anchor.endLine !== undefined ? { endLine: anchor.endLine } : {}),
    },
  }
}

export function fromMessageLine(anchor: HunkAnchor, commit: CommitAnchor): CommitAnchor {
  return {
    kind: 'commit',
    sha: commit.sha,
    subject: commit.subject,
    line: anchor.line,
    ...(anchor.endLine !== undefined ? { endLine: anchor.endLine } : {}),
  }
}
