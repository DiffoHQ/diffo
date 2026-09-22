import { Icon } from './Icon.js'

/**
 * The Layers tab before there are any. Four states, one action. Agent status
 * itself stays in the header's presence chip — the rail carries no
 * notifications — so this body explains the feature once, in the same words
 * every time, and then says what the one button does and why it is, or is
 * not, worth pressing right now.
 *
 *   quiet      nothing said either way; the button is there
 *   suggested  the agent flagged at open that this read benefits from layers;
 *              its reason is quoted here, next to the button it argues for
 *   queued     the outline was asked for, and waits behind the agent's open threads
 *   outlining  the agent has the request and is writing the plan
 *   noagent    nobody is attached, so nobody can outline — Invite instead
 */
export type LayersEmptyState = 'quiet' | 'suggested' | 'queued' | 'outlining' | 'noagent'

/** What a layer is, for a reviewer who has never seen one. The same words in
 * every state, so the tab teaches once and then gets out of the way. */
function Explainer() {
  return (
    <p className="ch-empty-sub">
      A diff arrives in alphabetical order. <b>Layers</b> are the agent's reading plan: the change
      as steps, in the order it should be read, each with the files that belong to it. You read one
      layer at a time. Only the session that wrote the code can write the plan.
    </p>
  )
}

/** What an outline looks like — labelled as an example, numbered as a
 * sequence, and dimmed, so it never reads as three layers you could click. */
function Example() {
  return (
    <figure className="ch-empty-example">
      <figcaption>Example</figcaption>
      <ol>
        <li>
          <span>The contract</span>
          <small>2 files</small>
        </li>
        <li>
          <span>Callers follow</span>
          <small>4 files</small>
        </li>
        <li>
          <span>Tests</span>
          <small>3 files</small>
        </li>
      </ol>
    </figure>
  )
}

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
          <Explainer />
          <Example />
          {onInvite && (
            <button type="button" className="btn" onClick={onInvite}>
              Invite an agent
            </button>
          )}
          <p className="ch-empty-hint">Once one is attached, you can ask for the plan here.</p>
        </div>
      </div>
    )
  }
  if (state === 'queued' || state === 'outlining') {
    const outlining = state === 'outlining'
    return (
      <div className="rail-scroll">
        <div className="ch-empty" data-state={state}>
          <p>
            <span className="ch-working" aria-hidden="true">
              <i />
              <i />
              <i />
            </span>{' '}
            {outlining ? 'The agent is outlining…' : 'Asked.'}
          </p>
          <p className="ch-empty-sub">
            {outlining
              ? 'It is writing the reading plan now. Layers appear here as soon as it posts them.'
              : 'The agent starts on the plan once it finishes the threads it is answering now.'}
          </p>
          <Example />
        </div>
      </div>
    )
  }
  const suggested = state === 'suggested'
  return (
    <div className="rail-scroll">
      <div className="ch-empty" data-state={state}>
        <p>
          {suggested ? 'The agent suggests reading this in layers.' : 'Read this change in layers.'}
        </p>
        {suggested && reason && <p className="ch-empty-quote">“{reason}”</p>}
        <Explainer />
        <Example />
        <button
          type="button"
          className={`btn${suggested ? ' btn-primary' : ''}`}
          onClick={onOutline}
          disabled={!onOutline}
        >
          <Icon name="list" size="sm" /> Ask the agent to outline this
        </button>
        <p className="ch-empty-hint">
          One click. The plan arrives in a moment; nothing leaves your machine.
        </p>
      </div>
    </div>
  )
}
