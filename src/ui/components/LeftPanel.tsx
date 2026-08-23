import type { ReactNode } from 'react'
import type { PanelTab } from '../threads.js'

export function LeftPanel({
  tab,
  onSetTab,
  fileCount,
  threadCount,
  settledCount = 0,
  wantsYou,
  files,
  threads,
}: {
  tab: PanelTab
  onSetTab: (tab: PanelTab) => void
  fileCount: number
  threadCount: number
  settledCount?: number
  wantsYou: number
  files: ReactNode
  threads: ReactNode
}) {
  return (
    <nav className="rail">
      <div className="tabs" role="tablist" aria-label="Files or threads">
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
      {tab === 'files' ? files : threads}
    </nav>
  )
}
