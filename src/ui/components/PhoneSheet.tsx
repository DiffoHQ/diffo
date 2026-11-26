import { type ReactNode, useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { Icon } from './Icon.js'

/**
 * How far the on-screen keyboard reaches up from the bottom of the layout
 * viewport. iOS does not shrink the page for the keyboard; it slides the
 * visual viewport over it, so a sheet pinned to `bottom: 0` would sit behind
 * the keys. The visual viewport says where the visible part really ends.
 */
function useKeyboardInset(): number {
  const [inset, setInset] = useState(0)
  useEffect(() => {
    const vv = window.visualViewport
    if (!vv) return
    const update = () =>
      setInset(Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop)))
    update()
    vv.addEventListener('resize', update)
    vv.addEventListener('scroll', update)
    return () => {
      vv.removeEventListener('resize', update)
      vv.removeEventListener('scroll', update)
    }
  }, [])
  return inset
}

/**
 * A sheet that rises from the bottom of the phone: what a side panel, a
 * popover or an inline composer becomes when there is no side and no room.
 *
 * Portalled to the body so no ancestor's overflow or stacking can clip it. A
 * portal keeps its place in the React tree, so the owner's state — a half-typed
 * comment above all — survives the sheet opening and closing. React events
 * still bubble to that owner, which is why the sheet stops them at its edge:
 * a tap inside must not also select the hunk underneath.
 *
 * `full` takes the whole screen (a thread, a navigator); otherwise the sheet
 * hugs its content and the review stays visible, dimmed, above it.
 */
export function PhoneSheet({
  children,
  onClose,
  title,
  full = false,
  className = '',
  label,
}: {
  children: ReactNode
  onClose: () => void
  /** A head with a close button; absent when the content brings its own. */
  title?: ReactNode
  full?: boolean
  className?: string
  /** The dialog's accessible name, when there is no `title` to give it one. */
  label?: string
}) {
  const keyboard = useKeyboardInset()
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  return createPortal(
    // biome-ignore lint/a11y/noStaticElementInteractions: the wrapper only fences events off from the owner's tree
    // biome-ignore lint/a11y/useKeyWithClickEvents: the wrapper only fences events off from the owner's tree
    <div
      className="psheet-root"
      onClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <button type="button" className="psheet-scrim" aria-label="Close" onClick={onClose} />
      <div
        className={`psheet${full ? ' psheet-full' : ''}${className ? ` ${className}` : ''}`}
        role="dialog"
        aria-modal="true"
        aria-label={label ?? (typeof title === 'string' ? title : undefined)}
        style={{ bottom: keyboard }}
      >
        {!full && <span className="psheet-grab" aria-hidden="true" />}
        {title !== undefined && (
          <div className="psheet-head">
            <span className="psheet-title">{title}</span>
            <button type="button" className="psheet-x" aria-label="Close" onClick={onClose}>
              <Icon name="x" size="md" />
            </button>
          </div>
        )}
        <div className="psheet-body">{children}</div>
      </div>
    </div>,
    document.body,
  )
}
