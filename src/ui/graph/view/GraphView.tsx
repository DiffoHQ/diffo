import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReviewThread } from '../../../shared/review.js'
import type { DiffLine, FileChange, Hunk } from '../../../shared/types.js'
import type { ReviewComments } from '../../components/ReadingPane.js'
import { changedLineMarks } from '../../fileMarks.js'
import type { CanvasBox, CanvasCard, CanvasGraph } from '../model.js'
import { Card, type Direction, type Link } from './Card.js'
import { COLOR_RGB, diffRgb, mostlyRemoved } from './colors.js'
import {
  ARROW_RGB,
  CARD_WIDTH,
  GLIDE_MS,
  HEADER,
  LAYOUT_MARGIN,
  MAX_ZOOM,
  MIN_ZOOM,
  NO_HUNKS,
  NO_THREADS,
  OVERLAY_KEY,
  RESIZE_MOST,
  type View,
} from './constants.js'
import {
  FAR_CARD_NAMES,
  FAR_MOUNT,
  FAR_ZOOM,
  type FarItem,
  farByKey as farByKeyOf,
  farLabels,
  farSize,
  farTree as farTreeOf,
  NO_KEYS,
  readingOrder,
} from './far.js'
import type { RealmLayout } from './layout.js'
import { cardWidth, useCharWidth } from './names.js'
import { resizeInPlace } from './resize.js'
import { layoutRouted, type Point } from './routed.js'
import { callOffset, edgeKey, isStacked, routePath } from './routes.js'

/** The layout has one column for all the cards. */
const COLUMN = ''
const COLUMNS = [COLUMN] as const

type Placed = RealmLayout<string> & { routes?: Map<string, Point[]> }

/** The color that the agent gave to the box with a title, or undefined. */
function colorOf(boxes: readonly CanvasBox[], title: string): string | undefined {
  for (const box of boxes) {
    if (box.title === title && box.color) return COLOR_RGB[box.color]
    const inner = colorOf(box.boxes, title)
    if (inner) return inner
  }
  return undefined
}

/**
 * The canvas of a graph: cards of code, boxes around them, and arrows from
 * one card to another. The reviewer moves in it: zoom, names from far, a
 * breadcrumb, keys from card to card. It draws the data of `model.ts`, and it
 * does not know what made that data.
 */
export function GraphCanvas({
  graph,
  viewed,
  onSetMarks,
  comments,
  hunkById,
  fileByPath,
  onOpenHunk,
  inert = false,
}: {
  graph: CanvasGraph
  /** A picture of the graph only: no keys. The page keeps its own keys, and
   * a click on the picture is for what holds it. */
  inert?: boolean
  /** The marks of the code that the reviewer read: the same ones as the list. */
  viewed?: ReadonlySet<string>
  /** Sets or clears marks of read code. With it, a card of changed code has
   * a Viewed button. */
  onSetMarks?: (marks: string[], on: boolean) => void
  /** The threads of the review and the actions on them, as in the list. */
  comments?: ReviewComments
  hunkById: ReadonlyMap<string, Hunk>
  fileByPath: ReadonlyMap<string, FileChange>
  /** Go to a hunk in the list view. */
  onOpenHunk: (hunkId: string) => void
}) {
  const { cards, arrows } = graph
  const [heights, setHeights] = useState<ReadonlyMap<string, number>>(new Map())
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set())
  const [view, setView] = useState<View>({ x: 0, y: 0, k: 1 })
  const [selected, setSelected] = useState<string | null>(null)
  const canvas = useRef<HTMLDivElement>(null)
  /** The reviewer moved the view: it does not fit by itself any more. */
  const fitted = useRef(false)

  const char = useCharWidth()
  // The same arrays and the same function for a card from one render to the
  // next, so the card is not drawn again.
  const byHunk = comments?.partition.byHunk
  const threadsOf = useMemo(
    () =>
      new Map(cards.map((c) => [c.id, c.hunkIds.flatMap((id) => byHunk?.get(id) ?? NO_THREADS)])),
    [cards, byHunk],
  )
  // A thread on a file, not on a line, is on one card of the file: the card
  // of changed code with the first lines.
  const byFile = comments?.partition.byFile
  const fileThreadsOf = useMemo(() => {
    const out = new Map<string, ReviewThread[]>()
    if (!byFile) return out
    const first = new Map<string, CanvasCard>()
    const top = (c: CanvasCard) => c.lines.find((l) => l.newNo !== null)?.newNo ?? 0
    for (const c of cards) {
      if (c.hunkIds.length === 0) continue
      const now = first.get(c.path)
      if (!now || top(c) < top(now)) first.set(c.path, c)
    }
    for (const [path, card] of first) {
      const threads = byFile.get(path)
      if (threads && threads.length > 0) out.set(card.id, threads)
    }
    return out
  }, [cards, byFile])
  const hunksOf = useMemo(
    () => new Map(cards.map((c) => [c.id, c.hunkIds.flatMap((id) => hunkById.get(id) ?? [])])),
    [cards, hunkById],
  )
  // The marks of the changed lines of each card: the marks of lines that
  // the list uses for a part of a hunk. A card can have a part of a hunk,
  // and a hunk can have lines of two cards, so a card is read line by line.
  const marksOf = useMemo(() => {
    const lineKey = (l: DiffLine) => `${l.kind}:${l.oldNo}:${l.newNo}`
    const all = new Map<string, string[]>()
    for (const c of cards) {
      const own = new Set(c.lines.filter((l) => l.kind !== 'context').map(lineKey))
      const marks = (hunksOf.get(c.id) ?? []).flatMap((hunk) => {
        const rows = new Set<number>()
        for (const [i, line] of hunk.lines.entries()) if (own.has(lineKey(line))) rows.add(i)
        return changedLineMarks(hunk, rows)
      })
      if (marks.length > 0) all.set(c.id, marks)
    }
    return all
  }, [cards, hunksOf])
  const viewedOf = (id: string): boolean | null => {
    const marks = marksOf.get(id)
    if (marks === undefined || onSetMarks === undefined) return null
    return marks.every((m) => viewed?.has(m) ?? false)
  }
  const onViewed = useCallback(
    (id: string) => {
      const marks = marksOf.get(id)
      if (marks === undefined) return
      onSetMarks?.(marks, !marks.every((m) => viewed?.has(m) ?? false))
    },
    [marksOf, viewed, onSetMarks],
  )
  const openHunk = useRef(onOpenHunk)
  openHunk.current = onOpenHunk
  const onOpen = useCallback((id: string) => openHunk.current(id), [])
  // Where the lines of each card are, for the ends of the arrows.
  const [tops, setTops] = useState<ReadonlyMap<string, [number, number][]>>(new Map())
  // The overlay: from far, names on the cards and on the closed boxes, and
  // the levels. On until the reviewer turns it off. A click in a box fits
  // the box with or without the overlay; with it, the click also opens one
  // level.
  const [overlay, setOverlay] = useState(() => {
    try {
      return localStorage.getItem(OVERLAY_KEY) !== '0'
    } catch {
      return true
    }
  })
  const onOverlay = () => {
    setOverlay((on) => {
      try {
        localStorage.setItem(OVERLAY_KEY, on ? '0' : '1')
      } catch {
        // The choice is for this page only.
      }
      return !on
    })
  }
  // The cards that show their threads, and the switch for all the cards. On
  // at the start: a comment is a part of the review, so it is in the view.
  const [allThreads, setAllThreads] = useState(true)
  const [threadsOn, setThreadsOn] = useState<ReadonlySet<string>>(new Set())
  const onThreads = useCallback((id: string, on?: boolean) => {
    setThreadsOn((prev) => {
      const next = new Set(prev)
      if (on ?? !next.has(id)) next.add(id)
      else next.delete(id)
      return next
    })
  }, [])
  const onHeight = useCallback((id: string, height: number, lineTops: [number, number][]) => {
    // A change of the place of a line draws the arrows again, also when the
    // height of the card is the same.
    setTops((prev) => {
      const old = prev.get(id)
      const same =
        old !== undefined &&
        old.length === lineTops.length &&
        old.every((t, i) => t[0] === lineTops[i]?.[0] && t[1] === lineTops[i]?.[1])
      return same ? prev : new Map(prev).set(id, lineTops)
    })
    setHeights((prev) => (prev.get(id) === height ? prev : new Map(prev).set(id, height)))
  }, [])
  const onToggle = useCallback((id: string) => {
    setOpen((prev) => {
      const next = new Set(prev)
      if (!next.delete(id)) next.add(id)
      return next
    })
  }, [])

  const measured = cards.every((c) => heights.has(c.id))
  // The layout is from the ELK engine: it puts the cards in an order that
  // makes the arrows cross as little as possible, and it gives a route for
  // each arrow around the cards. It is not immediate, so it is state.
  const [layout, setLayout] = useState<Placed | null>(null)
  const [layoutError, setLayoutError] = useState<string | null>(null)
  // The last layout, with what it was made from.
  const placed = useRef<{ shape: string; layout: Placed; heights: Map<string, number> } | null>(
    null,
  )
  useEffect(() => {
    if (!measured) {
      placed.current = null
      setLayout(null)
      return
    }
    let cancelled = false
    const boxes = cards.map((c) => ({
      id: c.id,
      realm: COLUMN,
      path: c.box,
      width: cardWidth(c, char),
      height: heights.get(c.id) ?? 0,
    }))
    const edges = arrows.map((a) => ({
      key: edgeKey(a),
      from: a.from,
      to: a.to,
      // An arrow leaves its card at its line, and it enters the target at
      // its header.
      fromY: callOffset(a.line, tops.get(a.from)),
      toY: HEADER / 2,
    }))
    // The same cards, boxes and arrows as the last layout, and only a few
    // cards with a new height (the reviewer shows more lines of a card):
    // each card keeps its place, and the cards below the new height move.
    // A new run of the engine would put the cards in new places.
    const shape = JSON.stringify([
      boxes.map((c) => [c.id, c.path, c.width]),
      edges.map((e) => e.key),
    ])
    const last = placed.current
    const sizes = () => new Map(boxes.map((c) => [c.id, c.height]))
    if (last !== null && last.shape === shape) {
      const changed = new Map(
        boxes.filter((c) => last.heights.get(c.id) !== c.height).map((c) => [c.id, c.height]),
      )
      if (changed.size === 0) return
      if (changed.size <= RESIZE_MOST) {
        const next = resizeInPlace(last.layout, changed, edges, LAYOUT_MARGIN)
        placed.current = { shape, layout: next, heights: sizes() }
        // The view stays where it is: the reviewer reads the card.
        fitted.current = true
        setLayout(next)
        return
      }
    }
    layoutRouted(COLUMNS, boxes, edges, true)
      .then((next) => {
        if (cancelled) return
        placed.current = { shape, layout: next, heights: sizes() }
        setLayoutError(null)
        setLayout(next)
      })
      // No second layout: the reviewer sees that the layout failed.
      .catch((err: unknown) => {
        if (!cancelled) setLayoutError(err instanceof Error ? err.message : String(err))
      })
    return () => {
      cancelled = true
    }
  }, [cards, arrows, heights, measured, char, tops])

  // A fit moves the view in steps, one on each frame, as a wheel zoom does.
  // It is not a transition of the stylesheet: for a transition, the browser
  // puts the full graph in a layer of its own at the start and takes it out
  // at the end, and it then draws the page again, the parts that are not the
  // graph too. That made the full page flicker on each fit.
  const viewRef = useRef(view)
  viewRef.current = view
  const gliding = useRef<number | null>(null)
  const stopGlide = useCallback(() => {
    if (gliding.current !== null) cancelAnimationFrame(gliding.current)
    gliding.current = null
  }, [])
  useEffect(() => stopGlide, [stopGlide])
  const glideTo = useCallback(
    (to: View) => {
      stopGlide()
      if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
        setView(to)
        return
      }
      const from = viewRef.current
      const start = performance.now()
      const step = (now: number) => {
        const t = Math.min(1, (now - start) / GLIDE_MS)
        // Fast at the start, slow at the end.
        const e = 1 - (1 - t) ** 3
        setView({
          x: from.x + (to.x - from.x) * e,
          y: from.y + (to.y - from.y) * e,
          k: from.k + (to.k - from.k) * e,
        })
        gliding.current = t < 1 ? requestAnimationFrame(step) : null
      }
      gliding.current = requestAnimationFrame(step)
    },
    [stopGlide],
  )
  const fitView = useCallback(() => {
    const el = canvas.current
    if (!el || !layout) return
    const k = Math.max(
      MIN_ZOOM,
      Math.min(1, el.clientWidth / layout.width, el.clientHeight / layout.height),
    )
    // In the middle of the canvas, in the two directions.
    glideTo({
      x: (el.clientWidth - layout.width * k) / 2,
      y: Math.max(0, (el.clientHeight - layout.height * k) / 2),
      k,
    })
  }, [layout, glideTo])
  /** Puts one card in the middle of the canvas, as large as fits. */
  const fitCard = useCallback(
    (id: string) => {
      const el = canvas.current
      const p = layout?.at.get(id)
      if (!el || !p) return
      fitted.current = true
      const pad = 48
      const k = Math.max(
        MIN_ZOOM,
        Math.min(1.25, (el.clientWidth - pad) / p.width, (el.clientHeight - pad) / p.height),
      )
      glideTo({
        k,
        x: el.clientWidth / 2 - (p.x + p.width / 2) * k,
        y: el.clientHeight / 2 - (p.y + p.height / 2) * k,
      })
    },
    [layout, glideTo],
  )
  /** Moves the view so that a box is all in it. */
  const fitBox = useCallback(
    (box: { x: number; y: number; width: number; height: number }) => {
      const el = canvas.current
      if (!el) return
      const pad = 96
      const k = Math.max(
        MIN_ZOOM,
        Math.min(1, (el.clientWidth - pad) / box.width, (el.clientHeight - pad) / box.height),
      )
      glideTo({
        k,
        x: el.clientWidth / 2 - (box.x + box.width / 2) * k,
        y: el.clientHeight / 2 - (box.y + box.height / 2) * k,
      })
    },
    [glideTo],
  )
  // From far, the code of a card is too small to read. Then a name is on
  // each card, and when the names of the cards are too small too, one name is
  // on the box around them. The boxes and the cards make a tree by their
  // places.
  const farTree = useMemo(() => (layout ? farTreeOf(layout, cards) : []), [layout, cards])
  // In steps, so a small move of the zoom does not make the names again.
  const farK = Math.round(view.k * 40) / 40 || MIN_ZOOM
  const frameW = canvas.current?.clientWidth ?? Number.POSITIVE_INFINITY
  const frameH = canvas.current?.clientHeight ?? Number.POSITIVE_INFINITY
  // A click in a box opens it: the level of the view is not less than this.
  // A zoom out, or the Fit button, gives the level back to the zoom.
  const [openLevel, setOpenLevel] = useState(0)
  const farNames = useMemo(
    () => farLabels(farTree, farK, openLevel, { width: frameW, height: frameH }),
    [farTree, farK, openLevel, frameW, frameH],
  )
  // From near, with no click, each box is open and each card shows its code.
  // After a click, the level of the click holds at each zoom: the boxes below
  // it stay closed, so a click opens one level only, as the zoom does.
  const allOpen = !overlay || (farK >= FAR_ZOOM && openLevel === 0)
  const farPlaces = useMemo(() => {
    if (allOpen) return NO_KEYS
    // From far, a card that is in the view shows its name.
    return farK >= FAR_ZOOM || !FAR_CARD_NAMES
      ? farNames.boxes
      : new Set([...farNames.boxes, ...farNames.cards])
  }, [allOpen, farK, farNames])
  // A card is in the view when no closed box is over it.
  const inView = (id: string) => allOpen || farNames.cards.has(`card:${id}`)
  // The selected card, when it is in the view. From a level above the card,
  // its arrows have no numbers, no side names and no strong color. They come
  // back when the view is at the level of the card again.
  const picked = selected !== null && inView(selected) ? selected : null
  const farByKey = useMemo(() => farByKeyOf(farTree), [farTree])
  const farItems = useMemo(() => [...farByKey.values()], [farByKey])
  /**
   * The color of an item. A card: from its own diff, green for added lines,
   * red for removed lines, a mix between them. A box: the color that the
   * agent gave it, but a box that mostly removes code is red.
   */
  const tintStyle = (key: string): React.CSSProperties => {
    const item = farByKey.get(key)
    if (!item) return {}
    const tint = item.card
      ? diffRgb(item.add, item.del)
      : mostlyRemoved(item)
        ? COLOR_RGB.red
        : (colorOf(graph.boxes, item.name) ?? COLOR_RGB.blue)
    return { '--realm': tint } as React.CSSProperties
  }
  // The view fits the graph by itself until the reviewer moves it: a card
  // can get a new size after the first layout (its tokens, its threads), and
  // the layout then changes.
  useEffect(() => {
    if (layout && !fitted.current) fitView()
  }, [layout, fitView])

  const hasCanvas = cards.length > 0
  // The wheel zooms at the pointer, and so does a pinch on a trackpad. With
  // shift, the wheel moves the view. The listener is not passive, so the page
  // does not scroll too.
  useEffect(() => {
    const el = canvas.current
    if (!el || !hasCanvas || inert) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      fitted.current = true
      stopGlide()
      if (e.shiftKey) {
        setView((v) => ({ ...v, x: v.x - e.deltaX - e.deltaY, y: v.y }))
        return
      }
      const rect = el.getBoundingClientRect()
      const px = e.clientX - rect.left
      const py = e.clientY - rect.top
      // A pinch sends small steps with ctrl set. A wheel sends large ones.
      const speed = e.ctrlKey ? 0.01 : 0.0015
      if (e.deltaY > 0) setOpenLevel(0)
      setView((v) => {
        const k = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, v.k * Math.exp(-e.deltaY * speed)))
        return { k, x: px - ((px - v.x) * k) / v.k, y: py - ((py - v.y) * k) / v.k }
      })
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
    // The canvas is in the page only after the graph has cards.
  }, [hasCanvas, inert, stopGlide])

  // A press that moves is a drag of the view, from a card too. A press that
  // does not move is a click: on a card it selects the card and fits it, on
  // the canvas it clears the selection. Text can be selected only in the
  // selected card, so a drag there does not move the view.
  const drag = useRef<{
    x: number
    y: number
    moved: boolean
    node: string | null
    box: string | null
  } | null>(null)
  /**
   * The box at the pointer: the smallest one, so a box in a box is before the
   * box around it. A card is before each box: the caller looks for it first.
   */
  const boxAt = (e: React.PointerEvent): string | null => {
    const el = canvas.current
    if (!el) return null
    const frame = el.getBoundingClientRect()
    const x = (e.clientX - frame.left - view.x) / view.k
    const y = (e.clientY - frame.top - view.y) / view.k
    let best: FarItem | null = null
    for (const item of farItems) {
      if (item.card) continue
      if (x < item.x || y < item.y || x > item.x + item.width || y > item.y + item.height) continue
      if (!best || item.width * item.height < best.width * best.height) best = item
    }
    return best?.key ?? null
  }
  // The box under the pointer has a mark: a click moves the view to it.
  const [hotBox, setHotBox] = useState<string | null>(null)
  const hot = (key: string) => (hotBox === key ? ' graph-hot' : '')
  // Where the reviewer is: the boxes around the middle of the canvas that
  // fill most of it, from the outer one to the inner one. The breadcrumb
  // shows it.
  const here = useMemo(() => {
    const el = canvas.current
    if (!el) return []
    const cx = (el.clientWidth / 2 - view.x) / view.k
    const cy = (el.clientHeight / 2 - view.y) / view.k
    return farItems
      .filter(
        (i) =>
          !i.card &&
          cx >= i.x &&
          cy >= i.y &&
          cx <= i.x + i.width &&
          cy <= i.y + i.height &&
          (i.width * view.k >= el.clientWidth * 0.6 || i.height * view.k >= el.clientHeight * 0.6),
      )
      .sort((a, b) => b.width * b.height - a.width * a.height)
  }, [farItems, view])
  // To follow the arrows of the selected card. Each arrow has a number at the
  // place where it meets the card. A click on a number goes to the card at the
  // other end. The Right key makes the arrows that leave the card the active
  // side, and the Left key those that come in. A number key follows the arrow
  // with that number on the active side. When the side has one arrow, the Left
  // or Right key follows it. After a step out, the Left key is the way back:
  // it goes to the card that the step came from.
  const [side, setSide] = useState<Direction>('out')
  // The card of the step before: its number has a mark.
  const [cameFrom, setCameFrom] = useState<string | null>(null)
  // The card or the box that the keys went to.
  const [focusKey, setFocusKey] = useState<string | null>(null)
  /** Goes to a box: fits it and shows the level below it. */
  const goBox = (key: string) => {
    const box = farByKey.get(key)
    if (!box) return
    fitted.current = true
    fitBox(box)
    // The click also shows the level below the box, and only that one: the
    // box is open, and each box in it is closed. A second click in the same
    // box gives the same view. With no overlay, the click only fits the box.
    if (overlay) setOpenLevel(Math.min(farNames.most, box.depth + 1))
    setFocusKey(null)
  }
  /** Goes to the full graph. The view fits by itself again. */
  const goAll = () => {
    fitted.current = false
    setOpenLevel(0)
    setSelected(null)
    setFocusKey(null)
    fitView()
  }
  /** Goes to a card: selects it and fits it. */
  const goCard = (id: string | null) => {
    setSelected(id)
    setFocusKey(id === null ? null : `card:${id}`)
    setSide('out')
    setCameFrom(null)
    if (id === null) return
    // Each box is open, so the card is in the view.
    setOpenLevel(0)
    fitCard(id)
  }
  const onPointerDown = (e: React.PointerEvent) => {
    const target = e.target as Element
    if (
      e.button !== 0 ||
      target.closest(
        'button, .graph-panel, .graph-crumbs, .graph-zoom, td.line-no, .thread-row, .file-threads, .hunk-boundary, textarea, input',
      )
    )
      return
    if (target.closest('.graph-card-selected .graph-card-code')) return
    const node = target.closest('[data-node]')?.getAttribute('data-node') ?? null
    const box =
      target.closest('[data-zoom-to]')?.getAttribute('data-zoom-to') ??
      (node === null ? boxAt(e) : null)
    drag.current = { x: e.clientX, y: e.clientY, moved: false, node, box }
    e.currentTarget.setPointerCapture(e.pointerId)
  }
  const onPointerMove = (e: React.PointerEvent) => {
    const from = drag.current
    if (!from) {
      const target = e.target as Element
      const free = !target.closest(
        '[data-node], [data-zoom-to], button, .graph-panel, .graph-crumbs, .graph-zoom',
      )
      const box = free ? boxAt(e) : null
      if (box !== hotBox) setHotBox(box)
      return
    }
    const dx = e.clientX - from.x
    const dy = e.clientY - from.y
    if (!from.moved && Math.abs(dx) + Math.abs(dy) < 4) return
    drag.current = { ...from, x: e.clientX, y: e.clientY, moved: true }
    fitted.current = true
    stopGlide()
    setView((v) => ({ ...v, x: v.x + dx, y: v.y + dy }))
  }
  const onPointerUp = () => {
    const from = drag.current
    drag.current = null
    if (!from || from.moved) return
    // A click in a box, not on a card: the view goes to the box.
    if (from.box !== null && farByKey.has(from.box)) goBox(from.box)
    else goCard(from.node)
  }

  const links = useMemo(() => {
    const make = (dir: Direction): Link[] => {
      const found = new Map<string, Link>()
      for (const a of arrows) {
        if ((dir === 'out' ? a.from : a.to) !== selected) continue
        const other = dir === 'out' ? a.to : a.from
        if (other !== selected && !found.has(other)) found.set(other, { id: other, line: a.line })
      }
      return [...found.values()].sort((a, b) => a.line - b.line)
    }
    return selected === null ? { out: [], in: [] } : { out: make('out'), in: make('in') }
  }, [arrows, selected])
  const follow = useCallback(
    (id: string, dir: Direction) => {
      setCameFrom(selected)
      setSide(dir)
      setSelected(id)
      fitCard(id)
    },
    [fitCard, selected],
  )
  // The two keys do the same on their side: with one arrow they follow it,
  // with more they make the numbers of the side active.
  const turn = useCallback(
    (dir: Direction) => {
      const only = links[dir].length === 1 ? links[dir][0] : undefined
      if (only) follow(only.id, dir)
      else setSide(dir)
    },
    [links, follow],
  )
  useEffect(() => {
    if (picked === null || inert) return
    const onKey = (e: KeyboardEvent) => {
      const el = e.target
      if (
        el instanceof Element &&
        el.closest('input, textarea, select, [contenteditable="true"]')
      ) {
        return
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return
      if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
        turn(e.key === 'ArrowRight' ? 'out' : 'in')
      } else {
        if (!/^[1-9]$/.test(e.key)) return
        const link = links[side][Number(e.key) - 1]
        if (!link) return
        follow(link.id, side)
      }
      e.preventDefault()
      e.stopPropagation()
    }
    // Before the shortcuts of the page, which also use these keys.
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [picked, links, follow, turn, side, inert])
  // One order of all the cards, for the Up and the Down keys.
  const linear = useMemo(() => readingOrder(farTree, graph.order), [farTree, graph.order])
  const stepTo = useCallback(
    (down: boolean) => {
      if (linear.length === 0) return
      const at = selected === null ? -1 : linear.indexOf(selected)
      let next: string | undefined
      if (at !== -1) {
        next = linear[at + (down ? 1 : -1)]
      } else {
        // No card is selected: the first card of the box where the reviewer
        // is, or the first card of the graph.
        const box = here[here.length - 1]
        const inBox = (id: string) => {
          const card = farByKey.get(`card:${id}`)
          return (
            card !== undefined &&
            box !== undefined &&
            card.x >= box.x &&
            card.y >= box.y &&
            card.x + card.width <= box.x + box.width &&
            card.y + card.height <= box.y + box.height
          )
        }
        next = linear.find(inBox) ?? linear[0]
      }
      if (next === undefined) return
      // As a step with the Left and the Right keys: the card is selected,
      // and the view fits it.
      setSelected(next)
      setFocusKey(`card:${next}`)
      setSide('out')
      setCameFrom(null)
      // Each box is open, so the card is in the view.
      setOpenLevel(0)
      fitCard(next)
    },
    [linear, selected, here, farByKey, fitCard],
  )
  // The moves between levels, as the last render made them: the listener of
  // the keys stays the same one.
  const levelUp = useRef<() => boolean>(() => false)
  const levelDown = useRef<() => boolean>(() => false)
  useEffect(() => {
    if (!hasCanvas || inert) return
    const onKey = (e: KeyboardEvent) => {
      const level = e.key === 'Escape' || e.key === 'Enter'
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && !level) return
      if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return
      const el = e.target
      if (
        el instanceof Element &&
        el.closest('input, textarea, select, [contenteditable="true"]')
      ) {
        return
      }
      if (e.key === 'Escape') {
        // One level up: from a card to its box, from a box to the box
        // around it, from an outer box to the full graph.
        if (!levelUp.current()) return
      } else if (e.key === 'Enter') {
        // On a card: the Viewed mark. If not: one level down, into the
        // box that has the focus.
        if (!levelDown.current()) return
      } else {
        stepTo(e.key === 'ArrowDown')
      }
      e.preventDefault()
      e.stopPropagation()
    }
    // Before the shortcuts of the page, which also use these keys.
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [hasCanvas, stepTo, inert])
  levelUp.current = () => {
    if (selected !== null) {
      const card = farByKey.get(`card:${selected}`)
      const around = card
        ? farItems
            .filter(
              (i) =>
                !i.card &&
                i.x <= card.x &&
                i.y <= card.y &&
                i.x + i.width >= card.x + card.width &&
                i.y + i.height >= card.y + card.height,
            )
            .sort((a, b) => a.width * a.height - b.width * b.height)[0]
        : undefined
      setSelected(null)
      if (around) goBox(around.key)
      else goAll()
      return true
    }
    const up = here[here.length - 2]
    if (up) {
      goBox(up.key)
      return true
    }
    // The view is the full graph already: the key goes on to what holds the
    // canvas (it closes a full view).
    if (!fitted.current && openLevel === 0) return false
    goAll()
    return true
  }
  levelDown.current = () => {
    // On a selected card, Enter marks its changed lines as viewed, or takes
    // the mark away: the Viewed button of the card.
    if (selected !== null && viewedOf(selected) !== null) {
      onViewed(selected)
      return true
    }
    if (focusKey === null) return false
    if (focusKey.startsWith('card:')) goCard(focusKey.slice('card:'.length))
    else goBox(focusKey)
    return true
  }
  const zoom = (factor: number) => {
    const el = canvas.current
    if (!el) return
    if (factor < 1) setOpenLevel(0)
    fitted.current = true
    const px = el.clientWidth / 2
    const py = el.clientHeight / 2
    const v = viewRef.current
    const k = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, v.k * factor))
    glideTo({ k, x: px - ((px - v.x) * k) / v.k, y: py - ((py - v.y) * k) / v.k })
  }

  if (layoutError !== null) {
    return <p className="graph-note graph-note-side">The graph has no layout: {layoutError}</p>
  }
  const byId = new Map(cards.map((c) => [c.id, c]))
  const selectedBox = picked !== null ? layout?.at.get(picked) : undefined
  return (
    <div
      className="graph-canvas"
      ref={canvas}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
    >
      {/* Where the reviewer is, at the top left. A click on a part goes up
          to that level. */}
      <nav className="graph-crumbs" aria-label="Place in the graph">
        <button
          type="button"
          className="graph-crumb"
          onClick={goAll}
          data-tip="The full graph (Esc goes up one level)"
        >
          All
        </button>
        {here.map((box) => (
          <span key={box.key} className="graph-crumb-part">
            <span className="graph-crumb-sep" aria-hidden="true">
              ›
            </span>
            <button
              type="button"
              className="graph-crumb"
              style={tintStyle(box.key)}
              onClick={() => goBox(box.key)}
            >
              {box.name}
            </button>
          </span>
        ))}
        {picked !== null && (
          <span className="graph-crumb-part">
            <span className="graph-crumb-sep" aria-hidden="true">
              ›
            </span>
            <span className="graph-crumb graph-crumb-card">{byId.get(picked)?.title ?? ''}</span>
          </span>
        )}
      </nav>
      {/* The switches of the view, at the top right. */}
      <div className="graph-panel">
        <div className="graph-tools">
          <button
            type="button"
            className="pane-word graph-comments"
            aria-pressed={overlay}
            data-tip={
              overlay
                ? 'Hide the names from far, and keep each box open'
                : 'From far, show names on the cards and the boxes. A click in a box opens it'
            }
            onClick={onOverlay}
          >
            Overlay
          </button>
          {comments && (
            <button
              type="button"
              className="pane-word graph-comments"
              aria-pressed={allThreads}
              data-tip={`${allThreads ? 'Hide' : 'Show'} the comment threads on all the cards`}
              onClick={() => {
                setAllThreads((on) => !on)
                setThreadsOn(new Set())
              }}
            >
              Comments
            </button>
          )}
        </div>
      </div>
      {/* The zoom, at the bottom right. */}
      <div className="graph-zoom">
        <button type="button" className="pane-icon" aria-label="Zoom out" onClick={() => zoom(0.8)}>
          −
        </button>
        <button type="button" className="pane-icon" aria-label="Zoom in" onClick={() => zoom(1.25)}>
          +
        </button>
        <button type="button" className="graph-fit" onClick={goAll}>
          Fit
        </button>
      </div>
      <div
        className="graph-world"
        style={{
          transform: `translate(${view.x}px, ${view.y}px) scale(${view.k})`,
          width: layout?.width ?? CARD_WIDTH,
          height: layout?.height ?? 0,
          visibility: layout ? 'visible' : 'hidden',
        }}
      >
        {/* The boxes. The zoom is a variable of this layer only: the name in
            the corner of a box keeps one size on the screen at each zoom. */}
        <div className="graph-far-layer" style={{ '--far-zoom': view.k } as React.CSSProperties}>
          {layout?.groups.map((g, i) => (
            <div
              // biome-ignore lint/suspicious/noArrayIndexKey: two boxes can have one name — position is the identity
              key={i}
              className={`graph-inner graph-box${hot(`group:${i}`)}`}
              style={{
                left: g.x,
                top: g.y,
                width: g.width,
                height: g.height,
                ...tintStyle(`group:${i}`),
              }}
              title={g.group}
            >
              <span className="graph-inner-name" hidden={farPlaces.has(`group:${i}`)}>
                {g.group}
              </span>
            </div>
          ))}
        </div>
        {cards.map((card) => {
          const p = layout?.at.get(card.id)
          return (
            <div
              key={card.id}
              className="graph-slot"
              style={{ left: p?.x ?? 0, top: p?.y ?? 0, width: cardWidth(card, char) }}
            >
              <Card
                node={card}
                open={open.has(card.id)}
                selected={selected === card.id}
                threads={threadsOf.get(card.id) ?? NO_THREADS}
                hunks={hunksOf.get(card.id) ?? NO_HUNKS}
                comments={comments}
                showThreads={allThreads || threadsOn.has(card.id)}
                onThreads={onThreads}
                onToggle={onToggle}
                onOpen={onOpen}
                onHeight={onHeight}
                file={fileByPath.get(card.path)}
                viewed={viewedOf(card.id)}
                onViewed={onViewed}
                fileThreads={fileThreadsOf.get(card.id) ?? NO_THREADS}
              />
            </div>
          )
        })}
        {/* The arrows are above the cards, so a card never hides a part of one. */}
        {layout && (
          <svg
            className="graph-edges"
            // The width of an arrow stays the same on the screen when the
            // view is small. The variable is on the arrows only: on the
            // canvas, each zoom step would style all the lines of all the
            // cards again.
            style={{ '--zoom': view.k, '--kind': ARROW_RGB } as React.CSSProperties}
            width={layout.width}
            height={layout.height}
            aria-hidden="true"
          >
            <defs>
              <marker
                id="graph-arrow"
                viewBox="0 0 10 10"
                refX="9"
                refY="5"
                markerWidth="7"
                markerHeight="7"
                orient="auto"
              >
                <path d="M1 1L9 5L1 9" fill="none" stroke="context-stroke" strokeWidth="1.5" />
              </marker>
            </defs>
            {arrows.map((e) => {
              const a = layout.at.get(e.from)
              const b = layout.at.get(e.to)
              if (!a || !b) return null
              // The two ends are under one closed box: the arrow is not in
              // the view. The name of the box lets what is under it show.
              const over = allOpen ? undefined : farNames.under.get(`card:${e.from}`)
              if (over !== undefined && over === farNames.under.get(`card:${e.to}`)) return null
              // An arrow leaves the right side of its card and enters the left
              // side of its target. When the target is to the left, it goes
              // the other way.
              const back = b.x + b.width < a.x
              // The target is above or below, in the same box: the arrow is
              // a bracket at the left of the two cards.
              const stacked = isStacked(a, b)
              const y1 = a.y + callOffset(e.line, tops.get(e.from))
              const y2 = b.y + HEADER / 2
              const x1 = back || stacked ? a.x : a.x + a.width
              const x2 = back ? b.x + b.width : b.x
              const bend = stacked
                ? -Math.min(72, Math.max(36, Math.abs(y2 - y1) / 6))
                : Math.max(40, Math.abs(x2 - x1) / 2) * (back ? -1 : 1)
              const bend2 = stacked ? -bend : bend
              const key = edgeKey(e)
              const route = layout.routes?.get(key)
              const path = (
                <path
                  key={key}
                  // The arrows of the selected card are strong.
                  className={`graph-edge graph-edge-kind ${
                    e.from === picked || e.to === picked ? 'graph-edge-hot' : 'graph-edge-cross'
                  }`}
                  d={
                    route
                      ? routePath(route)
                      : `M${x1} ${y1} C${x1 + bend} ${y1}, ${x2 - bend2} ${y2}, ${x2} ${y2}`
                  }
                  // An arrow into a closed box has no head: its target is
                  // not in the view.
                  markerEnd={inView(e.to) ? 'url(#graph-arrow)' : undefined}
                />
              )
              if (!e.label) return path
              return (
                <g key={key}>
                  {path}
                  <text className="graph-edge-label" x={(x1 + x2) / 2} y={(y1 + y2) / 2 - 8}>
                    {e.label}
                  </text>
                </g>
              )
            })}
          </svg>
        )}
        {/* From far: a name on each card, or one name on a box. Each name is
            in the page before it shows, so it fades in and out. A click on a
            card name is a click on the card. A click on a box name moves the
            view to the box. The zoom is a variable of this layer only: the
            borders keep one width on the screen. The names are above the
            arrows: an arrow shows only outside a box or a card that has its
            name, so the arrows in a closed box are not in the view. */}
        {overlay && (view.k < FAR_MOUNT || openLevel > 0) && (
          <div className="graph-far-layer" style={{ '--far-zoom': view.k } as React.CSSProperties}>
            {farItems.map((item) => (
              <div
                key={`far:${item.key}`}
                className={`graph-far ${item.card ? 'graph-far-card' : 'graph-far-box'}${
                  farPlaces.has(item.key) ? ' graph-far-on' : ''
                }${item.key === focusKey ? ' graph-far-focus' : ''}`}
                style={{
                  left: item.x,
                  top: item.y,
                  width: item.width,
                  height: item.height,
                  fontSize: farSize(item),
                  ...tintStyle(item.key),
                }}
                data-node={item.card ? item.key.slice('card:'.length) : undefined}
                data-zoom-to={item.card ? undefined : item.key}
              >
                <span className="graph-far-name">{item.name}</span>
              </div>
            ))}
          </div>
        )}
        {/* A number at each place where an arrow meets the selected card: a
            click makes the step. The numbers of the active side are full,
            and a number key follows them. */}
        {picked !== null &&
          selectedBox &&
          (['out', 'in'] as const).flatMap((dir) => {
            const taken = new Map<string, number>()
            return links[dir].map((link, i) => {
              const other = layout?.at.get(link.id)
              if (!other) return null
              // The same ends as the arrow: it leaves the right side at its
              // line, and enters the left side at the title. To a card on
              // the left, the sides are the other way.
              const back =
                dir === 'out'
                  ? other.x + other.width < selectedBox.x
                  : selectedBox.x + selectedBox.width < other.x
              // With a route: the number is at the end of the route.
              const route = layout?.routes?.get(
                edgeKey(
                  dir === 'out'
                    ? { from: picked, to: link.id, line: link.line }
                    : { from: link.id, to: picked, line: link.line },
                ),
              )
              const end = route ? (dir === 'out' ? route[0] : route[route.length - 1]) : undefined
              // To a card above or below, the arrow is at the left.
              const right = end
                ? dir === 'out'
                : isStacked(selectedBox, other)
                  ? false
                  : dir === 'out'
                    ? !back
                    : back
              const y = end
                ? end.y - selectedBox.y
                : dir === 'out'
                  ? callOffset(link.line, tops.get(picked))
                  : HEADER / 2
              // Two arrows that meet the card at one place: their numbers are
              // side by side, away from the card.
              const spot = `${right}:${y}`
              const nth = taken.get(spot) ?? 0
              taken.set(spot, nth + 1)
              const shift = nth * 30 * (right ? 1 : -1)
              return (
                <button
                  key={`${dir}:${link.id}`}
                  type="button"
                  className={`graph-port graph-port-${dir}${dir === side ? '' : ' graph-port-idle'}${
                    link.id === cameFrom ? ' graph-port-from' : ''
                  }`}
                  style={{
                    left: (right ? selectedBox.x + selectedBox.width : selectedBox.x) + shift,
                    top: selectedBox.y + y,
                  }}
                  title={`Go to ${byId.get(link.id)?.title ?? ''}${
                    link.id === cameFrom ? ' (the card of the step before)' : ''
                  }`}
                  onClick={() => follow(link.id, dir)}
                >
                  {i + 1}
                </button>
              )
            })
          })}
        {/* The two sides of the selected card, with the key of each: Left is
            for the arrows that come in, Right for the arrows that go out. */}
        {picked !== null &&
          selectedBox &&
          (['in', 'out'] as const).map((dir) => (
            <button
              key={dir}
              type="button"
              className={`graph-side graph-side-${dir}${dir === side ? ' graph-side-on' : ''}`}
              style={{
                left: dir === 'in' ? selectedBox.x : selectedBox.x + selectedBox.width,
                top: selectedBox.y,
              }}
              disabled={links[dir].length === 0}
              title={
                dir === 'in'
                  ? 'Left key: the cards with an arrow to this one'
                  : 'Right key: the cards that this one has an arrow to'
              }
              onClick={() => turn(dir)}
            >
              {dir === 'in' ? `← In ${links.in.length}` : `Out ${links.out.length} →`}
            </button>
          ))}
      </div>
    </div>
  )
}
