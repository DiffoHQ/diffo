import { useState } from 'react'
import { Icon } from './Icon.js'

export interface LandedNotice {
  sha: string
  subject: string
  /** How many threads a fresh start would delete — the honest number on the button. */
  threads: number
  onClear: () => Promise<unknown>
  onDismiss: () => void
}

/**
 * The offer a landed review earns: the changeset was committed away, so the
 * threads and guide still stored here belong to work that already shipped.
 * Two shapes, like ReviewDone — `full` stands in for the empty-changeset state
 * right after the commit; `docked` is the banner over a *new* diff whose review
 * still carries the previous round (the commit happened with the page closed).
 *
 * Suggests, never acts: Diffo deletes a reviewer's threads only when the
 * reviewer says so, and "Keep them" makes even the suggestion go away.
 */
export function ReviewLanded({
  sha,
  subject,
  threads,
  onClear,
  onDismiss,
  shape,
}: LandedNotice & { shape: 'full' | 'docked' }) {
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)

  const clear = () => {
    setBusy(true)
    setFailed(false)
    onClear().catch(() => {
      setBusy(false)
      setFailed(true)
    })
  }

  const commit = (
    <>
      <span className="landed-sha">{sha.slice(0, 7)}</span>
      {subject !== '' && <span className="landed-subject"> “{subject}”</span>}
    </>
  )
  const carried =
    threads === 0
      ? 'its review record'
      : `its ${threads === 1 ? 'thread' : `${threads} threads`} and guide`

  const clearLabel = busy
    ? 'Clearing…'
    : threads === 0
      ? 'Start fresh'
      : `Start fresh — clear ${threads === 1 ? 'the thread' : `${threads} threads`}`

  const errorNote = failed && (
    <p className="cov-note cov-note-error">
      Couldn't clear the review — the server may be down. Nothing was deleted; try again.
    </p>
  )

  if (shape === 'docked') {
    return (
      <div className="landed-card" role="status">
        <span className="landed-seal" aria-hidden="true">
          <Icon name="check" size="md" />
        </span>
        <span className="landed-said">
          The previous review landed in {commit} — {carried} {threads === 0 ? 'is' : 'are'} still
          here, under this new changeset.
        </span>
        <div className="landed-acts">
          <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={clear}>
            {clearLabel}
          </button>
        </div>
        <button
          type="button"
          className="done-close"
          title="Keep them"
          aria-label="Keep the previous review's threads"
          onClick={onDismiss}
        >
          <Icon name="x" size="sm" />
        </button>
      </div>
    )
  }

  return (
    <div className="empty-state landed-full">
      <Icon name="check" size="lg" />
      <h2>This review landed</h2>
      <p>
        Commit {commit} took the whole changeset —{' '}
        {threads === 0 ? `${carried} belongs` : `${carried} belong`} to that round. Clear the slate
        and the next changeset starts its own review.
      </p>
      <div className="empty-acts">
        <button type="button" className="btn btn-primary" disabled={busy} onClick={clear}>
          {clearLabel}
        </button>
        <button type="button" className="btn btn-ghost" onClick={onDismiss}>
          Keep them
        </button>
      </div>
      {errorNote}
    </div>
  )
}
