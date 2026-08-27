import { Fragment, type ReactNode, useEffect, useMemo, useState } from 'react'
import type { ReviewThread } from '../../shared/review.js'
import type { DiffLine, Hunk } from '../../shared/types.js'
import { EXPAND_STEP } from '../gaps.js'
import { type LineTokens, tokenizeLines } from '../highlight.js'
import { useDarkMode } from '../hooks.js'
import { intralineRanges, type Range, splitByRanges } from '../intraline.js'
import { anchorForLine, threadsByLine } from '../reviewPlacement.js'
import { toSplitRows } from '../splitRows.js'
import { Icon } from './Icon.js'
import type { ViewMode } from './ReadingPane.js'
import { CommentBox, type ReviewActions, ThreadList } from './Threads.js'

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
  onComment?: (lineIdx: number) => void
  ranges?: (Range[] | null)[]
}

function CommentButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      className="line-comment-btn"
      title="comment on this line"
      aria-label="comment on this line"
      onClick={(e) => {
        e.stopPropagation()
        onClick()
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
  onComment,
  boundary,
}: { lines: DiffLine[]; tokens: (LineTokens | null)[]; boundary?: ReactNode } & LineExtras) {
  return (
    <table className="hunk-lines">
      <tbody>
        {boundary}
        {lines.map((line, i) => {
          const extra = extraFor?.(i)
          return (
            // biome-ignore lint/suspicious/noArrayIndexKey: the hunk is keyed by content, so its rows never reorder
            <Fragment key={i}>
              <tr className={`line line-${line.kind}`}>
                <td className="line-no">
                  {onComment && <CommentButton onClick={() => onComment(i)} />}
                  {line.oldNo ?? ''}
                </td>
                <td className="line-no">{line.newNo ?? ''}</td>
                <td className="line-marker">{MARKER[line.kind]}</td>
                <td className="line-code">
                  <CodeText line={line} tokens={tokens[i] ?? null} ranges={ranges?.[i]} />
                </td>
              </tr>
              {extra && (
                <tr className="thread-row">
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
  onComment,
  boundary,
}: { lines: DiffLine[]; tokens: (LineTokens | null)[]; boundary?: ReactNode } & LineExtras) {
  const rows = toSplitRows(lines)
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
              <tr className="line">
                <td className="line-no">
                  {onComment && row.left && (
                    <CommentButton onClick={() => onComment(row.left!.idx)} />
                  )}
                  {row.left?.line.oldNo ?? ''}
                </td>
                <td className={`line-half line-half-${row.left?.line.kind ?? 'empty'}`}>
                  {row.left && (
                    <CodeText
                      line={row.left.line}
                      tokens={tokens[row.left.idx] ?? null}
                      ranges={ranges?.[row.left.idx]}
                    />
                  )}
                </td>
                <td className="line-no">
                  {onComment && row.right && (
                    <CommentButton onClick={() => onComment(row.right!.idx)} />
                  )}
                  {row.right?.line.newNo ?? ''}
                </td>
                <td className={`line-half line-half-${row.right?.line.kind ?? 'empty'}`}>
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
                <tr className="thread-row">
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
  const [composerAt, setComposerAt] = useState<number | null>(null)

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
    setComposerAt(idx === -1 ? 0 : idx)
    onComposeHandled?.()
  }, [composeRequested])

  const lineThreads = threadsByLine(lines, threads)
  const strayThreads = lineThreads.get(-1) ?? []

  const composerFor = (idx: number): ReactNode => {
    if (!reviewActions) return null
    const anchor = anchorForLine(hunk.id, hunk.path, lines[idx]!)
    if (!anchor) return null
    const base = hunk.path.slice(hunk.path.lastIndexOf('/') + 1)
    const anchorFor = (wide: boolean) => (wide ? ({ kind: 'changeset' } as const) : anchor)
    return (
      <CommentBox
        title={`Comment on ${base}:${anchor.line}`}
        placeholder="Leave a comment…"
        scope={{ label: `${base}:${anchor.line}`, canWiden: true }}
        agentConnected={agentConnected}
        onSubmit={(text, wide, intent) => {
          void reviewActions.create(anchorFor(wide), text, intent)
          setComposerAt(null)
        }}
        onSend={(text, wide, intent) => {
          void reviewActions
            .create(anchorFor(wide), text, intent)
            .then((t) => reviewActions.send(t.id))
          setComposerAt(null)
        }}
        onCancel={() => setComposerAt(null)}
      />
    )
  }

  const extraFor = (idx: number): ReactNode => {
    const items = lineThreads.get(idx)
    const composer = composerAt === idx ? composerFor(idx) : null
    if (!items && !composer) return null
    return (
      <>
        {items && reviewActions && (
          <ThreadList
            threads={items}
            actions={reviewActions}
            agentConnected={agentConnected}
            workingOn={workingOn}
            queuedOn={queuedOn}
          />
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
          onComment={reviewActions ? setComposerAt : undefined}
          boundary={boundary}
        />
      ) : (
        <UnifiedLines
          lines={lines}
          tokens={tokens}
          ranges={ranges}
          extraFor={extraFor}
          onComment={reviewActions ? setComposerAt : undefined}
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
