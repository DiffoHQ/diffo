import { memo, useEffect, useRef } from 'react'
import { renderMarkdown, renderMarkdownDoc } from '../markdown.js'
import { linkDiagramRefs, renderMermaidIn } from '../mermaid.js'

/**
 * The one way comment text becomes DOM: sanitised markdown, then the mermaid
 * pass over the result. Thread messages and the composer preview both render
 * through here so a diagram looks the same in both places.
 *
 * `docPath` switches to the document profile — for previewing a repo file,
 * whose images and relative paths a comment must never carry.
 *
 * `paths` turns the picture into navigation: once a diagram has rendered, a
 * node naming one of these files is tagged as a jump (see `linkDiagramRefs`).
 * The prose half — code spans — is the caller's, through `linkPaths`, because
 * it has to happen before sanitising.
 *
 * `memo` is load-bearing, not an optimisation: React 19 re-applies
 * `dangerouslySetInnerHTML` on every update even when `__html` is unchanged,
 * which tears the upgraded mermaid figure back to its raw fence — so typing in
 * a reply box made every diagram in the card re-render and the page jump.
 * Bailing out here keeps the DOM untouched unless the text itself changed.
 */
export const Markdown = memo(function Markdown({
  text,
  className,
  docPath,
  paths,
}: {
  text: string
  className: string
  docPath?: string
  paths?: readonly string[]
}) {
  const body = useRef<HTMLDivElement>(null)
  const html = docPath === undefined ? renderMarkdown(text) : renderMarkdownDoc(text, docPath)
  // biome-ignore lint/correctness/useExhaustiveDependencies: the pass re-runs when the rendered HTML changes — `text` is its input by proxy
  useEffect(() => {
    const el = body.current
    if (!el) return
    const pass = async () => {
      await renderMermaidIn(el)
      if (paths) linkDiagramRefs(el, paths)
    }
    void pass()
    // A live update can make React rewrite this subtree back to the raw fence
    // between the pass's async steps; the observer re-runs it until the DOM
    // settles. No feedback loop: an upgraded (or failed) fence no longer
    // matches, so the re-run is a no-op.
    const settle = new MutationObserver(() => {
      void pass()
    })
    settle.observe(el, { childList: true, subtree: true })
    return () => settle.disconnect()
  }, [html, paths])
  return (
    // biome-ignore lint/security/noDangerouslySetInnerHtml: renderMarkdown sanitises through DOMPurify
    <div ref={body} className={className} dangerouslySetInnerHTML={{ __html: html }} />
  )
})
