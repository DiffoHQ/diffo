import { useMemo, useState } from 'react'
import type { ReviewThread } from '../../shared/review.js'
import type { LayersRequest } from '../api.js'
import { isFileViewed } from '../fileMarks.js'
import { layerLineStats, layerProgress, type ResolvedLayer } from '../layers.js'
import type { ThreadItem } from '../threads.js'
import { Icon } from './Icon.js'
import { MarkBox } from './MarkBox.js'
import { FileTree, type FileTreeProps } from './Nav.js'

/**
 * The outline: one row per layer, a directory row without the folder icon. The
 * leading mark is the directory control — one click
 * marks every file in the layer read, same toggle, same mixed state. Counts sit
 * under the title rather than beside it, because at 264px a right-hand tally
 * truncated titles; the thread count is the one thing that stays on the right,
 * and only when it is non-zero. An opened layer shows its files as the Files
 * tab's own tree — folders that fold, roll-up marks and all — so a layer reads
 * as a place in the repo, not a flat list. The reading pane still reads the
 * layer in the order the agent listed it; the tree is the map, not the route.
 */

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

/** The words under a layer with nothing to show: Hide tests emptied it, or
 * the changeset did — different reasons, and the row says which. Null when
 * the layer has files, and `SubLine` takes over. */
function emptyLine(layer: ResolvedLayer): string | null {
  if (layer.files.length > 0) return null
  const hidden = layer.hidden ?? 0
  if (hidden > 0) return `${plural(hidden, 'test')} hidden`
  return layer.missing.length === 0
    ? 'nothing here now'
    : `${plural(layer.missing.length, 'listed file')} not in the changeset`
}

/**
 * Files, size, and state — no hunk arithmetic, the bar is the progress. The
 * size is the one figure the file count alone cannot carry: `3 files` is a
 * lunch break or an afternoon, `3 files · +243 −5` says which. The figures
 * wear the diff's own colours, as they do in the pane bar and a file header.
 */
function SubLine({ layer, viewed }: { layer: ResolvedLayer; viewed: ReadonlySet<string> }) {
  const empty = emptyLine(layer)
  if (empty !== null) return <span>{empty}</span>
  const hidden = layer.hidden ?? 0
  const p = layerProgress(layer, viewed)
  const { additions, deletions } = layerLineStats(layer)
  const done = p.doneFiles === p.files ? ' · read' : ''
  const mech = layer.kind === 'mechanical' ? ' · mechanical' : ''
  const off = hidden > 0 ? ` · ${hidden} hidden` : ''
  return (
    <span>
      {plural(p.files, 'file')}
      {(additions > 0 || deletions > 0) && (
        <>
          {' · '}
          {additions > 0 && <span className="stat-add">+{additions}</span>}
          {additions > 0 && deletions > 0 && ' '}
          {deletions > 0 && <span className="stat-del">−{deletions}</span>}
        </>
      )}
      {done}
      {mech}
      {off}
    </span>
  )
}

function LayerRow({
  layer,
  index,
  current,
  open,
  onToggleOpen,
  viewed,
  threadCount,
  onPick,
  onMarkFiles,
  onClearFiles,
}: {
  layer: ResolvedLayer
  index: number
  current: boolean
  /** The file rows under it are shown. */
  open: boolean
  onToggleOpen: () => void
  viewed: ReadonlySet<string>
  threadCount: number
  onPick: (index: number) => void
  onMarkFiles?: (paths: string[]) => void
  onClearFiles?: (paths: string[]) => void
}) {
  const p = layerProgress(layer, viewed)
  const allDone = p.files > 0 && p.doneFiles === p.files
  const some = p.doneMarks > 0
  const markable = layer.files.filter((f) => !isFileViewed(f.file, viewed)).map((f) => f.file.path)
  const paths = layer.files.map((f) => f.file.path)
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: the row's own pick button is the keyboard path; this only widens the mouse target to the whole row
    // biome-ignore lint/a11y/useKeyWithClickEvents: same — the pick button inside carries the keys
    <div
      className={`row row-layer${allDone ? ' row-done' : ''}${layer.derived ? ' row-layer-since' : ''}`}
      aria-current={current ? 'true' : undefined}
      data-layer={layer.id ?? 'since'}
      onClick={() => onPick(index)}
    >
      {/* biome-ignore lint/a11y/useSemanticElements: a native checkbox cannot express the roll-up's mixed state */}
      <button
        type="button"
        className="row-box"
        role="checkbox"
        aria-checked={allDone ? true : some ? 'mixed' : false}
        aria-label={
          allDone
            ? `Mark ${layer.title} not reviewed`
            : `Mark ${plural(markable.length, 'file')} in ${layer.title} reviewed`
        }
        data-tip={
          allDone
            ? `Mark ${plural(paths.length, 'file')} not reviewed`
            : `Mark ${plural(markable.length, 'file')} reviewed`
        }
        disabled={paths.length === 0 || (allDone ? !onClearFiles : !onMarkFiles)}
        onClick={(e) => {
          e.stopPropagation()
          if (allDone) onClearFiles?.(paths)
          else onMarkFiles?.(markable)
        }}
      >
        <MarkBox state={allDone ? true : some ? 'mixed' : false} />
      </button>
      {/* Title and count are one target: anywhere on them picks the layer. Only
          the mark and the fold chevron are their own controls. */}
      <button
        type="button"
        className="row-pick"
        title={layer.title}
        onClick={(e) => {
          // The row behind also picks; one pick per click.
          e.stopPropagation()
          onPick(index)
        }}
      >
        <span className="row-name">
          <span className="row-base">{layer.title}</span>
        </span>
        <span className="ch-sub">
          {/* The bar waits for the first mark: an empty track reads as
              something failing to render, not as 0%. */}
          {p.doneMarks > 0 && (
            <span className="prog-track" aria-hidden="true">
              <i
                style={{
                  width: `${p.marks === 0 ? 0 : Math.round((p.doneMarks / p.marks) * 100)}%`,
                }}
              />
            </span>
          )}
          <SubLine layer={layer} viewed={viewed} />
        </span>
      </button>
      <span className="row-right">
        {threadCount > 0 && (
          <span className="row-count" title={plural(threadCount, 'thread')}>
            <Icon name="chat" size="sm" />
            {threadCount}
          </span>
        )}
        {layer.files.length > 0 && (
          <button
            type="button"
            className={`row-act ch-fold chevron${open ? '' : ' chevron-shut'}`}
            aria-expanded={open}
            aria-label={`${open ? 'Hide' : 'Show'} the files in ${layer.title}`}
            data-tip={open ? 'Hide files' : 'Show files'}
            onClick={(e) => {
              e.stopPropagation()
              onToggleOpen()
            }}
          >
            <Icon name="chev" size="sm" />
          </button>
        )}
      </span>
    </div>
  )
}

/** An opened layer's files, as the Files tab's tree. The layer's notes ride
 * along as the rows' tooltips. */
function LayerFiles({
  layer,
  ...tree
}: { layer: ResolvedLayer } & Omit<FileTreeProps, 'files' | 'notes' | 'forceOpen'>) {
  // `layer.files` is stable between resolutions of the outline, so the tree is
  // rebuilt only when the changeset (or the filter) moves under it.
  const files = useMemo(() => layer.files.map((f) => f.file), [layer.files])
  const notes = useMemo(
    () => new Map(layer.files.flatMap((f) => (f.note ? [[f.file.path, f.note] as const] : []))),
    [layer.files],
  )
  return <FileTree files={files} notes={notes} {...tree} />
}

export function LayerRail({
  layers,
  activeIndex,
  onPick,
  viewed,
  guide,
  description,
  overviewActive = false,
  onOpenGuide,
  threads,
  attention,
  changed,
  selectedPath,
  onPickFile,
  onToggleFileViewed,
  onMarkFiles,
  onClearFiles,
  onAskFile,
  onRefresh,
  request = null,
}: {
  layers: readonly ResolvedLayer[]
  activeIndex: number
  onPick: (index: number) => void
  viewed: ReadonlySet<string>
  /** The guide comment, folded in as row 0 — one outline, not two agent
   * artifacts in two places. Not markable: it is not code. */
  guide?: ReviewThread
  /** On a pull request, the description: the author's map of the change, which
   * makes an Overview with or without a guide. */
  description?: ReviewThread
  /** The reviewer is standing on the Overview: the pane shows the guide and the
   * other changeset threads instead of a layer's files. */
  overviewActive?: boolean
  onOpenGuide?: () => void
  threads?: Map<string, ReviewThread[]>
  attention?: Map<string, ThreadItem[]>
  changed?: ReadonlySet<string>
  selectedPath?: string | null
  onPickFile?: (path: string) => void
  onToggleFileViewed?: (path: string) => void
  onMarkFiles?: (paths: string[]) => void
  onClearFiles?: (paths: string[]) => void
  onAskFile?: (path: string) => void
  /** Ask the agent to re-outline the change as it stands now. Absent when no
   * agent is attached: the line at the foot of the outline says so instead. */
  onRefresh?: () => void
  /** A re-outline is in flight — parked behind the agent's open threads, or in
   * its hands. The line says which, and cannot be clicked again. */
  request?: LayersRequest
}) {
  const threadCount = (layer: ResolvedLayer) =>
    layer.files.reduce((n, f) => n + (threads?.get(f.file.path)?.length ?? 0), 0)
  // Files stay folded until the chevron opens them — the outline is the list of
  // steps, and a step's files are detail the reviewer asks for.
  const [opened, setOpened] = useState<ReadonlySet<string>>(new Set())
  const isOpen = (layer: ResolvedLayer) => opened.has(layer.id ?? 'since')
  const toggle = (layer: ResolvedLayer) =>
    setOpened((prev) => {
      const next = new Set(prev)
      const key = layer.id ?? 'since'
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  return (
    <div className="rail-scroll">
      {(guide || description) && (
        // biome-ignore lint/a11y/noStaticElementInteractions: the pick button inside is the keyboard path; the row widens the mouse target
        // biome-ignore lint/a11y/useKeyWithClickEvents: same
        <div
          className="row row-layer row-layer-overview"
          aria-current={overviewActive ? 'true' : undefined}
          onClick={onOpenGuide}
        >
          <span className="row-box" aria-hidden="true">
            <MarkBox />
          </span>
          <button
            type="button"
            className="row-pick"
            title={
              description && guide
                ? 'The pull request description, and the agent’s guide to this change'
                : description
                  ? 'The pull request description'
                  : 'The agent’s guide to this change'
            }
            onClick={(e) => {
              e.stopPropagation()
              onOpenGuide?.()
            }}
          >
            <span className="row-name">
              <span className="row-base">Overview</span>
            </span>
            {/* The count line the layers carry, in words: a row that looks like
                the others reads as one of them, not as a heading over them. */}
            <span className="ch-sub">
              <span>
                {description && guide
                  ? 'the description, and the agent’s guide'
                  : description
                    ? 'the pull request description'
                    : 'the agent’s guide'}
              </span>
            </span>
          </button>
          <span className="row-right" />
        </div>
      )}
      {layers.map((layer, index) => {
        const current = index === activeIndex
        const open = isOpen(layer)
        return (
          <div key={layer.id ?? 'since'} className="ch-layer">
            {layer.derived && <div className="rail-rule" />}
            <LayerRow
              layer={layer}
              index={index}
              current={current}
              open={open}
              onToggleOpen={() => toggle(layer)}
              viewed={viewed}
              threadCount={threadCount(layer)}
              onPick={onPick}
              onMarkFiles={onMarkFiles}
              onClearFiles={onClearFiles}
            />
            {open && layer.files.length > 0 && (
              <div className="ch-files">
                <LayerFiles
                  layer={layer}
                  viewed={viewed}
                  selectedPath={selectedPath}
                  threads={threads}
                  attention={attention}
                  changed={changed}
                  onPickFile={onPickFile}
                  onToggleFileViewed={onToggleFileViewed}
                  onMarkFiles={onMarkFiles}
                  onClearFiles={onClearFiles}
                  onAskFile={onAskFile}
                />
              </div>
            )}
          </div>
        )
      })}
      {/* The foot of the outline, in the voice of the Threads tab's "Clear all
          threads…": a sentence, not a button, and only ever the one action. */}
      {request !== null ? (
        <div className="ch-foot ch-foot-live" aria-live="polite">
          <span className="ch-working" aria-hidden="true">
            <i />
            <i />
            <i />
          </span>{' '}
          {request === 'outlining' ? 're-outlining…' : 'asked · waits for the open threads'}
        </div>
      ) : onRefresh ? (
        <button
          type="button"
          className="ch-foot ch-foot-act"
          title="the change moved on; a re-post keeps your place"
          onClick={onRefresh}
        >
          Ask the agent to re-outline…
        </button>
      ) : (
        <div className="ch-foot" title="Invite one from the header">
          No agent attached to re-outline
        </div>
      )}
    </div>
  )
}
