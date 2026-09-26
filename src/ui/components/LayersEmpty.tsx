import { Icon } from './Icon.js'

/**
 * The Layers tab before there are any: a title, one line, and the one action —
 * or, when the action isn't there, the reason. Agent status itself stays in the
 * header's presence chip — an agent's suggestion to read in layers included —
 * so this body only says what the button does.
 *
 *   quiet      the button is there
 *   queued     the outline was asked for, and waits behind the agent's open threads
 *   outlining  the agent has the request and is writing the plan
 *   noagent    nobody is attached, so nobody can outline — Invite instead
 */
export type LayersEmptyState = 'quiet' | 'queued' | 'outlining' | 'noagent'

export function LayersEmpty({
  state,
  onOutline,
  onInvite,
}: {
  state: LayersEmptyState
  onOutline?: () => void
  onInvite?: () => void
}) {
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
            {outlining ? 'Outlining…' : 'Asked'}
          </h2>
          <p className="ch-empty-sub">
            {outlining
              ? 'The steps appear here as soon as the agent posts them.'
              : 'The agent starts once it finishes the threads it’s answering.'}
          </p>
        </div>
      </div>
    )
  }
  return (
    <div className="rail-scroll">
      <div className="ch-empty" data-state={state} aria-live="polite">
        <h2 className="ch-empty-title">Read in layers</h2>
        <p className="ch-empty-sub">The agent splits its change into steps you read in order.</p>
        {state === 'noagent' ? (
          <>
            <p className="ch-empty-note">No agent is attached to outline it.</p>
            {onInvite && (
              <button type="button" className="btn ch-empty-cta" onClick={onInvite}>
                Invite an agent
              </button>
            )}
          </>
        ) : (
          <button
            type="button"
            className="btn ch-empty-cta"
            onClick={onOutline}
            disabled={!onOutline}
          >
            <Icon name="list" size="sm" />
            Ask the agent to outline
          </button>
        )}
      </div>
    </div>
  )
}
