import type { BeforeAfter as BeforeAfterPost, BeforeAfterSection } from '../../shared/review.js'
import type { BeforeAfterRequest } from '../api.js'
import { Icon } from './Icon.js'
import { Markdown } from './Markdown.js'

/**
 * The pane while the reviewer stands on the Layers tab's Before / after row:
 * one section per behaviour the change alters, each with the agent's two
 * passages side by side, or, until there are any, where the ask stands — the
 * same states the Layers tab's empty body walks through.
 *
 *   post       the agent's sections
 *   queued     asked, waiting behind the agent's open threads
 *   writing    the agent has the ask
 *   quiet      marked as a behaviour change, nothing posted, nothing asked: one button
 *   noagent    nobody is attached to write it
 */
export function BeforeAfterCard({
  post,
  request,
  agentAttached,
  onAsk,
  onInvite,
}: {
  post?: BeforeAfterPost
  request: BeforeAfterRequest
  agentAttached: boolean
  onAsk?: () => void
  onInvite?: () => void
}) {
  return (
    <section className="ch-head ba-card" aria-label="Before and after">
      <div className="ch-head-top">
        <div className="ch-head-kicker">Behaviour change</div>
      </div>
      <h2>Before / after</h2>
      {post ? (
        post.sections.map((section) => (
          <BeforeAfterPair key={`${section.title ?? ''}\n${section.before}`} section={section} />
        ))
      ) : request !== null && agentAttached ? (
        <p className="ba-note" aria-live="polite">
          <span
            className={`ch-working${request === 'writing' ? '' : ' ch-working-idle'}`}
            aria-hidden="true"
          >
            <i />
            <i />
            <i />
          </span>{' '}
          {request === 'writing'
            ? 'The agent is writing it; it appears here as soon as it posts.'
            : 'Asked. The agent starts once it finishes the threads it’s answering.'}
        </p>
      ) : agentAttached ? (
        <div className="ba-note">
          <p>What the program did before this change, and what it does now.</p>
          <button type="button" className="btn ch-empty-cta" onClick={onAsk} disabled={!onAsk}>
            <Icon name="compare" size="sm" />
            Ask the agent for the before / after
          </button>
        </div>
      ) : (
        <div className="ba-note">
          <p>No agent is attached to write it.</p>
          {onInvite && (
            <button type="button" className="btn ch-empty-cta" onClick={onInvite}>
              Invite an agent
            </button>
          )}
        </div>
      )}
    </section>
  )
}

function BeforeAfterPair({ section }: { section: BeforeAfterSection }) {
  return (
    <div className="ba-section">
      {section.title && <h3 className="ba-title">{section.title}</h3>}
      <div className="ba-sides">
        <BeforeAfterSide label="Before" side="before" text={section.before} />
        <BeforeAfterSide label="After" side="after" text={section.after} />
      </div>
    </div>
  )
}

function BeforeAfterSide({
  label,
  side,
  text,
}: {
  label: string
  side: 'before' | 'after'
  text: string
}) {
  return (
    <div className={`ba-side ba-side-${side}`}>
      <div className="ba-label">{label}</div>
      <Markdown text={text} className="cmt-body markdown ch-summary" />
    </div>
  )
}
