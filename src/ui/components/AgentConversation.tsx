import { useState } from 'react'
import { timeAgo } from '../markdown.js'
import { Avatar } from './CommentBox.js'
import { Confirm } from './Confirm.js'
import { Icon } from './Icon.js'
import { Markdown } from './Markdown.js'

/**
 * A conversation with the author agent about one thing the reviewer keeps — a
 * layers preset, a reviewer role — as the card a review thread is: the same
 * message rows, the same "with the agent" line while an answer is owed, the
 * same reply bar. The Layers presets dialog and the Reviewer agents page both
 * use it, so the two read and behave alike. An agent message that changed the
 * thing carries the fields it set and an undo.
 */

/** What an agent's edit did, as both kinds of conversation record it. */
export interface ConversationChange {
  fields: readonly string[]
  /** The values before, for undo. Empty when the agent made the thing. */
  before: Readonly<Record<string, string | undefined>>
  created?: boolean
}

export interface ConversationMessage<C extends ConversationChange> {
  id: string
  author: 'reviewer' | 'agent'
  text: string
  at: string
  change?: C
}

/** A conversation as its hook keeps it: current from the events stream. */
export interface ConversationState<C extends ConversationChange> {
  thread: { messages: readonly ConversationMessage<C>[] }
  /** Resolves to something when the message was taken, null when refused. */
  send: (text: string) => Promise<unknown>
  clear: () => Promise<boolean>
}

export interface AgentConversationProps<C extends ConversationChange> {
  conversation: ConversationState<C>
  canAsk: boolean
  /** What the conversation is about, in a word: "preset", "role". */
  noun: string
  /** How each field is named where a change lists it. */
  fieldLabels: Readonly<Record<string, string>>
  maxLength: number
  /** The first message's box, named for what it does. */
  title: string
  /** What the agent is sent besides the messages: the caption's tooltip,
   * since it never shows in the thread. */
  context: string
  /** One short line at the foot of the first message's box: what the agent
   * does with it. */
  hint: string
  placeholder: string
  /** The thing as it stands: a change whose fields are back where they were
   * reads as undone, and offers no undo. */
  current?: object | undefined
  onUndo?: ((change: C) => void) | undefined
  /** A change that made something other than this thread's own (a copy of a
   * built-in): the way to open it, or undefined. */
  openMade?: ((change: C) => (() => void) | undefined) | undefined
}

export function AgentConversation<C extends ConversationChange>({
  conversation,
  canAsk,
  noun,
  fieldLabels,
  maxLength,
  title,
  context,
  hint,
  placeholder,
  current,
  onUndo,
  openMade,
}: AgentConversationProps<C>) {
  const { thread, send, clear } = conversation
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  // A new conversation asks first, in a dialog.
  const [clearing, setClearing] = useState(false)
  const trimmed = text.trim()
  const last = thread.messages.at(-1)
  // The reviewer spoke last: the agent is owed an answer, and the card says so.
  const waiting = last?.author === 'reviewer'
  const submit = async () => {
    if (trimmed === '' || !canAsk || sending) return
    setSending(true)
    const sent = await send(trimmed)
    setSending(false)
    if (sent) setText('')
  }
  const first = thread.messages.length === 0
  const input = (
    <textarea
      // The first message gets room to say what is wanted.
      rows={first ? 3 : 1}
      className={first ? 'thread-input cbox-input' : 'thread-input'}
      aria-label="Tell the agent what to change"
      value={text}
      maxLength={maxLength}
      // The example is for the first message; after it, this is a reply box.
      placeholder={first ? placeholder : 'Reply…'}
      onChange={(e) => setText(e.target.value)}
      onKeyDown={(e) => {
        if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
          e.preventDefault()
          void submit()
        }
      }}
    />
  )
  const sendButton = (
    <button
      type="button"
      className="btn btn-primary btn-sm"
      disabled={trimmed === '' || !canAsk || sending}
      title={
        canAsk
          ? 'send it to your agent; it answers here and edits the fields'
          : 'needs an agent on the review'
      }
      onClick={() => void submit()}
    >
      <Icon name="send" size="sm" /> Send
      <span className="btn-kbd">⌘↵</span>
    </button>
  )
  return (
    <>
      {first ? (
        // Nothing said yet: the review's own "Ask your agent" box.
        <div className="cbox thread-composer cbox-agent lp-cbox">
          <div className="cbox-head">
            <span className="cbox-title" title={context}>
              {title}
            </span>
          </div>
          <div className="cbox-body">{input}</div>
          <div className="cbox-foot">
            <span className="cbox-hint">{canAsk ? hint : 'No agent on the review to talk to'}</span>
            <span className="cbox-actions">{sendButton}</span>
          </div>
        </div>
      ) : (
        // A conversation: the card a review thread is, head and all.
        <div className="thread conv thread-open lp-conv">
          <div className="thread-head lp-conv-head">
            <span className="thread-where" title={context}>
              Conversation with the agent
            </span>
            <button
              type="button"
              className="lp-sec-act"
              title={`Clear these messages and start over; the ${noun} stays as it is`}
              onClick={() => setClearing(true)}
            >
              New conversation
            </button>
          </div>
          <div className="thread-messages">
            {thread.messages.map((m) => (
              <Message
                key={m.id}
                message={m}
                noun={noun}
                fieldLabels={fieldLabels}
                current={current}
                onUndo={onUndo}
                openMade={openMade}
              />
            ))}
            {waiting && (
              <div className="cmt thread-message thread-message-agent thread-message-pending">
                <div className="cmt-head">
                  <Avatar who="agent" />
                  <span className="cmt-who cmt-who-agent">Agent</span>
                  <span className="cmt-when">
                    {canAsk ? 'with the agent' : 'waits for an agent on a review'}
                  </span>
                </div>
                <div className="cmt-body pending-reply" role="status" aria-label="with the agent">
                  <span className="pending-dots">
                    <i />
                    <i />
                    <i />
                  </span>
                </div>
              </div>
            )}
          </div>
          <div className="thread-foot">
            <div className="thread-input-wrap">{input}</div>
            {sendButton}
          </div>
        </div>
      )}
      {clearing && (
        <Confirm
          title="New conversation"
          action="Clear conversation"
          onConfirm={async () => {
            if (!(await clear())) throw new Error('refused')
          }}
          onClose={() => setClearing(false)}
        >
          Clears the messages. The {noun} stays as it is.
        </Confirm>
      )}
    </>
  )
}

function Message<C extends ConversationChange>({
  message,
  noun,
  fieldLabels,
  current,
  onUndo,
  openMade,
}: {
  message: ConversationMessage<C>
  noun: string
  fieldLabels: Readonly<Record<string, string>>
  current: object | undefined
  onUndo: ((change: C) => void) | undefined
  openMade: ((change: C) => (() => void) | undefined) | undefined
}) {
  const change = message.change
  const now = current as Readonly<Record<string, unknown>> | undefined
  // Every field this change set is back where it was: undone, by the link
  // below or by hand.
  const undone =
    change !== undefined &&
    now !== undefined &&
    change.fields.length > 0 &&
    change.fields.every((f) => f in change.before && now[f] === change.before[f])
  const open = change ? openMade?.(change) : undefined
  return (
    <div className={`cmt thread-message thread-message-${message.author}`}>
      <div className="cmt-head">
        <Avatar who={message.author === 'reviewer' ? 'you' : 'agent'} />
        <span className={`cmt-who cmt-who-${message.author}`}>
          {message.author === 'reviewer' ? 'You' : 'Agent'}
        </span>
        <span className="cmt-when">{timeAgo(message.at)}</span>
      </div>
      {message.text !== '' && <Markdown className="cmt-body markdown" text={message.text} />}
      {change && (
        <div className="lp-change">
          {change.created
            ? `Made the ${noun}`
            : `Changed ${change.fields.map((f) => (fieldLabels[f] ?? f).toLowerCase()).join(', ')}`}
          {open && (
            <>
              {' · '}
              <button type="button" className="lp-change-undo" onClick={open}>
                open it
              </button>
            </>
          )}
          {onUndo && !change.created && undone && ' · undone'}
          {onUndo && !change.created && change.fields.length > 0 && !undone && (
            <>
              {' · '}
              <button
                type="button"
                className="lp-change-undo"
                title="Put the fields back as they were before this change"
                onClick={() => onUndo(change)}
              >
                undo
              </button>
            </>
          )}
        </div>
      )}
    </div>
  )
}
