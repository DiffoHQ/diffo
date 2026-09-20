import type { ReactNode } from 'react'
import type { PanelTab } from '../threads.js'

export function LeftPanel({
  tab,
  onSetTab,
  fileCount,
  threadCount,
  settledCount = 0,
  wantsYou,
  layerCount = null,
  layersSuggested = false,
  layers,
  files,
  threads,
}: {
  tab: PanelTab
  onSetTab: (tab: PanelTab) => void
  fileCount: number
  threadCount: number
  settledCount?: number
  wantsYou: number
  /** How many layers the agent posted; null when there are none — the tab then
   * carries no count, and its body is the offer to outline. */
  layerCount?: number | null
  /** The agent flagged that this read benefits from layers: an amber dot, the
   * same signal the Threads tab gives for an answer waiting on you. */
  layersSuggested?: boolean
  layers?: ReactNode
  files: ReactNode
  threads: ReactNode
}) {
  return (
    <nav className="rail">
      <div className="tabs" role="tablist" aria-label="Layers, files, or threads">
        <button
          type="button"
          role="tab"
          className="tab"
          aria-selected={tab === 'layers'}
          onClick={() => onSetTab('layers')}
          title={layerCount === null ? 'The agent’s reading plan, once it posts one' : undefined}
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
          aria-selected={tab === 'files'}
          onClick={() => onSetTab('files')}
        >
          Files <span className="tab-n">{fileCount}</span>
        </button>
        <button
          type="button"
          role="tab"
          className="tab"
          aria-selected={tab === 'threads'}
          onClick={() => onSetTab('threads')}
          title={
            settledCount > 0 ? `${threadCount} still going · ${settledCount} settled` : undefined
          }
        >
          {wantsYou > 0 && <span className="tab-dot" aria-hidden="true" />}
          Threads <span className="tab-n">{threadCount}</span>
        </button>
      </div>
      {tab === 'layers' ? layers : tab === 'files' ? files : threads}
    </nav>
  )
}
