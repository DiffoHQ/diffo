import { type ReactNode, useEffect, useState } from 'react'
import {
  AGENT_PICKS,
  activePresets,
  allPresets,
  BUILT_IN_PRESETS,
  fallbackPreset,
  isEmptyPreset,
  type LayersPreset,
  type LayersPresetDraft,
  type LayersPresetSettings,
  PRESET_BLURB_MAX,
  PRESET_INSTRUCTIONS_MAX,
  PRESET_MESSAGE_MAX,
  PRESET_NAME_MAX,
  PRESET_WHEN_MAX,
  PRESETS_MAX,
  type PresetChange,
  type PresetMessage,
  presetDefault,
} from '../../shared/presets.js'
import { timeAgo } from '../markdown.js'
import { usePresetThread } from '../presetsPref.js'
import { Avatar } from './CommentBox.js'
import { Confirm } from './Confirm.js'
import { Icon } from './Icon.js'
import { Markdown } from './Markdown.js'
import { Menu, MenuItem, MenuSep } from './Menu.js'
import { Modal } from './Modal.js'

/**
 * The Layers dialog: the presets, from the gear menu or the head of the
 * Layers tab. A preset tells the agent how to split a change into layers.
 *
 * A sidebar of cards: clicking a card shows it. The detail is one card: what
 * the preset says — when to use it, and what the agent is told, opening on
 * its first lines — and, attached under it the way a comment sits under the
 * lines it is about, its conversation with the agent, where the agent edits
 * the fields through the CLI and says what it changed, each edit with an
 * undo. The reviewer's own presets have a Manual edit that turns the card into a
 * form (never a built-in's). What can be done to a preset is behind its
 * "more". With a review open, one bar at the foot layers it by the preset in
 * view.
 */

/** What the dialog knows about the open review, when there is one. */
export interface PresetsReview {
  /** The preset the outline follows now, by id, when it follows one. */
  inUse?: string
  /** An agent is on the review: it can outline, and talk about presets. */
  agentAttached: boolean
  /** Outline this review with the preset (or `AGENT_PICKS`). */
  onUse: (id: string) => void
}

/** Which card the detail shows. A new preset has its id from the start, so
 * its conversation can begin before the agent makes it. */
type Pick =
  | { kind: 'agent' }
  | { kind: 'preset'; id: string }
  | { kind: 'new'; id: string; from?: LayersPresetDraft }

type Fields = LayersPresetDraft

const EMPTY: Fields = { name: '', blurb: '', whenToUse: '', instructions: '' }

/** What a first message about a new preset could say. */
const NEW_PLACEHOLDER =
  'Only the public API and anything that writes to disk. Tests and UI go to background.'

const mintId = () =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `p-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`

const FIELD_LABELS: Record<keyof Fields, string> = {
  name: 'Name',
  blurb: 'One line',
  whenToUse: 'Use it when',
  instructions: 'Instructions',
}

export function LayersPresets({
  settings,
  onSave,
  review,
  onClose,
}: {
  settings: LayersPresetSettings
  /** Replace the whole settings blob. Resolves false when the save failed. */
  onSave: (next: LayersPresetSettings) => Promise<boolean>
  /** Present while a review is open. */
  review?: PresetsReview
  onClose: () => void
}) {
  const [pick, setPick] = useState<Pick>(() =>
    review?.inUse && allPresets(settings).some((p) => p.id === review.inUse)
      ? { kind: 'preset', id: review.inUse }
      : { kind: 'agent' },
  )
  const [failed, setFailed] = useState(false)
  // The instructions open on their first lines; "Show all" is remembered
  // while the dialog is open.
  const [expanded, setExpanded] = useState(false)
  // One of the reviewer's own, with its fields open to edit.
  const [editing, setEditing] = useState(false)
  // A new preset written by hand: the form, above the conversation.
  const [byHand, setByHand] = useState(false)
  /** Shows a card: what was being edited in the last one is left behind. */
  const show = (next: Pick) => {
    setEditing(false)
    setByHand(false)
    setPick(next)
  }
  // Delete asks first, in a dialog over this one: the preset to delete.
  const [deleting, setDeleting] = useState<LayersPreset | null>(null)
  const off = new Set(settings.disabled)
  const def = presetDefault(settings)
  const inPlay = new Set(activePresets(settings).map((p) => p.id))
  // A preset the reviewer started and nobody has written yet: a card like
  // the others, offered nowhere until it has instructions.
  const empties = new Set(settings.presets.filter(isEmptyPreset).map((p) => p.id))
  const canAsk = review?.agentAttached === true
  // The agent made the new preset (its id is now in the settings): the
  // fields and the conversation carry on under the preset itself.
  const newId = pick.kind === 'new' ? pick.id : null
  const newMade = newId !== null && settings.presets.some((p) => p.id === newId)
  useEffect(() => {
    if (newId !== null && newMade) setPick({ kind: 'preset', id: newId })
  }, [newId, newMade])

  const save = async (next: LayersPresetSettings) => {
    setFailed(false)
    const ok = await onSave(next)
    if (!ok) setFailed(true)
    return ok
  }
  const toggle = (id: string) =>
    void save({
      ...settings,
      disabled: off.has(id)
        ? settings.disabled.filter((d) => d !== id)
        : [...settings.disabled, id],
      // The default cannot be a preset that is off: it falls back to the agent.
      default: !off.has(id) && settings.default === id ? AGENT_PICKS : settings.default,
    })
  const setDefault = (id: string) => void save({ ...settings, default: id })
  const upsert = async (preset: LayersPreset) => {
    const presets = settings.presets.some((p) => p.id === preset.id)
      ? settings.presets.map((p) => (p.id === preset.id ? preset : p))
      : [...settings.presets, preset]
    return save({ ...settings, presets })
  }
  const remove = (id: string) =>
    void save({
      ...settings,
      presets: settings.presets.filter((p) => p.id !== id),
      disabled: settings.disabled.filter((d) => d !== id),
      default: settings.default === id ? AGENT_PICKS : settings.default,
    }).then((ok) => ok && show({ kind: 'agent' }))
  const copy = (preset: LayersPreset) =>
    show({
      kind: 'new',
      id: mintId(),
      from: {
        name: `${preset.name} (mine)`,
        blurb: preset.blurb,
        whenToUse: preset.whenToUse,
        instructions: preset.instructions,
      },
    })

  /** A card: a click shows it. The default wears a badge. */
  const row = (id: string, label: string, sub: string, selected: boolean, open: () => void) => {
    const isOff = id !== AGENT_PICKS && off.has(id)
    return (
      <button
        key={id}
        type="button"
        className={`lp-row${isOff ? ' lp-row-off' : ''}`}
        aria-current={selected || undefined}
        onClick={open}
      >
        <span className="lp-row-name">
          {label}
          {def === id && <span className="lp-tag">default</span>}
          {isOff && <span className="lp-row-state">disabled</span>}
          {empties.has(id) && <span className="lp-row-state">empty</span>}
        </span>
        <span className="lp-row-sub">{sub}</span>
      </button>
    )
  }

  const selectedId = pick.kind === 'preset' ? pick.id : pick.kind === 'agent' ? AGENT_PICKS : null
  const newForm = pick.kind === 'new' && (pick.from !== undefined || byHand)
  const mine = settings.presets
  const viewed =
    pick.kind === 'preset' ? allPresets(settings).find((p) => p.id === pick.id) : undefined
  const inUse = review?.inUse ? allPresets(settings).find((p) => p.id === review.inUse) : undefined

  /** The default, said and set where the preset is shown: a badge on the one
   * that is, a button on the others. */
  const defaultControl = (id: string, isOff: boolean) =>
    def === id ? (
      <span className="lp-tag lp-tag-lg" title="New layers follow this unless you pick another">
        Default
      </span>
    ) : (
      <button
        type="button"
        className="btn btn-sm"
        disabled={isOff}
        title={
          isOff ? 'Disabled: enable it first' : 'New layers follow this unless you pick another'
        }
        onClick={() => setDefault(id)}
      >
        Make default
      </button>
    )
  const dhead = (title: string, sub: ReactNode, controls?: ReactNode, tags?: ReactNode) => (
    <header className="lp-dhead">
      <div className="lp-dhead-row">
        <h3 className="lp-title">{title}</h3>
        {tags && <span className="lp-dhead-tags">{tags}</span>}
        {controls && <span className="lp-dhead-acts">{controls}</span>}
      </div>
      {sub && <p className="lp-dsub">{sub}</p>}
    </header>
  )
  /** Everything done to a preset, behind one "more": what it is right now
   * reads as tags beside its name. */
  const presetMenu = (preset: LayersPreset) => {
    const isOff = off.has(preset.id)
    return (
      <Menu label="Preset options">
        {(close) => (
          <>
            {def !== preset.id && (
              <MenuItem
                disabled={!inPlay.has(preset.id)}
                title={
                  isOff
                    ? 'Disabled: enable it first'
                    : isEmptyPreset(preset)
                      ? 'Empty: it needs instructions first'
                      : 'New layers follow this unless you pick another'
                }
                onClick={() => {
                  close()
                  setDefault(preset.id)
                }}
              >
                Make default
              </MenuItem>
            )}
            <MenuItem
              title={
                isOff
                  ? 'Offer it again, to you and to the agent’s pick'
                  : 'Stop offering it; the agent never picks it'
              }
              onClick={() => {
                close()
                toggle(preset.id)
              }}
            >
              {isOff ? 'Enable' : 'Disable'}
            </MenuItem>
            <MenuSep />
            {preset.builtIn ? (
              <MenuItem
                title="A copy under your own presets, every field prefilled"
                onClick={() => {
                  close()
                  copy(preset)
                }}
              >
                Make a copy to edit
              </MenuItem>
            ) : (
              <MenuItem
                danger
                onClick={() => {
                  close()
                  setDeleting(preset)
                }}
              >
                Delete
              </MenuItem>
            )}
          </>
        )}
      </Menu>
    )
  }
  const sentence = (text: string) =>
    text === ''
      ? ''
      : `${text.charAt(0).toUpperCase()}${text.slice(1)}${/[.?!]$/.test(text) ? '' : '.'}`

  return (
    <Modal title="Layers presets" className="lp-modal" wide onClose={onClose}>
      <p className="cov-note lp-intro">
        A preset tells the agent how to split a change into layers.
      </p>
      <div className="lp-grid">
        <nav className="lp-side" aria-label="Presets">
          <div className="lp-group">
            {row(
              AGENT_PICKS,
              'Let the agent choose',
              'picks a preset by the change',
              selectedId === AGENT_PICKS,
              () => show({ kind: 'agent' }),
            )}
          </div>
          <div className="lp-cap">Built in</div>
          <div className="lp-group">
            {BUILT_IN_PRESETS.map((p) =>
              row(p.id, p.name, p.blurb, selectedId === p.id, () =>
                show({ kind: 'preset', id: p.id }),
              ),
            )}
          </div>
          <div className="lp-cap">Yours</div>
          <div className="lp-group">
            {mine.map((p) =>
              row(p.id, p.name, p.blurb, selectedId === p.id, () =>
                show({ kind: 'preset', id: p.id }),
              ),
            )}
            <button
              type="button"
              className="lp-row lp-row-new"
              aria-current={pick.kind === 'new' || undefined}
              disabled={mine.length >= PRESETS_MAX}
              title={mine.length >= PRESETS_MAX ? `Up to ${PRESETS_MAX} of your own` : undefined}
              onClick={() => show({ kind: 'new', id: mintId() })}
            >
              <Icon name="plus" size="sm" />
              <span className="lp-row-name">New preset</span>
            </button>
          </div>
        </nav>
        <div className="lp-detail">
          {pick.kind === 'agent' && (
            <>
              {dhead(
                'Let the agent choose',
                'The agent reads the change, picks one of the enabled presets, and says why.',
                defaultControl(AGENT_PICKS, false),
              )}
              <div className="lp-card">
                <div className="lp-facts">
                  <p className="lp-fact-cap">What it picks from, and when</p>
                  {activePresets(settings).length === 0 ? (
                    <p className="lp-pick-when">
                      No preset is enabled, so it layers by {fallbackPreset().name}.
                    </p>
                  ) : (
                    <dl className="lp-picks">
                      {activePresets(settings).map((p) => (
                        <div key={p.id} className="lp-pick-row">
                          <dt className="lp-pick-name">{p.name}</dt>
                          <dd className="lp-pick-when">
                            {p.whenToUse || sentence(p.blurb) || '—'}
                          </dd>
                        </div>
                      ))}
                    </dl>
                  )}
                </div>
              </div>
            </>
          )}
          {viewed && (
            <>
              {dhead(
                viewed.name,
                sentence(viewed.blurb),
                <>
                  {!viewed.builtIn && !editing && (
                    <button
                      type="button"
                      className="btn btn-sm"
                      title="Change the fields yourself, without the agent"
                      onClick={() => setEditing(true)}
                    >
                      Manual edit
                    </button>
                  )}
                  {presetMenu(viewed)}
                </>,
                <>
                  {viewed.builtIn && <span className="lp-row-state">Built in</span>}
                  {def === viewed.id && <span className="lp-tag">Default</span>}
                  {off.has(viewed.id) && <span className="lp-row-state">Disabled</span>}
                  {isEmptyPreset(viewed) && <span className="lp-row-state">Empty</span>}
                </>,
              )}
              {/* One card: what the preset says, and under it, the way a
                  comment sits under the lines it is about, the conversation
                  that changes it. */}
              <div className="lp-card">
                {editing && !viewed.builtIn ? (
                  <FieldsEditor
                    key={fieldsKey(viewed)}
                    initial={viewed}
                    onSave={async (fields) => {
                      const ok = await upsert({ ...viewed, ...fields })
                      if (ok) setEditing(false)
                      return ok
                    }}
                    onCancel={() => setEditing(false)}
                  />
                ) : isEmptyPreset(viewed) && viewed.whenToUse === '' ? (
                  <p className="lp-empty-note">
                    Nothing in it yet. Tell the agent what you want to read, or write it yourself
                    with Manual edit. Until then it is not offered in “Layer by”.
                  </p>
                ) : (
                  <Facts
                    preset={viewed}
                    expanded={expanded}
                    onToggle={() => setExpanded(!expanded)}
                  />
                )}
                <div className="lp-card-thread">
                  <Conversation
                    id={viewed.id}
                    canAsk={canAsk}
                    title={
                      viewed.builtIn
                        ? 'Want it different? Ask your agent'
                        : isEmptyPreset(viewed)
                          ? 'Describe it to your agent'
                          : 'Ask your agent to change it'
                    }
                    context={
                      viewed.builtIn
                        ? 'The agent is sent this preset’s fields with every message. It can’t change a built-in, so it answers with a copy under yours.'
                        : 'The agent is sent this preset’s fields, as they stand, with every message.'
                    }
                    hint={
                      viewed.builtIn
                        ? 'It answers with a copy under your presets'
                        : isEmptyPreset(viewed)
                          ? 'It writes the preset from what you say'
                          : 'It edits this preset; every edit has an undo'
                    }
                    placeholder={
                      isEmptyPreset(viewed) ? NEW_PLACEHOLDER : 'Tell the agent what to change.'
                    }
                    current={viewed}
                    onUndo={
                      viewed.builtIn
                        ? undefined
                        : (change) => void upsert({ ...viewed, ...change.before })
                    }
                  />
                </div>
              </div>
            </>
          )}
          {pick.kind === 'new' && (
            <>
              {dhead(
                'New preset',
                pick.from
                  ? 'A copy of a built-in, yours to change.'
                  : 'Tell the agent what you want to read, and it writes the preset.',
                <>
                  {!newForm && (
                    <button
                      type="button"
                      className="btn btn-sm"
                      title="Write the fields yourself, without the agent"
                      onClick={() => setByHand(true)}
                    >
                      Manual edit
                    </button>
                  )}
                  {/* With the form open by hand, Cancel is the form's own: it
                      closes the form, not the new preset. */}
                  {!(byHand && pick.from === undefined) && (
                    <button
                      type="button"
                      className="btn btn-sm btn-ghost"
                      onClick={() => show({ kind: 'agent' })}
                    >
                      Cancel
                    </button>
                  )}
                </>,
              )}
              {/* A copy is a form to save, so it opens on the form; a blank
                  one opens on the conversation, with the form behind the same
                  "Manual edit" a saved preset has. */}
              <div className={`lp-card${newForm ? '' : ' lp-card-bare'}`}>
                {newForm && (
                  <FieldsEditor
                    key={pick.id}
                    initial={pick.from ?? EMPTY}
                    fresh
                    {...(pick.from === undefined ? { onCancel: () => setByHand(false) } : {})}
                    onSave={async (fields) => {
                      const ok = await upsert({ id: pick.id, ...fields, builtIn: false })
                      if (ok) show({ kind: 'preset', id: pick.id })
                      return ok
                    }}
                  />
                )}
                <div className="lp-card-thread">
                  <Conversation
                    id={pick.id}
                    canAsk={canAsk}
                    title="Describe it to your agent"
                    context="The agent makes the preset from your first message, and is sent its fields with every one after."
                    hint="It writes the preset from what you say"
                    placeholder={NEW_PLACEHOLDER}
                  />
                </div>
              </div>
            </>
          )}
          {failed && (
            <p className="cov-note cov-note-error" aria-live="polite">
              Could not save; is the review server still running?
            </p>
          )}
        </div>
      </div>
      {/* With a review open: outline it with the preset in view. The one
          action that touches the review, so it sits apart from the settings. */}
      {review && pick.kind !== 'new' && (
        <div className="lp-bar">
          {/* Said only when it is true: with no layers yet, or layers that
              follow no preset, there is nothing to name. */}
          {inUse && (
            <span className="lp-bar-text">
              This review follows <b>{inUse.name}</b>.
            </span>
          )}
          <button
            type="button"
            className="btn btn-sm btn-primary"
            disabled={!canAsk || (viewed !== undefined && !inPlay.has(viewed.id))}
            title={
              !canAsk
                ? 'Needs an agent on the review'
                : viewed !== undefined && !inPlay.has(viewed.id)
                  ? isEmptyPreset(viewed)
                    ? 'Empty: it needs instructions first'
                    : 'Disabled: enable it first'
                  : 'The agent layers this review again'
            }
            onClick={() => {
              review.onUse(viewed ? viewed.id : AGENT_PICKS)
              onClose()
            }}
          >
            {viewed === undefined
              ? 'Layer by the agent’s choice'
              : review.inUse === viewed.id
                ? 'Layer again'
                : `Layer by ${viewed.name}`}
          </button>
        </div>
      )}
      {deleting && (
        <Confirm
          title="Delete preset"
          action="Delete preset"
          onConfirm={() => remove(deleting.id)}
          onClose={() => setDeleting(null)}
        >
          Deletes “{deleting.name}” and its conversation with the agent. This can’t be undone.
        </Confirm>
      )}
    </Modal>
  )
}

/** The fields as stored: an agent's edit changes the key, so the editor
 * shows the new values rather than a stale draft. */
const fieldsKey = (p: Fields) => [p.name, p.blurb, p.whenToUse, p.instructions].join('\u0000')

/** Longer than this, the instructions open on their first lines. */
const LONG_INSTRUCTIONS = 320

/**
 * A preset as it reads: when to use it, and what the agent is told. Long
 * instructions open clamped, with the rest one click away.
 */
function Facts({
  preset,
  expanded,
  onToggle,
}: {
  preset: Fields
  expanded: boolean
  onToggle: () => void
}) {
  const long = preset.instructions.length > LONG_INSTRUCTIONS
  return (
    <dl className="lp-facts">
      <div className="lp-fact">
        <dt className="lp-fact-cap">{FIELD_LABELS.whenToUse}</dt>
        <dd className="lp-fact-body">
          <p className="lp-fro">{preset.whenToUse || '—'}</p>
        </dd>
      </div>
      <div className="lp-fact">
        <dt className="lp-fact-cap">What the agent is told</dt>
        <dd className="lp-fact-body">
          <p className={`lp-fro${long && !expanded ? ' lp-clamp' : ''}`}>
            {preset.instructions || '—'}
          </p>
          {long && (
            <button type="button" className="lp-more" aria-expanded={expanded} onClick={onToggle}>
              {expanded ? 'Show less' : 'Show all'}
            </button>
          )}
        </dd>
      </div>
    </dl>
  )
}

/**
 * The four fields as a grouped form: Save once something changed, and
 * Cancel to leave the form (or, on a preset not saved yet, Revert).
 */
function FieldsEditor({
  initial,
  fresh = false,
  onSave,
  onCancel,
}: {
  initial: Fields
  /** Nothing is saved yet: Save is offered once there is a name. */
  fresh?: boolean
  onSave: (fields: Fields) => Promise<boolean>
  /** Leave the form as it was opened. Absent on a preset not saved yet. */
  onCancel?: () => void
}) {
  const [fields, setFields] = useState<Fields>(initial)
  const [saving, setSaving] = useState(false)
  const set = (key: keyof Fields) => (e: { target: { value: string } }) =>
    setFields((f) => ({ ...f, [key]: e.target.value }))
  const name = fields.name.trim()
  const dirty =
    fields.name !== initial.name ||
    fields.blurb !== initial.blurb ||
    fields.whenToUse !== initial.whenToUse ||
    fields.instructions !== initial.instructions
  const submit = async () => {
    if (name === '' || saving) return
    setSaving(true)
    await onSave({
      name,
      blurb: fields.blurb.trim(),
      whenToUse: fields.whenToUse.trim(),
      instructions: fields.instructions.trim(),
    })
    setSaving(false)
  }
  const frow = (key: keyof Fields, control: ReactNode) => (
    <div className="lp-frow">
      <label className="lp-flabel" htmlFor={`lp-f-${key}`}>
        {FIELD_LABELS[key]}
      </label>
      {control}
    </div>
  )
  return (
    <>
      <div className="lp-group lp-fields">
        {frow(
          'name',
          <input
            id="lp-f-name"
            className="lp-fin"
            value={fields.name}
            maxLength={PRESET_NAME_MAX}
            placeholder="API and disk"
            onChange={set('name')}
          />,
        )}
        {frow(
          'blurb',
          <input
            id="lp-f-blurb"
            className="lp-fin"
            value={fields.blurb}
            maxLength={PRESET_BLURB_MAX}
            placeholder="the API and what gets written; the rest in background"
            onChange={set('blurb')}
          />,
        )}
        {frow(
          'whenToUse',
          <textarea
            id="lp-f-whenToUse"
            className="lp-fin lp-farea"
            value={fields.whenToUse}
            maxLength={PRESET_WHEN_MAX}
            rows={2}
            placeholder="A change that adds endpoints or writes files, where the surface matters more than the internals."
            onChange={set('whenToUse')}
          />,
        )}
        {frow(
          'instructions',
          <textarea
            id="lp-f-instructions"
            className="lp-fin lp-farea lp-farea-tall"
            value={fields.instructions}
            maxLength={PRESET_INSTRUCTIONS_MAX}
            rows={5}
            placeholder="First every exported function, type and route, highlighted; then every write to disk, with the path. Tests and UI in background."
            onChange={set('instructions')}
          />,
        )}
      </div>
      {(dirty || fresh || onCancel) && (
        <div className="lp-savebar">
          <button
            type="button"
            className="btn btn-sm btn-primary"
            disabled={name === '' || saving || (!fresh && !dirty)}
            title={name === '' ? 'A preset needs a name' : undefined}
            onClick={() => void submit()}
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
          {onCancel ? (
            <button type="button" className="btn btn-sm btn-ghost" onClick={onCancel}>
              Cancel
            </button>
          ) : (
            dirty && (
              <button
                type="button"
                className="btn btn-sm btn-ghost"
                onClick={() => setFields(initial)}
              >
                Revert
              </button>
            )
          )}
        </div>
      )}
    </>
  )
}

/**
 * The conversation about one preset, as the card a review thread is: the
 * same message rows, the same "with the agent" line while an answer is owed,
 * the same reply bar. Messages come from the server and stay current from
 * the events stream; a reply rides to the agent's next poll. An agent message
 * that changed the preset carries the fields it set and an undo.
 */
function Conversation({
  id,
  canAsk,
  title,
  context,
  hint,
  placeholder,
  current,
  onUndo,
}: {
  id: string
  canAsk: boolean
  /** The first message's box, named for what it does to this preset. */
  title: string
  /** One short line at the foot of the first message's box: what the agent
   * does with it. */
  hint: string
  /** What the agent is sent besides the messages: the caption's tooltip,
   * since it never shows in the thread. */
  context: string
  placeholder: string
  /** The preset as it stands: a change whose fields are back where they were
   * reads as undone, and offers no undo. */
  current?: LayersPresetDraft
  onUndo?: (change: PresetChange) => void
}) {
  const { thread, send, clear } = usePresetThread(id)
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
      maxLength={PRESET_MESSAGE_MAX}
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
              title="Clear these messages and start over; the preset stays as it is"
              onClick={() => setClearing(true)}
            >
              New conversation
            </button>
          </div>
          <div className="thread-messages">
            {thread.messages.map((m) => (
              <Message key={m.id} message={m} current={current} onUndo={onUndo} />
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
          Clears the messages. The preset stays as it is.
        </Confirm>
      )}
    </>
  )
}

function Message({
  message,
  current,
  onUndo,
}: {
  message: PresetMessage
  current?: LayersPresetDraft | undefined
  onUndo?: ((change: PresetChange) => void) | undefined
}) {
  const change = message.change
  // Every field this change set is back where it was: undone, by the link
  // below or by hand.
  const undone =
    change !== undefined &&
    current !== undefined &&
    change.fields.length > 0 &&
    change.fields.every((f) => f in change.before && current[f] === change.before[f])
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
            ? 'Made the preset'
            : `Changed ${change.fields.map((f) => FIELD_LABELS[f].toLowerCase()).join(', ')}`}
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
