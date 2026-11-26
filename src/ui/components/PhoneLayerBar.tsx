import { Icon } from './Icon.js'
import type { PaneLayer } from './PaneBar.js'

/**
 * The phone's way between layers, at the bottom where the thumb is: back to
 * the one before, on to the next, each named by its title. It is the desktop
 * bar's pager and the `[` / `]` keys, and nothing else: scrolling is how a
 * phone moves within a layer, so the bar only moves between them.
 */
export function PhoneLayerBar({ layer }: { layer: PaneLayer }) {
  const noun = layer.noun ?? 'layer'
  const { prev, next } = layer
  if (!prev && !next) return null
  return (
    <nav className="phone-layer-bar" aria-label={`${noun}s`}>
      {prev && (
        <button
          type="button"
          className="phone-layer-go phone-layer-prev"
          onClick={prev.onGo}
          aria-label={`Previous ${noun}: ${prev.title}`}
        >
          <Icon name="chev" size="md" />
          <span className="phone-layer-text">
            <span className="phone-layer-kicker">Previous</span>
            <span className="phone-layer-title">{prev.title}</span>
          </span>
        </button>
      )}
      {next && (
        <button
          type="button"
          className="phone-layer-go phone-layer-next"
          onClick={next.onGo}
          aria-label={`Next ${noun}: ${next.title}`}
        >
          <span className="phone-layer-text">
            <span className="phone-layer-kicker">Next {noun}</span>
            <span className="phone-layer-title">{next.title}</span>
          </span>
          <Icon name="chev" size="md" />
        </button>
      )}
    </nav>
  )
}
