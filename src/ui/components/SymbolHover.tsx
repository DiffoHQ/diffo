import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { FileChange } from '../../shared/types.js'
import { HoverPolicy } from '../hoverPolicy.js'
import {
  countUsages,
  findUsages,
  isSymbolWord,
  type Side,
  type Usage,
  type UsageGroup,
  wordAt,
} from '../usages.js'
import { Icon } from './Icon.js'

const HIGHLIGHT_NAME = 'sym-occ'

/** The name under the pointer and where it was found. */
interface Target {
  word: string
  side: Side
  path: string
  hunkId: string
  /** Line number on `side`; null for an expanded context line the hunk has no record of. */
  line: number | null
  cell: Element
  start: number
  end: number
}

export interface JumpTarget {
  path: string
  side: Side
  line: number
}

/**
 * Rest on a name in the diff and see where else the change touches it — the
 * editor's "find all references", scoped to the review. Every usage is a jump.
 *
 * One document-level listener for the whole pane, like the tooltip layer: the
 * rows carry no handlers and never re-render for a hover. The word under the
 * pointer is read off the cell's text with the caret API, so wrapped lines,
 * intraline splits and un-scoped tokens all resolve to the same identifier.
 */
export function SymbolHoverLayer({
  files,
  onJump,
}: {
  files: readonly FileChange[]
  onJump: (target: JumpTarget) => void
}) {
  const [shown, setShown] = useState<Target | null>(null)
  const card = useRef<HTMLDivElement>(null)
  /** The listener effect's dismiss, so a jump picked in the card can close it. */
  const hideRef = useRef<() => void>(() => {})
  const pathByHunk = useMemo(() => {
    const map = new Map<string, string>()
    for (const f of files) for (const h of f.hunks) map.set(h.id, f.path)
    return map
  }, [files])
  const lookup = useRef(pathByHunk)
  lookup.current = pathByHunk

  useEffect(() => {
    // The rules — when to open, stay, close — live in HoverPolicy; this effect
    // only translates DOM events into its four verbs.
    const policy = new HoverPolicy<Target>({
      same: (a, b) => a.cell === b.cell && a.start === b.start && a.word === b.word,
      show: (t) => {
        light(t.word, t.side)
        setShown(t)
      },
      hide: () => {
        unlight()
        setShown(null)
      },
    })
    const inCard = (node: EventTarget | null) =>
      card.current !== null && node instanceof Node && card.current.contains(node)

    const onMove = (e: MouseEvent) => {
      if (inCard(e.target)) {
        policy.inCard()
        return
      }
      const el = e.target instanceof Element ? e.target : null
      const t = el ? targetAt(el, e.clientX, e.clientY, lookup.current) : null
      if (t) policy.over(t)
      else policy.away()
    }
    const dismiss = () => policy.dismiss()
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') dismiss()
    }
    const onDown = (e: MouseEvent) => {
      if (!inCard(e.target)) dismiss()
    }
    // The page moving under the card closes it; the card's own list scrolling,
    // by wheel or by a clicked row being brought into view, is the card's business.
    const onScroll = (e: Event) => {
      if (!inCard(e.target)) dismiss()
    }

    hideRef.current = dismiss
    document.addEventListener('mousemove', onMove, true)
    document.addEventListener('mousedown', onDown, true)
    document.addEventListener('scroll', onScroll, true)
    document.addEventListener('keydown', onKey, true)
    window.addEventListener('resize', dismiss)
    window.addEventListener('blur', dismiss)
    return () => {
      dismiss()
      document.removeEventListener('mousemove', onMove, true)
      document.removeEventListener('mousedown', onDown, true)
      document.removeEventListener('scroll', onScroll, true)
      document.removeEventListener('keydown', onKey, true)
      window.removeEventListener('resize', dismiss)
      window.removeEventListener('blur', dismiss)
    }
  }, [])

  const groups = useMemo(
    () => (shown ? findUsages(files, shown.word, shown.side) : []),
    [files, shown],
  )

  // Placed by hand after measuring, like the tooltip: above the name when there is
  // room, else below, and never off the side of the window.
  useLayoutEffect(() => {
    const node = card.current
    if (!node || !shown) return
    const anchor = rangeOver(shown.cell, shown.start, shown.end)?.getBoundingClientRect()
    if (!anchor) return
    const w = node.offsetWidth
    const h = node.offsetHeight
    const x = Math.max(8, Math.min(anchor.left - 10, window.innerWidth - w - 8))
    const above = anchor.top - h - 4
    const y = above >= 8 ? above : Math.min(anchor.bottom + 4, window.innerHeight - h - 8)
    node.style.left = `${Math.round(x)}px`
    node.style.top = `${Math.round(y)}px`
    // Which edge faces the name; an invisible bridge grows from it (styles.css).
    node.dataset.place = above >= 8 ? 'above' : 'below'
    node.classList.add('sym-card-on')
  }, [shown])

  if (!shown) return null
  return (
    <div ref={card} className="sym-card" role="dialog" aria-label={`usages of ${shown.word}`}>
      <UsagesCard
        key={`${shown.side}:${shown.word}`}
        word={shown.word}
        side={shown.side}
        groups={groups}
        here={shown.line === null ? null : { hunkId: shown.hunkId, line: shown.line }}
        onJump={(target) => {
          // The reviewer is leaving: the card has done its job.
          hideRef.current()
          onJump(target)
        }}
      />
    </div>
  )
}

/**
 * The card's face — a pure function of the usages, so it can be tested on its own.
 *
 * Collapsed by default: one row per file with a count, and the lines only when
 * a file is opened. A reviewer mid-read wants the shape of the answer — which
 * files, how many — before any of its text.
 */
export function UsagesCard({
  word,
  side,
  groups,
  here,
  onJump,
}: {
  word: string
  side: Side
  groups: readonly UsageGroup[]
  /** The usage the reviewer is already looking at, if the hovered line is one. */
  here: { hunkId: string; line: number } | null
  onJump: (target: JumpTarget) => void
}) {
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set())
  const toggle = (path: string) =>
    setOpen((prev) => {
      const next = new Set(prev)
      if (!next.delete(path)) next.add(path)
      return next
    })
  const total = countUsages(groups)
  const others = here ? Math.max(0, total - 1) : total
  return (
    <>
      <div className="sym-card-head">
        <code className="sym-card-word">{word}</code>
        <span className="sym-card-count">
          {others === 0
            ? 'nowhere else in this change'
            : `${others} other ${others === 1 ? 'usage' : 'usages'}`}
          {side === 'base' && <span className="sym-card-side">before</span>}
        </span>
      </div>
      {total > 0 && (
        <div className="sym-card-list">
          {groups.map((g) => {
            const expanded = open.has(g.path)
            const hereCount = here ? g.usages.filter((u) => isHere(u, here)).length : 0
            return (
              <div key={g.path} className="sym-card-file">
                <button
                  type="button"
                  className="sym-card-path"
                  aria-expanded={expanded}
                  title={g.path}
                  onClick={() => toggle(g.path)}
                >
                  <Icon name="chev" size="sm" />
                  <FilePath path={g.path} />
                  <span className="sym-card-n">
                    {g.usages.length - hereCount}
                    {hereCount > 0 && <span className="sym-card-n-here"> + here</span>}
                  </span>
                </button>
                {expanded &&
                  g.usages.map((u) => {
                    const current = here !== null && isHere(u, here)
                    return (
                      <button
                        key={`${u.hunkId}:${u.line}`}
                        type="button"
                        className={`sym-card-row${current ? ' sym-card-here' : ''}`}
                        aria-current={current ? 'location' : undefined}
                        onClick={() => onJump({ path: u.path, side, line: u.line })}
                      >
                        <span className="sym-card-ln">{u.line}</span>
                        <Preview usage={u} />
                      </button>
                    )
                  })}
              </div>
            )
          })}
        </div>
      )}
    </>
  )
}

function isHere(u: Usage, here: { hunkId: string; line: number }): boolean {
  return u.hunkId === here.hunkId && u.line === here.line
}

/** Name first, directory after and dimmer: the name is what the eye scans for. */
function FilePath({ path }: { path: string }) {
  const cut = path.lastIndexOf('/')
  if (cut === -1) return <span className="sym-card-name">{path}</span>
  return (
    <>
      <span className="sym-card-name">{path.slice(cut + 1)}</span>
      <span className="sym-card-dir">{path.slice(0, cut)}</span>
    </>
  )
}

/** How far before the match a preview starts: enough context to place it, little
 * enough that the match itself is never pushed out of a clipped row. */
const LEAD = 28

/** The line, trimmed, with the name lit — and re-anchored on the match when the
 * line runs long to the left. */
function Preview({ usage }: { usage: Usage }) {
  const text = usage.text
  let from = text.search(/\S|$/)
  let ellipsis = false
  if (usage.col - from > LEAD) {
    from = text.lastIndexOf(' ', usage.col - LEAD + 8) + 1
    if (from <= 0 || usage.col - from > LEAD * 2) from = usage.col - LEAD
    ellipsis = true
  }
  const before = text.slice(from, usage.col)
  const hit = text.slice(usage.col, usage.col + wordLength(text, usage.col))
  const after = text.slice(usage.col + hit.length)
  return (
    <span className="sym-card-code">
      {ellipsis && <span className="sym-card-ellipsis">…</span>}
      {before}
      <mark>{hit}</mark>
      {after}
    </span>
  )
}

function wordLength(text: string, col: number): number {
  const w = wordAt(text, col)
  return w && w.start === col ? w.end - col : 0
}

/* ---------- pointer → name ---------- */

function caretAt(x: number, y: number): { node: Node; offset: number } | null {
  const doc = document as Document & {
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null
    caretRangeFromPoint?: (x: number, y: number) => Range | null
  }
  if (doc.caretPositionFromPoint) {
    const p = doc.caretPositionFromPoint(x, y)
    return p ? { node: p.offsetNode, offset: p.offset } : null
  }
  if (doc.caretRangeFromPoint) {
    const r = doc.caretRangeFromPoint(x, y)
    return r ? { node: r.startContainer, offset: r.startOffset } : null
  }
  return null
}

function textNodes(root: Node): Text[] {
  const out: Text[] = []
  const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  for (let n = walk.nextNode(); n; n = walk.nextNode()) out.push(n as Text)
  return out
}

/** A DOM range over `[start, end)` of the cell's flattened text. */
function rangeOver(cell: Element, start: number, end: number): Range | null {
  const range = document.createRange()
  let at = 0
  let open = false
  for (const node of textNodes(cell)) {
    const len = node.data.length
    if (!open && start < at + len) {
      range.setStart(node, start - at)
      open = true
    }
    if (open && end <= at + len) {
      range.setEnd(node, end - at)
      return range
    }
    at += len
  }
  return null
}

function targetAt(
  el: Element,
  x: number,
  y: number,
  pathByHunk: ReadonlyMap<string, string>,
): Target | null {
  const cell = el.closest?.('td[data-side]')
  if (!(cell instanceof HTMLElement)) return null
  if (el.closest('.nosym')) return null
  const caret = caretAt(x, y)
  if (!caret || caret.node.nodeType !== Node.TEXT_NODE || !cell.contains(caret.node)) return null
  // Flatten to the cell's text: a name split across highlight spans is one name.
  let offset = caret.offset
  for (const node of textNodes(cell)) {
    if (node === caret.node) break
    offset += node.data.length
  }
  const text = cell.textContent ?? ''
  const hit = wordAt(text, offset)
  if (!hit || !isSymbolWord(hit.word)) return null
  // The caret snaps to the nearest gap; insist the pointer is really on the glyphs.
  const box = rangeOver(cell, hit.start, hit.end)?.getBoundingClientRect()
  if (!box || x < box.left - 1 || x > box.right + 1 || y < box.top - 1 || y > box.bottom + 1)
    return null
  const hunk = cell.closest('[data-hunk-id]')
  const hunkId = hunk?.getAttribute('data-hunk-id')
  if (!hunkId) return null
  const path = pathByHunk.get(hunkId)
  if (!path) return null
  const side: Side = cell.dataset.side === 'base' ? 'base' : 'head'
  const ln = Number(side === 'base' ? cell.dataset.old : cell.dataset.new)
  return {
    word: hit.word,
    side,
    path,
    hunkId,
    line: Number.isFinite(ln) && ln > 0 ? ln : null,
    cell,
    start: hit.start,
    end: hit.end,
  }
}

/* ---------- occurrences in view ---------- */

type HighlightRegistry = {
  highlights?: { set(name: string, h: unknown): void; delete(name: string): void }
}
declare const Highlight: { new (...ranges: Range[]): { add(r: Range): void } } | undefined

/** Light every visible occurrence with the CSS Custom Highlight API — no DOM
 * mutation, so React never notices. Browsers without it simply get the card. */
function light(word: string, side: Side): void {
  const registry = (globalThis.CSS as unknown as HighlightRegistry | undefined)?.highlights
  if (!registry || typeof Highlight === 'undefined') return
  const re = new RegExp(`(?<![\\w$])${word.replace(/[$\\]/g, '\\$&')}(?![\\w$])`, 'g')
  const marks = new Highlight()
  const vh = window.innerHeight
  // A cell is on a side when it has a line number there: a unified context line
  // is both base and head code, and lights up for either.
  const onSide = side === 'base' ? 'td[data-old]' : 'td[data-new]'
  for (const table of document.querySelectorAll('.hunk-lines')) {
    const r = table.getBoundingClientRect()
    if (r.bottom < 0 || r.top > vh) continue
    for (const cell of table.querySelectorAll(onSide)) {
      const text = cell.textContent
      if (!text) continue
      for (const m of text.matchAll(re)) {
        const range = rangeOver(cell, m.index, m.index + m[0].length)
        if (range) marks.add(range)
      }
    }
  }
  registry.set(HIGHLIGHT_NAME, marks)
}

function unlight(): void {
  ;(globalThis.CSS as unknown as HighlightRegistry | undefined)?.highlights?.delete(HIGHLIGHT_NAME)
}
