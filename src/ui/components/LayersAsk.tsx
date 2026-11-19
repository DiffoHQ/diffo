import { type ReactNode, useId, useState } from 'react'
import { AGENT_PICKS, LAYERS_NOTE_MAX } from '../../shared/presets.js'
import { Icon } from './Icon.js'
import { Menu, MenuItem, MenuSep } from './Menu.js'
import { Modal } from './Modal.js'

/**
 * What a layers ask carries to the server: the preset by id (`agent` leaves
 * the pick to the agent), `null` for none, and a note for this change only.
 * With no preset the note is the whole ask. `add` is the light ask, and
 * carries nothing else.
 */
export interface LayersAskInput {
  preset?: string | null
  note?: string
  /** Not a new split: the agent places what is outside the layers into the
   * ones the review has. The preset and the note stay as they are. */
  add?: true
}

/** The picker's value for "no preset, my words alone". Not a preset id (an id
 * holds no colon), and never sent. */
export const OWN_WORDS = ':own'

/** The ask as the reviewer is writing it. */
export interface LayersAskDraft {
  pick: string
  note: string
}

type Choice = { id: string; name: string; blurb?: string }

/** What the pick gives, in one line under the picker: a preset's own line,
 * or what leaving it to the agent means. Nothing under one-time instructions,
 * where the box below says it. */
const describe = (choice: Choice): string => {
  if (choice.id === AGENT_PICKS) return 'The agent picks the preset that fits this change.'
  const blurb = choice.blurb ?? ''
  if (choice.id === OWN_WORDS || blurb === '') return ''
  return `${blurb.charAt(0).toUpperCase()}${blurb.slice(1)}${/[.?!]$/.test(blurb) ? '' : '.'}`
}

const OWN: Choice = { id: OWN_WORDS, name: 'One-time instructions' }

const choicesOf = (presets: readonly Choice[]): Choice[] => [
  { id: AGENT_PICKS, name: 'Let the agent choose' },
  ...presets,
]

/** The choice a draft stands on. A pick that is no longer offered (a preset
 * disabled since) falls back to the agent's choice. */
const currentOf = (draft: LayersAskDraft, presets: readonly Choice[]): Choice => {
  if (draft.pick === OWN_WORDS) return OWN
  const choices = choicesOf(presets)
  return choices.find((c) => c.id === draft.pick) ?? choices[0]!
}

/** One-time instructions need the instructions; anything else can go as is. */
export const askReady = (draft: LayersAskDraft): boolean =>
  draft.pick !== OWN_WORDS || draft.note.trim() !== ''

export function askInput(draft: LayersAskDraft, presets: readonly Choice[]): LayersAskInput {
  const note = draft.note.trim()
  if (draft.pick === OWN_WORDS) return { preset: null, note }
  return { preset: currentOf(draft, presets).id, ...(note !== '' ? { note } : {}) }
}

/**
 * The two things a layers ask says: what to layer by, and anything the
 * reviewer wants this time only. The note rides on top of the preset and is
 * never saved with the presets; under "One-time instructions" it is the whole
 * ask. `compact` is the empty state's form: one control that reads "Layer by
 * Importance", the way the rail's head does once there are layers, with the
 * presets dialog in its menu, and what a pick gives as a tooltip, not a line.
 * Nothing is written there: "One-time instructions" opens the ask sheet
 * (`onOpenSheet`), the same one "Layer again" opens.
 */
export function LayerByFields({
  presets,
  draft,
  onChange,
  compact = false,
  onManagePresets,
  hint,
  suggestedId,
  onOpenSheet,
}: {
  presets: readonly Choice[]
  draft: LayersAskDraft
  onChange: (draft: LayersAskDraft) => void
  compact?: boolean
  /** Open the Layers dialog: a link beside the picker's caption, or, when
   * compact, the last item of its menu. */
  onManagePresets?: () => void
  /** One line under the picker: the agent's suggestion, in the empty state. */
  hint?: ReactNode
  /** The preset the agent suggested for this change: marked in the menu. */
  suggestedId?: string
  /** Compact only: anything written for this change is written in the ask
   * sheet, not here. Called with what the sheet opens on: one-time
   * instructions. */
  onOpenSheet?: (pick: string) => void
}) {
  const noteId = useId()
  const own = draft.pick === OWN_WORDS
  const current = currentOf(draft, presets)
  const about = describe(current)
  return (
    <div className="la-fields">
      <div className="la-by">
        {!compact && (
          <div className="la-by-head">
            <span className="la-cap">Layer by</span>
            {onManagePresets && (
              <button type="button" className="la-link" onClick={onManagePresets}>
                Manage presets
              </button>
            )}
          </div>
        )}
        <Menu
          label="What the layers are for"
          align="left"
          triggerClassName="la-pick"
          {...(compact && about !== '' ? { tip: about } : {})}
          trigger={
            <>
              {compact && <span className="la-pick-by">Layer by</span>}
              <span className="la-pick-name">{current.name}</span>
              <Icon name="chev" size="sm" className="la-pick-chev" />
            </>
          }
        >
          {(close) => (
            <>
              {choicesOf(presets).map((c) => (
                <MenuItem
                  key={c.id}
                  checked={c.id === current.id}
                  {...(describe(c) !== '' ? { title: describe(c) } : {})}
                  onClick={() => {
                    close()
                    onChange({ ...draft, pick: c.id })
                  }}
                >
                  {c.name}
                  {c.id === suggestedId && <span className="la-pick-tag">suggested</span>}
                </MenuItem>
              ))}
              <MenuSep />
              <MenuItem
                {...(onOpenSheet ? {} : { checked: own })}
                title="No preset: the agent layers this change by what you write, once"
                onClick={() => {
                  close()
                  if (onOpenSheet) onOpenSheet(OWN_WORDS)
                  else onChange({ ...draft, pick: OWN_WORDS })
                }}
              >
                {OWN.name}
              </MenuItem>
              {compact && onManagePresets && (
                <>
                  <MenuSep />
                  <MenuItem
                    onClick={() => {
                      close()
                      onManagePresets()
                    }}
                  >
                    Manage presets
                  </MenuItem>
                </>
              )}
            </>
          )}
        </Menu>
        {/* Compact, what a pick gives is a tooltip on the pick: the tab
            spends its lines on the agent's suggestion alone. */}
        {!compact && about !== '' && <p className="la-desc">{about}</p>}
        {hint}
      </div>
      {(own || !compact) && (
        <div className="la-note">
          <label className="la-cap" htmlFor={noteId}>
            {own ? 'Your instructions for this change' : 'For this change only (optional)'}
          </label>
          <textarea
            id={noteId}
            className="la-note-input"
            rows={3}
            maxLength={LAYERS_NOTE_MAX}
            value={draft.note}
            placeholder={
              own
                ? 'Only the database changes, one layer per table'
                : 'Start with the migration, keep the tests in background'
            }
            onChange={(e) => onChange({ ...draft, note: e.target.value })}
          />
          <p className="la-hint">
            {own ? 'Used once. Not saved as a preset.' : 'Used once, with the preset. Not saved.'}
          </p>
        </div>
      )}
    </div>
  )
}

/**
 * Layering again is the heavy step, so nothing in the rail starts it on its
 * own: a preset picked from the head's menu, or "Layer again", opens this
 * with the choice made, and only its button sends the ask.
 */
export function LayersAskSheet({
  presets,
  initial,
  onAsk,
  onManagePresets,
  onClose,
  title = 'Layer again',
  action = 'Layer again',
}: {
  presets: readonly Choice[]
  /** What the sheet opens on: the choice just made, and the note these
   * layers already carry. */
  initial: LayersAskDraft
  onAsk: (ask: LayersAskInput) => void
  /** Leave the sheet for the Layers dialog. Absent when there is none. */
  onManagePresets?: () => void
  onClose: () => void
  /** The sheet's name and its button: "Layer again" over layers that exist,
   * the first ask's words before there are any. */
  title?: string
  action?: string
}) {
  const [draft, setDraft] = useState(initial)
  const footer = (
    <>
      <button
        type="button"
        className="btn btn-primary"
        disabled={!askReady(draft)}
        title={askReady(draft) ? undefined : 'Write the instructions first'}
        onClick={() => {
          onAsk(askInput(draft, presets))
          onClose()
        }}
      >
        {action}
      </button>
      <button type="button" className="btn btn-ghost" onClick={onClose}>
        Cancel
      </button>
    </>
  )
  return (
    <Modal title={title} className="la-sheet" onClose={onClose} footer={footer}>
      <LayerByFields
        presets={presets}
        draft={draft}
        onChange={setDraft}
        {...(onManagePresets
          ? {
              onManagePresets: () => {
                onClose()
                onManagePresets()
              },
            }
          : {})}
      />
    </Modal>
  )
}
