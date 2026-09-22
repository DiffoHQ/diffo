import { useState } from 'react'
import type { ReviewThread } from '../../shared/review.js'
import type { LayersRequest } from '../api.js'
import { isFileViewed } from '../fileMarks.js'
import { layerProgress, type ResolvedLayer } from '../layers.js'
import type { ThreadItem } from '../threads.js'
import { Icon } from './Icon.js'
import { MarkBox } from './MarkBox.js'
import { FileRow } from './Nav.js'

/**
 * The outline: one row per layer, a directory row without the folder icon. The
 * leading mark is the directory control — one click
 * marks every file in the layer read, same toggle, same mixed state. Counts sit
 * under the title rather than beside it, because at 264px a right-hand tally
 * truncated titles; the thread count is the one thing that stays on the right,
 * and only when it is non-zero. The active layer is expanded to its file rows,
 * which are the Files tree's own rows, marks and all.
 */

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

function subLine(layer: ResolvedLayer, viewed: ReadonlySet<string>): string {
  if (layer.files.length === 0) {
    return layer.missing.length === 0
      ? 'nothing here now'
      : `${plural(layer.missing.length, 'listed file')} not in the changeset`
  }
  // Files and a bar, no hunk arithmetic: the bar is the progress, the words
  // only say what is here and whether it is done.
  const p = layerProgress(layer, viewed)
  const done = p.doneFiles === p.files ? ' · read' : ''
  return `${plural(p.files, 'file')}${done}${layer.kind === 'mechanical' ? ' · mechanical' : ''}`
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
    <div
      className={`row row-layer${allDone ? ' row-done' : ''}${layer.derived ? ' row-layer-since' : ''}`}
      aria-current={current ? 'true' : undefined}
      data-layer={layer.id ?? 'since'}
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
        onClick={() => {
          if (allDone) onClearFiles?.(paths)
          else onMarkFiles?.(markable)
        }}
      >
        <MarkBox state={allDone ? true : some ? 'mixed' : false} />
      </button>
      {/* Title and count are one target: anywhere on them picks the layer. Only
          the mark and the fold chevron are their own controls. */}
      <button type="button" className="row-pick" title={layer.title} onClick={() => onPick(index)}>
        <span className="row-name">
          <span className="row-base">{layer.title}</span>
        </span>
        <span className="ch-sub">
          {p.files > 0 && (
            <span className="prog-track" aria-hidden="true">
              <i
                style={{
                  width: `${p.marks === 0 ? 0 : Math.round((p.doneMarks / p.marks) * 100)}%`,
                }}
              />
            </span>
          )}
          <span>{subLine(layer, viewed)}</span>
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
            onClick={onToggleOpen}
          >
            <Icon name="chev" size="sm" />
          </button>
        )}
      </span>
    </div>
  )
}

export function LayerRail({
  layers,
  activeIndex,
  onPick,
  viewed,
  guide,
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
  const guideText = guide?.messages[0]?.text ?? ''
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
      {guide && (
        <div
          className="row row-layer row-layer-overview"
          aria-current={overviewActive ? 'true' : undefined}
        >
          <span className="row-box" aria-hidden="true">
            <MarkBox />
          </span>
          <button
            type="button"
            className="row-pick"
            title="The agent’s guide to this change"
            onClick={onOpenGuide}
          >
            <span className="row-name">
              <span className="row-base">Overview</span>
            </span>
            <span className="ch-sub">
              <span>guide · agent{guideText.includes('```mermaid') ? ' · with diagram' : ''}</span>
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
                {layer.files.map(({ file, note }) => (
                  <FileRow
                    key={file.path}
                    file={file}
                    depth={0}
                    note={note}
                    done={isFileViewed(file, viewed)}
                    current={selectedPath === file.path}
                    threads={threads?.get(file.path)}
                    wantsYou={
                      (attention?.get(file.path) ?? []).filter((i) => i.turn === 'yours').length
                    }
                    changed={changed?.has(file.path) ?? false}
                    onPick={onPickFile ? () => onPickFile(file.path) : undefined}
                    onToggleViewed={
                      onToggleFileViewed ? () => onToggleFileViewed(file.path) : undefined
                    }
                    onAsk={onAskFile ? () => onAskFile(file.path) : undefined}
                  />
                ))}
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
