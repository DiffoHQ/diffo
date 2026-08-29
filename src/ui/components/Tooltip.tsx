import { useEffect, useRef } from 'react'

/** First hover waits; after that, moving between controls feels like one toolbar. */
const SHOW_DELAY = 400
const WARM_GAP = 300

/**
 * One floating label for every `data-tip` element — icon-only buttons mostly.
 * The native `title` tooltip is too slow and too quiet to read as "this app has
 * tooltips", so controls that are nothing but an icon carry `data-tip` instead
 * and this layer draws it: instantly warm, styled, and live — the label re-reads
 * itself when the attribute changes, so "Copy" can become "Copied" mid-hover.
 *
 * Screen readers are already served by each control's aria-label; the layer is
 * aria-hidden so nothing is announced twice.
 */
export function TooltipLayer() {
  const el = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const tip = el.current
    if (!tip) return
    /** The control being pointed at — armed (delay running) or already shown. */
    let current: HTMLElement | null = null
    let shown = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let hiddenAt = -Infinity
    let watcher: MutationObserver | null = null

    const place = () => {
      if (!current) return
      const text = current.getAttribute('data-tip')
      if (!text) {
        hide()
        return
      }
      tip.textContent = text
      const r = current.getBoundingClientRect()
      const w = tip.offsetWidth
      const h = tip.offsetHeight
      const x = Math.max(8, Math.min(r.left + r.width / 2 - w / 2, window.innerWidth - w - 8))
      const above = r.top - h - 7
      const y = above < 8 ? r.bottom + 7 : above
      tip.style.left = `${Math.round(x)}px`
      tip.style.top = `${Math.round(y)}px`
    }

    const show = () => {
      if (!current) return
      shown = true
      watcher?.disconnect()
      watcher = new MutationObserver(place)
      watcher.observe(current, { attributes: true, attributeFilter: ['data-tip'] })
      place()
      if (shown) tip.classList.add('tip-on')
    }

    const hide = () => {
      if (timer !== undefined) clearTimeout(timer)
      timer = undefined
      watcher?.disconnect()
      watcher = null
      if (shown) hiddenAt = performance.now()
      shown = false
      current = null
      tip.classList.remove('tip-on')
    }

    const arm = (next: HTMLElement, instant: boolean) => {
      if (next === current) return
      const warm = shown || performance.now() - hiddenAt < WARM_GAP
      hide()
      current = next
      if (instant || warm) show()
      else timer = setTimeout(show, SHOW_DELAY)
    }

    const onOver = (e: Event) => {
      const next = (e.target as Element).closest?.('[data-tip]')
      if (next instanceof HTMLElement) arm(next, false)
      else hide()
    }
    const onFocusIn = (e: Event) => {
      const next = (e.target as Element).closest?.('[data-tip]')
      if (next instanceof HTMLElement && next.matches(':focus-visible')) arm(next, true)
      else hide()
    }
    // A click can re-anchor or unmount the control (delete, collapse); re-check
    // once React has re-rendered. Attribute swaps are the watcher's job.
    const onClick = () => {
      requestAnimationFrame(() => {
        if (current && !current.isConnected) hide()
        else place()
      })
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') hide()
    }

    document.addEventListener('pointerover', onOver, true)
    document.addEventListener('focusin', onFocusIn, true)
    document.addEventListener('focusout', hide, true)
    document.addEventListener('click', onClick, true)
    document.addEventListener('scroll', hide, true)
    document.addEventListener('keydown', onKey, true)
    window.addEventListener('resize', hide)
    return () => {
      hide()
      document.removeEventListener('pointerover', onOver, true)
      document.removeEventListener('focusin', onFocusIn, true)
      document.removeEventListener('focusout', hide, true)
      document.removeEventListener('click', onClick, true)
      document.removeEventListener('scroll', hide, true)
      document.removeEventListener('keydown', onKey, true)
      window.removeEventListener('resize', hide)
    }
  }, [])

  return <div ref={el} className="tip" aria-hidden="true" />
}
