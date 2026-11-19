import { type ReactNode, useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { Icon } from './Icon.js'

/** The dialogs open now, oldest first, and any menu open in one. A dialog
 * opened over another — a confirm over a settings dialog — is the only one
 * that answers the keyboard: every Modal listens on the document, and without
 * this both would close on one Escape. A menu joins while it is open (see
 * Menu.tsx), so Escape closes the menu and leaves its dialog standing. */
const stack: symbol[] = []

/** Take the top of the Escape stack; the returned function gives it back. */
export function claimEscape(name: string): () => void {
  const me = Symbol(name)
  stack.push(me)
  return () => {
    const at = stack.indexOf(me)
    if (at !== -1) stack.splice(at, 1)
  }
}

/**
 * Every dialog in the app, so none of them can be missing a way out again.
 *
 * Three ways to leave: the X, the scrim, and Escape. Escape is bound in the
 * **capture** phase, so a focused control inside the panel can't win the race, and it
 * stops propagation so it closes exactly one layer.
 *
 * The backdrop portals to <body>: a caller inside a sticky header or scroll pane
 * sits in a stacking context that would trap the scrim underneath the app chrome.
 * Clicks still bubble through the React tree, so callers keep their guards.
 */
export function Modal({
  title,
  badge,
  wide = false,
  className,
  footer,
  onClose,
  children,
}: {
  title: string
  badge?: ReactNode
  wide?: boolean
  className?: string
  footer?: ReactNode
  onClose: () => void
  children: ReactNode
}) {
  const panel = useRef<HTMLDivElement>(null)
  // Callers pass an inline `onClose`, so it's a new function every parent render.
  // Read it through a ref, keeping the effect's deps empty — otherwise it re-ran on
  // every render and stole focus back from whatever the user had just Tabbed to.
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose

  useEffect(() => {
    const me = Symbol('modal')
    stack.push(me)
    const onKey = (e: KeyboardEvent) => {
      // Only the dialog on top answers: Escape closes one layer, and Tab is
      // trapped in the one the reviewer is looking at.
      if (stack.at(-1) !== me) return
      if (e.key === 'Escape') {
        e.stopPropagation()
        onCloseRef.current()
        return
      }
      // Trap Tab inside the panel so focus can't wander to the page behind an
      // aria-modal dialog.
      if (e.key === 'Tab' && panel.current) {
        const focusables = Array.from(
          panel.current.querySelectorAll<HTMLElement>(
            'a[href], button:not([disabled]), textarea, input, select, [tabindex]:not([tabindex="-1"])',
          ),
        )
        if (focusables.length === 0) return
        const first = focusables[0]!
        const last = focusables[focusables.length - 1]!
        const active = document.activeElement
        if (!panel.current.contains(active)) {
          e.preventDefault()
          first.focus()
        } else if (e.shiftKey && active === first) {
          e.preventDefault()
          last.focus()
        } else if (!e.shiftKey && active === last) {
          e.preventDefault()
          first.focus()
        }
      }
    }
    document.addEventListener('keydown', onKey, true)
    // Focus the panel once on open (or Escape reaches the window handler behind the
    // modal), and restore focus to the trigger when it closes.
    const restore = document.activeElement as HTMLElement | null
    panel.current?.focus()
    return () => {
      document.removeEventListener('keydown', onKey, true)
      const at = stack.indexOf(me)
      if (at !== -1) stack.splice(at, 1)
      restore?.focus?.()
    }
  }, [])

  return createPortal(
    // biome-ignore lint/a11y/noStaticElementInteractions: closing is also Escape, bound below
    // biome-ignore lint/a11y/useKeyWithClickEvents: closing is also Escape, bound below
    <div className="modal-backdrop" onClick={onClose}>
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: the handler only contains a mouse click */}
      <div
        className={`modal${wide ? ' modal-wide' : ''}${className ? ` ${className}` : ''}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        ref={panel}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-head">
          <h3>{title}</h3>
          {badge}
          <button
            type="button"
            className="ghb"
            aria-label="Close"
            data-tip="Close"
            onClick={onClose}
          >
            <Icon name="x" size="sm" />
          </button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>,
    document.body,
  )
}
