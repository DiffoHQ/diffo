import { useState } from 'react'
import type { TelemetryStatus } from '../telemetry.js'
import { Modal } from './Modal.js'

/**
 * Settings → Privacy: the one place the usage-data switch lives, one level
 * below the menu so the menu itself carries no checkmark to flip in passing.
 * Turning off asks once, inline; turning on is immediate. When an environment
 * variable has decided, the switch is shown locked and says which one.
 */
export function Privacy({
  status,
  onSetEnabled,
  onClose,
}: {
  status: TelemetryStatus
  onSetEnabled: (on: boolean) => void
  onClose: () => void
}) {
  const [confirming, setConfirming] = useState(false)
  const locked = status.source === 'env'
  const footer = confirming ? (
    <>
      <button
        type="button"
        className="btn"
        onClick={() => {
          onSetEnabled(false)
          setConfirming(false)
        }}
      >
        Turn off
      </button>
      <button type="button" className="btn btn-ghost" onClick={() => setConfirming(false)}>
        Keep sharing
      </button>
    </>
  ) : undefined
  return (
    <Modal title="Privacy" onClose={onClose} footer={footer}>
      <div className="privacy-row">
        <button
          type="button"
          className={`pane-sw${status.enabled ? ' pane-sw-on' : ''}`}
          role="switch"
          aria-checked={status.enabled}
          disabled={locked}
          onClick={() => (status.enabled ? setConfirming(true) : onSetEnabled(true))}
        >
          <span className="pane-track" aria-hidden="true">
            <i />
          </span>
          Share anonymous usage data
        </button>
        <span className="privacy-state">
          {locked
            ? `Off: ${status.variable} is set in your environment`
            : status.enabled
              ? 'On'
              : 'Off'}
        </span>
      </div>
      <p className="cov-note">
        Two small events per review, opened and finished: the version, your OS, the kind of review,
        which agent, and counts. Never code, paths, or comment text. One random id per machine tells
        returning machines from new ones; turning this off deletes it.{' '}
        <a href={status.docs} target="_blank" rel="noreferrer">
          What is sent
        </a>
      </p>
      {confirming && (
        <p className="cov-note privacy-confirm">
          <strong>Stop sharing?</strong> Diffo will send nothing more from this machine and delete
          its random id. You can turn it back on here any time.
        </p>
      )}
    </Modal>
  )
}
