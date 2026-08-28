import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { ReviewThread } from '../../shared/review.js'
import type { DiffLine, FileChange, Hunk } from '../../shared/types.js'
import { copyText } from '../clipboard.js'
import { changedLineCount, type StubReason, stubReason } from '../diffStub.js'
import { isFileViewed } from '../fileMarks.js'
import {
  EXPAND_STEP,
  fileGaps,
  type Gap,
  type GapExpansion,
  gapRemaining,
  gapSize,
  materializeGap,
  NO_EXPANSION,
} from '../gaps.js'
import { fileAnchor } from '../hooks.js'
import { EMPTY_DELTA, type LiveDelta } from '../liveDelta.js'
import type { ThreadPartition } from '../reviewPlacement.js'
import { GapBand, type GapControls, HunkCard } from './HunkCard.js'
import { Icon } from './Icon.js'
import { ImageDiff } from './ImageDiff.js'
import { MarkBox } from './MarkBox.js'
import { canPreviewMarkdown, MarkdownPreview } from './MarkdownPreview.js'
import { Menu, MenuItem } from './Menu.js'
import { PaneBar } from './PaneBar.js'
import { ReviewDone } from './ReviewDone.js'
import { type LandedNotice, ReviewLanded } from './ReviewLanded.js'
import { CommentBox, type ReviewActions, ThreadList } from './Threads.js'

export type ViewMode = 'unified' | 'split'

export interface PaneControls {
  navHidden?: boolean
  onToggleNav?: () => void
  left: number
  total: number
  query: string
  onClearQuery: () => void
  hiddenQuery: number
  hideReviewed: boolean
  onHideReviewed: (on: boolean) => void
  hideTests: boolean
  onHideTests: (on: boolean) => void
  testCount: number
  onlyChanged: boolean
  onOnlyChanged: (on: boolean) => void
  changedCount: number
  hiddenTests: number
  hiddenReviewed: number
  hiddenUnchanged: number
  pinned: ReadonlySet<string>
  onSweep: (path: string) => void
  onShowAll: () => void
  onFinish?: () => void
  stats?: { additions: number; deletions: number }
  unsent?: number
  scopeLeft: number
  scopeTotal: number
  excludedTests: number
  excludedUnchanged: number
  onIncludeExcluded?: () => void
  viewMode: ViewMode
  onSetViewMode: (mode: ViewMode) => void
  allCollapsed: boolean
  onToggleCollapseAll: () => void
  onAddNote?: () => void
}

export interface ReviewComments {
  partition: ThreadPartition
  /** Threads the changeset has left behind — their file is no longer in the diff, so
   * no file body can hold them. The pane keeps a section of its own for them; without
   * it the rail lists conversations that render nowhere and can't be read. */
  past?: ReviewThread[]
  actions: ReviewActions
  agentConnected?: boolean
  workingOn?: ReadonlySet<string>
  queuedOn?: ReadonlyMap<string, number>
  revealNotesTick?: number
  revealPastTick?: number
  composeHunkId?: string | null
  onComposeHandled?: () => void
  composeFilePath?: string | null
  onComposeFileHandled?: () => void
  changesetComposerOpen?: boolean
  onOpenChangesetComposer?: () => void
  onCloseChangesetComposer?: () => void
}

export interface ReviewHandlers {
  viewed?: ReadonlySet<string>
  onToggleFileViewed?: (path: string) => void
  selectedId?: string | null
  onSelect?: (hunkId: string) => void
  viewMode?: ViewMode
  collapsed?: ReadonlySet<string>
  onToggleCollapsed?: (path: string) => void
  comments?: ReviewComments
}

function Squares({ additions, deletions }: { additions: number; deletions: number }) {
  const total = additions + deletions
  let add = total === 0 ? 0 : Math.round((additions / total) * 5)
  // A change that exists gets at least one square, however lopsided the ratio.
  if (additions > 0 && add === 0) add = 1
  if (deletions > 0 && add === 5) add = 4
  return (
    <span className="sq" aria-hidden="true">
      {Array.from({ length: 5 }, (_, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: five fixed squares — position is the identity
        <i key={i} className={total === 0 ? '' : i < add ? 'sq-a' : 'sq-d'} />
      ))}
    </span>
  )
}

const STATUS_WORD: Partial<Record<FileChange['status'], string>> = {
  added: 'added',
  deleted: 'deleted',
  renamed: 'renamed',
}

function FileHeader({
  file,
  viewed,
  collapsed = false,
  onToggle,
  commentCount = 0,
  sinceCount = 0,
  onComment,
  onToggleFileViewed,
}: {
  file: FileChange
  viewed?: ReadonlySet<string>
  collapsed?: boolean
  onToggle?: () => void
  commentCount?: number
  /** Hunks the agent changed since the last Finish and still unread — said once
   * here, as a count; the hunks themselves carry only the bar. */
  sinceCount?: number
  onComment?: () => void
  onToggleFileViewed?: () => void
}) {
  const [copied, setCopied] = useState(false)
  const [previewOpen, setPreviewOpen] = useState(false)
  // A live update can collapse/remove this header before the flag times out.
  const copyTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => clearTimeout(copyTimer.current), [])
  let additions = 0
  let deletions = 0
  for (const hunk of file.hunks) {
    for (const line of hunk.lines) {
      if (line.kind === 'add') additions++
      else if (line.kind === 'del') deletions++
    }
  }
  const allViewed = isFileViewed(file, viewed)
  const cut = file.path.lastIndexOf('/')
  const statusWord = STATUS_WORD[file.status]
  const stop = (e: React.MouseEvent) => e.stopPropagation()

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: folding is also the chevron button inside
    // biome-ignore lint/a11y/useKeyWithClickEvents: folding is also the chevron button inside
    <div className="file-header" onClick={onToggle}>
      <button
        type="button"
        className={`file-chevron chevron${collapsed ? ' chevron-shut' : ''}`}
        aria-expanded={!collapsed}
        data-tip={`${collapsed ? 'Expand' : 'Collapse'} this file`}
        aria-label={`${collapsed ? 'Expand' : 'Collapse'} ${file.path}`}
      >
        <Icon name="chev" />
      </button>
      <span className="file-path">
        {file.status === 'renamed' && file.oldPath && (
          <>
            <span className="file-oldpath">{file.oldPath}</span>
            {' → '}
          </>
        )}
        {cut !== -1 && <span className="file-dir">{file.path.slice(0, cut + 1)}</span>}
        <span className="file-base">{file.path.slice(cut + 1)}</span>
      </span>
      {statusWord && <span className={`file-status file-status-${file.status}`}>{statusWord}</span>}
      {sinceCount > 0 && (
        <span className="file-since" title="since your last review — reading it settles it">
          the agent changed{' '}
          {sinceCount === file.hunks.length
            ? 'this'
            : `${sinceCount} ${sinceCount === 1 ? 'hunk' : 'hunks'}`}
        </span>
      )}
      <button
        type="button"
        className="ghb file-copy"
        data-tip={copied ? 'Copied' : 'Copy path'}
        aria-label="Copy path"
        onClick={(e) => {
          stop(e)
          void copyText(file.path).then(() => {
            setCopied(true)
            clearTimeout(copyTimer.current)
            copyTimer.current = setTimeout(() => setCopied(false), 1500)
          })
        }}
      >
        <Icon name={copied ? 'check' : 'copy'} size="sm" />
      </button>
      <span className="grow" />
      {(additions > 0 || deletions > 0) && (
        <span className="dstat">
          {additions > 0 && <span className="stat-add">+{additions}</span>}
          {deletions > 0 && <span className="stat-del">−{deletions}</span>}
          <Squares additions={additions} deletions={deletions} />
        </span>
      )}
      {canPreviewMarkdown(file) && (
        <button
          type="button"
          className="file-preview-btn"
          title="Read this file rendered"
          aria-label={`Preview ${file.path} rendered`}
          onClick={(e) => {
            stop(e)
            setPreviewOpen(true)
          }}
        >
          <Icon name="book" size="sm" />
          Preview
        </button>
      )}
      {onToggleFileViewed && (
        <button
          type="button"
          className="file-viewed-toggle"
          aria-pressed={allViewed}
          title="mark this whole file read"
          onClick={(e) => {
            stop(e)
            onToggleFileViewed()
          }}
        >
          <MarkBox state={allViewed} />
          Viewed
        </button>
      )}
      {onComment && (
        <button
          type="button"
          className="ghb file-comment-btn"
          title="Comment on this file"
          aria-label="Comment on this file"
          onClick={(e) => {
            stop(e)
            onComment()
          }}
        >
          <Icon name="chat" size="sm" />
          {commentCount > 0 && <span className="ghb-badge">{commentCount}</span>}
        </button>
      )}
      {/* biome-ignore lint/a11y/noStaticElementInteractions: the handler only contains a mouse click */}
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: the handler only contains a mouse click */}
      <span onClick={stop}>
        <Menu label="More file actions" triggerClassName="ghb">
          {(close) => (
            <>
              <MenuItem
                icon="copy"
                onClick={() => {
                  close()
                  void copyText(file.path)
                }}
              >
                Copy path
              </MenuItem>
              <MenuItem
                icon="fold"
                kbd="o"
                onClick={() => {
                  close()
                  onToggle?.()
                }}
              >
                {collapsed ? 'Expand file' : 'Collapse file'}
              </MenuItem>
            </>
          )}
        </Menu>
      </span>
      {previewOpen && (
        // The backdrop click that closes the modal must not also reach the
        // header's collapse toggle.
        // biome-ignore lint/a11y/noStaticElementInteractions: the handler only stops propagation
        // biome-ignore lint/a11y/useKeyWithClickEvents: the handler only stops propagation
        <span onClick={stop}>
          <MarkdownPreview path={file.path} onClose={() => setPreviewOpen(false)} />
        </span>
      )}
    </div>
  )
}

interface GapState {
  fingerprint: string
  /** Head-side file text, fetched once per file on the first expansion and shared
   * by every gap; a fingerprint change (any content edit) drops it. */
  headLines: string[] | null
  exp: Map<string, GapExpansion>
  failed: Set<string>
}

function freshGapState(fingerprint: string): GapState {
  return { fingerprint, headLines: null, exp: new Map(), failed: new Set() }
}

/**
 * The file owns expansion, not the hunk: a gap between two hunks is shared by both
 * cards, and the tail gap belongs to no hunk at all. Hunk ids are content-addressed,
 * so the fingerprint rotates on any edit and the expansions reset with it — same
 * reset semantics as everything else keyed by hunk id.
 */
function useGapExpansion(file: FileChange) {
  const gaps = useMemo(() => fileGaps(file), [file])
  const fingerprint = useMemo(
    () => `${file.newLineCount ?? ''}#${file.hunks.map((h) => h.id).join('\n')}`,
    [file],
  )
  const [state, setState] = useState<GapState>(() => freshGapState(fingerprint))
  // Render-phase reset (the sanctioned "derived state" pattern): React re-renders
  // before committing, so a stale expansion never reaches the screen.
  if (state.fingerprint !== fingerprint) setState(freshGapState(fingerprint))
  const live = state.fingerprint === fingerprint ? state : freshGapState(fingerprint)

  const expand = async (gap: Gap, dir: 'up' | 'down' | 'all') => {
    let headLines = live.headLines
    if (headLines === null) {
      try {
        const res = await fetch(`/api/file?path=${encodeURIComponent(file.path)}&side=head`)
        if (!res.ok) throw new Error(`/api/file → ${res.status}`)
        const text = await res.text()
        headLines = text.endsWith('\n') ? text.slice(0, -1).split('\n') : text.split('\n')
      } catch {
        setState((prev) =>
          prev.fingerprint !== fingerprint
            ? prev
            : { ...prev, failed: new Set(prev.failed).add(gap.key) },
        )
        return
      }
    }
    const cur = live.exp.get(gap.key) ?? NO_EXPANSION
    const next: GapExpansion =
      dir === 'all'
        ? { fromTop: gapSize(gap), fromBottom: 0 }
        : dir === 'down'
          ? { ...cur, fromTop: cur.fromTop + EXPAND_STEP }
          : { ...cur, fromBottom: cur.fromBottom + EXPAND_STEP }
    // A live edit can have shortened the file past the gap — an expansion that
    // would reveal nothing new is reported, not silently swallowed.
    const before = materializeGap(headLines, gap, cur)
    const after = materializeGap(headLines, gap, next)
    const got = headLines
    if (after.top.length + after.bottom.length <= before.top.length + before.bottom.length) {
      setState((prev) =>
        prev.fingerprint !== fingerprint
          ? prev
          : { ...prev, headLines: got, failed: new Set(prev.failed).add(gap.key) },
      )
      return
    }
    setState((prev) => {
      if (prev.fingerprint !== fingerprint) return prev
      const failed = new Set(prev.failed)
      failed.delete(gap.key)
      return { ...prev, headLines: got, exp: new Map(prev.exp).set(gap.key, next), failed }
    })
  }

  const collapse = (gap: Gap) =>
    setState((prev) => {
      if (prev.fingerprint !== fingerprint) return prev
      const exp = new Map(prev.exp)
      exp.delete(gap.key)
      const failed = new Set(prev.failed)
      failed.delete(gap.key)
      return { ...prev, exp, failed }
    })

  // Memoized against the state object: without this, every render would rebuild the
  // expanded-line arrays, and HunkCard's tokenizer effect would retrigger forever.
  const visible = useMemo(() => {
    const m = new Map<string, { top: DiffLine[]; bottom: DiffLine[]; merged: boolean }>()
    if (live.headLines === null) return m
    for (const gap of gaps) {
      const exp = live.exp.get(gap.key)
      if (exp) m.set(gap.key, materializeGap(live.headLines, gap, exp))
    }
    return m
  }, [gaps, live])

  const controlsFor = (gap: Gap): GapControls => {
    const exp = live.exp.get(gap.key) ?? NO_EXPANSION
    return {
      remaining: gapRemaining(gap, exp),
      canUp: gap.below !== null,
      canDown: gap.above !== null,
      expanded: exp.fromTop + exp.fromBottom > 0,
      merged: visible.get(gap.key)?.merged ?? false,
      failed: live.failed.has(gap.key),
      onUp: () => void expand(gap, 'up'),
      onDown: () => void expand(gap, 'down'),
      onAll: () => void expand(gap, 'all'),
      onCollapse: () => collapse(gap),
    }
  }

  return { gaps, visible, controlsFor }
}

export function FileBody({
  file,
  delta,
  sinceReview,
  handlers,
  composerOpen = false,
  onCloseComposer,
  stub = null,
  onLoadDiff,
}: {
  file: FileChange
  delta: LiveDelta
  sinceReview?: ReadonlySet<string>
  handlers: ReviewHandlers
  composerOpen?: boolean
  onCloseComposer?: () => void
  /** Render a click-to-load stub instead of the diff (large / generated file). */
  stub?: StubReason | null
  onLoadDiff?: () => void
}) {
  // Deleted files have no head side to read context from; everything else expands.
  const expandable = file.status !== 'deleted' && file.kind === 'text'
  const { gaps, visible, controlsFor } = useGapExpansion(file)
  const comments = handlers.comments
  const fileThreads = comments?.partition.byFile.get(file.path) ?? []
  const base = file.path.slice(file.path.lastIndexOf('/') + 1)
  const fileAnchorFor = (wide: boolean) =>
    wide ? ({ kind: 'changeset' } as const) : ({ kind: 'file', path: file.path } as const)
  const fileSection = comments && (fileThreads.length > 0 || composerOpen) && (
    <div className="file-threads">
      <ThreadList
        threads={fileThreads}
        actions={comments.actions}
        showContext
        agentConnected={comments.agentConnected}
        workingOn={comments.workingOn}
        queuedOn={comments.queuedOn}
      />
      {composerOpen && (
        <CommentBox
          title={`Comment on ${base}`}
          placeholder="Leave a comment…"
          scope={{ label: base, canWiden: true }}
          agentConnected={comments.agentConnected}
          onSubmit={(text, wide, intent) => {
            void comments.actions.create(fileAnchorFor(wide), text, intent)
            onCloseComposer?.()
          }}
          onSend={(text, wide, intent) => {
            void comments.actions
              .create(fileAnchorFor(wide), text, intent)
              .then((t) => comments.actions.send(t.id))
            onCloseComposer?.()
          }}
          onCancel={() => onCloseComposer?.()}
        />
      )}
    </div>
  )
  if (stub !== null) {
    return (
      <>
        {fileSection}
        <div className="file-stub file-stub-large">
          <span>
            {stub === 'generated'
              ? 'Generated file — not rendered by default.'
              : `Large diff (${changedLineCount(file)} changed lines) — not rendered by default.`}
          </span>
          <button type="button" className="btn btn-ghost btn-sm" onClick={onLoadDiff}>
            Load diff
          </button>
        </div>
      </>
    )
  }
  if (file.kind === 'image' && file.hunks.length === 0) {
    return (
      <>
        {fileSection}
        <ImageDiff file={file} />
      </>
    )
  }
  if (file.kind === 'binary') {
    return (
      <>
        {fileSection}
        <div className="file-stub">binary file changed</div>
      </>
    )
  }
  if (file.hunks.length === 0) {
    return (
      <>
        {fileSection}
        <div className="file-stub">
          {file.status === 'renamed' ? 'renamed, no content changes' : 'no content changes'}
        </div>
      </>
    )
  }
  // The dim is a file-level verdict, not a hunk-level one. While anything in the
  // file is still unread — a fresh round from the agent, or a first pass mid-file —
  // the ticked hunks around it are the context the unread ones are judged by, so
  // everything renders at full strength. Only a settled file fades.
  const fileViewed = isFileViewed(file, handlers.viewed)
  // A gap sits between two hunks: its band lives on the boundary of the hunk below
  // it, its expand-down lines glue to the tail of the hunk above it.
  const gapAboveHunk = new Map<number, Gap>()
  const gapBelowHunk = new Map<number, Gap>()
  for (const gap of gaps) {
    if (gap.below !== null) gapAboveHunk.set(gap.below, gap)
    if (gap.above !== null) gapBelowHunk.set(gap.above, gap)
  }
  const tailGap = gaps.find((g) => g.below === null)
  return (
    <>
      {fileSection}
      {file.kind === 'image' && <ImageDiff file={file} />}
      {file.hunks.map((hunk: Hunk, i: number) => {
        const above = expandable ? gapAboveHunk.get(i) : undefined
        const below = expandable ? gapBelowHunk.get(i) : undefined
        return (
          <HunkCard
            key={hunk.id}
            hunk={hunk}
            fresh={delta.freshHunkIds.has(hunk.id)}
            changedSinceReview={sinceReview?.has(hunk.id) ?? false}
            changedSinceViewed={delta.changedViewedHunkIds.has(hunk.id)}
            viewed={fileViewed}
            selected={handlers.selectedId === hunk.id}
            onSelect={handlers.onSelect}
            viewMode={handlers.viewMode ?? 'unified'}
            linesAbove={above && visible.get(above.key)?.bottom}
            linesBelow={below && visible.get(below.key)?.top}
            gapAbove={above ? controlsFor(above) : null}
            threads={comments?.partition.byHunk.get(hunk.id)}
            reviewActions={comments?.actions}
            agentConnected={comments?.agentConnected}
            workingOn={comments?.workingOn}
            queuedOn={comments?.queuedOn}
            composeRequested={comments?.composeHunkId === hunk.id}
            onComposeHandled={comments?.onComposeHandled}
          />
        )
      })}
      {expandable && tailGap && <GapBand gap={controlsFor(tailGap)} />}
    </>
  )
}

export function ReadingPane({
  files,
  delta = EMPTY_DELTA,
  sinceReview,
  hasMore = false,
  onLoadMore,
  controls,
  landed,
  ...handlers
}: {
  files: FileChange[]
  delta?: LiveDelta
  sinceReview?: ReadonlySet<string>
  hasMore?: boolean
  onLoadMore?: () => void
  controls?: PaneControls
  /** The previous review landed in a commit — offer the fresh start. */
  landed?: LandedNotice
} & ReviewHandlers) {
  const [fileComposerFor, setFileComposerFor] = useState<string | null>(null)
  const [doneDismissed, setDoneDismissed] = useState(false)
  // Files whose stubbed diff the reviewer asked to see. Selection also opens a
  // stub durably: keyboard navigation must never land on a hunk with no DOM.
  const [diffLoaded, setDiffLoaded] = useState<ReadonlySet<string>>(new Set())
  const selectedId = handlers.selectedId
  useEffect(() => {
    if (!selectedId) return
    const hit = files.find((f) => f.hunks.some((h) => h.id === selectedId))
    if (hit && stubReason(hit) !== null) {
      setDiffLoaded((prev) => (prev.has(hit.path) ? prev : new Set(prev).add(hit.path)))
    }
  }, [selectedId, files])
  // Auto-load: when the end sentinel drifts within a screen of the viewport, ask
  // for the next batch. The observer is recreated per batch because observe()
  // reports the initial state — so a sentinel still inside the margin keeps
  // loading, which also fills a viewport taller than the first batch.
  const paneRef = useRef<HTMLDivElement>(null)
  const sentinelRef = useRef<HTMLDivElement>(null)
  // biome-ignore lint/correctness/useExhaustiveDependencies: recreating it per batch is the point
  useEffect(() => {
    if (!hasMore || !onLoadMore) return
    // No IntersectionObserver (jsdom, ancient browsers): render everything rather
    // than strand the tail of the changeset behind a dead sentinel.
    if (typeof IntersectionObserver === 'undefined') {
      onLoadMore()
      return
    }
    const node = sentinelRef.current
    if (!node) return
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) onLoadMore()
      },
      { root: paneRef.current, rootMargin: '1200px 0px' },
    )
    observer.observe(node)
    return () => observer.disconnect()
  }, [hasMore, onLoadMore, files.length])

  /**
   * The sweep — how a file you *jumped* to stops being an exception. A pin is how
   * a rail click or `n` lands on a file the filters are hiding, and that exemption
   * has to end, or every file you ever visited accumulates as an exception to a
   * filter that is still switched on.
   *
   * So a pinned file gives its exemption up once it is both read and scrolled out
   * of sight above — off-screen, with the height it took corrected out of the
   * scroll so the frame the reviewer is looking at does not move by a pixel.
   *
   * The listener is installed once and reads through a ref: `files`, `controls`
   * and `handlers.viewed` all change identity on most renders.
   */
  const sweepRef = useRef({ files, controls, viewed: handlers.viewed })
  sweepRef.current = { files, controls, viewed: handlers.viewed }
  // Height that left above the viewport, owed back to scrollTop on the commit that
  // actually removes it.
  const sweepDebt = useRef(0)
  useEffect(() => {
    const pane = paneRef.current
    if (!pane) return
    let frame = 0
    const check = () => {
      frame = 0
      const { files, controls, viewed } = sweepRef.current
      if (!controls?.hideReviewed || controls.pinned.size === 0) return
      const bar = pane.querySelector('.pane-bar')
      const edge = (bar ?? pane).getBoundingClientRect().bottom
      for (const file of files) {
        if (!controls.pinned.has(file.path)) continue
        if (!isFileViewed(file, viewed)) continue
        const node = document.getElementById(fileAnchor(file.path))
        if (!node) continue
        const rect = node.getBoundingClientRect()
        if (rect.bottom >= edge) continue
        sweepDebt.current += rect.height + (parseFloat(getComputedStyle(node).marginBottom) || 0)
        controls.onSweep(file.path)
      }
    }
    // Cancel-and-reschedule rather than skip-if-pending: a pending callback that
    // never runs — a backgrounded tab stops firing rAF — would leave a skip-guard
    // latched on and kill the sweep for the rest of the session.
    const onScroll = () => {
      if (frame !== 0) cancelAnimationFrame(frame)
      frame = requestAnimationFrame(check)
    }
    pane.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      pane.removeEventListener('scroll', onScroll)
      if (frame !== 0) cancelAnimationFrame(frame)
    }
  }, [])

  // Paid back before the browser paints, so the removal is never a visible jump.
  // No-ops unless the sweep just took something.
  useLayoutEffect(() => {
    const pane = paneRef.current
    if (!pane || sweepDebt.current === 0) return
    pane.scrollTop -= sweepDebt.current
    sweepDebt.current = 0
  })
  const askedFor = handlers.comments?.composeFilePath ?? null
  // biome-ignore lint/correctness/useExhaustiveDependencies: only a new request may open a file
  useEffect(() => {
    if (!askedFor) return
    if (handlers.collapsed?.has(askedFor)) handlers.onToggleCollapsed?.(askedFor)
    setFileComposerFor(askedFor)
    handlers.comments?.onComposeFileHandled?.()
  }, [askedFor])
  // Open by default: agent heads-ups and unanswered questions must not hide
  // behind a count the way the old "N changeset notes" fold did.
  const [notesOpen, setNotesOpen] = useState(true)
  const comments = handlers.comments
  const revealTick = comments?.revealNotesTick ?? 0
  useEffect(() => {
    if (revealTick > 0) setNotesOpen(true)
  }, [revealTick])
  const notesExpanded = notesOpen || comments?.changesetComposerOpen === true
  const [pastOpen, setPastOpen] = useState(false)
  const pastTick = comments?.revealPastTick ?? 0
  useEffect(() => {
    if (pastTick > 0) setPastOpen(true)
  }, [pastTick])

  const noteCount = comments?.partition.changeset.length ?? 0
  const changesetSection = comments && (noteCount > 0 || comments.changesetComposerOpen) && (
    <section className="changeset-strip">
      <button
        type="button"
        className="strip-head"
        onClick={() => setNotesOpen((v) => !v)}
        aria-expanded={notesExpanded}
      >
        <span className={`file-chevron chevron${notesExpanded ? '' : ' chevron-shut'}`}>
          <Icon name="chev" />
        </span>
        On the changeset
        <span className="strip-n">{noteCount}</span>
      </button>
      {notesExpanded && (
        <div className="strip-body">
          <ThreadList
            threads={comments.partition.changeset}
            actions={comments.actions}
            showContext
            agentConnected={comments.agentConnected}
            workingOn={comments.workingOn}
            queuedOn={comments.queuedOn}
          />
          {comments.changesetComposerOpen ? (
            <CommentBox
              title="Note on the whole changeset"
              placeholder="Leave a note…"
              scope={{ label: 'the whole changeset', canWiden: false }}
              agentConnected={comments.agentConnected}
              onSubmit={(text, _wide, intent) => {
                void comments.actions.create({ kind: 'changeset' }, text, intent)
                comments.onCloseChangesetComposer?.()
              }}
              onSend={(text, _wide, intent) => {
                void comments.actions
                  .create({ kind: 'changeset' }, text, intent)
                  .then((t) => comments.actions.send(t.id))
                comments.onCloseChangesetComposer?.()
              }}
              onCancel={() => comments.onCloseChangesetComposer?.()}
            />
          ) : (
            comments.onOpenChangesetComposer && (
              <button
                type="button"
                className="strip-add"
                onClick={comments.onOpenChangesetComposer}
              >
                + Note on the changeset
              </button>
            )
          )}
        </div>
      )}
    </section>
  )

  const past = comments?.past ?? []
  const pastSection = comments && past.length > 0 && (
    <section className="file-section past-threads">
      <button
        type="button"
        className="file-header notes-header"
        onClick={() => setPastOpen((v) => !v)}
        aria-expanded={pastOpen}
      >
        <span className={`file-chevron chevron${pastOpen ? '' : ' chevron-shut'}`}>
          <Icon name="chev" />
        </span>
        <span className="file-path">
          {past.length === 1
            ? '1 thread whose code left the changeset'
            : `${past.length} threads whose code left the changeset`}
        </span>
      </button>
      {pastOpen && (
        <div className="file-threads">
          <div className="past-hint">
            The file or change these hang off is no longer in the diff — reverted, deleted, or
            stashed. The conversation is intact, and the snapshot inside each one is the code you
            commented on.
          </div>
          <ThreadList
            threads={past}
            actions={comments.actions}
            showContext
            gone
            agentConnected={comments.agentConnected}
            workingOn={comments.workingOn}
            queuedOn={comments.queuedOn}
          />
        </div>
      )}
    </section>
  )

  const total = controls?.total ?? 0
  const emptyChangeset = files.length === 0 && total === 0
  const allHidden = files.length === 0 && total > 0
  const scopeDone = controls !== undefined && controls.scopeTotal > 0 && controls.scopeLeft === 0
  useEffect(() => {
    if (scopeDone) setDoneDismissed(false)
  }, [scopeDone])
  const hiddenCount =
    (controls?.hiddenTests ?? 0) +
    (controls?.hiddenReviewed ?? 0) +
    (controls?.hiddenUnchanged ?? 0) +
    (controls?.hiddenQuery ?? 0)

  const done = controls && (
    <ReviewDone
      read={controls.total - controls.left}
      total={controls.total}
      excludedTests={controls.excludedTests}
      excludedUnchanged={controls.excludedUnchanged}
      stats={controls.stats}
      unsent={controls.unsent}
      onFinish={controls.onFinish}
      onIncludeExcluded={controls.onIncludeExcluded}
      onDismiss={() => setDoneDismissed(true)}
      shape={allHidden ? 'full' : 'docked'}
    />
  )

  const body = emptyChangeset ? (
    landed ? (
      <ReviewLanded {...landed} shape="full" />
    ) : (
      <div className="empty-state">
        <Icon name="book" size="lg" />
        <h2>Nothing to review</h2>
        <p>
          The working tree is clean. Diffo is watching — start your agent and changes appear here as
          they land.
        </p>
      </div>
    )
  ) : allHidden && scopeDone ? (
    done
  ) : allHidden && controls ? (
    <div className="empty-state">
      <Icon name="filter" size="lg" />
      <h2>
        {controls.left} {controls.left === 1 ? 'file' : 'files'} still to review
      </h2>
      <p>
        {controls.hiddenQuery === 0
          ? "They're hidden by the switches on the bar above."
          : controls.hiddenTests + controls.hiddenReviewed + controls.hiddenUnchanged === 0
            ? `None of them match “${controls.query.trim()}”.`
            : `They're hidden by “${controls.query.trim()}” and the switches on the bar above.`}
      </p>
      <div className="empty-acts">
        <button type="button" className="btn btn-ghost" onClick={controls.onShowAll}>
          Show all files
        </button>
      </div>
    </div>
  ) : (
    <>
      {files.map((file) => {
        const isCollapsed = handlers.collapsed?.has(file.path) ?? false
        const fileThreadCount = comments?.partition.byFile.get(file.path)?.length ?? 0
        const hunkThreadCount =
          comments === undefined
            ? 0
            : file.hunks.reduce((n, h) => n + (comments.partition.byHunk.get(h.id)?.length ?? 0), 0)
        // A stub steps aside the moment the file is part of the conversation:
        // loaded by hand, selected by navigation, or carrying hunk threads.
        const selectedIn = selectedId != null && file.hunks.some((h) => h.id === selectedId)
        const stub =
          diffLoaded.has(file.path) || selectedIn || hunkThreadCount > 0 ? null : stubReason(file)
        const sinceCount =
          sinceReview === undefined
            ? 0
            : file.hunks.reduce((n, h) => n + (sinceReview.has(h.id) ? 1 : 0), 0)
        return (
          <section
            key={file.path}
            id={fileAnchor(file.path)}
            className={`file-section${isCollapsed ? ' file-section-collapsed' : ''}`}
          >
            <FileHeader
              file={file}
              viewed={handlers.viewed}
              collapsed={isCollapsed}
              onToggle={() => handlers.onToggleCollapsed?.(file.path)}
              commentCount={fileThreadCount + hunkThreadCount}
              sinceCount={sinceCount}
              onToggleFileViewed={
                handlers.onToggleFileViewed
                  ? () => handlers.onToggleFileViewed!(file.path)
                  : undefined
              }
              onComment={
                comments
                  ? () => {
                      if (isCollapsed) handlers.onToggleCollapsed?.(file.path)
                      setFileComposerFor((f) => (f === file.path ? null : file.path))
                    }
                  : undefined
              }
            />
            {!isCollapsed && (
              <FileBody
                file={file}
                delta={delta}
                sinceReview={sinceReview}
                handlers={handlers}
                composerOpen={fileComposerFor === file.path}
                onCloseComposer={() => setFileComposerFor(null)}
                stub={stub}
                onLoadDiff={() => setDiffLoaded((prev) => new Set(prev).add(file.path))}
              />
            )}
          </section>
        )
      })}
      {hasMore && (
        <div ref={sentinelRef} className="load-more" aria-hidden="true">
          <div className="shimmer" />
          <div className="shimmer shimmer-short" />
        </div>
      )}
      {controls && hiddenCount > 0 && (
        <div className="pane-hidden">
          <span className="pane-hidden-said">
            <Icon name="eye-off" size="sm" />
            {[
              controls.hiddenQuery > 0
                ? `${controls.hiddenQuery} not matching “${controls.query.trim()}”`
                : null,
              controls.hiddenUnchanged > 0 ? `${controls.hiddenUnchanged} unchanged` : null,
              controls.hiddenTests > 0
                ? `${controls.hiddenTests} test${controls.hiddenTests === 1 ? '' : 's'}`
                : null,
              controls.hiddenReviewed > 0 ? `${controls.hiddenReviewed} reviewed` : null,
            ]
              .filter(Boolean)
              .join(', ')}{' '}
            hidden
          </span>
          <button type="button" className="btn btn-ghost btn-sm" onClick={controls.onShowAll}>
            Show all files
          </button>
        </div>
      )}
    </>
  )

  return (
    <div className={`reading-pane${controls ? ' reading-pane-barred' : ''}`} ref={paneRef}>
      {controls && (
        <PaneBar
          navHidden={controls.navHidden}
          onToggleNav={controls.onToggleNav}
          left={controls.left}
          total={controls.total}
          query={controls.query}
          onClearQuery={controls.onClearQuery}
          hideReviewed={controls.hideReviewed}
          onHideReviewed={controls.onHideReviewed}
          hideTests={controls.hideTests}
          onHideTests={controls.onHideTests}
          testCount={controls.testCount}
          onlyChanged={controls.onlyChanged}
          onOnlyChanged={controls.onOnlyChanged}
          changedCount={controls.changedCount}
          viewMode={controls.viewMode}
          onSetViewMode={controls.onSetViewMode}
          allCollapsed={controls.allCollapsed}
          onToggleCollapseAll={controls.onToggleCollapseAll}
          onAddNote={controls.onAddNote}
        />
      )}
      <div className="reading-col">
        {/* Above even the changeset notes: the stale guide sits in there, and this
            banner is the reason it reads stale. */}
        {landed && !emptyChangeset && <ReviewLanded {...landed} shape="docked" />}
        {changesetSection}
        {pastSection}
        {body}
      </div>
      {scopeDone && !allHidden && !doneDismissed && done}
    </div>
  )
}
