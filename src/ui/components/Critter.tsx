import { type RefObject, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
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
 * It lives in the chip. The chip's face is the critter's own, so home is that
 * seat: it hops out onto the header's floor when the reviewer pauses or the
 * agent gets to work — or the cursor touches the chip — and hops back in — shrinking into the face — when they
 * start typing, when the agent finishes a batch, and while nobody is attached.
 * While it is out, the chip keeps a faint face in the seat. Scrolling or moving
 * the mouse only calms it where it stands: reading is when it keeps you company.
 *
 * What it does when is decided here (an act, a spot, a timer); how each act
 * looks is CSS under "the critter". Reduced motion, or a header with no room
 * to walk, keeps it home.
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
/** px per second when it hurries home, and how long a hop between floor and seat takes. */
const HURRY = 110
const HOP_MS = 560
/** Below this much floor (px) there is nowhere to walk, so it stays home. */
const ROOM = 64
/** The body's box inside the walking figure, in px at SIZE: x, y and width. The
 * chip's face is that box alone, so these line the two up for the hop. */
const BODY_X = (SIZE * 3) / 24
const BODY_Y = (SIZE * 3.5) / 24
const BODY_W = (SIZE * 18) / 24

/** The eyes, shared by the walking critter and the chip's face. Open is two
 * rects; the rest are strokes. */
const EYES = {
  shut: 'M7.8 10.4h2.4M13.8 10.4h2.4',
  plus: 'M7.8 10.2h2.4M9 9v2.4M13.8 10.2h2.4M15 9v2.4',
  happy: 'M7.8 11l1.2-1.4 1.2 1.4M13.8 11l1.2-1.4 1.2 1.4',
} as const

export type CritterEyes = keyof typeof EYES | 'open'

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

/** Where the walker stands: a translate in px from its parked box, and a scale. */
interface Spot {
  x: number
  y: number
  s: number
}

const spotTransform = (p: Spot) => `translate(${p.x}px, ${p.y}px) scale(${p.s})`

/** The header's flexible gap, with the critter roaming inside it. Stands in for
 * the header's `grow` spacer, so the layout around it is unchanged. `seat` is
 * the chip's face, its home; `onAway` tells the chip when the seat is empty. */
export function CritterTrack({
  presence,
  reason,
  seat,
  onAway,
  summon = 0,
}: {
  presence: Presence
  reason?: PresenceReason
  seat?: RefObject<HTMLElement | null>
  onAway?: (away: boolean) => void
  /** Bumped when the cursor touches the chip: it comes out to say hello. */
  summon?: number
}) {
  const track = useRef<HTMLSpanElement>(null)
  const walker = useRef<HTMLSpanElement>(null)
  // Home is the seat in the chip; away is out on the floor. It starts home.
  const [away, setAwayState] = useState(false)
  const awayRef = useRef(false)
  const onAwayRef = useRef(onAway)
  onAwayRef.current = onAway
  const setAway = useCallback((v: boolean) => {
    awayRef.current = v
    setAwayState(v)
    onAwayRef.current?.(v)
  }, [])
  // Legs and glasses fold away for the hop, so what lands in the seat is the face.
  const [tucked, setTucked] = useState(false)
  // The hop in flight, run by the Web Animations API; and whether it heads home.
  const hop = useRef<{ anim: Animation; home: boolean } | null>(null)
  // After a finished batch it rests at home a while before wandering again.
  const restUntil = useRef(0)
  const homeAfter = useRef(false)
  const lastSummon = useRef(summon)
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
  // Typing sends it home; scrolling or a moving mouse only calms it in place.
  const [homeward, setHomeward] = useState(false)

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const busy = (e: Event) => {
      if (!calmRef.current) setCalm(true)
      if (e.type === 'keydown') setHomeward(true)
      clearTimeout(timer)
      timer = setTimeout(() => {
        setCalm(false)
        setHomeward(false)
      }, CALM_MS)
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
  const maxRef = useRef(max)
  maxRef.current = max
  const measured = width > 0
  const stayHome = presence === 'waiting' || max < ROOM || reducedMotion()

  // Gone from the header (switched off, or no presence): the seat is never left empty.
  useEffect(() => () => onAwayRef.current?.(false), [])

  // Home again: the walker is hidden now, so the hop that held it in the seat can let go.
  useLayoutEffect(() => {
    if (!away && hop.current) {
      hop.current.anim.cancel()
      hop.current = null
    }
  }, [away])

  useEffect(() => {
    if (!measured) return
    // Read live, so a header reflow (the chip's label changing) never restarts the act.
    const end = () => maxRef.current
    let timer: ReturnType<typeof setTimeout> | undefined
    let alive = true
    const at = () => Math.min(xRef.current ?? end(), end())
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

    // The seat, in the walker's own coordinates: the translate and scale that
    // land the figure's body exactly on the chip's face.
    const seatSpot = (): Spot | null => {
      const face = seat?.current ? seat.current.getBoundingClientRect() : undefined
      const t = track.current?.getBoundingClientRect()
      const w = walker.current
      if (!face?.width || !t || !w) return null
      const k = face.width / BODY_W
      return {
        x: face.left - t.left - BODY_X * k,
        y: face.top + face.height / 30 - t.top - w.offsetTop - BODY_Y * k,
        s: k,
      }
    }
    const leap = (from: Spot, to: Spot, home: boolean, then: () => void) => {
      const el = walker.current
      if (!el || typeof el.animate !== 'function') {
        then()
        return
      }
      const top = { x: (from.x + to.x) / 2, y: Math.min(from.y, to.y) - 16, s: (from.s + to.s) / 2 }
      const anim = el.animate(
        [from, top, to].map((p) => ({ transform: spotTransform(p) })),
        { duration: HOP_MS, easing: 'cubic-bezier(0.3, 0.7, 0.4, 1)', fill: 'forwards' },
      )
      hop.current = { anim, home }
      after(HOP_MS, then)
    }
    const arrive = () => {
      setTucked(false)
      setAway(false)
    }
    // Walks to the chip's edge, hops up and shrinks into the face.
    const goHome = (then?: () => void) => {
      walk(end(), HURRY, () => {
        const to = seatSpot()
        if (!to) {
          arrive()
          then?.()
          return
        }
        setAct('stand')
        setTucked(true)
        leap({ x: at(), y: 0, s: 1 }, to, true, () => {
          arrive()
          then?.()
        })
      })
    }
    // Out of the face and down onto the floor beside the chip.
    const hopOut = (then: () => void) => {
      const from = seatSpot()
      setX(end())
      setAct('stand')
      setTucked(true)
      setAway(true)
      if (!from) {
        setTucked(false)
        then()
        return
      }
      leap(from, { x: end(), y: 0, s: 1 }, false, () => {
        hop.current?.anim.cancel()
        hop.current = null
        setTucked(false)
        then()
      })
    }
    const routine = () => {
      if (presence === 'working') {
        // Somewhere worth the walk: across the header, not a step aside.
        const spot = () =>
          at() > end() / 2 ? between(0, end() * 0.4) : between(end() * 0.6, end())
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
        // Starts on the job where it lands: the work is the news, not the walk.
        doing(task(), between(1500, 3000), shift)
      } else {
        const idle = () => {
          const r = Math.random()
          // Busy reviewer: no strolls or sudden sits. Read along, or stand still
          // and watch — standing is what lets its eyes follow the moving cursor.
          if (calmRef.current) doing(r < 0.5 ? 'stand' : 'read', between(3000, 6000), idle)
          else if (r < 0.3) doing('read', between(4000, 8000), idle)
          else if (r < 0.5) doing('stand', between(3000, 6000), idle)
          else if (r < 0.75) walk(between(0, end()), STROLL, idle)
          else if (r < 0.9) doing('sit', between(4000, 8000), idle)
          else doing('think', between(2000, 3500), idle)
        }
        doing('read', between(3000, 5000), idle)
      }
    }
    // Home, and free to wander: out after a beat — at once when there is work —
    // and a little longer after a finished batch.
    const venture = () =>
      after(
        Math.max(
          presence === 'working' ? between(300, 700) : between(1000, 2500),
          restUntil.current - Date.now(),
        ),
        () => hopOut(routine),
      )

    // The cursor on the chip: out of the seat with a happy hop, or — already
    // out — the hop where it stands.
    const summoned = summon !== lastSummon.current
    lastSummon.current = summon

    if (summoned && !flourish && !stayHome && !awayRef.current) {
      hopOut(() => setFlourish('poke'))
    } else if (summoned && !flourish && awayRef.current) {
      setFlourish('poke')
    } else if (flourish && awayRef.current) {
      doing(flourish, flourish === 'poke' ? POKE_MS : APPROVE_MS, () => {
        // A finished batch: the job is done, so it goes home to say so.
        if (flourish === 'approve') homeAfter.current = true
        setFlourish(null)
      })
    } else if (flourish) {
      // At home the chip's own face does the cheering.
      setFlourish(null)
    } else if (stayHome) {
      if (awayRef.current && !reducedMotion()) goHome()
      else if (awayRef.current) arrive()
      setAct(presence === 'waiting' ? 'sleep' : 'stand')
    } else if (awayRef.current && (homeward || homeAfter.current)) {
      const rest = homeAfter.current
      homeAfter.current = false
      if (rest) restUntil.current = Date.now() + between(4000, 6000)
      goHome(homeward ? undefined : venture)
    } else if (!awayRef.current) {
      setAct('stand')
      if (!homeward) venture()
    } else {
      routine()
    }
    return () => {
      alive = false
      clearTimeout(timer)
      // Interrupted mid-hop: land it — in the seat if it was headed home.
      if (hop.current) {
        const { anim, home } = hop.current
        anim.cancel()
        hop.current = null
        setTucked(false)
        if (home) setAway(false)
        setMove(null)
        return
      }
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
  }, [presence, measured, flourish, homeward, stayHome, seat, setAway, summon])

  const onPoke = () => {
    if (!flourish && !reducedMotion()) setFlourish('poke')
  }

  // Unmeasured or at home, it is hidden — the chip's face stands in for it. Out,
  // it starts parked by the chip, so the first walk has a position to move from.
  const style = {
    transform: spotTransform({ x: Math.min(x ?? max, max), y: 0, s: 1 }),
    transition: move ? `transform ${move.ms}ms linear` : 'none',
    visibility: width && away ? undefined : ('hidden' as const),
  }
  return (
    <span className="critter-track" ref={track}>
      <span
        ref={walker}
        className={`critter-walker${move ? ` critter-moving critter-${move.dir}` : ''}${calm ? ' critter-calm' : ''}${tucked ? ' critter-tucked' : ''}`}
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
            <path className="critter-eyes critter-eyes-shut" d={EYES.shut} />
            <g className="critter-eyes-open">
              <rect x="8.1" y="8.6" width="1.8" height="3.1" rx="0.9" />
              <rect x="14.1" y="8.6" width="1.8" height="3.1" rx="0.9" />
            </g>
            <path className="critter-eyes critter-eyes-plus" d={EYES.plus} />
            <path className="critter-eyes critter-eyes-happy" d={EYES.happy} />
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

/** The critter's face alone — the body with its eyes, cropped to the body — so
 * the chip can wear it. The walking critter lands exactly on top of it. */
export function CritterFace({ eyes }: { eyes: CritterEyes }) {
  return (
    <svg
      className="critter-face"
      width="18"
      height="15"
      viewBox="3 3 18 15"
      aria-hidden="true"
      focusable="false"
    >
      <rect x="3" y="3.5" width="18" height="14" rx="4" />
      {eyes === 'open' ? (
        <g className="critter-face-open">
          <rect x="8.1" y="8.6" width="1.8" height="3.1" rx="0.9" />
          <rect x="14.1" y="8.6" width="1.8" height="3.1" rx="0.9" />
        </g>
      ) : (
        <path className="critter-face-eyes" d={EYES[eyes]} />
      )}
    </svg>
  )
}
