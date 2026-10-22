/**
 * The Layers tab reads the change in one of two orders: the agent's steps, or
 * git's commits. The switch is offered only when a branch review has commits
 * to step through; Steps is the default either way.
 */

export type LayerSourceKind = 'steps' | 'commits'

export function LayerSource({
  source,
  onPick,
  stepCount,
  commitCount,
}: {
  source: LayerSourceKind
  onPick: (source: LayerSourceKind) => void
  /** Steps in the agent's outline; null before it has posted one. */
  stepCount: number | null
  commitCount: number
}) {
  return (
    <div className="src-seg" role="radiogroup" aria-label="Read the change by">
      {/* biome-ignore lint/a11y/useSemanticElements: styled chips; a native radio cannot carry this treatment */}
      <button
        type="button"
        role="radio"
        className="src-chip"
        aria-checked={source === 'steps'}
        title="The agent's steps, read in the order it outlined them"
        onClick={() => onPick('steps')}
      >
        Steps {stepCount !== null && <span className="tab-n">{stepCount}</span>}
      </button>
      {/* biome-ignore lint/a11y/useSemanticElements: styled chips; a native radio cannot carry this treatment */}
      <button
        type="button"
        role="radio"
        className="src-chip"
        aria-checked={source === 'commits'}
        title="The branch's commits, oldest first, each against its parent"
        onClick={() => onPick('commits')}
      >
        Commits <span className="tab-n">{commitCount}</span>
      </button>
    </div>
  )
}
