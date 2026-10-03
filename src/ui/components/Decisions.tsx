import type { DecisionAt } from '../../shared/review.js'
import type { ResolvedDecision } from '../layers.js'
import { Markdown } from './Markdown.js'

/*
 * The layer card's Decisions: what the agent chose, found, or ran into while
 * making this step, one short line each, set like a ledger down a rule. The
 * reviewer reads the lines before the diff. Opening one gives the agent's
 * sentence and two ways on: the places it names, each a chip that goes there,
 * or a comment on the layer with the decision quoted, so the thread sits with
 * the step the agent explained, not on a line that may move. Nothing here is
 * a verdict: a decision says what was done and why, never whether it is fine.
 */

export interface DecisionsProps {
  decisions: readonly ResolvedDecision[]
  /** The one open card, by index, or none. Owned by the app so `.` can walk it. */
  open: number | null
  onOpen: (index: number | null) => void
  /** A place chip goes the way a summary link does. */
  onJump: (path: string, line: number | null) => void
  /** `Comment`: open the layer's comment box with this decision quoted.
   * Absent when the layer has nothing to comment on (the derived one). */
  onComment?: (index: number) => void
}

export function Decisions({ decisions, open, onOpen, onJump, onComment }: DecisionsProps) {
  if (decisions.length === 0) return null
  return (
    <section className="ch-dec" aria-label="Decisions">
      <div className="ch-dec-h">Decisions</div>
      {decisions.map((d, i) => (
        <DecisionLine
          // biome-ignore lint/suspicious/noArrayIndexKey: the list is the agent's order, re-posted whole
          key={i}
          resolved={d}
          open={open === i}
          onToggle={() => onOpen(open === i ? null : i)}
          onJump={onJump}
          onComment={onComment ? () => onComment(i) : undefined}
        />
      ))}
    </section>
  )
}

/** `src/a.ts:12–18`, as a place is named. */
function placeLabel(at: DecisionAt): string {
  if (at.line === undefined) return at.path
  return `${at.path}:${at.line}${at.endLine === undefined ? '' : `–${at.endLine}`}`
}

function DecisionLine({
  resolved,
  open,
  onToggle,
  onJump,
  onComment,
}: {
  resolved: ResolvedDecision
  open: boolean
  onToggle: () => void
  onJump: DecisionsProps['onJump']
  onComment?: () => void
}) {
  const { decision, places } = resolved
  // Only a place the changeset has is somewhere to go.
  const reachable = places.filter((p) => p.file)
  return (
    <div className={`ch-dec-item${open ? ' ch-dec-item-open' : ''}`}>
      <button type="button" className="ch-dec-main" aria-expanded={open} onClick={onToggle}>
        <span className="ch-dec-text">{decision.text}</span>
      </button>
      {open && (
        <div className="ch-dec-card">
          {decision.detail && (
            <Markdown text={decision.detail} className="ch-dec-detail markdown" />
          )}
          <div className="ch-dec-acts">
            {reachable.map((p) => (
              <button
                key={placeLabel(p.at)}
                type="button"
                className="ch-dec-place"
                title={placeLabel(p.at)}
                onClick={() => onJump(p.at.path, p.at.line ?? null)}
              >
                <span className="ch-dec-place-path">{p.at.path}</span>
                {p.at.line !== undefined && (
                  <span className="ch-dec-place-lines">
                    {p.at.line}
                    {p.at.endLine !== undefined && `–${p.at.endLine}`}
                  </span>
                )}
              </button>
            ))}
            {reachable.length === 0 && places.length > 0 && (
              <span className="ch-dec-gone">
                {places.length === 1 ? 'its file is' : 'its files are'} not in the changeset now
              </span>
            )}
            {onComment && (
              <button type="button" className="ch-dec-comment" onClick={onComment}>
                Comment
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
