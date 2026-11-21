import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { filterPalette, type PaletteGroup, type PaletteItem } from '../palette.js'
import { Icon } from './Icon.js'
import { claimEscape } from './Modal.js'

/**
 * Jump to anything: a layer, a file, a thread, or an action — by typing a few
 * letters of it. Everything here is reachable some other way; the palette is
 * the one place that does not ask you to know where.
 *
 * A combobox over a listbox: focus stays in the input, arrows move the
 * selection, Enter runs it, Escape leaves. It portals to <body> for the same
 * reason Modal does — a caller in the header sits in a stacking context that
 * would trap the scrim.
 */
export function CommandPalette({
  items,
  onClose,
}: {
  items: readonly PaletteItem[]
  onClose: () => void
}) {
  const [query, setQuery] = useState('')
  const [at, setAt] = useState(0)
  const list = useRef<HTMLDivElement>(null)
  const shown = useMemo(() => filterPalette(items, query), [items, query])
  const active = Math.min(at, Math.max(shown.length - 1, 0))

  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onCloseRef.current()
      }
    }
    document.addEventListener('keydown', onKey, true)
    const release = claimEscape('palette')
    return () => {
      document.removeEventListener('keydown', onKey, true)
      release()
    }
  }, [])

  // Keep the lit row in view as the arrows move it.
  useEffect(() => {
    list.current?.querySelector(`#palette-${active}`)?.scrollIntoView?.({ block: 'nearest' })
  }, [active])

  const run = (item: PaletteItem | undefined) => {
    if (!item) return
    onClose()
    item.run()
  }

  let lastGroup: PaletteGroup | null = null
  return createPortal(
    // biome-ignore lint/a11y/noStaticElementInteractions: the scrim; Escape is the keyboard way out
    // biome-ignore lint/a11y/useKeyWithClickEvents: the scrim; Escape is the keyboard way out
    <div className="palette-scrim" onClick={onClose}>
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: only stops the scrim's click */}
      <div
        className="palette"
        role="dialog"
        aria-modal="true"
        aria-label="Jump to"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="palette-field">
          <Icon name="search" size="md" />
          <input
            // biome-ignore lint/a11y/noAutofocus: a palette exists to be typed into the moment it opens
            autoFocus
            className="palette-input"
            type="text"
            role="combobox"
            aria-expanded="true"
            aria-controls="palette-list"
            aria-activedescendant={shown[active] ? `palette-${active}` : undefined}
            aria-label="Jump to a layer, file, thread or action"
            placeholder="Jump to a layer, file, thread or action…"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value)
              setAt(0)
            }}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') {
                e.preventDefault()
                setAt(Math.min(active + 1, shown.length - 1))
              } else if (e.key === 'ArrowUp') {
                e.preventDefault()
                setAt(Math.max(active - 1, 0))
              } else if (e.key === 'Enter') {
                e.preventDefault()
                run(shown[active])
              }
            }}
          />
          <span className="kbd">esc</span>
        </div>
        <div className="palette-list" id="palette-list" role="listbox" ref={list}>
          {shown.length === 0 && <div className="palette-none">Nothing matches “{query}”.</div>}
          {shown.map((item, index) => {
            const head = item.group !== lastGroup
            lastGroup = item.group
            return (
              <div key={item.id} role="presentation">
                {head && <div className="palette-group">{item.group}</div>}
                {/* biome-ignore lint/a11y/useKeyWithClickEvents: the input holds focus and handles the keys */}
                <div
                  id={`palette-${index}`}
                  role="option"
                  tabIndex={-1}
                  aria-selected={index === active}
                  className="palette-row"
                  onMouseMove={() => setAt(index)}
                  onClick={() => run(item)}
                >
                  <span className="palette-label">{item.label}</span>
                  {item.hint && <span className="palette-hint">{item.hint}</span>}
                  {item.kbd && <span className="kbd">{item.kbd}</span>}
                </div>
              </div>
            )
          })}
        </div>
      </div>
    </div>,
    document.body,
  )
}
