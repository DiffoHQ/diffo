import { Icon } from './Icon.js'
import type { ViewMode } from './ReadingPane.js'

/**
 * The active layer, as the bar tells it. Navigation lives here and not on the
 * header card: the card is read once and scrolled past, the bar is always in
 * view. `prev` / `next` are null at the ends of the outline.
 */
export interface PaneLayer {
  /** The one line: `layer 3 / 6 · 3 files · 2 left`, or `overview · the guide`. */
  text: string
  /** The burndown's title, for the hover. */
  title: string
  /** 0..1, from the layer's hunk marks; null on the Overview, which has
   * nothing to read through and so draws no bar. */
  progress: number | null
  /** Lines added and removed in the layer — its size, where the bar shows the
   * changeset's size outside layer mode. Absent on the Overview. */
  stats?: { additions: number; deletions: number }
  prev: { title: string; onGo: () => void } | null
  next: { title: string; onGo: () => void } | null
}

export function PaneBar({
  navHidden,
  onToggleNav,
  left,
  total,
  hunksRead,
  hunksTotal,
  hunkAt = 0,
  hunkCount = 0,
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
  stats,
  layer,
}: {
  navHidden?: boolean
  onToggleNav?: () => void
  left: number
  total: number
  /** Hunk marks, the finer grain: the bar fills by hunks when they are known;
   * the words stay in files, which is what you tick. */
  hunksRead?: number
  hunksTotal?: number
  /** Where `j`/`k` stand, 1-based; 0 when no hunk is selected. */
  hunkAt?: number
  hunkCount?: number
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
  /** The size of the whole change. It sits beside the coverage because both
   * describe the changeset; the header is for where you are. */
  stats?: { additions: number; deletions: number }
}) {
  const done = total - left
  const byHunks = hunksTotal !== undefined && hunksRead !== undefined && hunksTotal > 0
  const fill = layer
    ? layer.progress
    : byHunks
      ? hunksRead / hunksTotal
      : total === 0
        ? 0
        : done / total
  // Files are the words; hunks only drive the bar's fill.
  const coverage = left === 0 ? 'all reviewed' : `${done} of ${total} files`
  const showTests = testCount > 0 || hideTests
  const showChanged = changedCount > 0 || onlyChanged
  // A filter appears once it has something to do, and says how much: "Hide 11
  // test files" offers, "11 test files hidden" reports. The same number on both
  // sides of the click is what makes the pair read as one control.
  const showReviewed = done > 0 || hideReviewed
  const tests = `${testCount} test ${testCount === 1 ? 'file' : 'files'}`
  const trimmedQuery = query.trim()
  // In layer mode the size is the layer's; the changeset's total belongs to
  // the Files tab, where the whole change is what is being read.
  const size = layer ? layer.stats : stats
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
      {fill !== null && (
        <span className="prog-track prog-track-pane" aria-hidden="true">
          <i style={{ width: `${Math.round(fill * 100)}%` }} />
        </span>
      )}
      {layer ? (
        <span className="pane-left" title={layer.title}>
          {layer.text}
        </span>
      ) : (
        <span className="pane-left" title={`${done} of ${total} files marked reviewed`}>
          {coverage}
        </span>
      )}
      {size && (size.additions > 0 || size.deletions > 0) && (
        <span
          className="pane-size"
          title={
            layer
              ? 'lines added and removed in this layer'
              : 'lines added and removed across the changeset'
          }
        >
          {size.additions > 0 && (
            <span className="stat-add">+{size.additions.toLocaleString('en-US')}</span>
          )}
          {size.deletions > 0 && (
            <span className="stat-del">−{size.deletions.toLocaleString('en-US')}</span>
          )}
        </span>
      )}
      {hunkAt > 0 && hunkCount > 0 && (
        <span className="pane-at" title="the selected hunk — j / k move it">
          hunk {hunkAt} / {hunkCount}
        </span>
      )}
      <span className="grow" />
      {/* In layer mode the outline is the narrowing, so the filters that narrow
          — the typed word, since, reviewed — step aside. Hide tests stays: it
          retires a category of file, which the outline has no opinion on. */}
      {!layer && trimmedQuery !== '' && onClearQuery && (
        <button
          type="button"
          className="pane-q"
          title={`Showing only files matching “${trimmedQuery}”; click to clear`}
          aria-label={`Clear the file filter “${trimmedQuery}”`}
          onClick={onClearQuery}
        >
          <Icon name="search" size="sm" />
          <span className="pane-q-word">{trimmedQuery}</span>
          <Icon name="x" size="sm" />
        </button>
      )}
      {!layer && showChanged && (
        <Switch
          on={onlyChanged}
          onChange={onOnlyChanged}
          label={changedCount > 0 ? `Only ${changedCount} since review` : 'Only since review'}
          onLabel={changedCount > 0 ? `only ${changedCount} since review` : undefined}
        />
      )}
      {!layer && showReviewed && (
        <Switch
          on={hideReviewed}
          onChange={onHideReviewed}
          label={done > 0 ? `Hide ${done} reviewed` : 'Hide reviewed'}
          onLabel={done > 0 ? `${done} reviewed hidden` : undefined}
        />
      )}
      {showTests && (
        <Switch
          on={hideTests}
          onChange={onHideTests}
          label={testCount > 0 ? `Hide ${tests}` : 'Hide tests'}
          onLabel={testCount > 0 ? `${tests} hidden` : undefined}
        />
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
  onLabel,
}: {
  on: boolean
  onChange: (on: boolean) => void
  /** The offer, while off: "Hide 11 test files". */
  label: string
  /** The report, once on: "11 test files hidden" — the pill says what it did,
   * so a shorter list is never a mystery. Left out when it hid nothing, so a
   * switch never says "0 hidden". */
  onLabel?: string
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
      {on && onLabel ? onLabel : label}
    </button>
  )
}
