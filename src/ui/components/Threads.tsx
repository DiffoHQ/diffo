import { Fragment, useEffect, useRef, useState } from 'react'
import {
  type ReviewThread,
  startedByAgent,
  type ThreadState,
  untouchedAgentVoice,
} from '../../shared/review.js'
import { timeAgo } from '../markdown.js'
import { isUnsent, TURN_LABEL } from '../threads.js'
import { Avatar, CommentBox } from './CommentBox.js'
import { Icon } from './Icon.js'
import { Markdown } from './Markdown.js'

export interface ReviewActions {
  create: (
    anchor: import('../../shared/review.js').Anchor,
    text: string,
    intent?: import('../../shared/review.js').ThreadIntent,
  ) => Promise<ReviewThread>
  reply: (threadId: string, text: string, deliver?: boolean) => Promise<unknown>
  send: (threadId: string) => Promise<{ delivered: boolean; copied?: boolean; prompt?: string }>
  resolve: (threadId: string) => Promise<unknown>
  reopen: (threadId: string) => Promise<unknown>
  remove?: (threadId: string) => Promise<unknown>
}

const STATE_LABEL: Record<ThreadState, string> = {
  open: 'Open',
  sent: 'Sent',
  addressed: 'Answered',
  resolved: 'Resolved',
}

const STATE_TONE: Record<ThreadState, string> = {
  open: 'mute',
  sent: 'mute',
  addressed: 'ok',
  resolved: 'mute',
}

export function formatAgentDuration(ms: number): string {
  const s = Math.max(0, ms) / 1000
  if (s < 60) return `${s.toFixed(1)}s`
  const whole = Math.round(s)
  return `${Math.floor(whole / 60)}m ${String(whole % 60).padStart(2, '0')}s`
}

export function formatQueuePlace(position: number): string {
  return position <= 1 ? 'next in line' : `#${position} in line`
}

function PendingReply({
  working,
  place,
  unanswered,
  since,
}: {
  working: boolean
  place?: number
  unanswered?: boolean
  since?: string
}) {
  const when = unanswered
    ? 'no answer — the agent moved on'
    : working
      ? `with the agent${since ? ` · ${timeAgo(since)}` : ''}`
      : `queued — ${formatQueuePlace(place ?? 1)}`
  return (
    <div
      className={`cmt thread-message thread-message-agent thread-message-pending${
        unanswered ? ' thread-message-unanswered' : ''
      }`}
    >
      <div className="cmt-head">
        <Avatar who="agent" />
        <span className="cmt-who cmt-who-agent">Agent</span>
        <span className="cmt-when">{when}</span>
      </div>
      <div className="cmt-body pending-reply" role="status" aria-label={when}>
        {unanswered ? (
          <span className="pending-none">Send it again, or resolve it if you've let it go.</span>
        ) : (
          <span className="pending-dots">
            <i />
            <i />
            <i />
          </span>
        )}
      </div>
    </div>
  )
}

function ThreadContext({ code }: { code: string }) {
  const [open, setOpen] = useState(false)
  const lines = code.split('\n')
  return (
    <div className="thread-context-wrap">
      <button
        type="button"
        className="thread-context-toggle"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span className={`chevron${open ? '' : ' chevron-shut'}`}>
          <Icon name="chev" size="sm" />
        </span>
        the commented change
        <span className="thread-context-n">
          {lines.length} {lines.length === 1 ? 'line' : 'lines'}
        </span>
      </button>
      {open && (
        <pre className="thread-context">
          {lines.map((l, i) => (
            <span
              // biome-ignore lint/suspicious/noArrayIndexKey: snapshot lines never reorder — the index is the identity
              key={`${i}-${l}`}
              className={`ctx-line${l.startsWith('+') ? ' ctx-add' : l.startsWith('-') ? ' ctx-del' : ''}`}
            >
              {l === '' ? '\n' : l}
            </span>
          ))}
        </pre>
      )}
    </div>
  )
}

/** The byline verb: an agent's opening message isn't a reply to anything. */
function verbFor(author: 'reviewer' | 'agent', index: number): string {
  if (author === 'reviewer') return 'commented'
  return index === 0 ? 'commented' : 'replied'
}

function submitOnCmdEnter(e: React.KeyboardEvent, submit: () => void) {
  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
    e.preventDefault()
    submit()
  }
}

function Body({ text }: { text: string }) {
  return <Markdown className="cmt-body markdown" text={text} />
}

export { CommentBox }

export function ThreadCard({
  thread,
  actions,
  showContext = false,
  agentConnected = false,
  working = false,
  queuePosition,
  gone = false,
}: {
  thread: ReviewThread
  actions: ReviewActions
  showContext?: boolean
  agentConnected?: boolean
  working?: boolean
  queuePosition?: number
  gone?: boolean
}) {
  const [reply, setReply] = useState('')
  const [copied, setCopied] = useState(false)
  // The prompt to show when the clipboard refuses — copying is the whole point of
  // the unattached send, so a silent failure there strands the reviewer.
  const [manual, setManual] = useState<string | null>(null)
  const [actionFailed, setActionFailed] = useState(false)
  const [replyOpen, setReplyOpen] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const [shut, setShut] = useState(false)
  const card = useRef<HTMLDivElement>(null)
  // A live update can unmount this card before the "copied" flag times out.
  const copyTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => clearTimeout(copyTimer.current), [])

  // Clear the textarea only once the reply has actually landed — a failed POST must
  // not silently eat a paragraph the reviewer just typed.
  const doReply = (deliver = true) => {
    if (!reply.trim()) return
    setActionFailed(false)
    actions
      .reply(thread.id, reply, deliver)
      .then(() => setReply(''))
      .catch(() => setActionFailed(true))
  }
  const doSend = () => {
    setActionFailed(false)
    setManual(null)
    return actions
      .send(thread.id)
      .then(({ delivered, copied, prompt }) => {
        if (delivered) return
        if (!copied) {
          // The clipboard refused — never claim a copy that didn't happen.
          setManual(prompt ?? null)
          return
        }
        setCopied(true)
        clearTimeout(copyTimer.current)
        copyTimer.current = setTimeout(() => setCopied(false), 2500)
      })
      .catch(() => setActionFailed(true))
  }
  const lastAuthor = thread.messages[thread.messages.length - 1]?.author
  const withheld = thread.withheld === true
  const unsent = isUnsent(thread)
  const awaitingAgent =
    !withheld &&
    lastAuthor === 'reviewer' &&
    (thread.state === 'sent' || thread.state === 'addressed')
  const showManualHint = thread.state === 'sent' && awaitingAgent && !agentConnected
  const replyDispatches =
    agentConnected && (thread.state === 'sent' || thread.state === 'addressed')
  const composerOpen = replyOpen || reply.trim() !== ''
  // The composer takes the stub's slot in the foot, so writing a reply adds one
  // button to the row it already had rather than a second band of its own.
  const writing = thread.state !== 'resolved' && composerOpen
  const showStub = thread.state !== 'resolved' && !composerOpen

  const proposed = untouchedAgentVoice(thread) && thread.state === 'open'
  const status = proposed
    ? 'From the agent'
    : withheld
      ? TURN_LABEL.note
      : STATE_LABEL[thread.state]
  const tone: string = proposed || withheld ? 'attn' : STATE_TONE[thread.state]

  // State and badges ride the first byline rather than a banded header row of their
  // own: on a two-line thread that band was taller than the comment it labelled.
  const marks = (
    <span className="thread-marks">
      {thread.codeChanged && (
        <span className="thread-badge">
          <Icon name="alert" size="sm" /> code changed since this comment
        </span>
      )}
      {copied && <span className="thread-badge">prompt copied — paste it to your agent</span>}
      <span className={`chip chip-${tone}`}>{status}</span>
    </span>
  )

  const pendingReply =
    working || queuePosition !== undefined || thread.unanswered ? (
      <PendingReply
        working={working}
        place={queuePosition}
        unanswered={thread.unanswered === true && queuePosition === undefined && !working}
        since={thread.updatedAt}
      />
    ) : null
  // While the agent is composing, the indicator sits where the answer will land:
  // after the words the delivery carried, above any the reviewer raced in since.
  const seenThrough =
    working && thread.deliveredThrough ? Date.parse(thread.deliveredThrough) : null
  const racedAt =
    seenThrough === null ? -1 : thread.messages.findIndex((m) => Date.parse(m.at) > seenThrough)
  const pendingAt = racedAt === -1 ? thread.messages.length : racedAt

  const resolveButton =
    thread.state === 'resolved' ? (
      <button
        type="button"
        className="btn btn-ghost btn-sm"
        onClick={() => void actions.reopen(thread.id)}
      >
        Reopen
      </button>
    ) : (
      <button
        type="button"
        className="btn btn-ghost btn-sm"
        onClick={() => void actions.resolve(thread.id)}
      >
        Resolve
      </button>
    )

  const copyPromptButton = showManualHint && (
    <button type="button" className="btn btn-ghost btn-sm" onClick={doSend}>
      <Icon name="copy" size="sm" /> Copy prompt
    </button>
  )
  // Send sits in the foot beside Resolve: the two ways a thread leaves your hands,
  // in the one place you look when you are done reading it.
  const sendButton = unsent && (
    <button
      type="button"
      className={`btn btn-sm ${writing && reply.trim() !== '' ? 'btn-outline' : 'btn-primary'}`}
      onClick={doSend}
      title={agentConnected ? 'send this thread to your agent' : 'mark sent and copy the prompt'}
    >
      <Icon name="send" size="sm" /> Send
    </button>
  )
  // Reopen lives in the foot, and the foot isn't rendered while the thread is folded
  // — so a resolved card you can see but can't act on needs its own way back. Same
  // button, hoisted to the one row that is still on screen.
  const reopenButton = thread.state === 'resolved' && (
    <button
      type="button"
      className="btn btn-ghost btn-sm"
      title="reopen this thread"
      onClick={() => void actions.reopen(thread.id)}
    >
      Reopen
    </button>
  )
  const deleteButton = actions.remove && (
    <button
      type="button"
      className="btn btn-ghost btn-icon btn-sm btn-ghost-danger"
      aria-label="delete this thread"
      title="delete this thread"
      onClick={() => void actions.remove!(thread.id)}
    >
      <Icon name="trash" size="sm" />
    </button>
  )

  if (thread.state === 'resolved' && !expanded) {
    const first = thread.messages[0]
    return (
      // biome-ignore lint/a11y/noStaticElementInteractions: the handler only contains a mouse click
      // biome-ignore lint/a11y/useKeyWithClickEvents: the handler only contains a mouse click
      <div
        className="thread thread-resolved thread-collapsed"
        data-thread-id={thread.id}
        ref={card}
        onClick={(e) => e.stopPropagation()}
      >
        <button
          type="button"
          className="thread-collapsed-summary"
          onClick={() => setExpanded(true)}
          title="expand this resolved thread"
        >
          <span className="chip chip-mute">Resolved</span>
          <span className="thread-collapsed-text">{first?.text ?? ''}</span>
          <span className="thread-collapsed-count">
            {thread.messages.length > 1 ? `${thread.messages.length} messages` : ''}
          </span>
          <span className="thread-collapsed-hint chevron chevron-shut">
            <Icon name="chev" size="sm" />
          </span>
        </button>
        {reopenButton}
        {deleteButton}
      </div>
    )
  }

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: the handler only contains a mouse click
    // biome-ignore lint/a11y/useKeyWithClickEvents: the handler only contains a mouse click
    <div
      className={`thread conv thread-${thread.state}`}
      data-thread-id={thread.id}
      ref={card}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="thread-head">
        <button
          type="button"
          className={`thread-shut chevron${shut ? ' chevron-shut' : ''}`}
          aria-expanded={!shut}
          title={shut ? 'expand this thread' : 'collapse this thread'}
          aria-label={shut ? 'expand this thread' : 'collapse this thread'}
          onClick={() => setShut(!shut)}
        >
          <Icon name="chev" size="sm" />
        </button>
        <span
          className={`thread-where${gone ? ' thread-where-gone' : ''}`}
          title={gone ? 'this file is no longer in the changeset' : undefined}
        >
          {anchorLabel(thread, gone)}
        </span>
        {shut && thread.messages.length > 1 && (
          <span className="thread-where-n">{thread.messages.length} messages</span>
        )}
        {marks}
        {shut && reopenButton}
      </div>
      {shut ? (
        <button type="button" className="thread-shut-peek" onClick={() => setShut(false)}>
          {thread.messages[0]?.text ?? ''}
        </button>
      ) : (
        <>
          {showContext && thread.codeContext && <ThreadContext code={thread.codeContext} />}
          {showManualHint && (
            <div className="thread-hint">
              waiting on your agent — paste the copied prompt into it; replies land here live
            </div>
          )}
          {withheld && (
            <div className="thread-hint">
              {gone
                ? 'your reply is held here — Send hands it over; Finish review will not, since this file has left the changeset'
                : 'your reply is held here — Send hands it over now, or Finish review takes it with the batch'}
            </div>
          )}
          <div className="thread-messages">
            {thread.messages.map((m, i) => (
              <Fragment key={m.id}>
                {i === pendingAt && pendingReply}
                <div className={`cmt thread-message thread-message-${m.author}`}>
                  <div className="cmt-head">
                    <Avatar who={m.author === 'reviewer' ? 'you' : 'agent'} />
                    <span className={`cmt-who cmt-who-${m.author}`}>
                      {m.author === 'reviewer' ? 'You' : 'Agent'}
                    </span>
                    <span className="cmt-when">
                      {m.author === 'agent' && m.durationMs !== undefined
                        ? `answered in ${formatAgentDuration(m.durationMs)}`
                        : `${verbFor(m.author, i)} ${timeAgo(m.at)}`}
                    </span>
                  </div>
                  <Body text={m.text} />
                </div>
              </Fragment>
            ))}
            {pendingAt >= thread.messages.length && pendingReply}
          </div>
          {actionFailed && (
            <div className="thread-hint thread-hint-error">
              couldn't reach the diffo server — your text is still here; try again
            </div>
          )}
          {manual && (
            <>
              <div className="thread-hint thread-hint-error">
                couldn't reach the clipboard — this browser blocked it. The thread is marked sent;
                select the prompt below and copy it by hand.
              </div>
              <pre className="invite-prompt">{manual}</pre>
            </>
          )}
        </>
      )}
      {!shut && (
        <div className={`thread-foot${showStub || writing ? '' : ' thread-foot-bare'}`}>
          {showStub && (
            <button
              type="button"
              className="thread-reply-stub replybar"
              onClick={() => setReplyOpen(true)}
            >
              Reply…
            </button>
          )}
          {writing && (
            <textarea
              // biome-ignore lint/a11y/noAutofocus: the reply box is opened by an explicit click
              autoFocus
              rows={1}
              className="thread-input"
              placeholder="reply…"
              value={reply}
              onChange={(e) => setReply(e.target.value)}
              onBlur={() => {
                if (!reply.trim()) setReplyOpen(false)
              }}
              onKeyDown={(e) => {
                if (e.key === 'Escape' && !reply.trim()) setReplyOpen(false)
                else submitOnCmdEnter(e, () => doReply(true))
              }}
            />
          )}
          {!showStub && !writing && <span className="thread-spacer" />}
          {writing && reply.trim() !== '' && (
            <button
              type="button"
              className="btn btn-primary btn-sm"
              onClick={() => doReply(true)}
              title={
                replyDispatches
                  ? 'reply and hand it to your agent in one go'
                  : 'write it into the thread'
              }
            >
              {replyDispatches ? (
                <>
                  <Icon name="send" size="sm" /> Reply &amp; send
                </>
              ) : (
                'Reply'
              )}
              <span className="btn-kbd">⌘↵</span>
            </button>
          )}
          {writing && reply.trim() !== '' && replyDispatches && (
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => doReply(false)}
              title={
                gone
                  ? 'write it into the thread without handing it over — Send takes it; the finish batch will not'
                  : 'write it into the thread without handing it over — Send or Finish takes it'
              }
            >
              Reply
            </button>
          )}
          {sendButton}
          {copyPromptButton}
          {resolveButton}
          {thread.state === 'resolved' && (
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => setExpanded(false)}
            >
              Collapse
            </button>
          )}
          {deleteButton}
        </div>
      )}
    </div>
  )
}

/** What the thread hangs off, said the way GitHub says it — the card needs a top
 * edge, and the one fact worth putting there is where the comment landed. A card
 * whose file left the changeset isn't sitting under that file any more, so it names
 * the path it came from instead of a bare line number. Agent-started threads name
 * their author instead of "Comment" — the head is where the voice is declared. */
function anchorLabel(thread: ReviewThread, gone = false): string {
  const anchor = thread.anchor
  const word = startedByAgent(thread) ? 'Agent comment' : 'Comment'
  if (anchor.kind === 'changeset') {
    return startedByAgent(thread) ? `${word} on the changeset` : 'Note on the changeset'
  }
  if (gone) return anchor.kind === 'hunk' ? `${anchor.path}:${anchor.line}` : anchor.path
  if (anchor.kind === 'hunk') return `${word} on line ${anchor.line}`
  return `${word} on this file`
}

export function ThreadList({
  threads,
  actions,
  showContext = false,
  agentConnected = false,
  workingOn,
  queuedOn,
  gone = false,
}: {
  threads: ReviewThread[]
  actions: ReviewActions
  showContext?: boolean
  agentConnected?: boolean
  workingOn?: ReadonlySet<string>
  queuedOn?: ReadonlyMap<string, number>
  gone?: boolean
}) {
  if (threads.length === 0) return null
  return (
    <div className="thread-list">
      {threads.map((t) => (
        <ThreadCard
          key={t.id}
          thread={t}
          actions={actions}
          showContext={showContext}
          agentConnected={agentConnected}
          working={workingOn?.has(t.id) ?? false}
          queuePosition={queuedOn?.get(t.id)}
          gone={gone}
        />
      ))}
    </div>
  )
}
