import type { ResolvedLayer } from '../layers.js'

/**
 * What the rail folds to. A folded rail does not vanish: it leaves a
 * slim strip that still says where you are: its layers by number, the current
 * one lit. The switch that brings the rail back is the top bar's first button.
 */
export function PlanStrip({
  layers,
  activeIndex,
  onPick,
}: {
  /** The outline, when the plan is being read by layers; empty otherwise. */
  layers: readonly ResolvedLayer[]
  activeIndex: number
  onPick: (index: number) => void
}) {
  return (
    <nav className="strip strip-plan" aria-label="Layers">
      {layers.map((layer, index) => (
        <button
          key={layer.id ?? `derived-${index}`}
          type="button"
          className="strip-num"
          aria-current={index === activeIndex ? 'true' : undefined}
          data-tip={layer.title}
          aria-label={`Layer ${layer.number ?? index + 1}: ${layer.title}`}
          onClick={() => onPick(index)}
        >
          {layer.number ?? '+'}
        </button>
      ))}
    </nav>
  )
}
