import { Icon } from './Icon.js'

/**
 * The Layers tab before there are any. Four states, one action. Agent status
 * itself stays in the header's presence chip — the rail carries no
 * notifications — so this body only ever says what the one button does and
 * why it is, or is not, worth pressing right now.
 *
 *   quiet      nothing said either way; the button is there
 *   suggested  the agent flagged at open that this read benefits from layers;
 *              its reason is quoted here, next to the button it argues for
 *   working    the outline was requested and the agent is writing it
 *   noagent    nobody is attached, so nobody can outline — Invite instead
 */
export type LayersEmptyState = 'quiet' | 'suggested' | 'working' | 'noagent'

export function LayersEmpty({
  state,
  reason,
  onOutline,
  onInvite,
}: {
  state: LayersEmptyState
  /** The agent's one line on why, when it suggested. */
  reason?: string
  onOutline?: () => void
  onInvite?: () => void
}) {
  if (state === 'noagent') {
    return (
      <div className="rail-scroll">
        <div className="ch-empty" data-state="noagent">
          <p>No session attached.</p>
          <p className="ch-empty-sub">Layers come from the session that wrote the code.</p>
          {onInvite && (
            <button type="button" className="btn" onClick={onInvite}>
              Invite
            </button>
          )}
        </div>
      </div>
    )
  }
  if (state === 'working') {
    return (
      <div className="rail-scroll">
        <div className="ch-empty" data-state="working">
          <p>
            <span className="ch-working" aria-hidden="true">
              <i />
              <i />
              <i />
            </span>{' '}
            Outlining…
          </p>
          <p className="ch-empty-sub">Layers appear here as soon as the agent posts them.</p>
        </div>
      </div>
    )
  }
  const suggested = state === 'suggested'
  return (
    <div className="rail-scroll">
      <div className="ch-empty" data-state={state}>
        <p>{suggested ? 'The agent suggests reading this in layers.' : 'No layers yet.'}</p>
        <p className="ch-empty-sub">
          {suggested && reason
            ? `“${reason}”`
            : 'The session that wrote this can outline it as steps to read in order.'}
        </p>
        <button
          type="button"
          className={`btn${suggested ? ' btn-primary' : ''}`}
          onClick={onOutline}
          disabled={!onOutline}
        >
          <Icon name="list" size="sm" /> Outline in layers
        </button>
      </div>
    </div>
  )
}
