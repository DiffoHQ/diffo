import { type ReactNode, useState } from 'react'
import { Modal } from './Modal.js'

/**
 * The one question before something is taken away: what goes, in a sentence,
 * and two buttons. The Clear-threads dialog's shape, for the cases that need
 * no counts of their own. `onConfirm` may be async; the button says so while
 * it runs, and a failure keeps the dialog with a line on it.
 */
export function Confirm({
  title,
  action,
  children,
  onConfirm,
  onClose,
}: {
  title: string
  /** The danger button's words: "Delete preset", "Remove layers". */
  action: string
  /** What goes, and what stays. */
  children: ReactNode
  onConfirm: () => unknown
  onClose: () => void
}) {
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const footer = (
    <>
      <button
        type="button"
        className="btn btn-danger"
        disabled={busy}
        onClick={() => {
          setBusy(true)
          setFailed(false)
          Promise.resolve()
            .then(onConfirm)
            .then(onClose)
            .catch(() => {
              setBusy(false)
              setFailed(true)
            })
        }}
      >
        {action}
      </button>
      <button type="button" className="btn btn-ghost" onClick={onClose}>
        Cancel
      </button>
    </>
  )
  return (
    <Modal title={title} onClose={onClose} footer={footer}>
      <p className="cov-note">{children}</p>
      {failed && (
        <p className="cov-note cov-note-error">
          That did not go through; the server may be down. Nothing was removed; try again.
        </p>
      )}
    </Modal>
  )
}
