import { useState } from 'react'
import { Modal } from './Modal.js'

export function ClearThreads({
  total,
  past,
  onClear,
  onClose,
}: {
  total: number
  past: number
  onClear: () => Promise<unknown>
  onClose: () => void
}) {
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const live = total - past

  const footer = (
    <>
      <button
        type="button"
        className="btn btn-danger"
        disabled={busy}
        onClick={() => {
          setBusy(true)
          setFailed(false)
          onClear()
            .then(onClose)
            .catch(() => {
              setBusy(false)
              setFailed(true)
            })
        }}
      >
        {busy ? 'Clearing…' : `Delete ${total} thread${total === 1 ? '' : 's'}`}
      </button>
      <button type="button" className="btn btn-ghost" onClick={onClose}>
        Cancel
      </button>
    </>
  )

  return (
    <Modal title="Clear threads" onClose={onClose} footer={footer}>
      <p className="cov-note">
        Deletes every thread in this repo's review — {total} in total
        {past > 0 && (
          <>
            , {past} of which {past === 1 ? 'is' : 'are'} hidden because{' '}
            {past === 1 ? 'its changeset is' : 'their changesets are'} behind you
          </>
        )}
        {live > 0 && past > 0 && `, and ${live} still on the current changeset`}. Answers from your
        agent go with them, and this can't be undone.
      </p>

      {failed && (
        <p className="cov-note cov-note-error">
          Couldn't clear the review — the server may be down. Nothing was deleted; try again.
        </p>
      )}
    </Modal>
  )
}
