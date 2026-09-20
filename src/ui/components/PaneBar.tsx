import { Icon } from './Icon.js'
import type { ViewMode } from './ReadingPane.js'

/**
 * The active layer, as the bar tells it. Navigation lives here and not on the
 * header card: the card is read once and scrolled past, the bar is always in
 * view. `prev` / `next` are null at the ends of the outline.
 */
export interface PaneLayer {
  /** `layer 3 / 6`, or `since your review` for the derived one. */
  label: string
  files: number
  left: number
  /** 0..1, from the layer's hunk marks. */
  progress: number
  prev: { title: string; onGo: () => void } | null
  next: { title: string; onGo: () => void } | null
}

export function PaneBar({
  navHidden,
  onToggleNav,
  left,
  total,
  query = '',
  onClearQuery,
  hideReviewed,
  onHideReviewed,
  hideTests,
  onHideTests,
  testCount,
  onlyChanged,
  onOnlyChanged,
  changedCount,
  viewMode,
  onSetViewMode,
  allCollapsed,
  onToggleCollapseAll,
  onAddNote,
  layer,
}: {
  navHidden?: boolean
  onToggleNav?: () => void
  left: number
  total: number
  /** In layer mode the burndown reads the active layer, and a pager sits at
   * the end of the bar. */
  layer?: PaneLayer
  /** The rail's typed filter. The pane obeys it, so the bar must say so — with the
   * rail collapsed this chip is the only trace of why files are missing. */
  query?: string
  onClearQuery?: () => void
  hideReviewed: boolean
  onHideReviewed: (on: boolean) => void
  hideTests: boolean
  onHideTests: (on: boolean) => void
  testCount: number
  onlyChanged: boolean
  onOnlyChanged: (on: boolean) => void
  changedCount: number
  viewMode: ViewMode
  onSetViewMode: (mode: ViewMode) => void
  allCollapsed: boolean
  onToggleCollapseAll: () => void
  onAddNote?: () => void
}) {
  const done = total - left
  const showTests = testCount > 0 || hideTests
  const showChanged = changedCount > 0 || onlyChanged
  const trimmedQuery = query.trim()
  return (
    <div className="pane-bar">
      {onToggleNav && (
        <button
          type="button"
          className="pane-icon pane-nav"
          onClick={onToggleNav}
          data-tip={`${navHidden ? 'Show' : 'Hide'} the file list (b)`}
          aria-label={`${navHidden ? 'Show' : 'Hide'} the file list`}
          aria-pressed={!navHidden}
        >
          <Icon name="sidebar" size="md" />
        </button>
      )}
      <span className="prog-track" aria-hidden="true">
        <i
          style={{
            width: `${
              layer
                ? Math.round(layer.progress * 100)
                : total === 0
                  ? 0
                  : Math.round((done / total) * 100)
            }%`,
          }}
        />
      </span>
      {layer ? (
        <span
          className="pane-left"
          title={`${layer.files - layer.left} of ${layer.files} files in this layer marked reviewed`}
        >
          {layer.label} · {layer.files} {layer.files === 1 ? 'file' : 'files'} ·{' '}
          {layer.files === 0 ? 'nothing here' : layer.left === 0 ? 'read' : `${layer.left} left`}
        </span>
      ) : (
        <span className="pane-left" title={`${done} of ${total} files marked reviewed`}>
          {left === 0 ? 'all reviewed' : `${left} left`}
        </span>
      )}
      <span className="grow" />
      {onAddNote && (
        <>
          <button
            type="button"
            className="pane-act"
            onClick={onAddNote}
            title="Note on the whole changeset"
          >
            <Icon name="note" size="sm" />
            Note
          </button>
          <span className="pane-sep" />
        </>
      )}
      {trimmedQuery !== '' && onClearQuery && (
        <button
          type="button"
          className="pane-q"
          title={`Showing only files matching “${trimmedQuery}” — click to clear`}
          aria-label={`Clear the file filter “${trimmedQuery}”`}
          onClick={onClearQuery}
        >
          <Icon name="search" size="sm" />
          <span className="pane-q-word">{trimmedQuery}</span>
          <Icon name="x" size="sm" />
        </button>
      )}
      {showChanged && (
        <Switch
          on={onlyChanged}
          onChange={onOnlyChanged}
          label="Only since review"
          n={changedCount}
        />
      )}
      <Switch on={hideReviewed} onChange={onHideReviewed} label="Hide reviewed" />
      {showTests && (
        <Switch on={hideTests} onChange={onHideTests} label="Hide tests" n={testCount} />
      )}
      <span className="pane-sep" />
      {/* biome-ignore lint/a11y/useSemanticElements: a a fieldset would bring a legend and its own box */}
      <span className="pane-modes" role="group" aria-label="Diff layout">
        <button
          type="button"
          className="pane-icon"
          aria-pressed={viewMode === 'unified'}
          data-tip="Unified diff (u)"
          aria-label="Unified diff"
          onClick={() => onSetViewMode('unified')}
        >
          <Icon name="unified" size="sm" />
        </button>
        <button
          type="button"
          className="pane-icon"
          aria-pressed={viewMode === 'split'}
          data-tip="Split diff (u)"
          aria-label="Split diff"
          onClick={() => onSetViewMode('split')}
        >
          <Icon name="split" size="sm" />
        </button>
      </span>
      <button
        type="button"
        className="pane-icon"
        aria-pressed={allCollapsed}
        data-tip={`${allCollapsed ? 'Expand' : 'Collapse'} all files`}
        aria-label={`${allCollapsed ? 'Expand' : 'Collapse'} all files`}
        onClick={onToggleCollapseAll}
      >
        <Icon name="fold" size="sm" />
      </button>
      {layer && (layer.prev || layer.next) && (
        <>
          <span className="pane-sep" />
          <span className="ch-pager">
            {layer.prev && (
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                title={`Previous layer: ${layer.prev.title} ([)`}
                aria-label={`Previous layer: ${layer.prev.title}`}
                onClick={layer.prev.onGo}
              >
                ‹ <span className="ch-pager-t">{layer.prev.title}</span>
              </button>
            )}
            {layer.next && (
              <button
                type="button"
                className="btn btn-sm"
                title={`Next layer: ${layer.next.title} (])`}
                aria-label={`Next layer: ${layer.next.title}`}
                onClick={layer.next.onGo}
              >
                <span className="ch-pager-t">{layer.next.title}</span> ›{' '}
                <span className="kbd" aria-hidden="true">
                  ]
                </span>
              </button>
            )}
          </span>
        </>
      )}
    </div>
  )
}

/**
 * A switch, not a tick-box. Ticking a box in the rail records that you have read
 * something; ticking one here hides files you haven't — and the pane bar's version is
 * the one that can empty the screen. So the filters carry `role="switch"`, and the
 * tick is reserved for progress, wherever `MarkBox` is drawn.
 */
function Switch({
  on,
  onChange,
  label,
  n,
}: {
  on: boolean
  onChange: (on: boolean) => void
  label: string
  n?: number
}) {
  return (
    <button
      type="button"
      className={`pane-sw${on ? ' pane-sw-on' : ''}`}
      role="switch"
      aria-checked={on}
      onClick={() => onChange(!on)}
    >
      <span className="pane-track" aria-hidden="true">
        <i />
      </span>
      {label}
      {n !== undefined && <span className="menu-n">{n}</span>}
    </button>
  )
}
