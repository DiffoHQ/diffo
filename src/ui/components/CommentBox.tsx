import { useRef, useState } from 'react'
import type { ThreadIntent } from '../../shared/review.js'
import { Icon, type IconName } from './Icon.js'
import { Markdown } from './Markdown.js'

export function Avatar({ who }: { who: 'you' | 'agent' }) {
  return (
    <span className={`avatar avatar-${who}`} aria-hidden="true">
      <Icon name={who === 'you' ? 'user' : 'sparkle'} size="sm" />
    </span>
  )
}

interface ToolbarButton {
  icon: IconName
  label: string
  wrap?: [string, string]
  prefix?: string
}

const TOOLBAR: (ToolbarButton | 'sep')[] = [
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

const OPENERS = ['Explain this change', 'What could break?', 'Is it tested?']

const INTENTS: { intent: ThreadIntent; label: string; title: string }[] = [
  { intent: 'fix', label: 'Change', title: 'ask the agent to change the code' },
  {
    intent: 'question',
    label: 'Question',
    title: 'ask for an answer — the agent won’t change code',
  },
]

function applyToolbar(
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
}: {
  title: string
  placeholder: string
  scope?: CommentBoxScope
  onSubmit: (text: string, wide: boolean, intent?: ThreadIntent) => void
  onSend?: (text: string, wide: boolean, intent?: ThreadIntent) => void
  onCancel: () => void
  agentConnected?: boolean
  autoFocus?: boolean
  /** Controlled draft. A range composer's row moves with the range's last line,
   * which re-mounts this component — the owner holds the words (and the intent)
   * so growing the range can never eat a half-typed comment. */
  draft?: string
  onDraft?: (text: string) => void
  draftIntent?: ThreadIntent
  onDraftIntent?: (intent: ThreadIntent | undefined) => void
}) {
  const [ownText, setOwnText] = useState('')
  const [tab, setTab] = useState<'write' | 'preview'>('write')
  const [wide, setWide] = useState(false)
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
    if (ready) onSubmit(text, wide, intent)
  }

  const toggleRich = () => {
    setRich((on) => !on)
    // Collapsing while previewing would hide the textarea with no way back.
    setTab('write')
  }

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: the handler only contains a mouse click
    // biome-ignore lint/a11y/useKeyWithClickEvents: the handler only contains a mouse click
    <div className="cbox thread-composer" onClick={(e) => e.stopPropagation()}>
      <div className="cbox-head">
        <Avatar who="you" />
        <span className="cbox-title">{scope ? 'Comment on' : title}</span>
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
                    data-tip="walk the range's edge one line up — the line you started on stays put"
                    aria-label="range edge one line up"
                    onClick={scope.adjust.up}
                  >
                    <Icon name="up" size="sm" />
                  </button>
                  <button
                    type="button"
                    className="scope-chip-step"
                    disabled={!scope.adjust.down}
                    data-tip="walk the range's edge one line down — the line you started on stays put"
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
        <button
          type="button"
          className="cbox-close"
          data-tip="Close (Esc)"
          aria-label="Close"
          onClick={onCancel}
        >
          <Icon name="x" size="sm" />
        </button>
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
              }
            }}
          />
        ) : ready ? (
          <Markdown className="cbox-preview markdown" text={text} />
        ) : (
          <div className="cbox-preview cbox-preview-empty">Nothing to preview yet.</div>
        )}
      </div>

      {!ready && (
        <div className="cbox-openers">
          {OPENERS.map((opener) => (
            <button
              key={opener}
              type="button"
              className="cbox-opener"
              onClick={() => {
                setText(opener)
                setIntent('question')
                setTab('write')
                box.current?.focus()
              }}
            >
              {opener}
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
        <span
          className="cbox-intent"
          role="radiogroup"
          aria-label="What this comment wants — optional; unset, the agent reads it from your words"
        >
          {INTENTS.map(({ intent: value, label, title }) => (
            // biome-ignore lint/a11y/useSemanticElements: styled chips; a native radio cannot carry this treatment
            <button
              key={value}
              type="button"
              role="radio"
              className="cbox-intent-chip"
              aria-checked={intent === value}
              title={`${title} — click again to unset`}
              onClick={() => setIntent(intent === value ? undefined : value)}
            >
              {label}
            </button>
          ))}
        </span>
        {rich && (
          <span className="cbox-attach">
            <Icon name="attach" size="sm" /> Markdown supported
          </span>
        )}
        <span className="cbox-actions">
          <button type="button" className="btn btn-sm btn-ghost" onClick={onCancel}>
            Close
          </button>
          {onSend && (
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
            title="leave this comment on the review"
          >
            Add comment
            <span className="btn-kbd">⌘↵</span>
          </button>
        </span>
      </div>
    </div>
  )
}
