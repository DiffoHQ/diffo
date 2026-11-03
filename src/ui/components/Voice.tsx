import { useState } from 'react'
import { DEFAULT_VOICE, normalizeVoice, VOICE_MAX } from '../../shared/voice.js'
import { Modal } from './Modal.js'

/**
 * Settings → Voice: the standing instructions an agent reads before it drafts
 * a PR comment in the reviewer's name. The textarea shows the text the agent
 * will see, default included, so editing starts from something rather than a
 * blank. Save waits for the server (the one reader) before closing; Reset puts
 * the default back as text, saved like any other edit.
 */
export function Voice({
  voice,
  onSave,
  onClose,
}: {
  /** The stored voice, or null for the default. */
  voice: string | null
  /** Null resets to the default. Resolves false when the save failed. */
  onSave: (next: string | null) => Promise<boolean>
  onClose: () => void
}) {
  const [text, setText] = useState(voice ?? DEFAULT_VOICE)
  const [saving, setSaving] = useState(false)
  const [failed, setFailed] = useState(false)
  const trimmed = text.trim()
  // What this text means once saved: the default, or a voice of their own.
  const isDefault = trimmed === '' || trimmed === DEFAULT_VOICE
  const over = trimmed.length > VOICE_MAX
  const unchanged = (isDefault ? null : trimmed) === voice
  const save = async () => {
    if (over || unchanged || saving) return
    setSaving(true)
    setFailed(false)
    const ok = await onSave(isDefault ? null : normalizeVoice(trimmed))
    setSaving(false)
    if (ok) onClose()
    else setFailed(true)
  }
  const footer = (
    <>
      <button
        type="button"
        className="btn btn-primary"
        disabled={over || unchanged || saving}
        onClick={() => void save()}
      >
        {saving ? 'Saving…' : 'Save'}
      </button>
      <button
        type="button"
        className="btn btn-ghost"
        disabled={isDefault && trimmed !== ''}
        title="put the default voice back in the box; Save makes it stick"
        onClick={() => setText(DEFAULT_VOICE)}
      >
        Reset to default
      </button>
      <span className={`voice-count${over ? ' voice-count-over' : ''}`} aria-live="polite">
        {failed
          ? 'Could not save; is the review server still running?'
          : `${trimmed.length} / ${VOICE_MAX}`}
      </span>
    </>
  )
  return (
    <Modal title="Voice" className="voice-modal" wide onClose={onClose} footer={footer}>
      <p className="cov-note">
        How your agent writes the PR comments it suggests in your name. It reads this before every
        suggestion, on every pull request, from now on. Nothing here is posted anywhere; it only
        shapes the drafts you still approve.
      </p>
      <textarea
        className="thread-input voice-input"
        aria-label="Your voice: how the agent writes PR comments for you"
        value={text}
        rows={12}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
            e.preventDefault()
            void save()
          }
        }}
      />
      <p className="cov-note voice-state">
        {isDefault
          ? 'This is the default voice.'
          : 'Your own voice; Reset to default brings the original back.'}
      </p>
    </Modal>
  )
}
