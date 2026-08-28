import { useEffect, useState } from 'react'
import {
  type Anchor,
  anchorSpan,
  type Coverage,
  type OutgoingThread,
  type ReviewVerdict,
} from '../../shared/review.js'
import { type Presence, useFinishPreview } from '../api.js'
import { copyText } from '../clipboard.js'
import type { ThreadItem } from '../threads.js'
import { Icon } from './Icon.js'
import { Modal } from './Modal.js'

const VERDICTS: { value: ReviewVerdict; label: string; hint: string }[] = [
  { value: 'comment', label: 'Comment', hint: 'feedback, no verdict' },
  { value: 'request-changes', label: 'Request changes', hint: 'not done until addressed' },
  { value: 'approve', label: 'Approve', hint: 'good to proceed' },
]

const CONSEQUENCE: Record<ReviewVerdict, string> = {
  comment: 'Feedback without an explicit verdict.',
  'request-changes': 'The review is not done until these are addressed.',
  approve: 'Tells the agent this changeset is good to proceed.',
}

const PRIMARY_LABEL: Record<ReviewVerdict, string> = {
  comment: 'Comment & send',
  'request-changes': 'Request changes & send',
  approve: 'Approve & finish',
}

const ROWS = 4

function rowAnchor(anchor: Anchor): string {
  if (anchor.kind === 'changeset') return 'the whole changeset'
  if (anchor.kind === 'file') return anchor.path
  return `${anchor.path}:${anchorSpan(anchor)}${anchor.side === 'old' ? ' (old side)' : ''}`
}

export function FinishReview({
  coverage,
  presence,
  checkOff = [],
  onResolve,
  onReopen,
  onFinish,
  onInvite,
  onClose,
}: {
  coverage: Coverage
  presence: Presence
  checkOff?: ThreadItem[]
  onResolve?: (threadId: string) => Promise<unknown>
  onReopen?: (threadId: string) => Promise<unknown>
  onFinish: (
    deliver: boolean,
    closing: { verdict: ReviewVerdict; note: string },
  ) => Promise<{ delivered: boolean; prompt: string }>
  onInvite: () => void
  onClose: () => void
}) {
  const preview = useFinishPreview(true, coverage)
  const [done, setDone] = useState<'copied' | 'delivered' | null>(null)
  const [failed, setFailed] = useState(false)
  const [manual, setManual] = useState<string | null>(null)
  const [peeked, setPeeked] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState('')
  const [verdict, setVerdict] = useState<ReviewVerdict>('comment')
  // Preselection must never override a hand that already chose.
  const [picked, setPicked] = useState(false)

  const attached = presence !== 'waiting'
  const outgoing = preview.data?.outgoing ?? []
  const rows = expanded ? outgoing : outgoing.slice(0, ROWS)
  const freshCount = outgoing.filter((t) => t.fresh).length
  const resentCount = outgoing.length - freshCount

  // Files are the reviewer's unit of done; an older payload without file counts
  // falls back to hunks.
  const hasFiles = coverage.totalFiles !== undefined && coverage.totalFiles > 0
  const read = hasFiles ? (coverage.viewedFiles ?? 0) : coverage.viewedHunks
  const total = hasFiles ? coverage.totalFiles! : coverage.totalHunks
  const changed = hasFiles ? (coverage.changedFiles?.length ?? 0) : 0
  const unread = Math.max(0, total - read - changed)
  const full = total > 0 && read === total

  const allClear =
    full && checkOff.length === 0 && !preview.isLoading && !preview.error && outgoing.length === 0
  useEffect(() => {
    if (allClear && !picked) setVerdict('approve')
  }, [allClear, picked])

  const pick = (v: ReviewVerdict) => {
    setPicked(true)
    setVerdict(v)
  }

  const finish = (deliver: boolean) => {
    setFailed(false)
    setBusy(true)
    onFinish(deliver, { verdict, note })
      .then(async ({ delivered, prompt }) => {
        if (delivered && deliver) return onClose()
        setDone('copied')
        if (!(await copyText(prompt))) setManual(prompt)
      })
      .catch(() => setFailed(true))
      .finally(() => setBusy(false))
  }

  const footer = done ? undefined : (
    <>
      <button
        type="button"
        className={`btn btn-primary${
          attached && verdict === 'request-changes'
            ? ' btn-primary-rc'
            : attached && verdict === 'approve'
              ? ' btn-primary-approve'
              : ''
        }`}
        disabled={busy}
        onClick={() => finish(attached)}
      >
        <Icon name={attached ? 'send' : 'copy'} size="sm" />{' '}
        {attached ? PRIMARY_LABEL[verdict] : 'Finish & copy prompt'}
      </button>
      {attached && (
        <button
          type="button"
          className="btn btn-ghost"
          disabled={busy}
          title="finish the review, but carry the prompt to your agent yourself"
          onClick={() => finish(false)}
        >
          Copy prompt instead
        </button>
      )}
      <button type="button" className="btn btn-ghost" onClick={onClose}>
        Cancel
      </button>
      {preview.data && (
        <span className="fin-foot-peek">
          <button
            type="button"
            className="fin-link"
            onClick={() => setPeeked(!peeked)}
            aria-expanded={peeked}
          >
            view the exact prompt
          </button>
          <button
            type="button"
            className="ghb"
            title="copy the prompt without finishing"
            aria-label="Copy the prompt without finishing"
            onClick={() => void copyText(preview.data!.prompt)}
          >
            <Icon name="copy" size="sm" />
          </button>
        </span>
      )}
    </>
  )

  return (
    <Modal title="Finish review" wide onClose={onClose} footer={footer}>
      {!attached && !done && (
        <div className="fin-dest">
          <span className="fin-dest-pip" />
          <span className="fin-dest-text">
            <b>No agent attached</b> — finishing copies the prompt for you to paste
          </span>
          <button type="button" className="fin-link" onClick={onInvite}>
            Invite an agent
          </button>
        </div>
      )}

      {!done && checkOff.length > 0 && (
        <div className="fin-sect fin-checkoff">
          <div className="fin-sect-h">
            <span className="fin-sect-label">Still on you</span>
            <span className="fin-sect-n">{checkOff.length}</span>
            <span className="fin-sect-why">— settle these first; reopened ones join this send</span>
          </div>
          <ul className="fin-rows">
            {checkOff.map((item) => (
              <CheckOffRow
                key={item.thread.id}
                item={item}
                onResolve={onResolve}
                onReopen={onReopen}
              />
            ))}
          </ul>
        </div>
      )}

      {!done && (preview.isLoading || preview.error || outgoing.length > 0) && (
        <div className="fin-sect">
          <div className="fin-sect-h">
            <span className="fin-sect-label">Going out</span>
            {outgoing.length > 0 && <span className="fin-sect-n">{outgoing.length}</span>}
            {outgoing.length > 0 && (
              <span className="fin-sect-why">
                {!attached
                  ? '— in the copied prompt'
                  : `— ${[
                      freshCount > 0 ? `${freshCount} new` : null,
                      resentCount > 0 ? `${resentCount} resent` : null,
                    ]
                      .filter(Boolean)
                      .join(' · ')}`}
              </span>
            )}
          </div>
          {preview.isLoading && <div className="shimmer" />}
          {preview.error && (
            <p className="cov-note cov-note-error">
              Couldn't read the outgoing batch: {(preview.error as Error).message}. Finishing still
              works — it just isn't previewed.
            </p>
          )}
          {outgoing.length > 0 && (
            <ul className="fin-rows">
              {rows.map((t) => (
                <OutgoingRow key={t.id} thread={t} />
              ))}
              {outgoing.length > ROWS && (
                <li className="fin-rows-span">
                  <button type="button" className="fin-more" onClick={() => setExpanded(!expanded)}>
                    <Icon name="chev" size="sm" />
                    {expanded ? 'Show fewer' : `${outgoing.length - ROWS} more`}
                  </button>
                </li>
              )}
            </ul>
          )}
        </div>
      )}

      {!done && total > 0 && (
        <div className="fin-sect">
          <div className="fin-sect-h">
            <span className="fin-sect-label">Your coverage</span>
            {!allClear && <span className="fin-sect-why">— sent as-is, never a gate</span>}
          </div>
          <div className="fin-cov-bar">
            <i className="fin-cov-read" style={{ width: `${(read / total) * 100}%` }} />
            <i className="fin-cov-moved" style={{ width: `${(changed / total) * 100}%` }} />
          </div>
          <div className="fin-cov-status">
            <span className={full ? 'fin-cov-ok' : ''}>
              <i className="fin-cov-sw fin-cov-sw-read" />
              {full
                ? `all ${total} ${hasFiles ? 'files' : 'hunks'} read`
                : `${read} of ${total} read`}
            </span>
            {changed > 0 && (
              <span className="fin-cov-attn">
                <i className="fin-cov-sw fin-cov-sw-moved" />
                {changed} changed since you read {changed === 1 ? 'it' : 'them'}
              </span>
            )}
            {unread > 0 && (
              <span>
                <i className="fin-cov-sw fin-cov-sw-unread" />
                {unread} not read
              </span>
            )}
            {allClear && (
              <>
                <span className="fin-cov-ok">✓ every thread settled</span>
                <span>nothing going out</span>
              </>
            )}
          </div>
        </div>
      )}

      {!done && (
        <div className="fin-sect">
          <div className="fin-sect-h">
            <span className="fin-sect-label">Your word</span>
          </div>
          <div className="fin-verdicts" role="radiogroup" aria-label="Review verdict">
            {VERDICTS.map((v) => (
              <label
                key={v.value}
                className={`fin-verdict fin-verdict-${v.value}${
                  verdict === v.value ? ' fin-verdict-on' : ''
                }`}
              >
                <input
                  type="radio"
                  name="fin-verdict"
                  value={v.value}
                  checked={verdict === v.value}
                  onChange={() => pick(v.value)}
                />
                <span className="fin-verdict-text">
                  <b>{v.label}</b>
                  <span>{v.hint}</span>
                </span>
              </label>
            ))}
          </div>
          <div className="fin-verdict-consequence">{CONSEQUENCE[verdict]}</div>
          <textarea
            className="fin-note"
            placeholder="Add a closing note (optional) — sent as a thread on the changeset, so the agent can reply to it"
            value={note}
            rows={2}
            onChange={(e) => setNote(e.target.value)}
          />
        </div>
      )}

      {peeked && preview.data && <pre className="invite-prompt">{preview.data.prompt}</pre>}

      {done && (
        <p className="thread-copied">
          {done === 'delivered'
            ? 'Sent to your agent — replies and fixes will show up here live.'
            : 'Review finished and the prompt copied — paste it to your agent. Its replies and fixes will show up here live.'}
        </p>
      )}

      {manual && (
        <>
          <div className="warn">
            <Icon name="alert" size="sm" />
            <div>
              <b>Couldn't reach the clipboard</b> — this browser blocked it. The review is finished;
              select the prompt below and copy it by hand.
            </div>
          </div>
          <pre className="invite-prompt">{manual}</pre>
        </>
      )}

      {failed && (
        <p className="cov-note cov-note-error">
          Couldn't finish the review — the server may be down. Nothing was sent; try again.
        </p>
      )}
    </Modal>
  )
}

const OUTCOME_LABEL: Partial<Record<NonNullable<ThreadItem['outcome']>, string>> = {
  fixed: 'fixed',
  answered: 'answered',
  changed: 'changed, no reply',
  'no-answer': 'no answer',
}

function CheckOffRow({
  item,
  onResolve,
  onReopen,
}: {
  item: ThreadItem
  onResolve?: (threadId: string) => Promise<unknown>
  onReopen?: (threadId: string) => Promise<unknown>
}) {
  const [busy, setBusy] = useState(false)
  const act = (fn?: (id: string) => Promise<unknown>) => {
    if (!fn) return
    setBusy(true)
    void fn(item.thread.id).finally(() => setBusy(false))
  }
  const label = item.outcome ? OUTCOME_LABEL[item.outcome] : undefined
  return (
    <li className="fin-row fin-row-checkoff">
      <span className={`fin-chip fin-chip-${item.outcome ?? 'waiting'}`}>{label ?? 'back'}</span>
      <span
        className={`fin-row-anchor${item.gone ? ' fin-row-anchor-gone' : ''}`}
        title={item.gone ? 'this file is no longer in the changeset' : undefined}
      >
        {item.anchor ?? 'the whole changeset'}
      </span>
      <span className="fin-row-text">{item.question}</span>
      <span className="fin-row-acts">
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          disabled={busy || !onResolve}
          title="the agent's answer stands — settle this one"
          onClick={() => act(onResolve)}
        >
          <Icon name="check" size="sm" /> Done
        </button>
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          disabled={busy || !onReopen}
          title={
            item.gone
              ? 'reopen it — it lands in Not sent, and Send on the thread hands it over; the finish batch is scoped to the changeset'
              : 'reopen it — it goes out again in this batch'
          }
          onClick={() => act(onReopen)}
        >
          <Icon name="undo" size="sm" /> Still not right
        </button>
      </span>
    </li>
  )
}

function OutgoingRow({ thread }: { thread: OutgoingThread }) {
  const [open, setOpen] = useState(false)
  const more = thread.text.includes('\n') || thread.text.length > 70
  return (
    <li className="fin-row">
      <span className={`fin-chip fin-chip-${thread.fresh ? 'fresh' : 'resent'}`}>
        {thread.fresh ? 'new' : 'resent'}
      </span>
      <span className="fin-row-anchor">{rowAnchor(thread.anchor)}</span>
      {more ? (
        <button
          type="button"
          className="fin-row-open"
          aria-expanded={open}
          aria-label={open ? 'Collapse this comment' : 'Show the full comment'}
          onClick={() => setOpen(!open)}
        >
          <span className={open ? 'fin-row-text fin-row-text-full' : 'fin-row-text'}>
            {thread.text}
          </span>
          <Icon name="chev" size="sm" />
        </button>
      ) : (
        <span className="fin-row-text">{thread.text}</span>
      )}
    </li>
  )
}
