import type { CSSProperties } from 'react'
import { Icon } from './Icon.js'

const count = (x: number) => x.toLocaleString('en-US')

export interface ReviewDoneProps {
  read: number
  total: number
  excludedTests: number
  excludedUnchanged: number
  stats?: { additions: number; deletions: number }
  unsent?: number
  onFinish?: () => void
  onIncludeExcluded?: () => void
  onDismiss?: () => void
  shape: 'full' | 'docked'
}

export function ReviewDone({
  read,
  total,
  excludedTests,
  excludedUnchanged,
  stats,
  unsent,
  onFinish,
  onIncludeExcluded,
  onDismiss,
  shape,
}: ReviewDoneProps) {
  const excluded = excludedTests + excludedUnchanged
  const waiting = unsent !== undefined && unsent > 0 ? unsent : 0

  const headline =
    excluded === 0 ? "That's the whole changeset" : "That's everything you asked to see"

  // The bar carries the count; the row underneath carries only what the bar can't say.
  const done = excluded === 0 ? total : read
  const filled = total === 0 ? 1 : Math.min(1, done / total)
  const tally = (
    <div className="done-stats">
      <span className="done-stat">
        <span className="done-n">{excluded === 0 ? count(total) : `${read} of ${total}`}</span>{' '}
        {total === 1 ? 'file' : 'files'} read
      </span>
      {excluded === 0 && stats && (stats.additions > 0 || stats.deletions > 0) && (
        <span className="done-stat done-size">
          {stats.additions > 0 && <span className="stat-add">+{count(stats.additions)}</span>}
          {stats.deletions > 0 && <span className="stat-del">−{count(stats.deletions)}</span>}
        </span>
      )}
      {waiting > 0 && (
        <span
          className="done-stat done-unsent"
          role="img"
          aria-label={`${waiting} comment${waiting === 1 ? '' : 's'} waiting to go back to your agent`}
          title={`${waiting} comment${waiting === 1 ? '' : 's'} waiting to go back to your agent`}
        >
          <Icon name="chat" size="sm" />
          {waiting}
        </span>
      )}
    </div>
  )
  const meter = (
    <div className="done-meter">
      <div className="done-bar" aria-hidden="true">
        <i style={{ '--p': filled } as CSSProperties} />
      </div>
      {tally}
    </div>
  )

  const caveat = excluded > 0 && (
    <div className="done-caveat">
      <Icon name="eye-off" size="sm" />
      <span className="done-caveat-text">
        {excludedTests > 0 && (
          <>
            {excludedTests} test {excludedTests === 1 ? 'file was' : 'files were'} hidden
          </>
        )}
        {excludedTests > 0 && excludedUnchanged > 0 && ', and '}
        {excludedUnchanged > 0 && (
          <>
            {excludedUnchanged} {excludedUnchanged === 1 ? 'file is' : 'files are'} outside this
            round
          </>
        )}
        {' — nobody reviewed '}
        {excluded === 1 ? 'it' : 'them'}.
      </span>
      {onIncludeExcluded && (
        <button type="button" className="done-caveat-act" onClick={onIncludeExcluded}>
          Review {excluded === 1 ? 'it' : 'them'} too
        </button>
      )}
    </div>
  )

  const acts = (
    <div className={shape === 'full' ? 'empty-acts' : 'done-acts'}>
      {onFinish && (
        <button
          type="button"
          className={shape === 'full' ? 'btn btn-primary' : 'btn btn-primary btn-sm'}
          onClick={onFinish}
        >
          Finish review
        </button>
      )}
    </div>
  )

  if (shape === 'docked') {
    return (
      <div className="done-card" role="status">
        <div className="done-card-row">
          <Seal />
          <span className="done-said">
            <span className="done-head">{headline}</span>
            {tally}
          </span>
          {acts}
          {onDismiss && (
            <button
              type="button"
              className="done-close"
              data-tip="Dismiss"
              aria-label="Dismiss"
              onClick={onDismiss}
            >
              <Icon name="x" size="sm" />
            </button>
          )}
        </div>
        {caveat}
      </div>
    )
  }

  return (
    <div className="pane-done">
      <Seal drawn />
      <h2>{headline}</h2>
      {meter}
      {caveat}
      {acts}
    </div>
  )
}

const SPARKS = [0, 1, 2, 3, 4, 5, 6, 7]

/** The tick. Drawn rather than taken from the sprite when it has room to be the
 * moment: the stroke needs its own dash animation, and a `<use>` into a shared sprite
 * can't carry one without every other check in the app inheriting it. The burst is
 * eight rays the stylesheet fans out by index — the one moment this app celebrates. */
function Seal({ drawn = false }: { drawn?: boolean }) {
  return (
    <span className={`done-seal${drawn ? ' done-seal-drawn' : ''}`} aria-hidden="true">
      {drawn && (
        <span className="done-spark">
          {SPARKS.map((i) => (
            <i key={i} />
          ))}
        </span>
      )}
      {drawn ? (
        <svg className="done-tick" viewBox="0 0 24 24" width="26" height="26" aria-hidden="true">
          <path
            d="M5 12.5 L10 17.5 L19 7"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      ) : (
        <Icon name="check" size="md" />
      )}
    </span>
  )
}
