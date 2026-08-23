import { type ReactNode, useEffect, useRef, useState } from 'react'
import { Icon, type IconName } from './Icon.js'

/**
 * The overflow menu — one control standing in for a whole toolbar.
 *
 * Closes on outside mousedown *and* on Escape. Escape is bound in the **capture**
 * phase on `document`: a bubble-phase listener loses the race whenever a focused
 * descendant handles the key first.
 */
export function Menu({
  label,
  icon = 'more',
  children,
  align = 'right',
  triggerClassName = 'btn btn-ghost btn-icon btn-sm',
}: {
  label: string
  icon?: IconName
  children: (close: () => void) => ReactNode
  align?: 'left' | 'right'
  triggerClassName?: string
}) {
  const [open, setOpen] = useState(false)
  const wrap = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey, true)
    }
  }, [open])

  return (
    <div className="menu" ref={wrap}>
      <button
        type="button"
        className={triggerClassName}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={(e) => {
          e.stopPropagation()
          setOpen((v) => !v)
        }}
      >
        <Icon name={icon} />
      </button>
      {open && (
        <div className={`menu-panel${align === 'left' ? ' menu-panel-left' : ''}`} role="menu">
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  )
}

export function MenuItem({
  icon,
  kbd,
  checked,
  danger = false,
  onClick,
  children,
}: {
  icon?: IconName
  kbd?: string
  checked?: boolean
  danger?: boolean
  onClick: () => void
  children: ReactNode
}) {
  return (
    <button
      type="button"
      role={checked === undefined ? 'menuitem' : 'menuitemradio'}
      {...(checked === undefined ? {} : { 'aria-checked': checked })}
      className={`menu-item${danger ? ' menu-item-danger' : ''}`}
      onClick={onClick}
    >
      {icon && <Icon name={icon} size="sm" />}
      <span className="menu-item-label">{children}</span>
      {checked && <Icon name="check" size="sm" className="menu-item-check" />}
      {kbd && <span className="kbd">{kbd}</span>}
    </button>
  )
}

export function MenuSep() {
  return <hr className="menu-sep" />
}

export function MenuLabel({ children }: { children: ReactNode }) {
  return <div className="menu-label">{children}</div>
}
