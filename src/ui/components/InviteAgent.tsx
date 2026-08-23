import { useEffect, useRef, useState } from 'react'
import type { Presence, PresenceReason } from '../api.js'
import { useInvite } from '../api.js'
import { copyText } from '../clipboard.js'
import { Icon } from './Icon.js'
import { Modal } from './Modal.js'

export function InviteAgent({
  presence,
  reason,
  onClose,
}: {
  presence: Presence
  reason?: PresenceReason
  onClose: () => void
}) {
  const { data, isLoading, error } = useInvite(true)
  const [copied, setCopied] = useState<string | null>(null)
  const [copyFailed, setCopyFailed] = useState(false)
  const [watching, setWatching] = useState(false)
  const [global, setGlobal] = useState(true)
  const attached = presence !== 'waiting'
  const [phase, setPhase] = useState<'invite' | 'connected'>(attached ? 'connected' : 'invite')
  const [detached, setDetached] = useState(false)

  // Presence is edge-triggered here: only a *change* means something happened while
  // this modal was open.
  const wasAttached = useRef(attached)
  useEffect(() => {
    if (attached === wasAttached.current) return
    wasAttached.current = attached
    setPhase(attached ? 'connected' : 'invite')
    setDetached(!attached)
  }, [attached])

  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose
  useEffect(() => {
    if (phase !== 'connected') return
    const timer = setTimeout(() => onCloseRef.current(), 1800)
    return () => clearTimeout(timer)
  }, [phase])

  const copy = (what: string, text: string) => {
    void copyText(text).then((ok) => {
      setCopyFailed(!ok)
      if (!ok) return
      setCopied(what)
      // Watching outlives the "Copied" flash: gating the listening strip on `copied`
      // tied it to that 2.5s timer. It ends when presence changes, or you close.
      setWatching(true)
      setTimeout(() => setCopied(null), 2500)
    })
  }

  if (phase === 'connected') {
    return (
      <Modal title="Agent attached" onClose={onClose}>
        <div className="invite-connected">
          <span className="presence-dot" />
          <p className="cov-note">Everything you send from here lands in that thread.</p>
        </div>
      </Modal>
    )
  }

  const install = data ? (global ? data.install.global : data.install.project) : ''

  return (
    <Modal title="Install the Diffo skill" wide onClose={onClose}>
      {detached && (
        <div className="warn">
          <Icon name="alert" size="sm" />
          <div>
            {reason === 'ended' ? (
              <>
                <b>Your agent left the review</b> — it detached on purpose. Bring it back whenever
                you like.
              </>
            ) : (
              <>
                <b>Your agent disconnected</b> — its poll died without detaching.
              </>
            )}
          </div>
        </div>
      )}

      {isLoading && <div className="shimmer" />}
      {error && <p className="cov-note">Couldn't build the invite: {(error as Error).message}</p>}
      {data && (
        <>
          <p className="cov-note">One command in your terminal. That's the whole setup.</p>

          <button
            type="button"
            className="invite-cmd"
            title={copied === 'install' ? 'Copied' : 'copy the install command'}
            onClick={() => copy('install', install)}
          >
            <code>{install}</code>
            <Icon name={copied === 'install' ? 'check' : 'copy'} size="sm" />
          </button>

          <label className="invite-scope">
            <input type="checkbox" checked={global} onChange={(e) => setGlobal(e.target.checked)} />
            Available in every project
          </label>

          <p className="cov-note">
            Your agent can then open reviews and act on your comments — just ask it to.
          </p>

          <div className="invite-join">
            <p className="cov-note">Already have it? Paste this to your agent:</p>
            <button
              type="button"
              className="invite-cmd"
              title={copied === 'join' ? 'Copied' : 'copy the prompt'}
              onClick={() => copy('join', data.join)}
            >
              <code>{data.join}</code>
              <Icon name={copied === 'join' ? 'check' : 'copy'} size="sm" />
            </button>
          </div>

          {watching && (
            <div className="invite-live">
              <span className="presence-dot" />
              Listening for your agent…
            </div>
          )}

          {copyFailed && (
            <div className="warn">
              <Icon name="alert" size="sm" />
              <div>
                <b>Couldn't reach the clipboard</b> — this browser blocked it. Select the command
                and copy it by hand.
              </div>
            </div>
          )}
        </>
      )}
    </Modal>
  )
}
