import { useEffect, useRef, useState } from 'react'
import type { Coverage } from '../../shared/review.js'
import { type Presence, type PublicOutcome, type ReviewEvent, useFinishPreview } from '../api.js'
import { usePr } from '../prMode.js'
import { applyToolbar, TOOLBAR } from './CommentBox.js'
import { Icon } from './Icon.js'
import { Markdown } from './Markdown.js'
import { Modal } from './Modal.js'

const VERDICT_DONE: Record<ReviewEvent, string> = {
  COMMENT: 'Commented',
  APPROVE: 'Approved',
  REQUEST_CHANGES: 'Changes requested',
}

/**
 * Finishing a pull request review is submitting a GitHub review, so the dialog
 * is GitHub's: the body, the verdict, then Submit. Diffo's one addition is the
 * pending list, every comment in full, since nothing has posted yet and this
 * is the last look. What goes to the agent privately is a line in the footer.
 */
export function SubmitReview({
  coverage,
  presence,
  onFinish,
  onInvite,
  onClose,
}: {
  coverage: Coverage
  presence: Presence
  onFinish: (
    deliver: boolean,
    closing: { note: string; event?: ReviewEvent },
  ) => Promise<{ delivered: boolean; prompt: string; public?: PublicOutcome }>
  onInvite: () => void
  onClose: () => void
}) {
  const pr = usePr()
  const preview = useFinishPreview(true, coverage)
  const box = useRef<HTMLTextAreaElement>(null)
  const [note, setNote] = useState('')
  const [tab, setTab] = useState<'write' | 'preview'>('write')
  const [event, setEvent] = useState<ReviewEvent>('COMMENT')
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const [publicFailed, setPublicFailed] = useState<PublicOutcome['failed'] | null>(null)
  const [submitted, setSubmitted] = useState<PublicOutcome | null>(null)
  // The private side, as the server reports it: delivered to a listening
  // agent, or held for its next poll.
  const [handedOver, setHandedOver] = useState(false)

  const attached = presence !== 'waiting'
  const pub = preview.data?.public
  const outgoing = preview.data?.outgoing ?? []
  const pendingCount = pub ? pub.drafts.length + pub.replies.length + pub.resolves.length : 0
  const over = pr !== null && pr.state !== 'open'
  // With the preview down, the server still knows what is pending; only a
  // loaded, empty list with nothing written and no verdict has nothing to send.
  const canSubmit = pendingCount > 0 || event !== 'COMMENT' || note.trim() !== '' || preview.isError

  const submit = () => {
    if (!canSubmit || busy) return
    setFailed(false)
    setPublicFailed(null)
    setBusy(true)
    // Always hand the private side over: the server delivers to a listening
    // agent or holds it for the next poll, and says which.
    onFinish(true, { note, event })
      .then(({ delivered, public: outcome }) => {
        if (outcome?.failed) {
          setPublicFailed(outcome.failed)
          // What posted before the stop is no longer pending: the list has to
          // say so before the retry, or it offers the same comments twice.
          void preview.refetch()
          return
        }
        setSubmitted(outcome ?? { posted: 0, resolved: 0, submitted: false, reviewId: null })
        setHandedOver(delivered)
      })
      .catch(() => setFailed(true))
      .finally(() => setBusy(false))
  }

  const verdicts: [ReviewEvent, string, string][] = [
    ['COMMENT', 'Comment', 'Submit general feedback without explicit approval.'],
    ['APPROVE', 'Approve', 'Submit feedback and approve merging these changes.'],
    ['REQUEST_CHANGES', 'Request changes', 'Submit feedback suggesting changes.'],
  ]
  const blockedWhy = over
    ? `${pr!.state === 'merged' ? 'Merged' : 'Closed'} already: GitHub takes comments, not verdicts.`
    : pub && !pub.canApprove
      ? 'Your own pull request: GitHub does not let you approve or block it.'
      : null
  // The radios are live until the preview says otherwise, and the PR can close
  // under an open dialog: a verdict picked before the block must not ride out
  // on a disabled radio.
  useEffect(() => {
    if (event !== 'COMMENT' && blockedWhy !== null) setEvent('COMMENT')
  }, [event, blockedWhy])

  const privateSide =
    outgoing.length > 0
      ? `${outgoing.length} private ${outgoing.length === 1 ? 'thread' : 'threads'} and your coverage`
      : 'your coverage'

  const footer = submitted ? (
    <button type="button" className="btn btn-primary" onClick={onClose}>
      Done
    </button>
  ) : (
    <>
      {preview.data && (
        <span className={`sub-agent${attached ? '' : ' sub-agent-off'}`}>
          <Icon name={attached ? 'lock' : 'alert'} size="sm" />
          <span className="sub-agent-text">
            {attached ? (
              <>Also, privately: {privateSide} go to your agent</>
            ) : (
              <>
                No agent attached: {privateSide} wait for one.{' '}
                <button type="button" className="fin-link" onClick={onInvite}>
                  Invite one
                </button>
              </>
            )}
          </span>
        </span>
      )}
      <span className="grow" />
      <button type="button" className="btn btn-ghost" disabled={busy} onClick={onClose}>
        Cancel
      </button>
      <button
        type="button"
        className={`btn btn-primary btn-gh${busy ? ' btn-busy' : ''}`}
        disabled={!canSubmit || busy}
        aria-busy={busy}
        title={
          canSubmit
            ? `post this review on GitHub, #${pr?.number ?? ''} (⌘↵)`
            : 'nothing for GitHub yet: write a comment, pick a verdict, or draft a review comment'
        }
        onClick={submit}
      >
        {busy ? (
          <>
            <span className="spin" aria-hidden="true" /> Submitting to GitHub
          </>
        ) : (
          <>
            <Icon name="globe" size="sm" /> Submit to GitHub <kbd className="sub-kbd">⌘↵</kbd>
          </>
        )}
      </button>
    </>
  )

  return (
    <Modal
      title={submitted ? 'Review submitted to GitHub' : 'Submit review to GitHub'}
      wide
      className="sub-modal"
      onClose={onClose}
      footer={footer}
    >
      {pr && (
        <div className="sub-where">
          <Icon name="pr" size="sm" />
          <span className="sub-where-repo">
            one review on {pr.owner}/{pr.repo} #{pr.number}
          </span>
          <span className="sub-where-title">{pr.title}</span>
        </div>
      )}

      {!submitted && (
        <>
          <div className="sub-editor">
            <div className="sub-editor-bar">
              <div className="cbox-tabs sub-tabs" role="tablist">
                {(['write', 'preview'] as const).map((name) => (
                  <button
                    key={name}
                    type="button"
                    role="tab"
                    className="cbox-tab"
                    aria-selected={tab === name}
                    onClick={() => setTab(name)}
                  >
                    {name === 'write' ? 'Write' : 'Preview'}
                  </button>
                ))}
              </div>
              {tab === 'write' && (
                <div className="sub-tools">
                  {TOOLBAR.map((action, i) =>
                    action === 'sep' ? (
                      // biome-ignore lint/suspicious/noArrayIndexKey: position is the identity; the toolbar is a fixed list
                      <span key={i} className="cbox-mdsep" />
                    ) : (
                      <button
                        // biome-ignore lint/suspicious/noArrayIndexKey: the toolbar is a fixed list
                        key={i}
                        type="button"
                        className="cbox-mdb"
                        data-tip={action.label}
                        aria-label={action.label}
                        onClick={() => box.current && applyToolbar(box.current, action, setNote)}
                      >
                        <Icon name={action.icon} size="sm" />
                      </button>
                    ),
                  )}
                </div>
              )}
            </div>
            {tab === 'write' ? (
              <textarea
                ref={box}
                // biome-ignore lint/a11y/noAutofocus: the dialog is opened by an explicit click
                autoFocus
                className="sub-body"
                placeholder="Leave a comment"
                value={note}
                onChange={(e) => setNote(e.target.value)}
                onKeyDown={(e) => {
                  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                    e.preventDefault()
                    submit()
                  }
                }}
              />
            ) : note.trim() ? (
              <Markdown className="sub-preview markdown" text={note} />
            ) : (
              <div className="sub-preview sub-preview-empty">Nothing to preview</div>
            )}
          </div>

          <div className="sub-verdicts" role="radiogroup" aria-label="Your verdict">
            {verdicts.map(([value, label, why]) => {
              const blocked = value !== 'COMMENT' && blockedWhy !== null
              return (
                <label
                  key={value}
                  className={`sub-verdict${event === value ? ' sub-verdict-on' : ''}${blocked ? ' sub-verdict-off' : ''}`}
                >
                  <input
                    type="radio"
                    name="verdict"
                    value={value}
                    checked={event === value}
                    disabled={blocked}
                    onChange={() => setEvent(value)}
                  />
                  <span className="sub-verdict-text">
                    <b>{label}</b>
                    <small className={blocked ? 'sub-verdict-why' : undefined}>
                      {blocked ? blockedWhy : why}
                    </small>
                  </span>
                </label>
              )
            })}
          </div>

          <div className="fin-sect">
            <div className="fin-sect-h">
              <span className="fin-sect-label">Pending</span>
              {pub && <span className="fin-sect-n">{pendingCount}</span>}
              <span className="fin-sect-why">
                {preview.isLoading
                  ? '· loading'
                  : preview.error || !pub
                    ? '· could not load what is pending; the review still submits'
                    : pendingCount > 0
                      ? '· post to GitHub with this review; nothing has posted yet'
                      : '· nothing drafted; a comment above still submits a review to GitHub'}
              </span>
            </div>
            {pub && pendingCount > 0 && (
              <ul className="sub-pending">
                {pub.drafts.map((d) => (
                  <li key={d.id} className="sub-pending-row">
                    <div className="sub-pending-at">
                      <span className="sub-pending-kind">
                        {d.conversation ? 'comment' : 'review comment'}
                      </span>
                      <span className="sub-pending-anchor">{d.anchor}</span>
                      {d.fromAgent && (
                        <span
                          className="fin-row-note sub-pending-origin"
                          title="your agent wrote the first version; it posts as yours"
                        >
                          from your agent{d.fromAgent.edited && ', edited'}
                        </span>
                      )}
                      {d.downgraded && (
                        <span
                          className="fin-row-note"
                          title="GitHub only takes comments on lines in its diff"
                        >
                          line not in the diff; posts on the file
                        </span>
                      )}
                    </div>
                    <div className="sub-pending-text">{d.text}</div>
                  </li>
                ))}
                {pub.replies.map((r) => (
                  <li key={r.id} className="sub-pending-row">
                    <div className="sub-pending-at">
                      <span className="sub-pending-kind">
                        {r.count === 1 ? 'reply' : `${r.count} replies`}
                      </span>
                      <span className="sub-pending-anchor">{r.anchor}</span>
                    </div>
                    <div className="sub-pending-text">{r.text}</div>
                  </li>
                ))}
                {pub.resolves.map((r) => (
                  <li key={r.id} className="sub-pending-row">
                    <div className="sub-pending-at">
                      <span className="sub-pending-kind">{r.resolve ? 'resolve' : 'reopen'}</span>
                      <span className="sub-pending-anchor">{r.anchor}</span>
                    </div>
                  </li>
                ))}
              </ul>
            )}
            {pub && (pub.undecidedSuggestions ?? 0) > 0 && (
              <p className="sub-undecided" role="note">
                {pub.undecidedSuggestions === 1
                  ? 'One suggested comment from your agent is still undecided. It stays private and never posts.'
                  : `${pub.undecidedSuggestions} suggested comments from your agent are still undecided. They stay private and never post.`}
              </p>
            )}
          </div>
        </>
      )}

      {submitted && (
        <div className="sub-done">
          <div className="sub-done-card">
            <span className="sub-done-mark" aria-hidden="true">
              <Icon name="check" size="md" />
            </span>
            <div className="sub-done-text">
              <b>{submitted.submitted ? VERDICT_DONE[event] : 'Review finished'}</b>
              <span className="sub-done-detail">
                {[
                  submitted.posted > 0 &&
                    `${submitted.posted} ${submitted.posted === 1 ? 'comment' : 'comments'} posted`,
                  submitted.resolved > 0 &&
                    `${submitted.resolved} ${submitted.resolved === 1 ? 'thread' : 'threads'} resolved`,
                ]
                  .filter(Boolean)
                  .join(' · ') || `on #${pr?.number ?? ''}`}
              </span>
            </div>
            {submitted.url && (
              <a
                className="btn btn-sm btn-outline"
                href={submitted.url}
                target="_blank"
                rel="noreferrer"
              >
                Open on GitHub <Icon name="link" size="sm" />
              </a>
            )}
          </div>
          <p className="sub-done-agent">
            <Icon name="lock" size="sm" />
            {handedOver
              ? 'Private threads and coverage went to your agent.'
              : 'Private threads and coverage go to your agent on its next poll.'}
          </p>
        </div>
      )}

      {publicFailed && (
        <div className="warn">
          <Icon name="alert" size="sm" />
          <div>
            <b>GitHub stopped at {publicFailed.step}</b>: {publicFailed.message}. What posted before
            it is recorded and will not post twice; nothing went to your agent. Fix the cause and
            submit again.
          </div>
        </div>
      )}

      {failed && (
        <p className="cov-note cov-note-error">
          Couldn't submit; the server may be down. Nothing was sent; try again.
        </p>
      )}
    </Modal>
  )
}
