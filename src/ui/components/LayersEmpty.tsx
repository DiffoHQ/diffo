import { useEffect, useRef, useState } from 'react'
import { AGENT_PICKS } from '../../shared/presets.js'
import { Icon } from './Icon.js'
import {
  askInput,
  askReady,
  LayerByFields,
  type LayersAskDraft,
  type LayersAskInput,
  LayersAskSheet,
} from './LayersAsk.js'

/**
 * The Layers tab before there are any: one line and the one action (the tab
 * is its title) — or, when the action isn't there, the reason. Agent status itself stays in the
 * header's presence chip — an agent's suggestion to read in layers included —
 * so this body only says what the button does.
 *
 *   quiet      the button is there
 *   queued     the outline was asked for, and waits behind the agent's open threads
 *   outlining  the agent has the request and is writing the plan
 *   stalled    it took the request minutes ago and nothing came — most often
 *              its harness refused the post and told it to stop — so say why
 *              and give the action back
 *   noagent    nobody is attached, so nobody can outline — Invite instead
 *
 * The quiet state also says what the layers will be for: a "Layer by" picker,
 * opening on the reviewer's default preset, so the ask carries the choice.
 */
export type LayersEmptyState = 'quiet' | 'queued' | 'outlining' | 'stalled' | 'noagent'

export function LayersEmpty({
  state,
  onOutline,
  onInvite,
  presets,
  defaultPreset = AGENT_PICKS,
  onManagePresets,
  suggested,
}: {
  state: LayersEmptyState
  /** Ask for the layers: what to layer by, and a note for this change. With
   * no presets to pick from, nothing is sent and the default applies. */
  onOutline?: (ask?: LayersAskInput) => void
  onInvite?: () => void
  /** The presets that are on, each with its one line. Absent, the picker is
   * not shown. */
  presets?: readonly { id: string; name: string; blurb?: string }[]
  /** What the picker opens on: `agent`, or a preset id. */
  defaultPreset?: string
  onManagePresets?: () => void
  /** The preset the agent named when it suggested layers, one that is on,
   * and its line on why. The picker opens on it unless the reviewer has a
   * default of their own; then it is a line they can take. */
  suggested?: { preset: { id: string; name: string }; reason?: string }
}) {
  // A default that was since disabled falls back to the agent's choice
  // (see `askInput`). With no default of the reviewer's own, the agent's
  // suggestion is where the picker opens.
  const suggestedId = suggested?.preset.id
  const follows = defaultPreset === AGENT_PICKS ? suggestedId : undefined
  const opensOn = follows ?? defaultPreset
  const [draft, setDraft] = useState({ pick: opensOn, note: '' })
  // The suggestion can land after the tab is open, and so can the default:
  // the settings load after the page, and the reviewer can change the default
  // in the presets dialog with this tab under it. Either moves the picker
  // only while the reviewer has not touched it.
  const touched = useRef(false)
  useEffect(() => {
    if (!touched.current) setDraft((d) => (d.pick === opensOn ? d : { ...d, pick: opensOn }))
  }, [opensOn])
  const change = (next: typeof draft) => {
    touched.current = true
    setDraft(next)
  }
  // Anything written for this change is written in the ask sheet, the one
  // "Layer again" opens: the tab itself stays a picker and a button.
  const [asking, setAsking] = useState<LayersAskDraft | null>(null)
  const picked = presets ? askInput(draft, presets).preset : undefined
  const hint = suggested ? (
    picked === suggestedId ? (
      <p className="la-suggest">
        Suggested by the agent{suggested.reason ? `: ${suggested.reason}` : ''}
      </p>
    ) : (
      <button
        type="button"
        className="la-link la-suggest"
        title={suggested.reason}
        onClick={() => change({ ...draft, pick: suggested.preset.id })}
      >
        The agent suggests {suggested.preset.name}
      </button>
    )
  ) : undefined
  if (state === 'queued' || state === 'outlining') {
    const outlining = state === 'outlining'
    return (
      <div className="rail-scroll">
        <div className="ch-empty" data-state={state} aria-live="polite">
          <h2 className="ch-empty-title">
            <span className={`ch-working${outlining ? '' : ' ch-working-idle'}`} aria-hidden="true">
              <i />
              <i />
              <i />
            </span>
            {outlining ? 'Layering…' : 'Asked'}
          </h2>
          <p className="ch-empty-sub">
            {outlining
              ? 'The layers appear here as soon as the agent posts them.'
              : 'The agent starts once it finishes the threads it’s answering.'}
          </p>
        </div>
      </div>
    )
  }
  if (state === 'stalled') {
    return (
      <div className="rail-scroll">
        <div className="ch-empty" data-state={state} aria-live="polite">
          <h2 className="ch-empty-title">No layers yet</h2>
          <p className="ch-empty-sub">
            The agent took the request a while ago and hasn’t posted. Its harness may have refused
            the command: ask it in chat, or ask again here.
          </p>
          <button
            type="button"
            className="btn ch-empty-cta"
            onClick={() => onOutline?.()}
            disabled={!onOutline}
          >
            <Icon name="list" size="sm" />
            Ask again
          </button>
        </div>
      </div>
    )
  }
  return (
    <div className="rail-scroll">
      <div className="ch-empty" data-state={state} aria-live="polite">
        {/* The tab already says "Layers": one line on what they are, and the
            action. */}
        <p className="ch-empty-sub">
          The agent groups related changes into layers, so you review one idea at a time.
        </p>
        {state === 'noagent' ? (
          <>
            <p className="ch-empty-note">No agent is attached to layer it.</p>
            {onInvite && (
              <button type="button" className="btn ch-empty-cta" onClick={onInvite}>
                Invite an agent
              </button>
            )}
          </>
        ) : (
          <>
            {presets && (
              <LayerByFields
                presets={presets}
                draft={draft}
                onChange={change}
                compact
                hint={hint}
                {...(onOutline ? { onOpenSheet: (pick) => setAsking({ pick, note: '' }) } : {})}
                {...(suggestedId ? { suggestedId } : {})}
                {...(onManagePresets ? { onManagePresets } : {})}
              />
            )}
            <button
              type="button"
              className="btn btn-primary ch-empty-cta"
              onClick={() => onOutline?.(presets ? askInput(draft, presets) : undefined)}
              disabled={!onOutline || (presets !== undefined && !askReady(draft))}
            >
              <Icon name="list" size="sm" />
              Ask the agent for layers
            </button>
            {presets && onOutline && (
              <button
                type="button"
                className="la-link la-add-note"
                title="Say what you want from the layers this time, on top of the preset"
                onClick={() => setAsking({ pick: draft.pick, note: '' })}
              >
                Add instructions
              </button>
            )}
          </>
        )}
        {asking && presets && onOutline && (
          <LayersAskSheet
            presets={presets}
            initial={asking}
            title="Ask for layers"
            action="Ask for layers"
            onAsk={onOutline}
            {...(onManagePresets ? { onManagePresets } : {})}
            onClose={() => setAsking(null)}
          />
        )}
        {/* With the picker up, the presets dialog is the last item of its menu. */}
        {onManagePresets && (!presets || state === 'noagent') && (
          <button type="button" className="ch-empty-link" onClick={onManagePresets}>
            Manage presets
          </button>
        )}
      </div>
    </div>
  )
}
