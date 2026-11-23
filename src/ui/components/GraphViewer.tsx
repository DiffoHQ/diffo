import { lazy, Suspense, useEffect, useState, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import type { FileChange } from '../../shared/types.js'
import {
  GRAPH_OPEN_EVENT,
  type GraphOpenDetail,
  getPreviews,
  prunePreviews,
  subscribePreviews,
} from '../graphs.js'
import { Modal } from './Modal.js'
import type { ReviewComments } from './ReadingPane.js'

// The canvas brings a layout library. It loads the first time a graph opens.
const GraphBlockView = lazy(() => import('../graph/GraphBlockView.js'))

const noop = () => {}

/**
 * The full view of a graph block: the canvas, the size of the window. Mounted
 * once. The card of a graph reaches it through a window event, because the
 * cards are built outside React (src/ui/graphs.ts).
 */
export function GraphViewer({
  files,
  comments,
  viewed,
  onSetMarks,
  onOpenHunk,
}: {
  files: readonly FileChange[]
  comments?: ReviewComments
  viewed?: ReadonlySet<string>
  onSetMarks?: (marks: string[], on: boolean) => void
  /** Go to a hunk in the file list. */
  onOpenHunk: (hunkId: string) => void
}) {
  const [open, setOpen] = useState<GraphOpenDetail | null>(null)
  useEffect(() => {
    const onOpen = (e: Event) => setOpen((e as CustomEvent<GraphOpenDetail>).detail)
    window.addEventListener(GRAPH_OPEN_EVENT, onOpen)
    return () => window.removeEventListener(GRAPH_OPEN_EVENT, onOpen)
  }, [])
  // The pictures in the cards of the page. A card that left the page (the
  // text was drawn again) has no picture to keep.
  const previews = useSyncExternalStore(subscribePreviews, getPreviews)
  useEffect(prunePreviews)
  const pictures = previews.map((p) =>
    createPortal(
      <Suspense fallback={null}>
        <GraphBlockView block={p.graph} files={files} onOpenHunk={noop} preview />
      </Suspense>,
      p.el,
      String(p.id),
    ),
  )
  if (!open) return pictures
  return (
    <>
      {pictures}
      <Modal
        title={open.title}
        className="graph-full"
        badge={<span className="artifact-tag">graph by the agent</span>}
        onClose={() => setOpen(null)}
      >
        <Suspense fallback={<p className="graph-note">Loading the graph…</p>}>
          <GraphBlockView
            block={open.graph}
            files={files}
            comments={comments}
            viewed={viewed}
            onSetMarks={onSetMarks}
            onOpenHunk={(id) => {
              setOpen(null)
              onOpenHunk(id)
            }}
          />
        </Suspense>
      </Modal>
    </>
  )
}
