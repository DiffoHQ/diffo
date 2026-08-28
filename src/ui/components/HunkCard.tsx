import { Fragment, type ReactNode, useEffect, useMemo, useState } from 'react'
import type { ReviewThread } from '../../shared/review.js'
import { anchorSpan, type ThreadIntent } from '../../shared/review.js'
import type { DiffLine, Hunk } from '../../shared/types.js'
import { EXPAND_STEP } from '../gaps.js'
import { type LineTokens, tokenizeLines } from '../highlight.js'
import { useDarkMode } from '../hooks.js'
import { intralineRanges, type Range, splitByRanges } from '../intraline.js'
import { anchorForRange, rangedRows, rangeStartRows, threadsByLine } from '../reviewPlacement.js'
import { toSplitRows } from '../splitRows.js'
import { Icon } from './Icon.js'
import type { ViewMode } from './ReadingPane.js'
import { CommentBox, type ReviewActions, ThreadList } from './Threads.js'

/** A run of rendered line indices, inclusive, in either order. */
interface LineSpan {
  start: number
  end: number
}

/**
 * The open composer's range, anchor-model: `at` is the row the composer was
 * opened on and never moves; `edge` is the other endpoint, free to walk up or
 * down — through `at` and out the far side. The rendered range is always
 * [min, max] of the two, and the composer card sits under the max.
 */
interface ComposeRange {
  at: number
  edge: number
}

/**
 * One hidden region's controls, owned by the file (a gap is shared between the two
 * hunks around it). `up` reveals lines glued to the hunk below the band, `down`
 * lines glued to the hunk above it — GitHub's expander semantics.
 */
export interface GapControls {
  /** Hidden lines not yet shown. */
  remaining: number
  canUp: boolean
  canDown: boolean
  /** Anything already revealed (shows the re-fold control). */
  expanded: boolean
  /** Fully open — the band collapses to a hairline. */
  merged: boolean
  failed: boolean
  onUp: () => void
  onDown: () => void
  onAll: () => void
  onCollapse: () => void
}

/** GitHub-style expander cluster: one unfold-all button when what's left fits a
 * step, otherwise a stacked pair (down over up, matching the regions they reveal). */
export function GapExpanders({ gap }: { gap: GapControls }) {
  if (gap.remaining <= 0) return null
  const act = (e: React.MouseEvent, fn: () => void) => {
    e.stopPropagation()
    fn()
  }
  if (gap.remaining <= EXPAND_STEP) {
    return (
      <span className="gap-x">
        <button
          type="button"
          className="gap-btn"
          title={`expand all (${gap.remaining} hidden ${gap.remaining === 1 ? 'line' : 'lines'})`}
          aria-label={`expand all ${gap.remaining} hidden lines`}
          onClick={(e) => act(e, gap.onAll)}
        >
          <Icon name="unfold" size="sm" />
        </button>
      </span>
    )
  }
  const both = gap.canUp && gap.canDown
  return (
    <span className={`gap-x${both ? ' gap-x-2' : ''}`}>
      {gap.canDown && (
        <button
          type="button"
          className="gap-btn"
          title={`expand down (${EXPAND_STEP} lines)`}
          aria-label="expand down"
          onClick={(e) => act(e, gap.onDown)}
        >
          <Icon name="down" size={both ? 'xs' : 'sm'} />
        </button>
      )}
      {gap.canUp && (
        <button
          type="button"
          className="gap-btn"
          title={`expand up (${EXPAND_STEP} lines)`}
          aria-label="expand up"
          onClick={(e) => act(e, gap.onUp)}
        >
          <Icon name="up" size={both ? 'xs' : 'sm'} />
        </button>
      )}
    </span>
  )
}

function FoldButton({ onCollapse }: { onCollapse: () => void }) {
  return (
    <button
      type="button"
      className="gap-fold"
      title="hide expanded lines"
      aria-label="hide expanded lines"
      onClick={(e) => {
        e.stopPropagation()
        onCollapse()
      }}
    >
      <Icon name="fold" size="sm" />
    </button>
  )
}

const EXPAND_FAILED = "couldn't read more context — the file may have changed since"

/** A gap with no hunk below it — the file tail — gets its own band after the last
 * card, since there is no hunk boundary to host the controls. */
export function GapBand({ gap }: { gap: GapControls }) {
  return (
    <div className="gap-band">
      <table className="hunk-lines">
        <tbody>
          <tr className={`hunk-boundary${gap.merged ? ' hunk-boundary-merged' : ''}`}>
            <td colSpan={4}>
              <span className="hunk-boundary-bar">
                {!gap.merged && <GapExpanders gap={gap} />}
                {(gap.merged || gap.expanded) && <FoldButton onCollapse={gap.onCollapse} />}
                {gap.failed && (
                  <span className="hunk-expand-failed" role="status">
                    {EXPAND_FAILED}
                  </span>
                )}
              </span>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  )
}

function useLineTokens(lines: DiffLine[], path: string): (LineTokens | null)[] {
  const dark = useDarkMode()
  const [tokens, setTokens] = useState<(LineTokens | null)[]>([])

  useEffect(() => {
    let cancelled = false
    const oldLines = lines.filter((l) => l.kind !== 'add')
    const newLines = lines.filter((l) => l.kind !== 'del')
    Promise.all([
      tokenizeLines(
        oldLines.map((l) => l.text),
        path,
        dark,
      ),
      tokenizeLines(
        newLines.map((l) => l.text),
        path,
        dark,
      ),
    ])
      .then(([oldTokens, newTokens]) => {
        if (cancelled) return
        let oldIdx = 0
        let newIdx = 0
        setTokens(
          lines.map((line) => {
            if (line.kind === 'add') return newTokens?.[newIdx++] ?? null
            if (line.kind === 'del') return oldTokens?.[oldIdx++] ?? null
            newIdx++
            return oldTokens?.[oldIdx++] ?? null
          }),
        )
      })
      .catch(() => {
        // A Shiki grammar failed to load — the lines render plain.
      })
    return () => {
      cancelled = true
    }
  }, [lines, path, dark])

  return tokens
}

function CodeText({
  line,
  tokens,
  ranges,
}: {
  line: DiffLine
  tokens: LineTokens | null
  ranges?: Range[] | null
}) {
  if (!tokens) {
    return (
      <>
        {splitByRanges(line.text, 0, ranges ?? null).map((piece, i) =>
          piece.changed ? (
            // biome-ignore lint/suspicious/noArrayIndexKey: pieces of one line — position is the identity
            <span key={i} className="word-changed">
              {piece.text}
            </span>
          ) : (
            // biome-ignore lint/suspicious/noArrayIndexKey: pieces of one line — position is the identity
            <span key={i}>{piece.text}</span>
          ),
        )}
      </>
    )
  }
  let offset = 0
  return (
    <>
      {tokens.map((t, i) => {
        const at = offset
        offset += t.content.length
        const style = t.color ? { color: t.color } : undefined
        const pieces = splitByRanges(t.content, at, ranges ?? null)
        if (pieces.length === 1 && !pieces[0]!.changed) {
          return (
            // biome-ignore lint/suspicious/noArrayIndexKey: tokens of one line — position is the identity
            <span key={i} style={style}>
              {t.content}
            </span>
          )
        }
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: tokens of one line — position is the identity
          <span key={i} style={style}>
            {pieces.map((piece, j) =>
              piece.changed ? (
                // biome-ignore lint/suspicious/noArrayIndexKey: pieces of one token — position is the identity
                <span key={j} className="word-changed">
                  {piece.text}
                </span>
              ) : (
                // biome-ignore lint/suspicious/noArrayIndexKey: pieces of one token — position is the identity
                <span key={j}>{piece.text}</span>
              ),
            )}
          </span>
        )
      })}
    </>
  )
}

const MARKER: Record<DiffLine['kind'], string> = { add: '+', del: '−', context: ' ' }

interface LineExtras {
  extraFor?: (lineIdx: number) => ReactNode
  /** Extra classes for the thread-row hosting extraFor's card(s) — carries the
   * range bracket's spine through the card row. */
  extraClass?: (lineIdx: number) => string
  onComment?: (lineIdx: number) => void
  /** Mousedown in a line-number gutter — where a range drag (or a shift-click
   * extension of the open composer) begins. */
  onGutterDown?: (lineIdx: number, shiftKey: boolean) => void
  /** The pointer crossed onto this line mid-drag. */
  onLineEnter?: (lineIdx: number) => void
  selRows?: ReadonlySet<number>
  rangeRows?: ReadonlySet<number>
  /** First row of each range thread — hosts the gutter glyph. */
  rangeStarts?: ReadonlySet<number>
  ranges?: (Range[] | null)[]
}

/** The at-rest shape saying "a range conversation starts on this line" — a glyph
 * survives every row tint where a colored bar drowns. Hidden while the row is
 * hovered so it never fights the comment button that appears in the same spot. */
function RangeGlyph() {
  return (
    <span className="line-range-glyph" aria-hidden="true">
      <Icon name="chat" size="sm" />
    </span>
  )
}

/** The selection / commented-range classes for a rendered row (split rows answer
 * for both halves). Leading space so it appends straight onto the base class. */
function rowClass(
  selRows: ReadonlySet<number> | undefined,
  rangeRows: ReadonlySet<number> | undefined,
  ...idxs: (number | undefined)[]
): string {
  const has = (set: ReadonlySet<number> | undefined) =>
    set !== undefined && idxs.some((i) => i !== undefined && set.has(i))
  return `${has(selRows) ? ' line-sel' : ''}${has(rangeRows) ? ' line-ranged' : ''}`
}

/** Left-button gutter presses start a drag; preventDefault keeps the browser from
 * beginning a text selection that would then smear across the code cells. */
function gutterDown(
  onGutterDown: ((lineIdx: number, shiftKey: boolean) => void) | undefined,
  idx: number,
): ((e: React.MouseEvent) => void) | undefined {
  if (!onGutterDown) return undefined
  return (e) => {
    if (e.button !== 0) return
    e.preventDefault()
    onGutterDown(idx, e.shiftKey)
  }
}

function CommentButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      className="line-comment-btn"
      title="comment on this line — drag down to take more lines"
      aria-label="comment on this line, or drag down to comment on a range"
      onClick={(e) => {
        e.stopPropagation()
        // A shift-click is a range extension, handled on mousedown by the gutter —
        // re-opening a single-line composer here would throw that range away.
        if (!e.shiftKey) onClick()
      }}
    >
      <Icon name="plus" size="sm" />
    </button>
  )
}

function UnifiedLines({
  lines,
  tokens,
  ranges,
  extraFor,
  extraClass,
  onComment,
  onGutterDown,
  onLineEnter,
  selRows,
  rangeRows,
  rangeStarts,
  boundary,
}: { lines: DiffLine[]; tokens: (LineTokens | null)[]; boundary?: ReactNode } & LineExtras) {
  return (
    <table className="hunk-lines">
      <tbody>
        {boundary}
        {lines.map((line, i) => {
          const extra = extraFor?.(i)
          const down = gutterDown(onGutterDown, i)
          return (
            // biome-ignore lint/suspicious/noArrayIndexKey: the hunk is keyed by content, so its rows never reorder
            <Fragment key={i}>
              <tr
                className={`line line-${line.kind}${rowClass(selRows, rangeRows, i)}`}
                onMouseEnter={onLineEnter ? () => onLineEnter(i) : undefined}
              >
                <td className="line-no" onMouseDown={down}>
                  {rangeStarts?.has(i) && <RangeGlyph />}
                  {onComment && <CommentButton onClick={() => onComment(i)} />}
                  {line.oldNo ?? ''}
                </td>
                <td className="line-no" onMouseDown={down}>
                  {line.newNo ?? ''}
                </td>
                <td className="line-marker">{MARKER[line.kind]}</td>
                <td className="line-code">
                  <CodeText line={line} tokens={tokens[i] ?? null} ranges={ranges?.[i]} />
                </td>
              </tr>
              {extra && (
                <tr className={`thread-row${extraClass?.(i) ?? ''}`}>
                  <td colSpan={4}>{extra}</td>
                </tr>
              )}
            </Fragment>
          )
        })}
      </tbody>
    </table>
  )
}

function SplitLines({
  lines,
  tokens,
  ranges,
  extraFor,
  extraClass,
  onComment,
  onGutterDown,
  onLineEnter,
  selRows,
  rangeRows,
  rangeStarts,
  boundary,
}: { lines: DiffLine[]; tokens: (LineTokens | null)[]; boundary?: ReactNode } & LineExtras) {
  const rows = toSplitRows(lines)
  // Each half of a split row is its own line, so the drag handlers ride the cells
  // rather than the row — crossing onto either half extends to that half's line.
  const enter = (idx: number | undefined) =>
    onLineEnter && idx !== undefined ? () => onLineEnter(idx) : undefined
  return (
    <table className="hunk-lines hunk-lines-split">
      {/* table-layout: fixed sizes columns from the first row, and that row is the
       * boundary's colSpan cell — which says nothing, leaving four equal quarters.
       * cols are consulted first, so they carry the real widths. */}
      <colgroup>
        <col className="split-col-no" />
        <col />
        <col className="split-col-no" />
        <col />
      </colgroup>
      <tbody>
        {boundary}
        {rows.map((row, i) => {
          const leftExtra = row.left ? extraFor?.(row.left.idx) : null
          const rightExtra =
            row.right && row.right.idx !== row.left?.idx ? extraFor?.(row.right.idx) : null
          return (
            // biome-ignore lint/suspicious/noArrayIndexKey: the hunk is keyed by content, so its rows never reorder
            <Fragment key={i}>
              <tr className={`line${rowClass(selRows, rangeRows, row.left?.idx, row.right?.idx)}`}>
                <td
                  className="line-no"
                  onMouseDown={row.left ? gutterDown(onGutterDown, row.left.idx) : undefined}
                  onMouseEnter={enter(row.left?.idx)}
                >
                  {row.left && rangeStarts?.has(row.left.idx) && <RangeGlyph />}
                  {onComment && row.left && (
                    <CommentButton onClick={() => onComment(row.left!.idx)} />
                  )}
                  {row.left?.line.oldNo ?? ''}
                </td>
                <td
                  className={`line-half line-half-${row.left?.line.kind ?? 'empty'}`}
                  onMouseEnter={enter(row.left?.idx)}
                >
                  {row.left && (
                    <CodeText
                      line={row.left.line}
                      tokens={tokens[row.left.idx] ?? null}
                      ranges={ranges?.[row.left.idx]}
                    />
                  )}
                </td>
                <td
                  className="line-no"
                  onMouseDown={row.right ? gutterDown(onGutterDown, row.right.idx) : undefined}
                  onMouseEnter={enter(row.right?.idx)}
                >
                  {row.right && rangeStarts?.has(row.right.idx) && <RangeGlyph />}
                  {onComment && row.right && (
                    <CommentButton onClick={() => onComment(row.right!.idx)} />
                  )}
                  {row.right?.line.newNo ?? ''}
                </td>
                <td
                  className={`line-half line-half-${row.right?.line.kind ?? 'empty'}`}
                  onMouseEnter={enter(row.right?.idx)}
                >
                  {row.right && (
                    <CodeText
                      line={row.right.line}
                      tokens={tokens[row.right.idx] ?? null}
                      ranges={ranges?.[row.right.idx]}
                    />
                  )}
                </td>
              </tr>
              {(leftExtra || rightExtra) && (
                <tr
                  className={`thread-row${
                    (leftExtra && row.left && extraClass?.(row.left.idx)) ||
                    (rightExtra && row.right && extraClass?.(row.right.idx)) ||
                    ''
                  }`}
                >
                  <td colSpan={4}>
                    {leftExtra}
                    {rightExtra}
                  </td>
                </tr>
              )}
            </Fragment>
          )
        })}
      </tbody>
    </table>
  )
}

export function HunkCard({
  hunk,
  fresh = false,
  changedSinceReview = false,
  changedSinceViewed = false,
  viewed = false,
  selected = false,
  onSelect,
  viewMode = 'unified',
  linesAbove,
  linesBelow,
  gapAbove = null,
  threads = [],
  reviewActions,
  agentConnected,
  workingOn,
  queuedOn,
  composeRequested = false,
  onComposeHandled,
}: {
  hunk: Hunk
  fresh?: boolean
  changedSinceReview?: boolean
  changedSinceViewed?: boolean
  /** Whether the whole *file* is read — the dim is a file-level verdict, so a ticked
   * hunk stays at full strength while any sibling is still unread. */
  viewed?: boolean
  selected?: boolean
  onSelect?: (hunkId: string) => void
  viewMode?: ViewMode
  /** Expanded context glued above / below the hunk — owned by the file, since a
   * gap's lines are shared with the neighbouring hunk. */
  linesAbove?: DiffLine[]
  linesBelow?: DiffLine[]
  /** Controls for the hidden region above this hunk; null when there is none. */
  gapAbove?: GapControls | null
  threads?: ReviewThread[]
  reviewActions?: ReviewActions
  agentConnected?: boolean
  workingOn?: ReadonlySet<string>
  queuedOn?: ReadonlyMap<string, number>
  composeRequested?: boolean
  onComposeHandled?: () => void
}) {
  // The open composer's range (anchor + free edge) and a drag still in flight.
  // The drag's press-point becomes the anchor, so the steppers and shift-click
  // keep adjusting relative to the line the reviewer actually chose.
  const [compose, setCompose] = useState<ComposeRange | null>(null)
  const [drag, setDrag] = useState<LineSpan | null>(null)

  // Memoized so `lines` keeps a stable identity across renders: once expanded, an
  // unmemoized `[...linesAbove, ...hunk.lines]` was a fresh array every render, which
  // retriggered the tokenizer effect → setTokens → render → forever.
  const lines = useMemo(() => {
    if ((linesAbove?.length ?? 0) === 0 && (linesBelow?.length ?? 0) === 0) return hunk.lines
    return [...(linesAbove ?? []), ...hunk.lines, ...(linesBelow ?? [])]
  }, [linesAbove, linesBelow, hunk.lines])
  const tokens = useLineTokens(lines, hunk.path)
  const ranges = useMemo(() => intralineRanges(lines), [lines])

  // biome-ignore lint/correctness/useExhaustiveDependencies: only a new request may reopen it
  useEffect(() => {
    if (!composeRequested) return
    const idx = lines.findIndex((l) => l.kind !== 'context')
    const at = idx === -1 ? 0 : idx
    setCompose({ at, edge: at })
    onComposeHandled?.()
  }, [composeRequested])

  // The composer's words live up here, not in the CommentBox: growing the range
  // downward moves the composer's row, which re-mounts the box — a draft it owned
  // would be eaten mid-sentence.
  const [draft, setDraft] = useState('')
  const [draftIntent, setDraftIntent] = useState<ThreadIntent | undefined>(undefined)
  const closeComposer = () => {
    setCompose(null)
    setDraft('')
    setDraftIntent(undefined)
  }

  // The drag lives until the button comes back up anywhere on the page — the
  // pointer routinely leaves the table mid-drag, so the listener is global.
  useEffect(() => {
    if (!drag) return
    const up = () => {
      setDrag(null)
      setCompose({ at: drag.start, edge: drag.end })
    }
    window.addEventListener('mouseup', up)
    return () => window.removeEventListener('mouseup', up)
  }, [drag])

  const onGutterDown = reviewActions
    ? (idx: number, shiftKey: boolean) => {
        // Shift-click puts the range's free edge on the clicked line — the anchor
        // (where the composer was opened) stays put, exactly like extending a text
        // selection from its origin. Fully reversible, so no line is ever lost.
        if (shiftKey && compose) {
          setCompose({ at: compose.at, edge: idx })
          return
        }
        setDrag({ start: idx, end: idx })
      }
    : undefined
  const onLineEnter = drag
    ? (idx: number) => setDrag((d) => (d && d.end !== idx ? { ...d, end: idx } : d))
    : undefined

  const lineThreads = threadsByLine(lines, threads)
  const strayThreads = lineThreads.get(-1) ?? []
  const rangeRows = useMemo(() => rangedRows(lines, threads), [lines, threads])
  const rangeStarts = useMemo(() => rangeStartRows(lines, threads), [lines, threads])
  // Hovering a range thread's card lights the rows it spans — the card sits under
  // the range's last line, and this is what ties it back to the rest of them. The
  // idx names which thread-row is hovered, so its own spine can light up too.
  const [hover, setHover] = useState<{ idx: number; rows: ReadonlySet<number> } | null>(null)
  const selRows = useMemo(() => {
    const span = drag ?? (compose ? { start: compose.at, end: compose.edge } : null)
    const rows = new Set<number>(hover?.rows ?? [])
    if (span) {
      for (let i = Math.min(span.start, span.end); i <= Math.max(span.start, span.end); i++) {
        rows.add(i)
      }
    }
    return rows
  }, [drag, compose, hover])

  const composerFor = (span: ComposeRange): ReactNode => {
    if (!reviewActions) return null
    const anchor = anchorForRange(hunk.id, hunk.path, lines, span.at, span.edge)
    if (!anchor) return null
    const base = hunk.path.slice(hunk.path.lastIndexOf('/') + 1)
    const label = `${base}:${anchorSpan(anchor)}`
    const anchorFor = (wide: boolean) => (wide ? ({ kind: 'changeset' } as const) : anchor)
    return (
      <CommentBox
        title={`Comment on ${label}`}
        placeholder="Leave a comment…"
        scope={{
          label,
          canWiden: true,
          adjust: {
            up: span.edge > 0 ? () => setCompose({ at: span.at, edge: span.edge - 1 }) : undefined,
            down:
              span.edge < lines.length - 1
                ? () => setCompose({ at: span.at, edge: span.edge + 1 })
                : undefined,
          },
        }}
        agentConnected={agentConnected}
        draft={draft}
        onDraft={setDraft}
        draftIntent={draftIntent}
        onDraftIntent={setDraftIntent}
        onSubmit={(text, wide, intent) => {
          void reviewActions.create(anchorFor(wide), text, intent)
          closeComposer()
        }}
        onSend={(text, wide, intent) => {
          void reviewActions
            .create(anchorFor(wide), text, intent)
            .then((t) => reviewActions.send(t.id))
          closeComposer()
        }}
        onCancel={closeComposer}
      />
    )
  }

  // The bracket's spine continues through the card's own row — muted at rest,
  // blue while that card is hovered (its spanned lines light up in step).
  const extraClass = (idx: number): string => {
    const items = lineThreads.get(idx)
    if (!items || rangedRows(lines, items).size === 0) return ''
    return ` thread-row-ranged${hover?.idx === idx ? ' thread-row-lit' : ''}`
  }

  const extraFor = (idx: number): ReactNode => {
    const items = lineThreads.get(idx)
    const composer =
      compose !== null && Math.max(compose.at, compose.edge) === idx ? composerFor(compose) : null
    if (!items && !composer) return null
    const spanned = items ? rangedRows(lines, items) : new Set<number>()
    return (
      <>
        {items && reviewActions && (
          // biome-ignore lint/a11y/noStaticElementInteractions: hover-only affordance — the lit range duplicates what the card's head already says in words
          <div
            className="thread-anchor-scope"
            onMouseEnter={spanned.size > 0 ? () => setHover({ idx, rows: spanned }) : undefined}
            onMouseLeave={spanned.size > 0 ? () => setHover(null) : undefined}
          >
            <ThreadList
              threads={items}
              actions={reviewActions}
              agentConnected={agentConnected}
              workingOn={workingOn}
              queuedOn={queuedOn}
            />
          </div>
        )}
        {composer}
      </>
    )
  }

  const sinceReview = changedSinceReview && !viewed
  const classes = ['hunk']
  if (sinceReview) classes.push('hunk-since-review')
  if (fresh) classes.push('hunk-fresh')
  if (viewed) classes.push('hunk-viewed')
  if (selected) classes.push('hunk-selected')

  const oldCount = hunk.lines.filter((l) => l.kind !== 'add').length
  const newCount = hunk.lines.filter((l) => l.kind !== 'del').length
  const merged = gapAbove?.merged ?? false
  // Since-review says nothing per hunk — the words live once in the file header;
  // here it is only the bar, named on hover.
  const badges = !sinceReview && changedSinceViewed && (
    <span className="hunk-badge">changed since you read it</span>
  )
  // A fully opened gap reads as continuous code: the band gives up its background,
  // borders and `@@` header, leaving a hairline with just the re-fold control.
  const boundary = (
    <tr
      className={`hunk-boundary${merged ? ' hunk-boundary-merged' : ''}`}
      title={sinceReview ? 'the agent changed this since your last review' : undefined}
    >
      <td colSpan={4}>
        <span className="hunk-boundary-bar">
          {gapAbove && !merged && <GapExpanders gap={gapAbove} />}
          {gapAbove && (merged || gapAbove.expanded) && (
            <FoldButton onCollapse={gapAbove.onCollapse} />
          )}
          {!merged && (
            <span className="hunk-at" title="hunk position in the file">
              @@ −{hunk.oldStart},{oldCount} +{hunk.newStart},{newCount} @@
              {hunk.context !== undefined && <span className="hunk-at-scope"> {hunk.context}</span>}
            </span>
          )}
          {gapAbove?.failed && (
            <span className="hunk-expand-failed" role="status">
              {EXPAND_FAILED}
            </span>
          )}
          {badges}
        </span>
      </td>
    </tr>
  )

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: selecting a hunk is also `J`/`K`
    // biome-ignore lint/a11y/useKeyWithClickEvents: selecting a hunk is also `J`/`K`
    <div className={classes.join(' ')} data-hunk-id={hunk.id} onClick={() => onSelect?.(hunk.id)}>
      {viewMode === 'split' ? (
        <SplitLines
          lines={lines}
          tokens={tokens}
          ranges={ranges}
          extraFor={extraFor}
          extraClass={extraClass}
          onComment={reviewActions ? (idx) => setCompose({ at: idx, edge: idx }) : undefined}
          onGutterDown={onGutterDown}
          onLineEnter={onLineEnter}
          selRows={selRows}
          rangeRows={rangeRows}
          rangeStarts={rangeStarts}
          boundary={boundary}
        />
      ) : (
        <UnifiedLines
          lines={lines}
          tokens={tokens}
          ranges={ranges}
          extraFor={extraFor}
          extraClass={extraClass}
          onComment={reviewActions ? (idx) => setCompose({ at: idx, edge: idx }) : undefined}
          onGutterDown={onGutterDown}
          onLineEnter={onLineEnter}
          selRows={selRows}
          rangeRows={rangeRows}
          rangeStarts={rangeStarts}
          boundary={boundary}
        />
      )}
      {strayThreads.length > 0 && reviewActions && (
        <ThreadList
          threads={strayThreads}
          actions={reviewActions}
          agentConnected={agentConnected}
          workingOn={workingOn}
          queuedOn={queuedOn}
        />
      )}
    </div>
  )
}
