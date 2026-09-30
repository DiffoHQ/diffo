import { useEffect, useRef, useState } from 'react'
import type { TelemetryStatus } from '../telemetry.js'
import { Icon } from './Icon.js'

/** A dozen seconds of the card being in front of the reader, one unhurried
 * read of it, then it dismisses itself: the clock runs only while the tab is
 * visible, and pauses while the pointer or focus is on the card. Settings →
 * Privacy keeps the link and the switch afterwards. */
export const NOTICE_AUTO_DISMISS_MS = 12_000

/**
 * The one-time notice that usage data is on — shown here, in the page, because
 * the human reads the page while the agent reads the terminal. Rendering it
 * records that it was shown, which is what arms reporting from the next review
 * on; this review reports nothing. It stays until dismissed, by a click or by
 * the timer above, across reviews. Homebrew-style, it informs and says where
 * the switch is rather than carrying one: turning off is a deliberate act in
 * Settings → Privacy or the CLI, not a reflex next to OK.
 */
export function TelemetryNotice({
  status,
  onShown,
  onAcknowledge,
}: {
  status: TelemetryStatus
  onShown: () => void
  onAcknowledge: () => void
}) {
  // Decided once: after onShown lands the status reads `shown`, and the text
  // must not flip from "nothing during this review" to "reporting" under the
  // reader's eyes.
  const firstShowing = useRef(status.notice === 'pending')
  const reported = useRef(false)
  const visible = status.enabled && status.notice !== 'acknowledged'
  useEffect(() => {
    if (visible && firstShowing.current && !reported.current) {
      reported.current = true
      onShown()
    }
  }, [visible, onShown])

  const [held, setHeld] = useState(false)
  const remaining = useRef(NOTICE_AUTO_DISMISS_MS)
  // What the ring around OK draws: the time left, refreshed a few times a second
  // while the clock runs, frozen while it does not.
  const [left, setLeft] = useState(NOTICE_AUTO_DISMISS_MS)
  useEffect(() => {
    if (!visible || held) return
    let timer: ReturnType<typeof setTimeout> | undefined
    let ticker: ReturnType<typeof setInterval> | undefined
    let startedAt = 0
    const elapsed = () => Math.max(0, remaining.current - (Date.now() - startedAt))
    const arm = () => {
      if (timer !== undefined) return
      startedAt = Date.now()
      timer = setTimeout(onAcknowledge, remaining.current)
      ticker = setInterval(() => setLeft(elapsed()), 250)
    }
    const disarm = () => {
      if (timer === undefined) return
      clearTimeout(timer)
      clearInterval(ticker)
      timer = undefined
      remaining.current = elapsed()
      setLeft(remaining.current)
    }
    const onVisibility = () => (document.visibilityState === 'visible' ? arm() : disarm())
    onVisibility()
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      disarm()
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [visible, held, onAcknowledge])

  if (!visible) return null
  return (
    <div
      className="telemetry-notice"
      role="status"
      aria-live="polite"
      onMouseEnter={() => setHeld(true)}
      onMouseLeave={() => setHeld(false)}
      onFocus={() => setHeld(true)}
      onBlur={() => setHeld(false)}
    >
      <Icon name="note" size="sm" />
      <p className="telemetry-notice-text">
        <strong>Diffo sends anonymous usage data.</strong> Two small events per review, opened and
        finished: the version, your OS, the kind of review, which agent, and counts. Never code,
        paths, or comment text.{' '}
        {firstShowing.current
          ? 'Nothing has been sent yet, and nothing is during this review. '
          : ''}
        Turn it off any time under Settings → Privacy.{' '}
        <a href={status.docs} target="_blank" rel="noreferrer">
          What is sent
        </a>
      </p>
      <span className="telemetry-notice-ok">
        <svg className="telemetry-notice-ring" viewBox="0 0 40 40" aria-hidden="true">
          <circle className="telemetry-notice-ring-track" cx="20" cy="20" r={RING_R} />
          <circle
            className="telemetry-notice-ring-left"
            cx="20"
            cy="20"
            r={RING_R}
            strokeDasharray={RING_C}
            strokeDashoffset={RING_C * (1 - left / NOTICE_AUTO_DISMISS_MS)}
          />
        </svg>
        <button
          type="button"
          className="btn btn-sm telemetry-notice-ok-btn"
          title="dismiss; it closes on its own in a few seconds"
          onClick={onAcknowledge}
        >
          OK
        </button>
      </span>
    </div>
  )
}

const RING_R = 18
const RING_C = 2 * Math.PI * RING_R
