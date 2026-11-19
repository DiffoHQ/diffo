import { GITHUB_URL } from '../starNudge.js'
import { Icon } from './Icon.js'

/** The GitHub-star ask (see starNudge.ts): the star ends it; ✕ snoozes it once. */
export interface StarAsk {
  onStar: () => void
  onDismiss: () => void
}

/**
 * The ask, as a header chip beside the critter holding up its star: the same
 * shape and weight as the presence chip, so it reads as part of the header.
 * It stays until answered: no timer, since the whole point is to be seen. With
 * no critter about (animations off, no agent), it sits in the empty stretch alone.
 */
export function StarBubble({ ask, onStar }: { ask: StarAsk; onStar?: () => void }) {
  return (
    <span className="star-bubble" role="status">
      <a
        className="star-bubble-ask"
        href={GITHUB_URL}
        target="_blank"
        rel="noopener noreferrer"
        onClick={() => {
          onStar?.()
          ask.onStar()
        }}
      >
        <span className="star-bubble-lead">Enjoying Diffo?</span>
        <span className="star-bubble-cta">
          <svg className="star-bubble-star" viewBox="0 0 16 16" aria-hidden="true">
            <path d="M8 1.6l1.95 4.06 4.45.58-3.26 3.08.82 4.42L8 11.58l-3.96 2.16.82-4.42L1.6 6.24l4.45-.58z" />
          </svg>
          Star on GitHub
        </span>
      </a>
      <button
        type="button"
        className="star-bubble-x"
        data-tip="Not now"
        aria-label="Not now"
        onClick={ask.onDismiss}
      >
        <Icon name="x" size="xs" />
      </button>
    </span>
  )
}
