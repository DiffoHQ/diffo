import { useRef, useState } from 'react'
import type { Audience, ThreadIntent } from '../../shared/review.js'
import type { GhUser } from '../../shared/types.js'
import { usePr } from '../prMode.js'
import { Icon, type IconName } from './Icon.js'
import { Markdown } from './Markdown.js'

/** `github` is a person on the pull request: their avatar when GitHub gave one,
 * the first letter of their login otherwise. */
export function Avatar({ who, user }: { who: 'you' | 'agent' | 'github'; user?: GhUser }) {
  if (who === 'github') {
    return user?.avatarUrl ? (
      <img className="avatar avatar-github" src={user.avatarUrl} alt="" aria-hidden="true" />
    ) : (
      <span className="avatar avatar-github" aria-hidden="true">
        {(user?.login ?? '?').slice(0, 1).toUpperCase()}
      </span>
    )
  }
  return (
    <span className={`avatar avatar-${who}`} aria-hidden="true">
      <Icon name={who === 'you' ? 'user' : 'sparkle'} size="sm" />
    </span>
  )
}

/** The composer's audience switch, on a pull request: two tabs along the
 * composer's top edge, the live one filled in its side's color with the
 * consequence written into it. It is the loudest thing in the composer on
 * purpose — it decides whether the words leave the machine. */
export function AudienceTabs({
  value,
  onChange,
}: {
  value: Audience
  onChange: (next: Audience) => void
}) {
  return (
    <div className="aud-tabs" role="radiogroup" aria-label="Who this comment is for">
      {/* biome-ignore lint/a11y/useSemanticElements: styled tabs; a native radio cannot carry this treatment */}
      <button
        type="button"
        role="radio"
        aria-checked={value === 'pr'}
        className={`aud-tab aud-tab-pr${value === 'pr' ? ' aud-tab-on' : ''}`}
        title="a review comment: drafted here, posted to GitHub when you submit (⌘. flips)"
        onClick={() => onChange('pr')}
      >
        <Icon name="globe" size="sm" /> Comment on PR
      </button>
      {/* biome-ignore lint/a11y/useSemanticElements: styled tabs; a native radio cannot carry this treatment */}
      <button
        type="button"
        role="radio"
        aria-checked={value === 'agent'}
        className={`aud-tab aud-tab-agent${value === 'agent' ? ' aud-tab-on' : ''}`}
        title="a private question for your agent: never leaves this machine (⌘. flips)"
        onClick={() => onChange('agent')}
      >
        <Icon name="lock" size="sm" /> Ask agent
      </button>
    </div>
  )
}

export interface ToolbarButton {
  icon: IconName
  label: string
  wrap?: [string, string]
  prefix?: string
}

export const TOOLBAR: (ToolbarButton | 'sep')[] = [
  { icon: 'bold', label: 'Bold', wrap: ['**', '**'] },
  { icon: 'italic', label: 'Italic', wrap: ['_', '_'] },
  { icon: 'code', label: 'Code', wrap: ['`', '`'] },
  'sep',
  { icon: 'link', label: 'Link', wrap: ['[', '](url)'] },
  { icon: 'list', label: 'Bulleted list', prefix: '- ' },
  { icon: 'quote', label: 'Quote', prefix: '> ' },
  'sep',
  { icon: 'at', label: 'Reference a file', wrap: ['`', '`'] },
]

/** The three asks a reviewer of agent code makes most: one question, two
 * commands. Each fills a whole sentence and picks its kind, then hands the
 * caret over — the words are a start, not the message. (Excess comments is
 * the most-cited flaw in agent-written code; redundancy is next.) */
const OPENERS: { label: string; text: string; intent: ThreadIntent }[] = [
  {
    label: 'Explain this',
    text: 'Explain what this does and why it’s needed.',
    intent: 'question',
  },
  {
    label: 'Clean up the comments',
    text: 'Cut comments that narrate the code. Keep the ones that explain why.',
    intent: 'fix',
  },
  {
    label: 'Simplify this',
    text: 'Simplify this. Same behavior, less code, no new abstractions.',
    intent: 'fix',
  },
]

/** The three things a comment can declare it wants. The last is the default and
 * is a real state, not an absence: an unlabeled thread tells the agent to read
 * the intent from the words — so the control always shows one segment lit. */
const INTENTS: { intent: ThreadIntent | undefined; label: string; title: string }[] = [
  { intent: 'fix', label: 'Change', title: 'ask the agent to change the code' },
  {
    intent: 'question',
    label: 'Question',
    title: 'ask for an answer; the agent won’t change code',
  },
  {
    intent: undefined,
    label: 'Agent decides',
    title: 'no label — the agent reads what you want from your words',
  },
]

export function applyToolbar(
  el: HTMLTextAreaElement,
  action: ToolbarButton,
  setText: (next: string) => void,
): void {
  const { value, selectionStart: start, selectionEnd: end } = el
  const selected = value.slice(start, end)
  let next: string
  let caret: [number, number]
  if (action.prefix) {
    // Line-oriented: extend the selection to whole lines first, or a list marker
    // lands mid-word.
    const from = value.lastIndexOf('\n', start - 1) + 1
    const toIdx = value.indexOf('\n', end)
    const to = toIdx === -1 ? value.length : toIdx
    const block = value
      .slice(from, to)
      .split('\n')
      .map((line) => `${action.prefix}${line}`)
      .join('\n')
    next = value.slice(0, from) + block + value.slice(to)
    caret = [from, from + block.length]
  } else {
    const [before, after] = action.wrap!
    next = value.slice(0, start) + before + selected + after + value.slice(end)
    caret = selected
      ? [start + before.length, start + before.length + selected.length]
      : [start + before.length, start + before.length]
  }
  setText(next)
  // After React re-renders the controlled value, put the caret back.
  requestAnimationFrame(() => {
    el.focus()
    el.setSelectionRange(caret[0], caret[1])
  })
}

export interface CommentBoxScope {
  label: string
  canWiden: boolean
  /** Range steppers on the chip: one dial, not two jobs. The line the composer
   * was opened on is the range's fixed anchor; each press walks the OTHER edge
   * one line up or down — through the anchor and out the far side, so ▼▼▼ from a
   * single line reads "this line as top, three lines down". Every press has an
   * exact inverse, so no selection is ever lost. Also how a single-line comment
   * quietly teaches that ranges exist at all. Absent ⇒ that direction is at the
   * rendered window's limit. */
  adjust?: { up?: () => void; down?: () => void }
}

export function CommentBox({
  title,
  placeholder,
  scope,
  onSubmit,
  onSend,
  onCancel,
  agentConnected = false,
  autoFocus = true,
  draft,
  onDraft,
  draftIntent,
  onDraftIntent,
  initialText,
  fixedAudience,
}: {
  title: string
  placeholder: string
  scope?: CommentBoxScope
  /** `audience` is set only on a pull request: 'pr' for a review comment, 'agent'
   * for a private thread. Off a PR it is undefined and nothing changes. */
  onSubmit: (text: string, wide: boolean, intent?: ThreadIntent, audience?: Audience) => void
  onSend?: (text: string, wide: boolean, intent?: ThreadIntent) => void
  onCancel: () => void
  agentConnected?: boolean
  autoFocus?: boolean
  /** Words to start from — "Post as PR comment" hands the agent's suggestion over. */
  initialText?: string
  /** No segment: this composer can only write for one side (a private aside). */
  fixedAudience?: Audience
  /** Controlled draft. A range composer's row moves with the range's last line,
   * which re-mounts this component — the owner holds the words (and the intent)
   * so growing the range can never eat a half-typed comment. */
  draft?: string
  onDraft?: (text: string) => void
  draftIntent?: ThreadIntent
  onDraftIntent?: (intent: ThreadIntent | undefined) => void
}) {
  const [ownText, setOwnText] = useState(initialText ?? '')
  const [tab, setTab] = useState<'write' | 'preview'>('write')
  const [wide, setWide] = useState(false)
  // The public side exists only on a pull request. There, a comment is for
  // GitHub unless the reviewer flips it; off a PR the segment never renders and
  // the composer is exactly what it was.
  const pr = usePr()
  const [ownAudience, setOwnAudience] = useState<Audience>('pr')
  const audience: Audience | undefined = pr === null ? undefined : (fixedAudience ?? ownAudience)
  const forGithub = audience === 'pr'
  const switchable = audience !== undefined && fixedAudience === undefined
  // On a pull request the private side is a question for the agent, and asking
  // is sending: one button, no intent chips — the words carry the intent, and
  // the agent is told to read unlabeled threads from the text.
  const askOnly = audience === 'agent' && onSend !== undefined
  // Unset by default: most comments say what they want on their own, and the agent
  // is told to judge unlabeled threads from the text. The chips force a reading
  // only when the words alone could be taken either way.
  const [ownIntent, setOwnIntent] = useState<ThreadIntent | undefined>(undefined)
  const [rich, setRich] = useState(false)
  const text = onDraft ? (draft ?? '') : ownText
  const setText = onDraft ?? setOwnText
  const intent = onDraftIntent ? draftIntent : ownIntent
  const setIntent = onDraftIntent ?? setOwnIntent
  const box = useRef<HTMLTextAreaElement>(null)
  const ready = text.trim().length > 0

  const submit = () => {
    if (!ready) return
    // Off a pull request the call is exactly what it always was — three
    // arguments — so nothing that listens to it has to learn a fourth.
    if (audience === undefined) onSubmit(text, wide, intent)
    else if (askOnly) onSend(text, wide, undefined)
    else onSubmit(text, wide, undefined, audience)
  }
  const flip = () => setOwnAudience((a) => (a === 'pr' ? 'agent' : 'pr'))

  const toggleRich = () => {
    setRich((on) => !on)
    // Collapsing while previewing would hide the textarea with no way back.
    setTab('write')
  }

  const scopeBits = (
    <>
      {scope && (
        <>
          <span className="scope-chip">
            <Icon name={wide ? 'cmp' : 'unified'} size="sm" />
            {wide ? 'the whole changeset' : scope.label}
            {!wide && scope.adjust && (
              <span className="scope-chip-steppers">
                <button
                  type="button"
                  className="scope-chip-step"
                  disabled={!scope.adjust.up}
                  data-tip="walk the range's edge one line up; the line you started on stays put"
                  aria-label="range edge one line up"
                  onClick={scope.adjust.up}
                >
                  <Icon name="up" size="sm" />
                </button>
                <button
                  type="button"
                  className="scope-chip-step"
                  disabled={!scope.adjust.down}
                  data-tip="walk the range's edge one line down; the line you started on stays put"
                  aria-label="range edge one line down"
                  onClick={scope.adjust.down}
                >
                  <Icon name="down" size="sm" />
                </button>
              </span>
            )}
            {wide && scope.canWiden && (
              <button
                type="button"
                className="scope-chip-x"
                data-tip="Narrow the scope back"
                aria-label="Narrow the scope back"
                onClick={() => setWide(false)}
              >
                <Icon name="x" size="sm" />
              </button>
            )}
          </span>
          {!wide && scope.canWiden && (
            <button type="button" className="cbox-widen" onClick={() => setWide(true)}>
              + whole changeset
            </button>
          )}
        </>
      )}
    </>
  )
  const closeButton = (
    <button
      type="button"
      className="cbox-close"
      data-tip="Close (Esc)"
      aria-label="Close"
      onClick={onCancel}
    >
      <Icon name="x" size="sm" />
    </button>
  )

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: the handler only contains a mouse click
    // biome-ignore lint/a11y/useKeyWithClickEvents: the handler only contains a mouse click
    <div
      className={`cbox thread-composer${audience ? ` cbox-${audience}` : ''}`}
      onClick={(e) => e.stopPropagation()}
    >
      <div className={`cbox-head${switchable ? ' cbox-head-aud' : ''}`}>
        {switchable ? (
          <>
            <AudienceTabs value={audience} onChange={setOwnAudience} />
            <span className="cbox-head-right">
              {scopeBits}
              {closeButton}
            </span>
          </>
        ) : (
          <>
            <span className="cbox-title">
              {fixedAudience === 'agent' ? 'Ask your agent' : scope ? 'Comment on' : title}
            </span>
            {scopeBits}
            {closeButton}
          </>
        )}
      </div>

      {rich && (
        <div className="cbox-tabs" role="tablist">
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
      )}

      {rich && tab === 'write' && (
        <div className="cbox-mdbar">
          {TOOLBAR.map((action, i) =>
            action === 'sep' ? (
              // biome-ignore lint/suspicious/noArrayIndexKey: position is the identity — the toolbar is a fixed list
              <span key={i} className="cbox-mdsep" />
            ) : (
              <button
                // biome-ignore lint/suspicious/noArrayIndexKey: the toolbar is a fixed list
                key={i}
                type="button"
                className="cbox-mdb"
                data-tip={action.label}
                aria-label={action.label}
                onClick={() => box.current && applyToolbar(box.current, action, setText)}
              >
                <Icon name={action.icon} size="sm" />
              </button>
            ),
          )}
        </div>
      )}

      <div className="cbox-body">
        {tab === 'write' ? (
          <textarea
            ref={box}
            // biome-ignore lint/a11y/noAutofocus: the composer is opened by an explicit click
            autoFocus={autoFocus}
            className="thread-input cbox-input"
            placeholder={placeholder}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') onCancel()
              else if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                e.preventDefault()
                submit()
              } else if ((e.metaKey || e.ctrlKey) && e.key === '.' && switchable) {
                e.preventDefault()
                flip()
              }
            }}
          />
        ) : ready ? (
          <Markdown className="cbox-preview markdown" text={text} />
        ) : (
          <div className="cbox-preview cbox-preview-empty">Nothing to preview yet.</div>
        )}
      </div>

      {!ready && !forGithub && (
        <div className="cbox-openers">
          {OPENERS.map((opener) => (
            <button
              key={opener.label}
              type="button"
              className="cbox-opener"
              title={opener.text}
              onClick={() => {
                setText(opener.text)
                setIntent(opener.intent)
                setTab('write')
                box.current?.focus()
              }}
            >
              {opener.label}
            </button>
          ))}
        </div>
      )}

      <div className="cbox-foot">
        <button
          type="button"
          className="cbox-rich"
          aria-pressed={rich}
          data-tip="Formatting and preview"
          aria-label="Formatting and preview"
          onClick={toggleRich}
        >
          Aa
        </button>
        {audience === 'pr' && (
          <span className="cbox-hint">Posts to GitHub when you submit the review</span>
        )}
        {audience === 'agent' && <span className="cbox-hint">Private, stays on this machine</span>}
        {audience === undefined && (
          <span className="cbox-intent" role="radiogroup" aria-label="What this comment wants">
            {INTENTS.map(({ intent: value, label, title }) => (
              // biome-ignore lint/a11y/useSemanticElements: styled chips; a native radio cannot carry this treatment
              <button
                key={label}
                type="button"
                role="radio"
                className="cbox-intent-chip"
                aria-checked={intent === value}
                title={title}
                onClick={() => setIntent(value)}
              >
                {label}
              </button>
            ))}
          </span>
        )}
        {rich && (
          <span className="cbox-attach">
            <Icon name="attach" size="sm" /> Markdown supported
          </span>
        )}
        <span className="cbox-actions">
          <button type="button" className="btn btn-sm btn-ghost" onClick={onCancel}>
            Close
          </button>
          {onSend && !forGithub && !askOnly && (
            <button
              type="button"
              className="btn btn-sm btn-outline"
              disabled={!ready}
              onClick={() => ready && onSend(text, wide, intent)}
              title={
                agentConnected
                  ? 'add the comment and send it to your agent'
                  : 'add the comment and copy its prompt for your agent'
              }
            >
              <Icon name="send" size="sm" /> Send to agent
            </button>
          )}
          <button
            type="button"
            className="btn btn-sm btn-primary"
            disabled={!ready}
            onClick={submit}
            title={
              forGithub
                ? 'add this to your review; it posts to GitHub when you submit'
                : askOnly
                  ? agentConnected
                    ? 'send this to your agent; it never leaves this machine'
                    : 'add this and copy its prompt for your agent'
                  : 'leave this comment on the review'
            }
          >
            {askOnly && <Icon name="send" size="sm" />}
            {forGithub ? 'Add to review' : askOnly ? 'Send to agent' : 'Add comment'}
            <span className="btn-kbd">⌘↵</span>
          </button>
        </span>
      </div>
    </div>
  )
}
