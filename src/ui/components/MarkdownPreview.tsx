import { useEffect, useState } from 'react'
import type { FileChange } from '../../shared/types.js'
import { Markdown } from './Markdown.js'
import { Modal } from './Modal.js'

/** The preview renders the head side, so a deleted file has nothing to show. */
export function canPreviewMarkdown(file: FileChange): boolean {
  return file.status !== 'deleted' && /\.(md|markdown)$/i.test(file.path)
}

/**
 * A rendered read of a markdown file, in a modal on top of the review. Reading
 * only — comments stay on the diff, so the review has one surface for feedback.
 */
export function MarkdownPreview({ path, onClose }: { path: string; onClose: () => void }) {
  const [text, setText] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    let stale = false
    void (async () => {
      try {
        const res = await fetch(`/api/file?path=${encodeURIComponent(path)}&side=head`)
        if (!res.ok) throw new Error(`/api/file → ${res.status}`)
        const body = await res.text()
        if (!stale) setText(body)
      } catch {
        if (!stale) setFailed(true)
      }
    })()
    return () => {
      stale = true
    }
  }, [path])
  return (
    <Modal title={path} className="md-preview" onClose={onClose}>
      {failed ? (
        <div className="file-stub">couldn't read this file — it may have just changed on disk</div>
      ) : text === null ? (
        <div aria-hidden="true">
          <div className="shimmer" />
          <div className="shimmer" />
          <div className="shimmer shimmer-short" />
        </div>
      ) : (
        <Markdown className="markdown md-doc" text={text} docPath={path} />
      )}
    </Modal>
  )
}
