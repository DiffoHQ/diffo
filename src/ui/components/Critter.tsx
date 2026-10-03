import { useEffect, useRef, useState } from 'react'
import type { Presence, PresenceReason } from '../api.js'

/*
 * Diffo's critter: a small block on two legs, in reading glasses, that lives in
 * the header's empty stretch and acts out what the agent is doing. A reviewer,
 * like the person it keeps company. It is decoration — the chip stays the source
 * of truth, so the critter is aria-hidden and says nothing the label doesn't.
 *
 * The face is the diff's own signs, cut out of the body in the page colour, and
 * the presence picks what it gets up to:
 *
 *   waiting   — grey, glasses off, asleep where it stood: eyes − −, a "z"
 *   listening — green, keeping you company: reads a little diff page line by
 *               line, stands and watches your cursor, strolls, sits, thinks
 *   working   — amber like the chip: walks to a spot and gets on with it,
 *               sweeping a magnifier over the code or writing the fix (eyes + +,
 *               +s rising), pausing to think, then moving on
 *
 * When the agent replies, it hops and a ✓ pops overhead. Touch it with the
 * cursor and it hops, happy, then gets back to it.
 *
 * It keeps out of the way: while the reviewer is busy (scrolling, typing,
 * moving the mouse) it stays where it is and settles into the quietest version
 * of what it's doing, and only wanders again once they pause.
 *
 * What it does when is decided here (an act, a spot, a timer); how each act
 * looks is CSS under "the critter". Reduced motion parks it by the chip.
 */

const SIZE = 30
/** px per second: an amble while listening, a hurry while working. */
const STROLL = 22
const PACE = 48
const POKE_MS = 1100
const APPROVE_MS = 1500
/** How far the eyes travel toward the cursor, in viewBox units. */
const LOOK = 1.1
/** How long after the reviewer's last scroll, key or mouse move it stays calm. */
const CALM_MS = 3000

export type CritterAct =
  | 'sleep'
  | 'sit'
  | 'stand'
  | 'walk'
  | 'read'
  | 'inspect'
  | 'write'
  | 'think'
  | 'poke'
  | 'approve'

/** Acts with nothing better to look at, so the eyes follow the cursor. */
const WATCHING: ReadonlySet<CritterAct> = new Set(['stand', 'sit'])

function reducedMotion(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
}

const between = (lo: number, hi: number) => lo + Math.random() * (hi - lo)

/** The header's flexible gap, with the critter roaming inside it. Stands in for
 * the header's `grow` spacer, so the layout around it is unchanged. */
export function CritterTrack({
  presence,
  reason,
}: {
  presence: Presence
  reason?: PresenceReason
}) {
  const track = useRef<HTMLSpanElement>(null)
  const walker = useRef<HTMLSpanElement>(null)
  const [width, setWidth] = useState(0)
  // x is the left edge, in px from the track's start; null means parked at
  // the far end, beside the chip, where it starts.
  const [x, setX] = useState<number | null>(null)
  const [move, setMove] = useState<{ ms: number; dir: 'left' | 'right' } | null>(null)
  const [act, setAct] = useState<CritterAct>('stand')
  // A one-shot that interrupts whatever it was doing, then hands back.
  const [flourish, setFlourish] = useState<'poke' | 'approve' | null>(null)
  const xRef = useRef<number | null>(null)
  xRef.current = x
  // Calm while the reviewer is busy. State drives the CSS (re-rendering only
  // when it flips, not per event); the ref lets the scheduler read it live.
  const [calm, setCalm] = useState(false)
  const calmRef = useRef(false)
  calmRef.current = calm

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const busy = () => {
      if (!calmRef.current) setCalm(true)
      clearTimeout(timer)
      timer = setTimeout(() => setCalm(false), CALM_MS)
    }
    const opts = { capture: true, passive: true }
    const events = ['pointermove', 'wheel', 'scroll', 'keydown'] as const
    for (const name of events) addEventListener(name, busy, opts)
    return () => {
      clearTimeout(timer)
      for (const name of events) removeEventListener(name, busy, opts)
    }
  }, [])

  useEffect(() => {
    const el = track.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(([entry]) => entry && setWidth(entry.contentRect.width))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // The agent just answered: celebrate it, whatever it was up to.
  const lastReason = useRef(reason)
  useEffect(() => {
    if (reason === 'replied' && lastReason.current !== 'replied' && !reducedMotion()) {
      setFlourish('approve')
    }
    lastReason.current = reason
  }, [reason])

  // Eyes follow the cursor while it idles. Written straight to the DOM, once
  // a frame at most: a re-render per mouse move would be absurd for this.
  const watching = WATCHING.has(act) && !flourish
  useEffect(() => {
    const el = walker.current
    const look = el?.querySelector<SVGGElement>('.critter-look')
    if (!el || !look) return
    if (!watching || reducedMotion()) {
      look.style.transform = ''
      return
    }
    let frame = 0
    const onMove = (e: PointerEvent) => {
      if (frame) return
      frame = requestAnimationFrame(() => {
        frame = 0
        const r = el.getBoundingClientRect()
        const dx = e.clientX - (r.left + r.width / 2)
        const dy = e.clientY - (r.top + r.height * 0.4)
        const d = Math.hypot(dx, dy) || 1
        look.style.transform = `translate(${(dx / d) * LOOK}px, ${(dy / d) * LOOK * 0.8}px)`
      })
    }
    addEventListener('pointermove', onMove)
    return () => {
      removeEventListener('pointermove', onMove)
      cancelAnimationFrame(frame)
      look.style.transform = ''
    }
  }, [watching])

  const max = Math.max(0, width - SIZE)

  useEffect(() => {
    if (!width) return
    let timer: ReturnType<typeof setTimeout> | undefined
    let alive = true
    const at = () => Math.min(xRef.current ?? max, max)
    const after = (ms: number, then: () => void) => {
      timer = setTimeout(() => alive && then(), ms)
    }
    const doing = (a: CritterAct, ms: number, then: () => void) => {
      setAct(a)
      after(ms, then)
    }
    const walk = (to: number, speed: number, then: () => void) => {
      const from = at()
      const ms = (Math.abs(to - from) / speed) * 1000
      if (ms < 150) {
        then()
        return
      }
      setAct('walk')
      setMove({ ms, dir: to < from ? 'left' : 'right' })
      setX(to)
      after(ms, () => {
        setMove(null)
        then()
      })
    }

    if (flourish) {
      doing(flourish, flourish === 'poke' ? POKE_MS : APPROVE_MS, () => setFlourish(null))
    } else if (reducedMotion()) {
      setX(max)
      setAct(presence === 'waiting' ? 'sleep' : 'stand')
    } else if (presence === 'waiting') {
      setAct('sleep')
    } else if (presence === 'working') {
      // Somewhere worth the walk: across the header, not a step aside.
      const spot = () => (at() > max / 2 ? between(0, max * 0.4) : between(max * 0.6, max))
      const task = (): CritterAct => (Math.random() < 0.5 ? 'inspect' : 'write')
      // Busy reviewer: carry on working where it stands rather than cross the header.
      const shift = (): void =>
        calmRef.current
          ? doing(task(), between(2500, 4000), shift)
          : walk(spot(), PACE, () =>
              doing(task(), between(2500, 5000), () =>
                Math.random() < 0.4 ? doing('think', between(1500, 2800), shift) : shift(),
              ),
            )
      // Starts on the job where it stands: the work is the news, not the walk.
      doing(task(), between(1500, 3000), shift)
    } else {
      const idle = () => {
        const r = Math.random()
        // Busy reviewer: no strolls or sudden sits. Read along, or stand still
        // and watch — standing is what lets its eyes follow the moving cursor.
        if (calmRef.current) doing(r < 0.5 ? 'stand' : 'read', between(3000, 6000), idle)
        else if (r < 0.3) doing('read', between(4000, 8000), idle)
        else if (r < 0.5) doing('stand', between(3000, 6000), idle)
        else if (r < 0.75) walk(between(0, max), STROLL, idle)
        else if (r < 0.9) doing('sit', between(4000, 8000), idle)
        else doing('think', between(2000, 3500), idle)
      }
      doing('read', between(3000, 5000), idle)
    }
    return () => {
      alive = false
      clearTimeout(timer)
      // Interrupted mid-walk: stop where it actually is, not where it was headed.
      const el = walker.current
      if (el) {
        try {
          setX(new DOMMatrixReadOnly(getComputedStyle(el).transform).m41)
        } catch {
          // nothing to read; it lands where it was headed
        }
      }
      setMove(null)
    }
  }, [presence, width, max, flourish])

  const onPoke = () => {
    if (!flourish && !reducedMotion()) setFlourish('poke')
  }

  // Unmeasured, it is hidden; measured, it renders parked by the chip first, so
  // the first walk has a position to transition from.
  const style = {
    transform: `translateX(${Math.min(x ?? max, max)}px)`,
    transition: move ? `transform ${move.ms}ms linear` : 'none',
    visibility: width ? undefined : ('hidden' as const),
  }
  return (
    <span className="critter-track" ref={track}>
      <span
        ref={walker}
        className={`critter-walker${move ? ` critter-moving critter-${move.dir}` : ''}${calm ? ' critter-calm' : ''}`}
        style={style}
        onPointerEnter={onPoke}
      >
        <Critter presence={presence} act={act} />
      </span>
    </span>
  )
}

export function Critter({
  presence,
  act = presence === 'waiting' ? 'sleep' : 'stand',
  size = SIZE,
}: {
  presence: Presence
  act?: CritterAct
  size?: number
}) {
  return (
    <svg
      className={`critter critter-${presence} critter-act-${act}`}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      aria-hidden="true"
      focusable="false"
    >
      <g className="critter-figure">
        <rect className="critter-leg critter-leg-l" x="7" y="16.5" width="3" height="4.5" rx="1" />
        <rect className="critter-leg critter-leg-r" x="14" y="16.5" width="3" height="4.5" rx="1" />
        <g className="critter-torso">
          <rect className="critter-body" x="3" y="3.5" width="18" height="14" rx="4" />
          <g className="critter-look">
            <path className="critter-eyes critter-eyes-shut" d="M7.8 10.4h2.4M13.8 10.4h2.4" />
            <g className="critter-eyes-open">
              <rect x="8.1" y="8.6" width="1.8" height="3.1" rx="0.9" />
              <rect x="14.1" y="8.6" width="1.8" height="3.1" rx="0.9" />
            </g>
            <path
              className="critter-eyes critter-eyes-plus"
              d="M7.8 10.2h2.4M9 9v2.4M13.8 10.2h2.4M15 9v2.4"
            />
            <path
              className="critter-eyes critter-eyes-happy"
              d="M7.8 11l1.2-1.4 1.2 1.4M13.8 11l1.2-1.4 1.2 1.4"
            />
          </g>
          {/* thin rims wide of the eyes, touching at the bridge: the eyes stay the
              face, the glasses a hint around them */}
          <g className="critter-glasses">
            <circle cx="9" cy="10.2" r="3" />
            <circle cx="15" cy="10.2" r="3" />
          </g>
        </g>
        {/* reading and writing: a little diff page, held in both hands */}
        <g className="critter-page">
          <rect x="6.2" y="13.2" width="11.6" height="7" rx="1" />
          <path className="critter-line-del" d="M8 15.1h4" />
          <path className="critter-line-ctx" d="M8 16.7h6.5" />
          <path className="critter-line-add" pathLength="1" d="M8 18.3h5.5" />
        </g>
        <g className="critter-hands">
          <circle cx="6.2" cy="17" r="1.4" />
          <circle cx="17.8" cy="17" r="1.4" />
        </g>
        <g className="critter-pen">
          <path d="M14.6 19l3.4-3.6" />
          <circle cx="18.3" cy="15.3" r="1.4" />
        </g>
        {/* inspecting: a magnifier, swept over the code */}
        <g className="critter-mag">
          <circle className="critter-lens" cx="21.6" cy="13.4" r="3" />
          <path d="M23.7 15.6l2 2" />
          <circle className="critter-mag-hand" cx="25.8" cy="17.7" r="1.4" />
        </g>
      </g>
      {/* asleep: two z's, a small one and a bigger one, drifting up in turn */}
      <g className="critter-z">
        <path className="critter-z-a" d="M17.5 0.5h3l-3 3h3" />
        <path className="critter-z-b" d="M21.5 -4.5h4l-4 4h4" />
      </g>
      <g className="critter-thought">
        <circle cx="20.5" cy="2.6" r="0.9" />
        <circle cx="22.6" cy="0.2" r="1.15" />
        <circle cx="25.2" cy="-2.6" r="1.4" />
      </g>
      <path className="critter-spark critter-spark-a" d="M19.5 1.5h2.4M20.7 0.3v2.4" />
      <path className="critter-spark critter-spark-b" d="M2.5 2.5h2.4M3.7 1.3v2.4" />
      <g className="critter-badge">
        <circle cx="12" cy="-2.5" r="3" />
        <path d="M10.6 -2.5l1 1 1.9-2" />
      </g>
    </svg>
  )
}
