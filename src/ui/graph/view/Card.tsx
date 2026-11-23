import { memo, useLayoutEffect, useMemo, useRef } from 'react'
import type { ReviewThread } from '../../../shared/review.js'
import type { DiffLine, FileChange, Hunk } from '../../../shared/types.js'
import { GapBand, HunkCard } from '../../components/HunkCard.js'
import { MarkBox } from '../../components/MarkBox.js'
import { type ReviewComments, useGapExpansion } from '../../components/ReadingPane.js'
import { type ReviewActions, ThreadList } from '../../components/Threads.js'
import { threadsByLine } from '../../reviewPlacement.js'
import type { CanvasCard } from '../model.js'
import { FOLD, NO_THREADS } from './constants.js'
import { baseName } from './names.js'

export type Direction = 'out' | 'in'

/** A card that an arrow of the selected card leads to, or comes from. */
export interface Link {
  id: string
  line: number
}

/**
 * One card. Memoized: a pan or a zoom draws the canvas again on each frame,
 * and a card with the same props must not draw its lines again.
 */
export const Card = memo(function Card({
  node,
  open,
  selected,
  threads,
  hunks,
  comments,
  showThreads,
  onThreads,
  onToggle,
  onOpen,
  onHeight,
  file,
  viewed,
  onViewed,
  fileThreads,
}: {
  node: CanvasCard
  /** The threads on the file of the card, not on a line. One card of each
   * file has them: the list has them below the header of the file. */
  fileThreads: ReviewThread[]
  open: boolean
  selected: boolean
  /** The reviewer read the changed lines of the card. Null: the card has no
   * line that can have a mark, so it has no Viewed button. */
  viewed: boolean | null
  onViewed: (id: string) => void
  /** The threads on the hunks of the node. */
  threads: ReviewThread[]
  /** The hunks of the node: a comment on a line goes to its hunk. */
  hunks: readonly Hunk[]
  comments?: ReviewComments
  /** The threads show below their lines. */
  showThreads: boolean
  onThreads: (id: string, on?: boolean) => void
  onToggle: (id: string) => void
  onOpen: (hunkId: string) => void
  onHeight: (id: string, height: number, tops: [number, number][]) => void
  /** The file of the card in the review, when the review has it. */
  file: FileChange | undefined
}) {
  const ref = useRef<HTMLDivElement>(null)
  const folded = !open && node.lines.length > FOLD
  // The body of a card is the hunk card of the list view: its lines, its
  // comment box, its threads, its ranges and its gaps. Each run of lines of
  // the node with no gap in the line numbers is one hunk for it.
  const runs = useMemo(
    () => lineRuns(node, folded ? node.lines.slice(0, FOLD) : node.lines, hunks),
    [node, folded, hunks],
  )
  // The gaps need the head line numbers.
  const expandable = runs.every((r) => r.hunk.lines.some((l) => l.newNo !== null))
  const gapFile = useMemo(
    (): FileChange => ({
      ...(file ?? {
        path: node.path,
        oldPath: null,
        status: 'modified',
        kind: 'text',
        staged: false,
      }),
      hunks: expandable ? runs.map((r) => r.hunk) : [],
    }),
    [file, node.path, runs, expandable],
  )
  const { gaps, visible: opened, controlsFor } = useGapExpansion(gapFile)
  // A line of a gap of the card can be a line of a hunk of the change: a
  // line of a different card. Then it shows as the line of the diff that it
  // is, not as a line with no change. Memoized: a new array for each render
  // starts the tokens of the hunk card again.
  const visible = useMemo(() => {
    const real = new Map<number, DiffLine>()
    for (const h of file?.hunks ?? []) {
      for (const l of h.lines) if (l.newNo !== null) real.set(l.newNo, l)
    }
    const fix = (lines: DiffLine[]) => lines.map((l) => real.get(l.newNo ?? 0) ?? l)
    return new Map(
      [...opened].map(([key, v]) => [key, { top: fix(v.top), bottom: fix(v.bottom) }] as const),
    )
  }, [opened, file])
  const tailGap = gaps.find((g) => g.below === null)
  // A thread is on the run that has its line.
  const placed = runs.map((r) => {
    const stray = threadsByLine(r.hunk.lines, threads).get(-1) ?? NO_THREADS
    return threads.filter((t) => r.real && t.anchor.kind === 'hunk' && !stray.includes(t))
  })
  const count = placed.reduce((n, list) => n + list.length, 0) + fileThreads.length
  // A new comment shows the threads of the card.
  const actions = useMemo((): ReviewActions | undefined => {
    const all = comments?.actions
    if (!all) return undefined
    return {
      ...all,
      create: (...args) => {
        onThreads(node.id, true)
        return all.create(...args)
      },
    }
  }, [comments?.actions, onThreads, node.id])
  // The height of the card and the place of each line, for the layout and
  // for the ends of the arrows. Measured when the size of the card changes
  // (a thread, a comment box, the lines of a gap), not on each render.
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const measure = () => {
      // Where each line is, from the top of the card, by its line number.
      const box = el.getBoundingClientRect()
      const scale = el.offsetHeight > 0 ? box.height / el.offsetHeight : 1
      const tops: [number, number][] = []
      for (const row of el.querySelectorAll<HTMLElement>('tr.line')) {
        const cells = row.querySelectorAll('td.line-no')
        const no = Number((cells[1]?.textContent ?? '').replace(/\D/g, ''))
        if (no === 0) continue
        const r = row.getBoundingClientRect()
        tops.push([no, Math.round((r.top + r.height / 2 - box.top) / scale)])
      }
      onHeight(node.id, el.offsetHeight, tops)
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
  }, [node.id, onHeight])
  const hunkId = node.hunkIds[0]
  return (
    <div
      className={`graph-card${selected ? ' graph-card-selected' : ''}`}
      ref={ref}
      data-node={node.id}
    >
      <div
        className="graph-card-head"
        title={node.path ? `${node.title}\n${node.path}` : node.title}
      >
        <span className="graph-card-name">{node.title}</span>
        {node.tag !== undefined && (
          <span className="graph-card-tag">
            {node.tag === 'note' ? 'note of the agent' : 'outside the change'}
          </span>
        )}
        {node.path !== '' && <span className="graph-card-file">{baseName(node.path)}</span>}
        {count > 0 && (
          <button
            type="button"
            className="graph-card-threads"
            aria-pressed={showThreads}
            title={`${showThreads ? 'Hide' : 'Show'} the ${count} comment threads`}
            onClick={() => onThreads(node.id)}
          >
            {count}
          </button>
        )}
        {viewed !== null && (
          <button
            type="button"
            className="file-viewed-toggle graph-card-viewed"
            aria-pressed={viewed}
            title="mark the changed lines of this card read"
            onClick={() => onViewed(node.id)}
          >
            <MarkBox state={viewed} />
            Viewed
          </button>
        )}
        {hunkId !== undefined && (
          <button type="button" className="graph-card-open" onClick={() => onOpen(hunkId)}>
            Open in list
          </button>
        )}
      </div>
      {node.text !== undefined && node.text !== '' && (
        <p className="graph-card-note">{node.text}</p>
      )}
      {/* The threads on the file: the section of the list, with its parts. */}
      {showThreads && fileThreads.length > 0 && comments && (
        <div className="file-threads graph-card-file-threads">
          <ThreadList
            threads={fileThreads}
            actions={comments.actions}
            showContext
            agentConnected={comments.agentConnected}
            workingOn={comments.workingOn}
            queuedOn={comments.queuedOn}
          />
        </div>
      )}
      <div className="graph-card-code">
        {runs.map((r, k) => {
          const above = gaps.find((g) => g.below === k)
          const below = gaps.find((g) => g.above === k)
          return (
            <HunkCard
              key={r.start}
              hunk={r.hunk}
              viewMode="unified"
              linesAbove={above && visible.get(above.key)?.bottom}
              linesBelow={below && visible.get(below.key)?.top}
              gapAbove={above ? controlsFor(above) : null}
              threads={showThreads ? placed[k] : NO_THREADS}
              // Pale when read, as in the list.
              viewed={viewed === true}
              // A comment needs a hunk of the change. Code that the change
              // does not touch has none.
              reviewActions={r.real ? actions : undefined}
              agentConnected={comments?.agentConnected}
              workingOn={comments?.workingOn}
              queuedOn={comments?.queuedOn}
            />
          )
        })}
        {/* Not with folded lines: the lines after the fold are lines of the
            card, not of the gap. */}
        {tailGap && !folded && <GapBand gap={controlsFor(tailGap)} />}
      </div>
      {node.lines.length > FOLD && (
        <button type="button" className="graph-card-more" onClick={() => onToggle(node.id)}>
          {folded ? `Show ${node.lines.length - FOLD} more lines` : 'Show fewer lines'}
        </button>
      )}
    </div>
  )
})

/** A run of lines of a card with no gap in their line numbers, as a hunk. */
export interface LineRun {
  /** The place of the first line of the run in the lines of the node. */
  start: number
  hunk: Hunk
  /** The run is a part of a hunk of the change, and has its id: a comment on
   * a line of the run is a comment on that hunk. */
  real: boolean
}

export function sameLine(a: DiffLine, b: DiffLine): boolean {
  return a.kind === b.kind && a.oldNo === b.oldNo && a.newNo === b.newNo
}

/**
 * The runs of lines of a node. Each run is a part of one hunk of the change:
 * it has the id and the path of that hunk, and the start numbers of its own
 * first line.
 */
export function lineRuns(
  node: Pick<CanvasCard, 'id' | 'path'>,
  lines: readonly DiffLine[],
  hunks: readonly Hunk[],
): LineRun[] {
  const runs: LineRun[] = []
  let last: number | null = null
  let current: { start: number; lines: DiffLine[] } | null = null
  const close = () => {
    if (current === null) return
    const { start, lines: own } = current
    current = null
    const first = own[0]
    if (first === undefined) return
    const hunk = hunks.find((h) => h.lines.some((l) => sameLine(l, first)))
    // The numbers of the two sides at the first line of the run. In a hunk,
    // they come from the lines before it. A side with no line in the run has
    // the number of the line before, as git writes it.
    let oldAt = own.find((l) => l.oldNo !== null)?.oldNo ?? null
    let newAt = own.find((l) => l.newNo !== null)?.newNo ?? null
    if (hunk) {
      let o = hunk.oldStart + (hunk.lines.some((l) => l.kind !== 'add') ? 0 : 1)
      let n = hunk.newStart + (hunk.lines.some((l) => l.kind !== 'del') ? 0 : 1)
      for (const l of hunk.lines) {
        if (sameLine(l, first)) break
        if (l.kind !== 'add') o++
        if (l.kind !== 'del') n++
      }
      oldAt ??= o - 1
      newAt ??= n - 1
    }
    runs.push({
      start,
      real: hunk !== undefined,
      hunk: {
        id: hunk?.id ?? `${node.id}:${start}`,
        path: hunk?.path ?? node.path,
        oldStart: oldAt ?? newAt ?? 0,
        newStart: newAt ?? oldAt ?? 0,
        lines: own,
      },
    })
  }
  lines.forEach((line, i) => {
    if (line.newNo !== null && last !== null && line.newNo !== last + 1) close()
    if (current === null) current = { start: i, lines: [] }
    current.lines.push(line)
    if (line.newNo !== null) last = line.newNo
  })
  close()
  return runs
}
