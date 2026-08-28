import { Icon } from './Icon.js'
import type { ViewMode } from './ReadingPane.js'

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
}: {
  navHidden?: boolean
  onToggleNav?: () => void
  left: number
  total: number
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
        <i style={{ width: `${total === 0 ? 0 : Math.round((done / total) * 100)}%` }} />
      </span>
      <span className="pane-left" title={`${done} of ${total} files marked reviewed`}>
        {left === 0 ? 'all reviewed' : `${left} left`}
      </span>
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
