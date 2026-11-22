import type { ReactNode } from 'react'
import type { RailView } from '../threads.js'

/**
 * The plan: the left of the three zones. It answers one question — in what
 * order am I reading this change? — by layers (the agent's
 * steps, or git's commits) or by the flat file tree — and holds the list of the review's threads,
 * which themselves sit inline in the diff, on the code they are about.
 */
export function LeftPanel({
  view,
  onSetView,
  fileCount,
  layerCount = null,
  layersSuggested = false,
  threadCount,
  settledCount = 0,
  wantsYou = 0,
  layers,
  files,
  threads,
}: {
  view: RailView
  onSetView: (view: RailView) => void
  fileCount: number
  /** How many layers the agent posted; null when there are none — the tab then
   * carries no count, and its body is the offer to outline. */
  layerCount?: number | null
  /** The agent flagged that this read benefits from layers: an amber dot. */
  layersSuggested?: boolean
  /** Threads still going; the settled ones are in the tab's hover. */
  threadCount: number
  settledCount?: number
  /** Threads waiting on the reviewer: an amber dot on the tab. */
  wantsYou?: number
  layers?: ReactNode
  files: ReactNode
  threads: ReactNode
}) {
  return (
    <nav className="rail" aria-label="Reading plan">
      <div className="tabs" role="tablist" aria-label="Read the change by">
        <button
          type="button"
          role="tab"
          className="tab"
          aria-selected={view === 'layers'}
          onClick={() => onSetView('layers')}
          title={
            layerCount === null
              ? 'The agent’s reading plan, once it posts one'
              : 'The agent’s layers, read in the order it put them in'
          }
        >
          {layersSuggested && layerCount === null && (
            <span className="tab-dot" aria-hidden="true" />
          )}
          Layers {layerCount !== null && <span className="tab-n">{layerCount}</span>}
        </button>
        <button
          type="button"
          role="tab"
          className="tab"
          aria-selected={view === 'files'}
          onClick={() => onSetView('files')}
        >
          Files <span className="tab-n">{fileCount}</span>
        </button>
        <button
          type="button"
          role="tab"
          className="tab"
          aria-selected={view === 'threads'}
          onClick={() => onSetView('threads')}
          title={
            settledCount > 0 ? `${threadCount} still going · ${settledCount} settled` : undefined
          }
        >
          {wantsYou > 0 && <span className="tab-dot" aria-hidden="true" />}
          Threads <span className="tab-n">{threadCount}</span>
        </button>
      </div>
      {view === 'layers' ? layers : view === 'threads' ? threads : files}
    </nav>
  )
}
