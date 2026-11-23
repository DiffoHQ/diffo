import { useEffect, useMemo, useState } from 'react'
import type { Graph } from '../../shared/graphs.js'
import type { FileChange } from '../../shared/types.js'
import type { ReviewComments } from '../components/ReadingPane.js'
import { blockCanvas } from './block.js'
import { MAX_FILE_BYTES } from './view/constants.js'
import { GraphCanvas } from './view/GraphView.js'
import './graph.css'

/**
 * A graph block of the agent on the canvas. It is a module of its own, so the
 * canvas and the layout library load only when a graph is near the view.
 */
export default function GraphBlockView({
  block,
  files,
  comments,
  viewed,
  onSetMarks,
  onOpenHunk,
  preview = false,
}: {
  block: Graph
  /** The files of the review: a hunk card has the lines of one of them. */
  files: readonly FileChange[]
  comments?: ReviewComments
  viewed?: ReadonlySet<string>
  onSetMarks?: (marks: string[], on: boolean) => void
  onOpenHunk: (hunkId: string) => void
  /** The picture of the graph in its card: the canvas at the zoom that shows
   * all of it, with no controls. A click on it is for the card. */
  preview?: boolean
}) {
  // The head text of the files of the code cards. Null: the file did not load.
  const [texts, setTexts] = useState<ReadonlyMap<string, string | null>>(new Map())
  const paths = useMemo(
    () => [...new Set(block.cards.flatMap((c) => (c.kind === 'code' ? [c.at.path] : [])))],
    [block],
  )
  useEffect(() => {
    let cancelled = false
    const missing = paths.filter((path) => !texts.has(path))
    if (missing.length === 0) return
    Promise.all(
      missing.map(async (path) => {
        const res = await fetch(`/api/file?path=${encodeURIComponent(path)}&side=head`).catch(
          () => null,
        )
        const text = res?.ok ? await res.text() : null
        return [path, text !== null && text.length > MAX_FILE_BYTES ? null : text] as const
      }),
    ).then((got) => {
      if (!cancelled) setTexts((prev) => new Map([...prev, ...got]))
    })
    return () => {
      cancelled = true
    }
  }, [paths, texts])
  const canvas = useMemo(() => blockCanvas(block, files, texts), [block, files, texts])
  const hunkById = useMemo(
    () => new Map(files.flatMap((f) => f.hunks.map((h) => [h.id, h] as const))),
    [files],
  )
  const fileByPath = useMemo(() => new Map(files.map((f) => [f.path, f])), [files])
  return (
    <div className={`graph-view ${preview ? 'graph-preview' : 'graph-block-view'}`}>
      {!preview && canvas.problems.length > 0 && (
        <ul className="graph-block-problems">
          {canvas.problems.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      )}
      <GraphCanvas
        graph={canvas.graph}
        fileByPath={fileByPath}
        hunkById={hunkById}
        viewed={viewed}
        onSetMarks={preview ? undefined : onSetMarks}
        comments={preview ? undefined : comments}
        onOpenHunk={onOpenHunk}
        inert={preview}
      />
    </div>
  )
}
