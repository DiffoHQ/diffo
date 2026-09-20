import type { ReviewThread } from '../../shared/review.js'
import { isFileViewed } from '../fileMarks.js'
import { layerProgress, type ResolvedLayer } from '../layers.js'
import type { ThreadItem } from '../threads.js'
import { Icon } from './Icon.js'
import { MarkBox } from './MarkBox.js'
import { FileRow } from './Nav.js'

/**
 * The outline: one row per layer, a directory row with a number where the
 * folder icon would be. The leading mark is the directory control — one click
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
  const p = layerProgress(layer, viewed)
  const read =
    p.doneFiles === p.files
      ? 'read'
      : p.doneMarks === 0
        ? plural(p.marks, 'hunk')
        : `${p.doneMarks} of ${plural(p.marks, 'hunk')}`
  return `${plural(p.files, 'file')} · ${read}${layer.kind === 'mechanical' ? ' · mechanical' : ''}`
}

function LayerRow({
  layer,
  index,
  current,
  viewed,
  threadCount,
  onPick,
  onMarkFiles,
  onClearFiles,
}: {
  layer: ResolvedLayer
  index: number
  current: boolean
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
  const glyph = layer.number === null ? '+' : String(layer.number)
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
      <button
        type="button"
        className="row-pick"
        aria-expanded={current}
        title={layer.title}
        onClick={() => onPick(index)}
      >
        <span className="row-name">
          <span className="ch-n" aria-hidden="true">
            {glyph}
          </span>
          <span className="row-base">{layer.title}</span>
        </span>
      </button>
      <span className="row-right">
        {threadCount > 0 && (
          <span className="row-count" title={plural(threadCount, 'thread')}>
            <Icon name="chat" size="sm" />
            {threadCount}
          </span>
        )}
      </span>
      <div className="ch-sub">
        {p.files > 0 && (
          <span className="prog-track" aria-hidden="true">
            <i
              style={{ width: `${p.marks === 0 ? 0 : Math.round((p.doneMarks / p.marks) * 100)}%` }}
            />
          </span>
        )}
        <span>{subLine(layer, viewed)}</span>
      </div>
    </div>
  )
}

export function LayerRail({
  layers,
  activeIndex,
  onPick,
  viewed,
  guide,
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
}: {
  layers: readonly ResolvedLayer[]
  activeIndex: number
  onPick: (index: number) => void
  viewed: ReadonlySet<string>
  /** The guide comment, folded in as row 0 — one outline, not two agent
   * artifacts in two places. Not markable: it is not code. */
  guide?: ReviewThread
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
  /** Ask the agent to refresh the outline. Absent until the request loop
   * exists, so the rail head shows no action it cannot honour. */
  onRefresh?: () => void
}) {
  const threadCount = (layer: ResolvedLayer) =>
    layer.files.reduce((n, f) => n + (threads?.get(f.file.path)?.length ?? 0), 0)
  const guideText = guide?.messages[0]?.text ?? ''
  return (
    <div className="rail-scroll">
      <div className="ch-rail-head">
        <span>read in this order</span>
        <span className="grow" />
        {onRefresh && (
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            title="Ask the agent to refresh the layers"
            onClick={onRefresh}
          >
            refresh
          </button>
        )}
      </div>
      {guide && (
        <div className="row row-layer row-layer-overview">
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
              <span className="ch-n" aria-hidden="true">
                0
              </span>
              <span className="row-base">Overview</span>
            </span>
          </button>
          <span className="row-right" />
          <div className="ch-sub">
            <span>guide · agent{guideText.includes('```mermaid') ? ' · with diagram' : ''}</span>
          </div>
        </div>
      )}
      {layers.map((layer, index) => {
        const current = index === activeIndex
        return (
          <div key={layer.id ?? 'since'} className="ch-layer">
            {layer.derived && <div className="rail-rule" />}
            <LayerRow
              layer={layer}
              index={index}
              current={current}
              viewed={viewed}
              threadCount={threadCount(layer)}
              onPick={onPick}
              onMarkFiles={onMarkFiles}
              onClearFiles={onClearFiles}
            />
            {current && layer.files.length > 0 && (
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
    </div>
  )
}
