import { useState } from 'react'
import { usePr } from '../prMode.js'
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
 *
 * On a pull request the same marker means the PR was merged or closed: there
 * is no "new changeset" — the diff is the one that shipped, kept to read — so
 * the words change while the offer stays the same. Clearing (or keeping) also
 * lets Diffo drop the checkout when the server exits.
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
  const pr = usePr()
  const ended = pr && pr.state !== 'open' ? pr : null

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
      ? ended
        ? 'Clear the review'
        : 'Start fresh'
      : ended
        ? `Clear ${threads === 1 ? 'the thread' : `${threads} threads`}`
        : `Start fresh: clear ${threads === 1 ? 'the thread' : `${threads} threads`}`

  // The pull request's ending, in the PR's own words: "Merged as a1b2c3d", not
  // "the previous review landed in". The header chip already names the state;
  // this line says what it means here, and no more.
  const prEnding =
    ended &&
    (ended.state === 'merged' ? (
      <>
        <b>Merged</b> as <span className="landed-sha">{sha.slice(0, 7)}</span>. The diff is what
        shipped, and comments still post to GitHub.
      </>
    ) : (
      <>
        <b>Closed</b> without merging. The diff stays to read, and comments still post to GitHub.
      </>
    ))

  const errorNote = failed && (
    <p className="cov-note cov-note-error">
      Couldn't clear the review; the server may be down. Nothing was deleted; try again.
    </p>
  )

  // A pull request that ended: one quiet line in the state's color, the same
  // purple or red as the header chip. Clear keeps its honest count; what it
  // drops beyond the threads (the checkout) lives on its tooltip.
  if (shape === 'docked' && ended) {
    return (
      <div className={`landed-strip landed-strip-${ended.state}`} role="status">
        <Icon name="pr" size="sm" />
        <span className="landed-strip-text">{prEnding}</span>
        <button
          type="button"
          className="landed-strip-act"
          disabled={busy}
          title="Deletes the threads and guide; Diffo drops the checkout when the server exits"
          onClick={clear}
        >
          {clearLabel}
        </button>
        <button
          type="button"
          className="done-close"
          data-tip="Keep them"
          aria-label="Keep the review as it is"
          onClick={onDismiss}
        >
          <Icon name="x" size="sm" />
        </button>
        {failed && <span className="landed-strip-err">Couldn't clear; nothing was deleted.</span>}
      </div>
    )
  }

  if (shape === 'docked') {
    return (
      <div className="landed-card" role="status">
        <span className="landed-seal" aria-hidden="true">
          <Icon name="check" size="md" />
        </span>
        <span className="landed-said">
          The previous review landed in {commit}; {carried} {threads === 0 ? 'is' : 'are'} still
          here, under this new changeset.
        </span>
        <div className="landed-acts">
          <button type="button" className="btn btn-sm btn-primary" disabled={busy} onClick={clear}>
            {clearLabel}
          </button>
        </div>
        <button
          type="button"
          className="done-close"
          data-tip="Keep them"
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
      {prEnding ? (
        <>
          <h2>This pull request {ended.state === 'merged' ? 'merged' : 'closed'}</h2>
          <p>
            {prEnding} Clear {carried} when you are done, and Diffo drops the checkout.
          </p>
        </>
      ) : (
        <>
          <h2>This review landed</h2>
          <p>
            Commit {commit} took the whole changeset;{' '}
            {threads === 0 ? `${carried} belongs` : `${carried} belong`} to that round. Clear the
            slate and the next changeset starts its own review.
          </p>
        </>
      )}
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
