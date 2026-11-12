import { useMemo } from 'react'
import { type Anchor, commitMessageLines, type ReviewThread } from '../../shared/review.js'
import { fromMessageLine, messageHunk, onMessageLine } from '../commitMessage.js'
import { HunkCard } from './HunkCard.js'
import type { ReviewComments } from './ReadingPane.js'
import type { ReviewActions } from './Threads.js'

export function CommitMessage({
  anchor,
  body,
  threads,
  comments,
}: {
  anchor: Extract<Anchor, { kind: 'commit' }>
  body: string
  /** The threads on lines of this message; whole-message ones read elsewhere. */
  threads: readonly ReviewThread[]
  comments?: ReviewComments
}) {
  const hunk = useMemo(
    () => messageHunk(anchor.sha, commitMessageLines({ subject: anchor.subject, body })),
    [anchor.sha, anchor.subject, body],
  )
  const placed = useMemo(() => threads.map((t) => onMessageLine(t, hunk)), [threads, hunk])
  const base = comments?.actions
  const actions = useMemo<ReviewActions | undefined>(
    () =>
      base && {
        ...base,
        create: (target, text, intent, options) =>
          base.create(
            target.kind === 'hunk' ? fromMessageLine(target, anchor) : target,
            text,
            intent,
            options,
          ),
      },
    [base, anchor],
  )
  return (
    <div className="ch-message">
      <HunkCard
        hunk={hunk}
        threads={placed}
        reviewActions={actions}
        agentConnected={comments?.agentConnected}
        workingOn={comments?.workingOn}
        queuedOn={comments?.queuedOn}
        prose={{ label: 'message' }}
      />
    </div>
  )
}
