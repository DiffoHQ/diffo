import { Fragment, type ReactNode, useEffect, useRef, useState } from 'react'
import {
  type Audience,
  type Author,
  anchorSpan,
  isPublic,
  type ReviewMessage,
  type ReviewThread,
  seenByAgent,
  startedByAgent,
  type ThreadIntent,
  type ThreadState,
  untouchedAgentVoice,
} from '../../shared/review.js'
import { linkPaths, type RefLinks, refClickTarget } from '../layers.js'
import { timeAgo } from '../markdown.js'
import { usePr } from '../prMode.js'
import { firstLine, isUnsent, TURN_LABEL } from '../threads.js'
import { Avatar, CommentBox } from './CommentBox.js'
import { Icon } from './Icon.js'
import { Markdown } from './Markdown.js'

export interface ReviewActions {
  create: (
    anchor: import('../../shared/review.js').Anchor,
    text: string,
    intent?: import('../../shared/review.js').ThreadIntent,
    options?: { audience?: Audience; parentId?: string },
  ) => Promise<ReviewThread>
  reply: (threadId: string, text: string, deliver?: boolean) => Promise<unknown>
  /** Rewrite one of the reviewer's own messages; see `ReviewStore.editMessage`. */
  edit?: (threadId: string, messageId: string, text: string, deliver?: boolean) => Promise<unknown>
  send: (threadId: string) => Promise<{ delivered: boolean; copied?: boolean; prompt?: string }>
  resolve: (threadId: string) => Promise<unknown>
  reopen: (threadId: string) => Promise<unknown>
  remove?: (threadId: string) => Promise<unknown>
}

/** The kind the reviewer declared, as the card shows it — the composer's own
 * words, so the badge reads as "what I picked", not as a new vocabulary. */
export const INTENT_WORD: Record<ThreadIntent, string> = {
  fix: 'Change',
  question: 'Question',
}

/* One vocabulary, card and rail alike: Draft (yours, not sent) → Sent →
 * Answered / Addressed (the agent replied, or changed the code you asked
 * about) → Resolved. */
const STATE_LABEL: Record<ThreadState, string> = {
  open: 'Draft',
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
  followUp,
  since,
}: {
  working: boolean
  place?: number
  unanswered?: boolean
  followUp?: boolean
  since?: string
}) {
  const when = unanswered
    ? 'no answer, the agent moved on'
    : working
      ? `with the agent${since ? ` · ${timeAgo(since)}` : ''}`
      : followUp
        ? `follow-up on the way${since ? ` · ${timeAgo(since)}` : ''}`
        : `queued, ${formatQueuePlace(place ?? 1)}`
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
function verbFor(author: Author, index: number): string {
  if (author === 'reviewer') return 'commented'
  return index === 0 ? 'commented' : 'replied'
}

const REVIEW_STATE_LABEL = {
  APPROVED: 'approved',
  CHANGES_REQUESTED: 'requested changes',
  COMMENTED: 'reviewed',
  DISMISSED: 'dismissed',
} as const

/**
 * The words an agent reply hands to "Post as PR comment": its ```suggestion
 * block when it wrote one (GitHub renders that as an applicable change), else
 * the reply itself; the reviewer's own last words when the agent never spoke.
 */
export function promotionText(thread: ReviewThread): string {
  const agent = [...thread.messages].reverse().find((m) => m.author === 'agent')
  if (agent) {
    const block = /```suggestion\n[\s\S]*?```/.exec(agent.text)
    return block ? block[0] : agent.text
  }
  return [...thread.messages].reverse().find((m) => m.author === 'reviewer')?.text ?? ''
}

function submitOnCmdEnter(e: React.KeyboardEvent, submit: () => void) {
  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
    e.preventDefault()
    submit()
  }
}

/** A message body. With `links`, a code span naming a changeset file — and a
 * diagram node naming one — becomes a jump into the review: the guide is a map,
 * and a map you can click is navigation. */
function Body({ text, links }: { text: string; links?: RefLinks }) {
  if (!links) return <Markdown className="cmt-body markdown" text={text} />
  const onClick = (e: React.MouseEvent) => {
    const ref = refClickTarget(e.target as Element)
    if (!ref) return
    e.preventDefault()
    links.onJump(ref.path, ref.line)
  }
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: click delegation for the links inside rendered markdown
    // biome-ignore lint/a11y/useKeyWithClickEvents: the links themselves are focusable and keyboard-activated
    <div onClick={onClick}>
      <Markdown
        className="cmt-body markdown"
        text={linkPaths(text, links.paths)}
        paths={links.paths}
      />
    </div>
  )
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
  links,
  asides,
}: {
  thread: ReviewThread
  actions: ReviewActions
  showContext?: boolean
  agentConnected?: boolean
  working?: boolean
  queuePosition?: number
  gone?: boolean
  /** File references in the messages become jumps into the review. */
  links?: RefLinks
  /** Private asides under a public thread, already rendered. */
  asides?: ReactNode
}) {
  // On a pull request every thread has a side. A public one is a review
  // comment for GitHub — drafted here, posted on Finish; a private one is
  // today's thread with the agent. Off a PR `pr` is null and none of this shows.
  const pr = usePr()
  const publicThread = isPublic(thread)
  const gh = thread.github
  const draft = publicThread && thread.state === 'open' && gh === undefined
  const imported = gh !== undefined && thread.id.startsWith('gh:')
  const [promote, setPromote] = useState<string | null>(null)
  const [reply, setReply] = useState('')
  const [copied, setCopied] = useState(false)
  // The prompt to show when the clipboard refuses — copying is the whole point of
  // the unattached send, so a silent failure there strands the reviewer.
  const [manual, setManual] = useState<string | null>(null)
  const [actionFailed, setActionFailed] = useState(false)
  const [replyOpen, setReplyOpen] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const [shut, setShut] = useState(false)
  // The message being rewritten and its draft. One at a time: the editor takes
  // that message's body in place, and the error is the server's own words — a
  // refusal ("the agent is answering") must not read as a dropped connection.
  const [editing, setEditing] = useState<{ id: string; draft: string } | null>(null)
  const [editError, setEditError] = useState<string | null>(null)
  const card = useRef<HTMLDivElement>(null)
  const box = useRef<HTMLTextAreaElement>(null)
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
  const editIndex = editing ? thread.messages.findIndex((m) => m.id === editing.id) : -1
  // Everything below the edited message goes when it is saved — struck through
  // while the editor is open, so the rewind is visible before it happens.
  const cutCount = editIndex === -1 ? 0 : thread.messages.length - 1 - editIndex
  const editSeen = editIndex !== -1 && seenByAgent(thread, editIndex)
  // Resend is a choice only when the rewrite reaches a live agent; otherwise
  // Save does what Reply does and the thread waits in the queue.
  const editDispatches =
    editSeen && agentConnected && (thread.state === 'sent' || thread.state === 'addressed')
  // A message already on GitHub is edited there, not here (see the server's guard).
  const canEdit = (m: ReviewMessage) =>
    actions.edit !== undefined &&
    m.author === 'reviewer' &&
    thread.state !== 'resolved' &&
    m.github === undefined
  const startEdit = (m: ReviewMessage) => {
    setEditError(null)
    setEditing({ id: m.id, draft: m.text })
  }
  const cancelEdit = () => {
    setEditing(null)
    setEditError(null)
  }
  // Close the editor only once the edit has landed — a refused save keeps the draft.
  const doEdit = (deliver = true) => {
    if (!editing || editIndex === -1) return
    const text = editing.draft.trim()
    if (!text) return
    if (text === thread.messages[editIndex]!.text.trim()) return cancelEdit()
    setEditError(null)
    actions.edit!(thread.id, editing.id, text, deliver)
      .then(cancelEdit)
      .catch((err: unknown) =>
        setEditError(
          err instanceof Error && err.message
            ? err.message
            : "couldn't reach the diffo server — your text is still here; try again",
        ),
      )
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
    !publicThread &&
    !withheld &&
    lastAuthor === 'reviewer' &&
    (thread.state === 'sent' || thread.state === 'addressed')
  const showManualHint = thread.state === 'sent' && awaitingAgent && !agentConnected
  const unpostedReplies =
    publicThread && gh
      ? thread.messages.filter((m) => m.author === 'reviewer' && m.github === undefined).length
      : 0
  const proposed = untouchedAgentVoice(thread) && thread.state === 'open'
  // Replying to the agent's own comment hands it over too — the server sends
  // the thread on that reply — so the composer offers the one-click primary.
  // A reply on a public thread is a GitHub reply, posted when the review is
  // submitted; it never dispatches to the agent, whatever the thread's state.
  const replyDispatches =
    !publicThread &&
    agentConnected &&
    (thread.state === 'sent' || thread.state === 'addressed' || proposed)
  const composerOpen = replyOpen || reply.trim() !== ''
  // The composer takes the stub's slot in the foot, so writing a reply adds one
  // button to the row it already had rather than a second band of its own.
  const writing = thread.state !== 'resolved' && composerOpen
  const showStub = thread.state !== 'resolved' && !composerOpen
  // The agent offered the reviewer their answer: ghost text in the composer,
  // Tab takes it. Only while the agent has the last word — the reviewer's own
  // reply, whatever it says, supersedes the offer.
  const last = thread.messages[thread.messages.length - 1]
  const offered =
    thread.state !== 'resolved' && last?.author === 'agent' ? (last.suggestedReply ?? null) : null
  const ghost = offered !== null && reply === ''
  // Take the offer as the draft: the box opens with it, caret at the end, so
  // the next keystroke edits it and ⌘↵ sends it.
  const useOffer = () => {
    if (offered === null) return
    setReply(offered)
    setReplyOpen(true)
    requestAnimationFrame(() => {
      const el = box.current
      if (!el) return
      el.focus()
      el.setSelectionRange(el.value.length, el.value.length)
    })
  }
  const takesOffer = (e: React.KeyboardEvent) =>
    ghost &&
    (e.key === 'Tab' || e.key === 'ArrowRight') &&
    !e.shiftKey &&
    !e.metaKey &&
    !e.ctrlKey &&
    !e.altKey

  const status = publicThread
    ? draft
      ? 'Draft'
      : thread.state === 'resolved'
        ? 'Resolved'
        : 'On GitHub'
    : proposed
      ? 'From the agent'
      : withheld
        ? TURN_LABEL.note
        : thread.state === 'addressed' && thread.intent === 'fix'
          ? 'Addressed'
          : STATE_LABEL[thread.state]
  const tone: string = publicThread
    ? draft
      ? 'attn'
      : thread.state === 'resolved'
        ? 'mute'
        : 'pr'
    : proposed || withheld
      ? 'attn'
      : STATE_TONE[thread.state]

  // A resolve or reopen queued for the submit: on the open card's marks, and on
  // the collapsed resolved line too, or a queued resolve reads as one already
  // on GitHub.
  const queuedMarks = (
    <>
      {thread.queued?.resolve && (
        <span className="thread-badge thread-badge-pr">resolves when you submit</span>
      )}
      {thread.queued?.unresolve && (
        <span className="thread-badge thread-badge-pr">reopens when you submit</span>
      )}
    </>
  )
  // State and badges ride the first byline rather than a banded header row of their
  // own: on a two-line thread that band was taller than the comment it labelled.
  const marks = (
    <span className="thread-marks">
      {thread.intent && !startedByAgent(thread) && (
        <span className={`thread-badge thread-badge-kind thread-kind-${thread.intent}`}>
          {INTENT_WORD[thread.intent]}
        </span>
      )}
      {thread.closingNote && <span className="thread-badge">closing note</span>}
      {gh?.reviewState && (
        <span className={`thread-badge thread-badge-${gh.reviewState.toLowerCase()}`}>
          {REVIEW_STATE_LABEL[gh.reviewState]}
        </span>
      )}
      {gh?.outdated && (
        <span className="thread-badge" title="the commented line is no longer in the diff">
          outdated
        </span>
      )}
      {draft && <span className="thread-badge thread-badge-pr">posts when you submit</span>}
      {unpostedReplies > 0 && (
        <span className="thread-badge thread-badge-pr">
          {unpostedReplies === 1 ? 'reply posts' : `${unpostedReplies} replies post`} when you
          submit
        </span>
      )}
      {queuedMarks}
      {gh?.url && (
        <a
          className="thread-badge thread-badge-link"
          href={gh.url}
          target="_blank"
          rel="noreferrer"
          title="open on GitHub"
        >
          <Icon name="link" size="sm" /> GitHub
        </a>
      )}
      {thread.codeChanged && (
        <span className="thread-badge">
          <Icon name="alert" size="sm" /> code changed since this comment
        </span>
      )}
      {copied && <span className="thread-badge">prompt copied, paste it to your agent</span>}
      <span className={`chip chip-${tone}`}>{status}</span>
    </span>
  )

  // A `--more` reply promised a follow-up: keep the typing indicator going
  // under the interim answer instead of handing the turn back.
  const followUp = thread.awaitingFollowUp === true
  const pendingReply =
    !publicThread && (working || queuePosition !== undefined || thread.unanswered || followUp) ? (
      <PendingReply
        working={working}
        place={queuePosition}
        followUp={followUp}
        unanswered={thread.unanswered === true && queuePosition === undefined && !working}
        since={thread.updatedAt}
      />
    ) : null
  // While the agent is composing, the indicator sits where the answer will land:
  // after the words the delivery carried (its own interim reply included),
  // above any the reviewer raced in since.
  const seenThrough =
    (working || followUp) && thread.deliveredThrough ? Date.parse(thread.deliveredThrough) : null
  const racedAt =
    seenThrough === null
      ? -1
      : thread.messages.findIndex((m) => m.author === 'reviewer' && Date.parse(m.at) > seenThrough)
  const pendingAt = racedAt === -1 ? thread.messages.length : racedAt
  // A rewind in the editor is about to cut the turn the indicator stands for.
  const pending = cutCount > 0 ? null : pendingReply

  const resolveButton =
    thread.state === 'resolved' ? (
      <button
        type="button"
        className="btn btn-ghost btn-sm"
        onClick={() => void actions.reopen(thread.id)}
      >
        Reopen
      </button>
    ) : draft && actions.remove ? (
      <button
        type="button"
        className="btn btn-ghost btn-sm"
        title="drop this draft; nothing was posted"
        onClick={() => void actions.remove!(thread.id)}
      >
        Discard draft
      </button>
    ) : (
      <button
        type="button"
        className="btn btn-ghost btn-sm"
        title={
          gh ? 'resolve on GitHub when you submit; until then it is only marked here' : undefined
        }
        onClick={() => void actions.resolve(thread.id)}
      >
        Resolve
      </button>
    )

  // Private → public only: the agent's words (its suggestion block, when it
  // wrote one) become an editable draft on the same anchor; nothing of the
  // agent's reaches GitHub on its own. A public card offers no way to the
  // agent: its row is GitHub's, and a private question about the same lines
  // starts from the composer's Ask agent side.
  const promoteButton = pr && !publicThread && thread.messages.length > 0 && (
    <button
      type="button"
      className="btn btn-ghost btn-sm thread-promote"
      title="turn this into a review comment for GitHub; you edit it before it joins the review"
      onClick={() => setPromote(promotionText(thread))}
    >
      <Icon name="globe" size="sm" /> Post as PR comment
    </button>
  )
  const promoteComposer = promote !== null && (
    <div className="thread-aside-compose">
      <CommentBox
        title="Comment on PR"
        placeholder="The review comment as GitHub will show it…"
        fixedAudience="pr"
        initialText={promote}
        agentConnected={agentConnected}
        onSubmit={(text) => {
          void actions.create(thread.anchor, text, undefined, { audience: 'pr' })
          setPromote(null)
        }}
        onCancel={() => setPromote(null)}
      />
    </div>
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
  // A thread GitHub owns comes back on the next pull; deleting it here is noise.
  const deleteButton = actions.remove && !imported && (
    <button
      type="button"
      className="btn btn-ghost btn-icon btn-sm btn-ghost-danger"
      aria-label="delete this thread"
      data-tip="delete this thread"
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
          {queuedMarks}
          <span className="thread-collapsed-text">{firstLine(first?.text ?? '')}</span>
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
      className={`thread conv thread-${thread.state}${
        publicThread ? ' thread-public' : pr ? ' thread-private' : ''
      }${thread.parentId ? ' thread-aside' : ''}`}
      data-thread-id={thread.id}
      ref={card}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="thread-head">
        <button
          type="button"
          className={`thread-shut chevron${shut ? ' chevron-shut' : ''}`}
          aria-expanded={!shut}
          data-tip={shut ? 'expand this thread' : 'collapse this thread'}
          aria-label={shut ? 'expand this thread' : 'collapse this thread'}
          onClick={() => setShut(!shut)}
        >
          <Icon name="chev" size="sm" />
        </button>
        {pr && (
          <span
            className={`thread-side thread-side-${publicThread ? 'pr' : 'agent'}`}
            title={
              publicThread
                ? 'a review comment: on GitHub, or headed there when you submit'
                : 'private: between you and your agent, never leaves this machine'
            }
          >
            <Icon name={publicThread ? 'globe' : 'lock'} size="sm" />
            {publicThread ? 'PR comment' : 'Private'}
          </span>
        )}
        <span
          className={`thread-where${gone ? ' thread-where-gone' : ''}`}
          title={
            gone
              ? gh?.outdated
                ? 'outdated on GitHub: the line left the diff'
                : 'this file is no longer in the changeset'
              : undefined
          }
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
          {firstLine(thread.messages[0]?.text ?? '')}
        </button>
      ) : (
        <>
          {showContext && thread.codeContext && <ThreadContext code={thread.codeContext} />}
          {showManualHint && (
            <div className="thread-hint">
              waiting on your agent: paste the copied prompt into it; replies land here live
            </div>
          )}
          {withheld && (
            <div className="thread-hint">
              {gone
                ? 'your reply is held here: Send hands it over; Finish review will not, since this file has left the changeset'
                : 'your reply is held here: Send hands it over now, or Finish review takes it with the batch'}
            </div>
          )}
          <div className="thread-messages">
            {thread.messages.map((m, i) => (
              <Fragment key={m.id}>
                {i === pendingAt && pending}
                <div
                  className={`cmt thread-message thread-message-${m.author}${
                    i === editIndex ? ' thread-message-editing' : ''
                  }${editIndex !== -1 && i > editIndex ? ' thread-message-cut' : ''}`}
                >
                  <div className="cmt-head">
                    <Avatar
                      who={
                        m.author === 'reviewer' ? 'you' : m.author === 'agent' ? 'agent' : 'github'
                      }
                      user={m.github?.user}
                    />
                    <span className={`cmt-who cmt-who-${m.author}`}>
                      {m.author === 'reviewer'
                        ? 'You'
                        : m.author === 'agent'
                          ? 'Agent'
                          : (m.github?.user.login ?? 'GitHub')}
                    </span>
                    <span className="cmt-when">
                      {m.author === 'agent' && m.durationMs !== undefined
                        ? `answered in ${formatAgentDuration(m.durationMs)}`
                        : `${verbFor(m.author, i)} ${timeAgo(m.at)}`}
                      {m.editedAt && ' · edited'}
                      {m.author === 'github' && ' · on GitHub'}
                      {m.author === 'reviewer' && publicThread && m.github && ' · on GitHub'}
                      {m.author === 'reviewer' &&
                        publicThread &&
                        !m.github &&
                        (draft ? ' · draft' : ' · posts when you submit')}
                    </span>
                    {canEdit(m) && editing?.id !== m.id && (
                      <button
                        type="button"
                        className="btn btn-ghost btn-icon btn-sm cmt-edit"
                        aria-label="edit this message"
                        // Not `disabled`: a disabled button shows no tooltip, and
                        // the tooltip is the only place that says why.
                        aria-disabled={working || undefined}
                        data-tip={
                          working
                            ? 'the agent is answering — edit after it replies'
                            : 'edit this message'
                        }
                        onClick={() => {
                          if (!working) startEdit(m)
                        }}
                      >
                        <Icon name="edit" size="sm" />
                      </button>
                    )}
                  </div>
                  {editing?.id === m.id ? (
                    <div className="cmt-edit-box">
                      <textarea
                        // biome-ignore lint/a11y/noAutofocus: the editor is opened by an explicit click
                        autoFocus
                        className="cmt-edit-input"
                        aria-label="edit your message"
                        value={editing.draft}
                        onFocus={(e) =>
                          e.currentTarget.setSelectionRange(
                            e.currentTarget.value.length,
                            e.currentTarget.value.length,
                          )
                        }
                        onChange={(e) => setEditing({ id: m.id, draft: e.target.value })}
                        onKeyDown={(e) => {
                          if (e.key === 'Escape') {
                            e.preventDefault()
                            cancelEdit()
                          } else submitOnCmdEnter(e, () => doEdit(true))
                        }}
                      />
                      {editError && (
                        <div className="cmt-edit-error" role="alert">
                          {editError}
                        </div>
                      )}
                      <div className="cmt-edit-foot">
                        <button type="button" className="btn btn-ghost btn-sm" onClick={cancelEdit}>
                          Cancel
                        </button>
                        {editDispatches && (
                          <button
                            type="button"
                            className="btn btn-ghost btn-sm"
                            onClick={() => doEdit(false)}
                            title={
                              gone
                                ? 'save it without handing it over — Send takes it; the finish batch will not'
                                : 'save it without handing it over — Send or Finish takes it'
                            }
                          >
                            Save
                          </button>
                        )}
                        <button
                          type="button"
                          className="btn btn-primary btn-sm"
                          onClick={() => doEdit(true)}
                          title={
                            editDispatches
                              ? 'save the edit and hand the thread back to your agent — its withdrawn replies are named, and code it changed for them stays until it says otherwise'
                              : editSeen
                                ? 'save the edit — the thread waits for the agent, which is told its earlier replies were withdrawn'
                                : 'save the edit'
                          }
                        >
                          {editDispatches ? (
                            <>
                              <Icon name="send" size="sm" /> Save &amp; resend
                            </>
                          ) : (
                            'Save'
                          )}
                          <span className="btn-kbd">⌘↵</span>
                        </button>
                      </div>
                    </div>
                  ) : (
                    <Body text={m.text} links={links} />
                  )}
                </div>
                {/* The rewind point: a rule across the thread where the cut
                    happens, so "everything below goes" is a place, not a sentence.
                    Short enough to stay one line; the rest rides the Save tooltip. */}
                {i === editIndex && cutCount > 0 && (
                  <div className="cmt-cut" role="note">
                    <span>
                      {`Saving removes the ${cutCount === 1 ? 'message' : `${cutCount} messages`} below`}
                      {editSeen && ' · the agent answers again'}
                    </span>
                  </div>
                )}
              </Fragment>
            ))}
            {pendingAt >= thread.messages.length && pending}
          </div>
          {asides && <div className="thread-asides">{asides}</div>}
          {promoteComposer}
          {actionFailed && (
            <div className="thread-hint thread-hint-error">
              couldn't reach the diffo server; your text is still here, try again
            </div>
          )}
          {manual && (
            <>
              <div className="thread-hint thread-hint-error">
                couldn't reach the clipboard; this browser blocked it. The thread is marked sent;
                select the prompt below and copy it by hand.
              </div>
              <pre className="invite-prompt">{manual}</pre>
            </>
          )}
        </>
      )}
      {/* One composer at a time: while a message is rewritten, the reply bar and
          the close-out buttons wait. */}
      {!shut && editIndex === -1 && (
        <div className={`thread-foot${showStub || writing ? '' : ' thread-foot-bare'}`}>
          {showStub && offered !== null && (
            <div className="thread-offer replybar">
              <button
                type="button"
                className="thread-reply-stub thread-reply-stub-offer"
                onClick={() => setReplyOpen(true)}
                title="the agent suggests this reply — click to write your own, Tab in the box takes this one"
              >
                <Icon name="sparkle" size="sm" className="thread-offer-icon" />
                <span className="thread-offer-text">{offered}</span>
              </button>
              <button
                type="button"
                className="btn btn-outline btn-sm thread-offer-use"
                onClick={useOffer}
                title="take the suggested reply into the box, ready to edit or send"
              >
                Use
              </button>
            </div>
          )}
          {showStub && offered === null && (
            <button
              type="button"
              className="thread-reply-stub replybar"
              onClick={() => setReplyOpen(true)}
            >
              {publicThread ? 'Reply on GitHub…' : 'Reply…'}
            </button>
          )}
          {writing && (
            <div className={`thread-input-wrap${ghost ? ' thread-input-wrap-ghost' : ''}`}>
              {/* The glyph belongs to the ghost text, not the field: the moment
                  the reviewer types, the words are theirs and it goes. */}
              {ghost && (
                <Icon name="sparkle" size="sm" className="thread-offer-icon thread-ghost-icon" />
              )}
              <textarea
                // biome-ignore lint/a11y/noAutofocus: the reply box is opened by an explicit click
                autoFocus
                ref={box}
                rows={1}
                className={`thread-input${ghost ? ' thread-input-ghost' : ''}`}
                // The placeholder IS the ghost text: it wraps and sits exactly
                // where the typed reply will, for free.
                placeholder={
                  ghost
                    ? offered
                    : publicThread
                      ? 'reply on GitHub, posts when you submit…'
                      : 'reply…'
                }
                aria-description={
                  ghost ? 'the agent offered this reply; press Tab to take it' : undefined
                }
                value={reply}
                onChange={(e) => setReply(e.target.value)}
                onBlur={() => {
                  if (!reply.trim()) setReplyOpen(false)
                }}
                onKeyDown={(e) => {
                  if (takesOffer(e)) {
                    e.preventDefault()
                    setReply(offered!)
                  } else if (e.key === 'Escape' && !reply.trim()) setReplyOpen(false)
                  else submitOnCmdEnter(e, () => doReply(true))
                }}
              />
              {ghost && (
                <button
                  type="button"
                  className="thread-offer-kbd thread-ghost-hint"
                  // Keep the caret in the box: a click here must not blur it shut.
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={useOffer}
                  title="take the suggested reply (Tab)"
                >
                  Tab
                </button>
              )}
            </div>
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
                  : publicThread
                    ? 'reply on GitHub; it posts when you submit the review'
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
                  ? 'write it into the thread without handing it over: Send takes it; the finish batch will not'
                  : 'write it into the thread without handing it over: Send or Finish takes it'
              }
            >
              Reply
            </button>
          )}
          {sendButton}
          {copyPromptButton}
          {promoteButton}
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
  const gh = thread.github
  if (gh?.kind === 'description') return 'Pull request description'
  if (gh?.kind === 'review') return 'Review on the pull request'
  if (gh?.kind === 'comment' || (isPublic(thread) && anchor.kind === 'changeset')) {
    return 'Comment on the pull request'
  }
  const word = startedByAgent(thread)
    ? 'Agent comment'
    : thread.messages[0]?.author === 'github'
      ? `${thread.messages[0].github?.user.login ?? 'GitHub'}'s comment`
      : isPublic(thread)
        ? 'Review comment'
        : 'Comment'
  if (anchor.kind === 'changeset') {
    return startedByAgent(thread) ? `${word} on the changeset` : 'Note on the changeset'
  }
  if (gone) return anchor.kind === 'hunk' ? `${anchor.path}:${anchorSpan(anchor)}` : anchor.path
  if (anchor.kind === 'hunk') {
    return `${word} on ${anchor.endLine === undefined ? 'line' : 'lines'} ${anchorSpan(anchor)}`
  }
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
  links,
}: {
  threads: ReviewThread[]
  actions: ReviewActions
  showContext?: boolean
  agentConnected?: boolean
  workingOn?: ReadonlySet<string>
  queuedOn?: ReadonlyMap<string, number>
  gone?: boolean
  links?: RefLinks
}) {
  if (threads.length === 0) return null
  // A private aside renders inside its public parent, not beside it. An aside
  // whose parent is elsewhere (a re-anchored parent) stands on its own.
  const ids = new Set(threads.map((t) => t.id))
  const asidesOf = new Map<string, ReviewThread[]>()
  for (const t of threads) {
    if (t.parentId && ids.has(t.parentId)) {
      const list = asidesOf.get(t.parentId)
      if (list) list.push(t)
      else asidesOf.set(t.parentId, [t])
    }
  }
  const card = (t: ReviewThread, asides?: ReactNode) => (
    <ThreadCard
      key={t.id}
      thread={t}
      actions={actions}
      showContext={showContext}
      agentConnected={agentConnected}
      working={workingOn?.has(t.id) ?? false}
      queuePosition={queuedOn?.get(t.id)}
      gone={gone}
      links={links}
      asides={asides}
    />
  )
  return (
    <div className="thread-list">
      {threads
        .filter((t) => !(t.parentId && ids.has(t.parentId)))
        .map((t) => {
          const nested = asidesOf.get(t.id)
          return card(
            t,
            nested?.map((a) => card(a)),
          )
        })}
    </div>
  )
}
