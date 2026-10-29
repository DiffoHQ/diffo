import type { BeforeAfter as BeforeAfterPost, BeforeAfterSection } from '../../shared/review.js'
import { Markdown } from './Markdown.js'

/**
 * The pane while the reviewer stands on the Layers tab's Before / after row:
 * one section per behaviour the change alters, each with the agent's two
 * passages side by side.
 */
export function BeforeAfterCard({ post }: { post: BeforeAfterPost }) {
  return (
    <section className="ch-head ba-card" aria-label="Before and after">
      <div className="ch-head-top">
        <div className="ch-head-kicker">Behaviour change</div>
      </div>
      <h2>Before / after</h2>
      {post.sections.map((section) => (
        <BeforeAfterPair key={`${section.title ?? ''}\n${section.before}`} section={section} />
      ))}
    </section>
  )
}

function BeforeAfterPair({ section }: { section: BeforeAfterSection }) {
  return (
    <div className="ba-section">
      {section.title && <h3 className="ba-title">{section.title}</h3>}
      <div className="ba-sides">
        <BeforeAfterSide label="Before" side="before" text={section.before} />
        <BeforeAfterSide label="After" side="after" text={section.after} />
      </div>
    </div>
  )
}

function BeforeAfterSide({
  label,
  side,
  text,
}: {
  label: string
  side: 'before' | 'after'
  text: string
}) {
  return (
    <div className={`ba-side ba-side-${side}`}>
      <div className="ba-label">{label}</div>
      <Markdown text={text} className="cmt-body markdown ch-summary" />
    </div>
  )
}
