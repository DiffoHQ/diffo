import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { LayerArrowEnd, LayerBox, LayerColor, ReviewThread } from '../../../shared/review.js'
import type { DiffLine, FileChange, Hunk } from '../../../shared/types.js'
import type { GraphStep, ReviewComments } from '../../components/ReadingPane.js'
import { changedLineMarks } from '../../fileMarks.js'
import type { CodeGraph, GraphEdge, GraphNode, Realm } from '../basic/build.js'
import { pickRepo, plainRepo } from '../repo/index.js'
import type { GraphRepo } from '../repo/repo.js'
import {
  AGENT,
  agentCards,
  agentEdges as agentEdgesOf,
  agentOrder as agentOrderOf,
  boxByTitle,
  boxChain,
  cardAt,
  noteId,
  splitBySteps,
  stepsOfCards,
} from './agent.js'
import { Card, type Direction, type Link } from './Card.js'
import { COLOR_ORDER, COLOR_RGB, diffRgb, mostlyRemoved } from './colors.js'
import {
  CALLBACK,
  CARD_WIDTH,
  contractGroup,
  GLIDE_MS,
  GROUP_REALMS,
  HEADER,
  LAYOUT_MARGIN,
  MAX_FILE_BYTES,
  MAX_ZOOM,
  MIN_ZOOM,
  NO_HUNKS,
  NO_STEPS,
  NO_THREADS,
  OTHER_STEP,
  OVERLAY_KEY,
  REALM_NAME,
  REALMS,
  REPO_KEY,
  RESIZE_MOST,
  type View,
} from './constants.js'
import {
  FAR_CARD_NAMES,
  FAR_MOUNT,
  FAR_ZOOM,
  type FarItem,
  farByKey as farByKeyOf,
  farCardName,
  farLabels,
  farSize,
  farTree as farTreeOf,
  NO_KEYS,
  readingOrder,
  rectOf,
} from './far.js'
import type { RealmLayout } from './layout.js'
import { boxName, cardWidth, nodeTitle, stepName, useCharWidth } from './names.js'
import { OUTLINE_SLOT } from './outlineSlot.js'
import { resizeInPlace } from './resize.js'
import { layoutRouted, type Point } from './routed.js'
import { callOffset, edgeKey, isStacked, routePath } from './routes.js'
import { useGraph } from './useGraph.js'

/**
 * The graph view of the files: a canvas of code snippets. A card is a function
 * that the change touches, with its diff lines. An arrow is a call from one
 * card to another. The parser runs in the page (tree-sitter, C++ and
 * TypeScript), on the head text of each changed file.
 */

export default function GraphView({
  files,
  split = false,
  pickedFile,
  pickedThread,
  steps,
  activeStep,
  comments,
  viewed,
  onSetMarks,
  onOpenHunk,
}: {
  files: readonly FileChange[]
  /** The marks of the code that the reviewer read: the same ones as the list. */
  viewed?: ReadonlySet<string>
  /** Sets or clears marks of read code. With it, each card has a Viewed button. */
  onSetMarks?: (marks: string[], on: boolean) => void
  /** The steps of the outline of the agent. With them, the cards are in one
   * group for each step, with the name of the step. */
  steps?: readonly GraphStep[]
  /** The step that the reviewer reads now. The cards of the other steps are
   * pale. */
  activeStep?: string | null
  /** The file that a click in the tree of files picked. Its cards get a
   * mark, and the view goes to them. */
  pickedFile?: { path: string; n: number } | null
  /** The thread that a click in the list of threads picked: the view goes
   * to its comment. */
  pickedThread?: { id: string; path: string | null; n: number } | null
  /**
   * The diff layout of the page. Unified: one graph of the change, with what
   * it adds, changes and removes. Split: the code before the change and the
   * code after it, side by side.
   */
  split?: boolean
  /** The threads of the review and the actions on them, as in the list. */
  comments?: ReviewComments
  /** Go to a hunk in the list view. */
  onOpenHunk: (hunkId: string) => void
}) {
  // The rules of the repo of the change: its groups and its connections.
  // The layers of the graph. Basic is always there: what the diff and the
  // language tell, for each repository. The Repo layer adds the rules of the
  // repository of the change, when Diffo has them: its groups, its
  // connections, its libraries and its style.
  const known = useMemo(() => pickRepo(files.map((f) => f.path)), [files])
  const [repoOn, setRepoOn] = useState(() => {
    try {
      return localStorage.getItem(REPO_KEY) === '1'
    } catch {
      return false
    }
  })
  const onRepo = useCallback(() => {
    setRepoOn((on) => {
      try {
        localStorage.setItem(REPO_KEY, on ? '0' : '1')
      } catch {
        // The choice is for this page only.
      }
      return !on
    })
  }, [])
  // The rules of the repo and the outline of the agent are two views of the
  // same thing: the agent gives the groups and the connections that the repo
  // rules give. So they are never on together: with an outline, the graph
  // is the basic one.
  const repo = repoOn && (steps?.length ?? 0) === 0 ? known : plainRepo
  const { graph: built, error } = useGraph(files, repo)
  // The cards of the agent: its notes, and its cards for code that the
  // change does not touch. The text of that code is from the head.
  const [contextText, setContextText] = useState<ReadonlyMap<string, string>>(new Map())
  const contextPaths = useMemo(
    () => [...new Set((steps ?? []).flatMap((st) => (st.context ?? []).map((c) => c.at.path)))],
    [steps],
  )
  useEffect(() => {
    let cancelled = false
    const missing = contextPaths.filter((path) => !contextText.has(path))
    if (missing.length === 0) return
    Promise.all(
      missing.map(async (path) => {
        const res = await fetch(`/api/file?path=${encodeURIComponent(path)}&side=head`)
        const text = res.ok ? await res.text() : ''
        return [path, text.length > MAX_FILE_BYTES ? '' : text] as const
      }),
    ).then((got) => {
      if (!cancelled) setContextText((prev) => new Map([...prev, ...got]))
    })
    return () => {
      cancelled = true
    }
  }, [contextPaths, contextText])
  const graph = useMemo(() => {
    if (built === null) return null
    const all = splitBySteps(built.all, steps ?? [], files)
    const cards = agentCards(steps ?? [], contextText)
    return all === built.all && cards.length === 0
      ? built
      : { ...built, all: { ...all, nodes: [...all.nodes, ...cards] } }
  }, [built, steps, contextText, files])
  const hunkById = useMemo(
    () => new Map(files.flatMap((f) => f.hunks.map((h) => [h.id, h] as const))),
    [files],
  )
  const fileByPath = useMemo(() => new Map(files.map((f) => [f.path, f])), [files])
  if (error !== null) {
    return <p className="graph-note">The graph did not load: {error}</p>
  }
  if (graph === null) {
    return <p className="graph-note">Reading the changed files…</p>
  }
  return (
    <div className="graph-view">
      {split ? (
        <div className="graph-split">
          <GraphCanvas
            key="before"
            title="Before"
            graph={graph.before}
            side="base"
            fileByPath={fileByPath}
            pickedFile={pickedFile}
            pickedThread={pickedThread}
            steps={steps}
            activeStep={activeStep}
            repo={repo}
            known={known}
            repoOn={repoOn}
            viewed={viewed}
            onSetMarks={onSetMarks}
            onRepo={onRepo}
            comments={comments}
            hunkById={hunkById}
            onOpenHunk={onOpenHunk}
          />
          <GraphCanvas
            key="after"
            title="After"
            graph={graph.after}
            side="head"
            fileByPath={fileByPath}
            pickedFile={pickedFile}
            pickedThread={pickedThread}
            steps={steps}
            activeStep={activeStep}
            repo={repo}
            known={known}
            repoOn={repoOn}
            viewed={viewed}
            onSetMarks={onSetMarks}
            onRepo={onRepo}
            comments={comments}
            hunkById={hunkById}
            onOpenHunk={onOpenHunk}
          />
        </div>
      ) : (
        <GraphCanvas
          key="all"
          graph={graph.all}
          side="head"
          fileByPath={fileByPath}
          pickedFile={pickedFile}
          pickedThread={pickedThread}
          steps={steps}
          activeStep={activeStep}
          repo={repo}
          known={known}
          repoOn={repoOn}
          viewed={viewed}
          onSetMarks={onSetMarks}
          onRepo={onRepo}
          comments={comments}
          hunkById={hunkById}
          onOpenHunk={onOpenHunk}
        />
      )}
    </div>
  )
}

function GraphCanvas({
  graph,
  title,
  pickedFile,
  pickedThread,
  steps = NO_STEPS,
  activeStep = null,
  repo,
  known,
  repoOn,
  viewed,
  onSetMarks,
  onRepo,
  comments,
  hunkById,
  fileByPath,
  side: textSide,
  onOpenHunk,
}: {
  graph: CodeGraph
  repo: GraphRepo
  pickedFile?: { path: string; n: number } | null
  /** The thread that a click in the list of threads picked: the view goes
   * to its comment. */
  pickedThread?: { id: string; path: string | null; n: number } | null
  steps?: readonly GraphStep[]
  activeStep?: string | null
  /** The repository of the change whose rules Diffo has. */
  known: GraphRepo
  /** The Repo layer is on: the graph has the rules of `known`. */
  repoOn: boolean
  viewed?: ReadonlySet<string>
  onSetMarks?: (marks: string[], on: boolean) => void
  onRepo: () => void
  fileByPath: ReadonlyMap<string, FileChange>
  /** The side of the change that the graph shows. */
  side: 'head' | 'base'
  /** The name of the side, in the side by side layout. */
  title?: string
  comments?: ReviewComments
  hunkById: ReadonlyMap<string, Hunk>
  onOpenHunk: (hunkId: string) => void
}) {
  const [heights, setHeights] = useState<ReadonlyMap<string, number>>(new Map())
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set())
  const [view, setView] = useState<View>({ x: 0, y: 0, k: 1 })
  const [selected, setSelected] = useState<string | null>(null)
  const [hidden, setHidden] = useState<ReadonlySet<Realm>>(new Set())
  // The arrows that are not a direct call: a callback, and the kinds of the
  // repo. Each kind has a switch.
  const kinds = useMemo(
    () => [...repo.kinds, CALLBACK, ...(steps.some((st) => st.arrows?.length) ? [AGENT] : [])],
    [repo, steps],
  )
  // The arrows of the agent: from the card at one place to the card at a
  // second place. They are arrows of the graph as the calls are: the layout
  // has them, and they have a switch.
  const agentEdges = useMemo(() => agentEdgesOf(graph.nodes, steps), [graph, steps])
  // The order of reading of the agent: the cards at the places of each step,
  // step by step. The Up and the Down keys follow it.
  const agentOrder = useMemo(() => agentOrderOf(graph.nodes, steps), [graph, steps])
  const [hiddenHops, setHiddenHops] = useState<ReadonlySet<string>>(new Set())
  // The functions that the change removes completely. They can be hidden, to
  // see only the code that stays.
  const [showRemoved, setShowRemoved] = useState(true)
  const canvas = useRef<HTMLDivElement>(null)
  /** The reviewer moved the view: it does not fit by itself any more. */
  const fitted = useRef(false)

  const char = useCharWidth()
  // The same arrays and the same function for a card from one render to the
  // next, so the card is not drawn again.
  const byHunk = comments?.partition.byHunk
  const threadsOf = useMemo(
    () =>
      new Map(
        graph.nodes.map((n) => [n.id, n.hunkIds.flatMap((id) => byHunk?.get(id) ?? NO_THREADS)]),
      ),
    [graph, byHunk],
  )
  // A thread on a file, not on a line, is on one card of the file: the card
  // with the first lines.
  const byFile = comments?.partition.byFile
  const fileThreadsOf = useMemo(() => {
    const out = new Map<string, ReviewThread[]>()
    if (!byFile) return out
    const first = new Map<string, GraphNode>()
    const top = (n: GraphNode) => n.lines.find((l) => l.newNo !== null)?.newNo ?? 0
    for (const n of graph.nodes) {
      const now = first.get(n.path)
      if (!now || top(n) < top(now)) first.set(n.path, n)
    }
    for (const [path, node] of first) {
      const threads = byFile.get(path)
      if (threads && threads.length > 0) out.set(node.id, threads)
    }
    return out
  }, [graph, byFile])
  const hunksOf = useMemo(
    () =>
      new Map(graph.nodes.map((n) => [n.id, n.hunkIds.flatMap((id) => hunkById.get(id) ?? [])])),
    [graph, hunkById],
  )
  // The marks of the changed lines of each card: the marks of lines that
  // the list uses for a part of a hunk. A card can have a part of a hunk,
  // and a hunk can have lines of two cards, so a card is read line by line.
  const marksOf = useMemo(() => {
    const lineKey = (l: DiffLine) => `${l.kind}:${l.oldNo}:${l.newNo}`
    const all = new Map<string, string[]>()
    for (const n of graph.nodes) {
      const own = new Set(n.lines.filter((l) => l.kind !== 'context').map(lineKey))
      const marks = (hunksOf.get(n.id) ?? []).flatMap((hunk) => {
        const rows = new Set<number>()
        for (const [i, line] of hunk.lines.entries()) if (own.has(lineKey(line))) rows.add(i)
        return changedLineMarks(hunk, rows)
      })
      if (marks.length > 0) all.set(n.id, marks)
    }
    return all
  }, [graph, hunksOf])
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
  // The cards that show their threads, and the switch for all the cards.
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
  // On at the start: a comment is a part of the review, so it is in the view.
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

  const shown = useMemo(() => {
    const nodes = graph.nodes.filter((n) => !hidden.has(n.realm) && (showRemoved || !n.removed))
    const ids = new Set(nodes.map((n) => n.id))
    return {
      nodes,
      edges: [...graph.edges, ...agentEdges].filter(
        (e) => ids.has(e.from) && ids.has(e.to) && (e.kind === 'call' || !hiddenHops.has(e.kind)),
      ),
    }
  }, [graph, agentEdges, hidden, hiddenHops, showRemoved])
  // The steps of the outline: the cards are in one group for each step, in
  // place of the groups of the repo. A card is in the first step that holds
  // a line of it.
  // The page gives the steps only in the Layers tab, so that tab is the
  // switch: the graph has no button for it.
  const grouped = steps.length > 0
  const stepsOf = useMemo(() => stepsOfCards(graph.nodes, steps), [graph, steps])
  const active = steps.find((st) => st.key === activeStep)
  const activeName = active ? stepName(active) : null
  // The color of a step: the one that the agent gave, or one of the palette
  // by the place of the step.
  const stepColor = (name: string): string => {
    const i = steps.findIndex((st) => stepName(st) === name)
    const given = steps[i]?.color
    if (given) return COLOR_RGB[given]
    // Not a color that the agent gave to a different step.
    const taken = new Set(steps.map((st) => st.color))
    const free = COLOR_ORDER.filter((c) => !taken.has(c))
    const palette = free.length > 0 ? free : COLOR_ORDER
    const nth = steps.slice(0, Math.max(0, i)).filter((st) => !st.color).length
    return COLOR_RGB[palette[nth % palette.length] ?? 'blue']
  }
  const boxColor = (step: string, title: string): string => {
    const find = (boxes: readonly LayerBox[] | undefined): LayerColor | undefined => {
      for (const b of boxes ?? []) {
        if (b.title === title && b.color) return b.color
        const inner = find(b.boxes)
        if (inner) return inner
      }
      return undefined
    }
    const given = find(steps.find((st) => stepName(st) === step)?.boxes)
    return given ? COLOR_RGB[given] : stepColor(step)
  }
  // A card with lines of two or more steps: the names of the other steps.
  const alsoIn = (id: string): string | undefined => {
    const own = stepsOf.get(id)
    if (!grouped || own === undefined || own.length < 2) return undefined
    return own
      .slice(1)
      .map((st) => st.number ?? st.title)
      .join(', ')
  }
  const measured = shown.nodes.every((n) => heights.has(n.id))
  // The layout is from the ELK engine: it puts the cards in an order that
  // makes the arrows cross as little as possible, and it gives a route for
  // each arrow around the cards. It is not immediate, so it is state. If the
  // engine fails, the layout of `layout.ts` is used, with no routes.
  const [layout, setLayout] = useState<
    (RealmLayout<string> & { routes?: Map<string, Point[]> }) | null
  >(null)
  // The last layout, with what it was made from.
  const [layoutError, setLayoutError] = useState<string | null>(null)
  const placed = useRef<{
    shape: string
    layout: RealmLayout<string> & { routes?: Map<string, Point[]> }
    heights: Map<string, number>
  } | null>(null)
  useEffect(() => {
    if (!measured) {
      placed.current = null
      setLayout(null)
      return
    }
    let cancelled = false
    // With the steps of the outline: one column for each step, in the order
    // of the outline, and the realms are the groups inside a column.
    const columns = grouped
      ? [...steps.map(stepName), stepName(OTHER_STEP)]
      : (REALMS as readonly string[])
    const cards = shown.nodes.map((n) => ({
      id: n.id,
      realm: grouped ? stepName(stepsOf.get(n.id)?.[0] ?? OTHER_STEP) : n.realm,
      // The logic and the headers are in one inner box for each group. In a
      // step of the outline, the only boxes are the ones that the agent made.
      group: grouped
        ? undefined
        : n.realm === 'tests'
          ? undefined
          : n.between
            ? contractGroup(n.between[0], n.between[1])
            : n.group,
      // Inside the group: the boxes of the repo, or of the agent.
      path: grouped
        ? (n.agent?.box !== undefined
            ? boxByTitle(stepsOf.get(n.id)?.[0]?.boxes, n.agent.box)
            : boxChain(stepsOf.get(n.id)?.[0]?.boxes, n)
          )?.map((b) => b.title)
        : n.realm !== 'tests' && !n.between
          ? repo.boxes(n.path, n.cls)
          : undefined,
      width: cardWidth(n, char),
      height: heights.get(n.id) ?? 0,
    }))
    const edges = shown.edges.map((e) => ({
      key: edgeKey(e),
      from: e.from,
      to: e.to,
      // An arrow leaves its card at the line of the call, and it enters
      // the target at its header.
      fromY: callOffset(e.line, tops.get(e.from)),
      toY: HEADER / 2,
    }))
    // The same cards, boxes and arrows as the last layout, and only a few
    // cards with a new height (the reviewer shows more lines of a card):
    // each card keeps its place, and the cards below the new height move.
    // A new run of the engine would put the cards in new places.
    const shape = JSON.stringify([
      columns,
      grouped,
      cards.map((c) => [c.id, c.realm, c.group, c.path, c.width]),
      edges.map((e) => e.key),
    ])
    const last = placed.current
    if (last !== null && last.shape === shape) {
      const changed = new Map(
        cards.filter((c) => last.heights.get(c.id) !== c.height).map((c) => [c.id, c.height]),
      )
      if (changed.size === 0) return
      if (changed.size <= RESIZE_MOST) {
        const next = resizeInPlace(last.layout, changed, edges, LAYOUT_MARGIN)
        placed.current = {
          shape,
          layout: next,
          heights: new Map(cards.map((c) => [c.id, c.height])),
        }
        // The view stays where it is: the reviewer reads the card.
        fitted.current = true
        setLayout(next)
        return
      }
    }
    layoutRouted(columns, cards, edges, grouped)
      .then((next) => {
        if (cancelled) return
        placed.current = {
          shape,
          layout: next,
          heights: new Map(cards.map((c) => [c.id, c.height])),
        }
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
  }, [shown, heights, measured, char, repo, tops, grouped, stepsOf, steps])
  const toggleRealm = (realm: Realm) => {
    fitted.current = false
    setSelected(null)
    setHidden((prev) => {
      const next = new Set(prev)
      if (!next.delete(realm)) next.add(realm)
      return next
    })
  }

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
  /** Move the view so that these boxes are all in it. */
  const fitBoxes = useCallback(
    (boxes: readonly { x: number; y: number; width: number; height: number }[]) => {
      const el = canvas.current
      if (!el || boxes.length === 0) return
      const x0 = Math.min(...boxes.map((b) => b.x))
      const y0 = Math.min(...boxes.map((b) => b.y))
      const x1 = Math.max(...boxes.map((b) => b.x + b.width))
      const y1 = Math.max(...boxes.map((b) => b.y + b.height))
      const pad = 96
      const k = Math.max(
        MIN_ZOOM,
        Math.min(1, (el.clientWidth - pad) / (x1 - x0), (el.clientHeight - pad) / (y1 - y0)),
      )
      glideTo({
        k,
        x: el.clientWidth / 2 - ((x0 + x1) / 2) * k,
        y: el.clientHeight / 2 - ((y0 + y1) / 2) * k,
      })
    },
    [glideTo],
  )
  // From far, the code of a card is too small to read. Then a name is on
  // each card, and when the names of the cards are too small too, one name is
  // on the box around them. The name is the one in the top left corner of the
  // card or of the box. The boxes and the cards make a tree by their places.
  const farTree = useMemo(
    () => (layout ? farTreeOf(layout, shown.nodes, grouped, repo) : []),
    [layout, shown, grouped, repo],
  )
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
   * The color of a box, from the diff of the cards in it. A group of Diffo:
   * green for added lines, red for removed lines, a mix between them. The
   * outer boxes of Diffo keep their own colors. A step or a box of the
   * agent keeps the color of the agent, but one that mostly removes code is
   * red.
   */
  const tintOf = (key: string): string | undefined => {
    const item = farByKey.get(key)
    if (!item) return undefined
    // A card: the color of its own diff, in the two views.
    if (item.card) return diffRgb(item.add, item.del)
    if (item.step !== undefined) {
      if (mostlyRemoved(item)) return COLOR_RGB.red
      return item.box !== undefined ? boxColor(item.step, item.box) : stepColor(item.step)
    }
    return key.startsWith('realm:') ? undefined : diffRgb(item.add, item.del)
  }
  const tintStyle = (key: string): React.CSSProperties => {
    const tint = tintOf(key)
    return tint === undefined ? {} : ({ '--realm': tint } as React.CSSProperties)
  }
  // The view fits the graph by itself until the reviewer moves it: a card
  // can get a new size after the first layout (its tokens, its threads), and
  // the layout then changes. With an active step of the outline, the view
  // fits the cards of that step. A new active step fits again.
  const seenStep = useRef<string | null>(null)
  useEffect(() => {
    if (!layout) return
    const stepChanged = grouped && activeStep !== seenStep.current
    if (fitted.current && !stepChanged) return
    seenStep.current = grouped ? activeStep : null
    fitted.current = false
    // With an active step: its column.
    const column =
      grouped && activeName !== null ? layout.realms.find((r) => r.realm === activeName) : undefined
    if (column) fitBoxes([column])
    else fitView()
  }, [grouped, layout, activeStep, activeName, fitBoxes, fitView])
  // A click on a file in the tree: the view goes to the cards of that file,
  // and they have a mark until a card is selected.
  const [litPath, setLitPath] = useState<string | null>(null)
  const pickedN = pickedFile?.n
  const seenPick = useRef(pickedN)
  useEffect(() => {
    if (pickedFile == null || pickedN === seenPick.current || !layout) return
    seenPick.current = pickedN
    const el = canvas.current
    const boxes = shown.nodes
      .filter((n) => n.path === pickedFile.path)
      .flatMap((n) => layout.at.get(n.id) ?? [])
    if (!el || boxes.length === 0) {
      setLitPath(null)
      return
    }
    setLitPath(pickedFile.path)
    setSelected(null)
    fitted.current = true
    fitBoxes(boxes)
  }, [pickedFile, pickedN, layout, shown, fitBoxes])
  // A click on a thread in the list of threads: the cards of its hunk show
  // their threads, and the view goes to the comment, at a zoom where the
  // text is easy to read.
  const threadN = pickedThread?.n
  const seenThread = useRef(threadN)
  useEffect(() => {
    if (pickedThread == null || threadN === seenThread.current || !layout) return
    const has = (list: ReviewThread[] | undefined) =>
      (list ?? NO_THREADS).some((t) => t.id === pickedThread.id)
    const cards = shown.nodes.filter(
      (n) => has(threadsOf.get(n.id)) || has(fileThreadsOf.get(n.id)),
    )
    seenThread.current = threadN
    const first = cards[0]
    if (first === undefined) {
      // A thread on a file, not on a line: the view goes to the cards of
      // the file, and they get a mark.
      const boxes = shown.nodes
        .filter((n) => n.path === pickedThread.path)
        .flatMap((n) => layout.at.get(n.id) ?? [])
      if (boxes.length === 0) return
      setLitPath(pickedThread.path)
      setSelected(null)
      setOpenLevel(0)
      fitted.current = true
      fitBoxes(boxes)
      return
    }
    for (const card of cards) onThreads(card.id, true)
    setSelected(first.id)
    setFocusKey(`card:${first.id}`)
    setLitPath(null)
    // Each box is open, so the card is in the view.
    setOpenLevel(0)
    fitted.current = true
    let frame = 0
    // The comment is in the page only after the card shows its threads.
    const seek = (tries: number) => {
      const el = canvas.current
      const row = el?.querySelector(`[data-thread-id="${CSS.escape(pickedThread.id)}"]`)
      if (!el || !row) {
        if (tries > 0) frame = requestAnimationFrame(() => seek(tries - 1))
        else fitCard(first.id)
        return
      }
      const at = row.getBoundingClientRect()
      const frameBox = el.getBoundingClientRect()
      const v = viewRef.current
      // The place of the comment in the graph, from its place on the screen.
      const x = (at.left + at.width / 2 - frameBox.left - v.x) / v.k
      const y = (at.top - frameBox.top - v.y) / v.k
      glideTo({ k: 1, x: frameBox.width / 2 - x, y: frameBox.height / 3 - y })
    }
    frame = requestAnimationFrame(() => seek(30))
    return () => cancelAnimationFrame(frame)
  }, [
    pickedThread,
    threadN,
    layout,
    shown,
    threadsOf,
    fileThreadsOf,
    onThreads,
    fitCard,
    fitBoxes,
    glideTo,
  ])

  const hasCanvas = graph !== null && graph.nodes.length > 0
  // The wheel zooms at the pointer, and so does a pinch on a trackpad. With
  // shift, the wheel moves the view. The listener is not passive, so the page
  // does not scroll too.
  useEffect(() => {
    const el = canvas.current
    if (!el || !hasCanvas) return
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
    // The canvas is in the page only after the graph has nodes.
  }, [hasCanvas, stopGlide])

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
  // fill most of it, from the outer one to the inner one. The breadcrumb and
  // the outline show it.
  const here = useMemo(() => {
    const el = canvas.current
    if (!el) return []
    const cx = (el.clientWidth / 2 - view.x) / view.k
    const cy = (el.clientHeight / 2 - view.y) / view.k
    return farItems
      .filter(
        (i) =>
          !i.card &&
          i.name !== '' &&
          cx >= i.x &&
          cy >= i.y &&
          cx <= i.x + i.width &&
          cy <= i.y + i.height &&
          (i.width * view.k >= el.clientWidth * 0.6 || i.height * view.k >= el.clientHeight * 0.6),
      )
      .sort((a, b) => b.width * b.height - a.width * a.height)
  }, [farItems, view])
  /** Goes to a box: fits it and shows the level below it. */
  const goBox = (key: string) => {
    const box = farByKey.get(key)
    if (!box) return
    fitted.current = true
    fitBoxes([box])
    if (overlay) setOpenLevel(Math.min(farNames.most, box.depth + 1))
    setFocusKey(null)
  }
  /** Goes to the full graph. */
  const goAll = () => {
    setOpenLevel(0)
    setSelected(null)
    setFocusKey(null)
    fitView()
  }
  /** Goes to a card: selects it and fits it. */
  const goCard = (id: string) => {
    setSelected(id)
    setFocusKey(`card:${id}`)
    setLitPath(null)
    setSide('out')
    setCameFrom(null)
    setOpenLevel(0)
    fitCard(id)
  }
  // The rows of the outline that show what is in them.
  const [outlineOpen, setOutlineOpen] = useState<ReadonlySet<string>>(new Set())
  // The place of the outline in the left rail of the page. It is there only
  // with the graph of the Files tab.
  const [slot, setSlot] = useState<HTMLElement | null>(null)
  useLayoutEffect(() => {
    const el = textSide === 'head' ? document.getElementById(OUTLINE_SLOT) : null
    if (el !== slot) setSlot(el)
  })
  const onPointerDown = (e: React.PointerEvent) => {
    const target = e.target as Element
    if (
      e.button !== 0 ||
      target.closest(
        'button, .graph-panel, .graph-crumbs, .graph-key, .graph-zoom, td.line-no, .thread-row, .file-threads, .hunk-boundary, textarea, input',
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
        '[data-node], [data-zoom-to], button, .graph-panel, .graph-crumbs, .graph-key, .graph-zoom',
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
    const box = from.box === null ? undefined : farByKey.get(from.box)
    if (box) {
      fitted.current = true
      fitBoxes([box])
      // The click also shows the level below the box, and only that one:
      // the box is open, and each box in it is closed. A second click in
      // the same box gives the same view.
      // With no overlay, the click only fits the box.
      if (overlay) setOpenLevel(Math.min(farNames.most, box.depth + 1))
      setFocusKey(null)
      return
    }
    setSelected(from.node)
    setFocusKey(from.node === null ? null : `card:${from.node}`)
    setLitPath(null)
    setSide('out')
    setCameFrom(null)
    if (from.node !== null) fitCard(from.node)
  }

  // To follow the arrows of the selected card. Each arrow has a number at the
  // place where it meets the card. A click on a number goes to the card at the
  // other end. The Right key makes the arrows that leave the card the active
  // side, and the Left key those that come in. A number key follows the arrow
  // with that number on the active side. When the side has one arrow, the Left
  // or Right key follows it. After a step out, the Left key is the return: it
  // goes back to the card that the step came from. On a card with two or more
  // callers, the first Left shows their numbers and the second is the return.
  const [side, setSide] = useState<Direction>('out')
  // The card of the step before: its number has a mark.
  const [cameFrom, setCameFrom] = useState<string | null>(null)
  const links = useMemo(() => {
    const make = (dir: Direction): Link[] => {
      const found = new Map<string, Link>()
      for (const e of shown?.edges ?? []) {
        if ((dir === 'out' ? e.from : e.to) !== selected) continue
        const other = dir === 'out' ? e.to : e.from
        if (other === selected) continue
        const link = found.get(other)
        if (link === undefined) found.set(other, { id: other, kinds: [e.kind], line: e.line })
        else if (!link.kinds.includes(e.kind)) link.kinds.push(e.kind)
      }
      return [...found.values()].sort((a, b) => a.line - b.line)
    }
    return selected === null ? { out: [], in: [] } : { out: make('out'), in: make('in') }
  }, [shown, selected])
  const follow = useCallback(
    (id: string, dir: Direction) => {
      // A step out adds to the path of the return. A step to a caller starts
      // a new path.
      setCameFrom(selected)
      setSide(dir)
      setSelected(id)
      fitCard(id)
    },
    [fitCard, selected],
  )
  // Right is for the calls of the card, Left for its returns: the cards that
  // call it. The two keys do the same on their side: with one arrow they
  // follow it, with more they make the numbers of the side active.
  const turn = useCallback(
    (dir: Direction) => {
      const only = links[dir].length === 1 ? links[dir][0] : undefined
      if (only) follow(only.id, dir)
      else setSide(dir)
    },
    [links, follow],
  )
  useEffect(() => {
    if (picked === null) return
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
  }, [picked, links, follow, turn, side])
  // The card that the Up and the Down keys went to.
  const [focusKey, setFocusKey] = useState<string | null>(null)
  // One order of all the cards of the change, for the Up and the Down keys:
  // card by card in a group, group by group in the group around it, then
  // the next outer group. In a box, the cards and the boxes are in the order
  // of their places, from the top. With an order of the agent in a step,
  // the cards of that order are first in the step.
  const linear = useMemo(() => readingOrder(farTree, agentOrder), [farTree, agentOrder])
  const stepTo = useCallback(
    (down: boolean) => {
      if (linear.length === 0) return
      const at = selected === null ? -1 : linear.indexOf(selected)
      let next: string | undefined
      if (at !== -1) {
        next = linear[at + (down ? 1 : -1)]
      } else {
        // No card is selected: the first card of the box where the reviewer
        // is, or the first card of the change.
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
      setLitPath(null)
      setSide('out')
      setCameFrom(null)
      // Each box is open, so the card is in the view.
      setOpenLevel(0)
      fitCard(next)
    },
    [linear, selected, here, farByKey, fitCard],
  )
  useEffect(() => {
    if (!hasCanvas) return
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
  }, [hasCanvas, stepTo])
  // The moves between levels, as the last render made them: the listener of
  // the keys stays the same one.
  const levelUp = useRef<() => boolean>(() => false)
  const levelDown = useRef<() => boolean>(() => false)
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
    if (here.length === 0) return false
    const up = here[here.length - 2]
    if (up) goBox(up.key)
    else goAll()
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

  const hereKey = picked !== null ? `card:${picked}` : here[here.length - 1]?.key
  /** One row of the outline, and the rows of what is in it. */
  const outlineRows = (item: FarItem, depth: number): React.ReactNode => {
    // An outer row shows its groups at the start. Its cards, and what is
    // in each other row, show after a click on the fold mark.
    const opened = outlineOpen.has(item.key)
    const hasCards = item.children.some((c) => c.card)
    const foldable = depth === 0 ? hasCards : item.children.length > 0
    const realm = !item.card && item.key.startsWith('realm:') && !grouped ? item.realm : undefined
    return (
      <div key={item.key}>
        <div
          className={`graph-outline-row${item.key === hereKey ? ' graph-outline-here' : ''}${
            item.card ? ' graph-outline-card' : ''
          }`}
          style={{ paddingLeft: 6 + depth * 12 }}
        >
          {item.card || !foldable ? (
            <span className="graph-outline-fold" />
          ) : (
            <button
              type="button"
              className="graph-outline-fold"
              aria-label={`${opened ? 'Hide' : 'Show'} what is in ${item.name}`}
              aria-expanded={opened}
              onClick={() =>
                setOutlineOpen((prev) => {
                  const next = new Set(prev)
                  if (!next.delete(item.key)) next.add(item.key)
                  return next
                })
              }
            >
              {opened ? '▾' : '▸'}
            </button>
          )}
          <span
            className={`graph-outline-dot${realm ? ` graph-realm-${realm}` : ''}`}
            style={tintStyle(item.key)}
          />
          <button
            type="button"
            className="graph-outline-name"
            title={item.name}
            onClick={() => (item.card ? goCard(item.key.slice('card:'.length)) : goBox(item.key))}
          >
            {item.name || '(no name)'}
          </button>
          <span className="graph-outline-count">
            {item.add > 0 && <span className="graph-add">+{item.add}</span>}
            {item.del > 0 && <span className="graph-del"> −{item.del}</span>}
          </span>
          {realm !== undefined && (GROUP_REALMS as readonly string[]).includes(realm) && (
            <button
              type="button"
              className="graph-outline-eye"
              aria-label={`Hide ${item.name}`}
              data-tip="Hide this group"
              onClick={() => toggleRealm(realm as Realm)}
            >
              hide
            </button>
          )}
        </div>
        {[...item.children]
          .filter((child) => opened || (depth === 0 && !child.card))
          .sort((a, b) => Number(a.card) - Number(b.card) || a.y - b.y || a.x - b.x)
          .map((child) => outlineRows(child, depth + 1))}
      </div>
    )
  }
  if (layoutError !== null) {
    return <p className="graph-note graph-note-side">The graph has no layout: {layoutError}</p>
  }
  if (graph.nodes.length === 0) {
    return (
      <p className="graph-note graph-note-side">
        {title ? `${title}: ` : ''}These files have no change that the graph can show.
      </p>
    )
  }
  const removedCount = graph.nodes.filter((n) => n.removed).length
  const byId = new Map(graph.nodes.map((n) => [n.id, n]))
  const selectedBox = picked !== null ? layout?.at.get(picked) : undefined
  const count = (realm: Realm) => graph.nodes.filter((n) => n.realm === realm && !n.schema).length
  const hopCount = (kind: string) =>
    [...graph.edges, ...agentEdges].filter((e) => e.kind === kind).length
  const kindOf = new Map(kinds.map((k) => [k.id, k]))
  const logic = graph.nodes.filter((n) => n.tested !== undefined)
  const untested = logic.filter((n) => n.tested === 'none').length
  return (
    <div
      className="graph-canvas"
      ref={canvas}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
    >
      {title && <span className="graph-side-name">{title}</span>}
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
            <span className="graph-crumb graph-crumb-card">
              {farByKey.get(`card:${picked}`)?.name ?? ''}
            </span>
          </span>
        )}
      </nav>
      {/* The switches of the view, at the top right. */}
      <div className="graph-panel">
        <div className="graph-tools">
          {/* The Repo layer, when Diffo has the rules of this repository. Not
              with an outline of the agent: the two are not on together. */}
          {known !== plainRepo && !grouped && (
            <button
              type="button"
              className="pane-word graph-comments"
              aria-pressed={repoOn}
              data-tip={
                repoOn
                  ? `The rules of the ${known.name} repository are on: its groups, its connections, its libraries and its style. Press for the basic graph.`
                  : `Basic: what the diff and the language tell. Press to add the rules of the ${known.name} repository.`
              }
              onClick={onRepo}
            >
              Repo: {known.name}
            </button>
          )}
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
      {/* The arrows, at the bottom left: a sample of each kind, its count,
          and a switch for each kind that is not a direct call. */}
      <div className="graph-key">
        <span className="graph-key-row">
          <svg className="graph-key-line" viewBox="0 0 30 8" aria-hidden="true">
            <path d="M1 4 H24 M19 1 L25 4 L19 7" />
          </svg>
          Call {shown.edges.filter((e) => e.kind === 'call').length}
        </span>
        {kinds
          .filter((kind) => hopCount(kind.id) > 0)
          .map((kind) => (
            <button
              key={kind.id}
              type="button"
              className="graph-key-row graph-key-switch"
              style={{ '--realm': kind.rgb } as React.CSSProperties}
              aria-pressed={!hiddenHops.has(kind.id)}
              data-tip={kind.tip}
              onClick={() =>
                setHiddenHops((prev) => {
                  const next = new Set(prev)
                  if (!next.delete(kind.id)) next.add(kind.id)
                  return next
                })
              }
            >
              <svg className="graph-key-line" viewBox="0 0 30 8" aria-hidden="true">
                <path d="M1 4 H24 M19 1 L25 4 L19 7" />
              </svg>
              {kind.name} {hopCount(kind.id)}
            </button>
          ))}
        {logic.length > 0 && (
          <span className="graph-key-row graph-key-note">
            No test calls {untested} of {logic.length} logic functions
          </span>
        )}
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
      {/* The outline of the graph, in the left rail of the page: each group
          with what is in it. A click goes to the box or the card. The eye
          hides a group. The row of the place of the reviewer has a mark. */}
      {slot &&
        createPortal(
          <div className="graph-outline">
            <div className="graph-outline-head">Graph</div>
            {farTree.map((root) => outlineRows(root, 0))}
            {!grouped &&
              GROUP_REALMS.filter((realm) => hidden.has(realm) && count(realm) > 0).map((realm) => (
                <div key={realm} className="graph-outline-row graph-outline-off">
                  <span className={`graph-outline-dot graph-realm-${realm}`} />
                  <span className="graph-outline-name">{REALM_NAME[realm]}</span>
                  <span className="graph-outline-count">{count(realm)}</span>
                  <button
                    type="button"
                    className="graph-outline-eye"
                    aria-label={`Show ${REALM_NAME[realm]}`}
                    data-tip="Show this group"
                    onClick={() => toggleRealm(realm)}
                  >
                    show
                  </button>
                </div>
              ))}
            {removedCount > 0 && (
              <div className={`graph-outline-row${showRemoved ? '' : ' graph-outline-off'}`}>
                <span className="graph-outline-dot graph-chip-removed" />
                <span className="graph-outline-name">Removed functions</span>
                <span className="graph-outline-count">{removedCount}</span>
                <button
                  type="button"
                  className="graph-outline-eye"
                  aria-label={`${showRemoved ? 'Hide' : 'Show'} the functions that the change removes`}
                  data-tip={`${showRemoved ? 'Hide' : 'Show'} the functions that the change removes completely`}
                  onClick={() => {
                    fitted.current = false
                    setSelected(null)
                    setShowRemoved((on) => !on)
                  }}
                >
                  {showRemoved ? 'hide' : 'show'}
                </button>
              </div>
            )}
          </div>,
          slot,
        )}
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
          {layout?.realms.map((r, ri) => (
            <div
              key={r.realm}
              // With the steps of the outline, the box is the column of a step.
              className={
                grouped
                  ? `graph-realm graph-step${r.realm === activeName ? ' graph-step-on' : ''}${hot(`realm:${ri}`)}`
                  : `graph-realm graph-realm-${r.realm}${hot(`realm:${ri}`)}`
              }
              style={{
                left: r.x,
                top: r.y,
                width: r.width,
                height: r.height,
                ...tintStyle(`realm:${ri}`),
              }}
            >
              <span className="graph-realm-name" hidden={farPlaces.has(`realm:${ri}`)}>
                {grouped ? r.realm : REALM_NAME[r.realm as Realm]}
              </span>
            </div>
          ))}
          {layout?.groups.map((g, i) =>
            g.level > 0 ? (
              <div
                // biome-ignore lint/suspicious/noArrayIndexKey: two boxes can have one name — position is the identity
                key={i}
                // A box of the agent has the color that the agent gave it, or
                // the color of its step.
                className={`${grouped ? 'graph-inner graph-box' : `graph-inner graph-tint graph-inner-${g.level}`}${hot(`group:${i}`)}`}
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
                  {boxName(g.group, g.level, grouped)}
                </span>
              </div>
            ) : (
              <div
                key={`${g.realm}:${g.group}`}
                className={`graph-entity graph-tint${g.group.includes('↔') ? ' graph-entity-contract' : ''}${hot(`group:${i}`)}`}
                style={{
                  left: g.x,
                  top: g.y,
                  width: g.width,
                  height: g.height,
                  ...tintStyle(`group:${i}`),
                }}
              >
                <span className="graph-entity-name" hidden={farPlaces.has(`group:${i}`)}>
                  {boxName(g.group, 0, grouped)}
                </span>
              </div>
            ),
          )}
        </div>
        {/* The cards of the file that a click in the tree picked: a mark
            around each one. Its border has the same width on the screen at
            each zoom, so it shows also when the graph is small. */}
        {litPath !== null &&
          shown.nodes
            .filter((n) => n.path === litPath)
            .map((n) => {
              const p = layout?.at.get(n.id)
              if (!p) return null
              const grow = 10 / Math.min(1, view.k)
              return (
                <div
                  key={`lit:${n.id}`}
                  className="graph-lit"
                  style={{
                    left: p.x - grow,
                    top: p.y - grow,
                    width: p.width + grow * 2,
                    height: p.height + grow * 2,
                    borderWidth: 3 / Math.min(1, view.k),
                    borderRadius: grow,
                  }}
                />
              )
            })}
        {shown.nodes.map((node) => {
          const p = layout?.at.get(node.id)
          return (
            <div
              key={node.id}
              className="graph-slot"
              style={{ left: p?.x ?? 0, top: p?.y ?? 0, width: cardWidth(node, char) }}
            >
              <Card
                node={node}
                open={open.has(node.id)}
                selected={selected === node.id}
                also={alsoIn(node.id)}
                threads={threadsOf.get(node.id) ?? NO_THREADS}
                hunks={hunksOf.get(node.id) ?? NO_HUNKS}
                comments={comments}
                showThreads={allThreads || threadsOn.has(node.id)}
                onThreads={onThreads}
                onToggle={onToggle}
                onOpen={onOpen}
                onHeight={onHeight}
                file={fileByPath.get(node.path)}
                side={textSide}
                viewed={viewedOf(node.id)}
                onViewed={onViewed}
                fileThreads={fileThreadsOf.get(node.id) ?? NO_THREADS}
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
            style={{ '--zoom': view.k } as React.CSSProperties}
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
            {shown.edges.map((e) => {
              const a = layout.at.get(e.from)
              const b = layout.at.get(e.to)
              const from = byId.get(e.from)
              if (!a || !b || !from) return null
              // The two ends are under one closed box: the arrow is not in
              // the view. The name of the box lets what is under it show.
              const over = allOpen ? undefined : farNames.under.get(`card:${e.from}`)
              if (over !== undefined && over === farNames.under.get(`card:${e.to}`)) return null
              // An arrow leaves the right side of its card and enters the left
              // side of its target. When the target is to the left (a reply
              // from the browser to the page), it goes the other way.
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
                  className={`graph-edge${e.added ? ' graph-edge-added' : ''}${
                    e.method === 'name' || e.method === 'open' ? ' graph-edge-name' : ''
                  }${e.kind !== 'call' ? ' graph-edge-kind' : ''}${
                    e.removed ? ' graph-edge-removed' : ''
                  }${
                    // Pale, so an arrow does not hide the code that it
                    // crosses. The arrows of the selected card are strong.
                    e.from === picked || e.to === picked
                      ? ' graph-edge-hot'
                      : // An arrow between two steps shows how the steps
                        // connect: it is not pale.
                        e.kind === AGENT.id ||
                          (grouped && stepsOf.get(e.from)?.[0] !== stepsOf.get(e.to)?.[0])
                        ? ' graph-edge-cross'
                        : ' graph-edge-dim'
                  }`}
                  style={
                    e.kind !== 'call'
                      ? ({ '--kind': kindOf.get(e.kind)?.rgb } as React.CSSProperties)
                      : undefined
                  }
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
              // An arrow to or from a contract card needs no label: the card has
              // the name.
              const to = byId.get(e.to)
              // A name only on the arrows of the selected card.
              // The name of an arrow of the agent is always there: it is
              // a part of what the agent tells.
              if (e.kind !== AGENT.id && e.from !== picked && e.to !== picked) return path
              if (e.kind === 'call' || from.schema || to?.schema) return path
              return (
                <g key={key}>
                  {path}
                  <text className="graph-edge-label" x={(x1 + x2) / 2} y={(y1 + y2) / 2 - 8}>
                    {e.kind === AGENT.id
                      ? (e.via ?? '')
                      : e.kind === 'callback'
                        ? e.method === 'open'
                          ? `given to ${e.via ?? 'a call'}`
                          : 'callback'
                        : `${kindOf.get(e.kind)?.name ?? e.kind} ${e.via ?? ''}`}
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
                className={`graph-far ${item.card ? 'graph-far-card' : 'graph-far-box'} graph-far-${item.shape}${
                  farPlaces.has(item.key) ? ' graph-far-on' : ''
                }${
                  item.key === focusKey ? ' graph-far-focus' : ''
                }${item.realm ? ` graph-realm-${item.realm}` : ''}`}
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
        {/* A number at each place where an arrow meets the selected card: the
            a click makes the step. The numbers of the active side are full,
            and a number key follows them. */}
        {picked !== null &&
          selectedBox &&
          (['out', 'in'] as const).flatMap((dir) => {
            const node = byId.get(picked)
            const taken = new Map<string, number>()
            return links[dir].map((link, i) => {
              const other = layout?.at.get(link.id)
              if (!node || !other) return null
              // The same ends as the arrow: it leaves the right side at the
              // line of the call, and enters the left side at the title. To a
              // card on the left, the sides are the other way.
              const back =
                dir === 'out'
                  ? other.x + other.width < selectedBox.x
                  : selectedBox.x + selectedBox.width < other.x
              // To a card above or below, the arrow is at the left.
              // With a route: the number is at the end of the route.
              const route = layout?.routes?.get(
                dir === 'out'
                  ? `${picked}>${link.id}:${link.line}`
                  : `${link.id}>${picked}:${link.line}`,
              )
              const end = route ? (dir === 'out' ? route[0] : route[route.length - 1]) : undefined
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
                  title={`${dir === 'out' ? 'Call: go to' : 'Return: go to'} ${nodeTitle(byId.get(link.id) ?? node)}${
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
            for the returns, Right is for the calls. */}
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
                  ? 'Left key: the cards that call this one, where it returns to'
                  : 'Right key: the cards that this one calls'
              }
              onClick={() => turn(dir)}
            >
              {dir === 'in' ? `← Return ${links.in.length}` : `Calls ${links.out.length} →`}
            </button>
          ))}
      </div>
    </div>
  )
}
