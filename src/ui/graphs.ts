import { GRAPH_LIMITS, type Graph, parseGraph } from '../shared/graphs.js'

/**
 * Graph blocks in the page. The markdown renderer leaves each ```graph fence
 * as a marked <pre> (src/ui/markdown.ts). This pass turns it into a card: the
 * title, what the graph holds, and a button that opens it on the canvas. The
 * canvas itself is React (GraphViewer), reached through a window event, as
 * the full view of an artifact is.
 */

export interface GraphOpenDetail {
  title: string
  graph: Graph
}

export const GRAPH_OPEN_EVENT = 'diffo:graph-open'

/** A card of a graph that wants its picture: the place for it, and the graph. */
export interface GraphPreview {
  id: number
  el: HTMLElement
  title: string
  graph: Graph
}

// The cards are built outside React, and the picture is the canvas, which is
// React. So a card puts its place here, and GraphViewer draws into it through
// a portal. A card can be built before GraphViewer listens: the list holds it.
let previews: readonly GraphPreview[] = []
let nextPreview = 1
const watchers = new Set<() => void>()

function setPreviews(next: readonly GraphPreview[]): void {
  previews = next
  for (const w of watchers) w()
}

export function subscribePreviews(onChange: () => void): () => void {
  watchers.add(onChange)
  return () => watchers.delete(onChange)
}

/** The places that are in the page now. */
export function getPreviews(): readonly GraphPreview[] {
  return previews
}

/** Drops the places that left the page: a re-render of the text makes new cards. */
export function prunePreviews(): void {
  if (previews.some((p) => !p.el.isConnected)) {
    setPreviews(previews.filter((p) => p.el.isConnected))
  }
}

/** The picture mounts when its card is near the view: it measures real cards
 * of code, and a long guide can hold some graphs. */
function whenNear(el: Element, mount: () => void): void {
  if (typeof IntersectionObserver === 'undefined') {
    mount()
    return
  }
  const io = new IntersectionObserver(
    (entries) => {
      if (!entries.some((e) => e.isIntersecting)) return
      io.disconnect()
      mount()
    },
    { rootMargin: '400px 0px' },
  )
  io.observe(el)
}

const count = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

function buildCard(pre: HTMLElement): HTMLElement {
  const title = pre.dataset.graphTitle || 'Graph'
  const json = pre.querySelector('code')?.textContent ?? ''
  const card = el('figure', 'graph-block')
  const head = el('figcaption', 'graph-block-head')
  head.append(el('span', 'graph-block-tag', 'graph'), el('span', 'graph-block-title', title))
  card.append(head)
  const parsed =
    json.length > GRAPH_LIMITS.bytes
      ? { ok: false as const, errors: ['is too large'] }
      : parseGraph(json)
  if (!parsed.ok) {
    card.classList.add('graph-block-broken')
    const list = el('ul', 'graph-block-errors')
    for (const e of parsed.errors.slice(0, 8)) list.append(el('li', '', `The graph ${e}`))
    card.append(list)
    return card
  }
  const graph = parsed.graph
  const kinds = [
    count(graph.cards.length, 'card'),
    ...(graph.boxes.length > 0 ? [count(graph.boxes.length, 'box').replace('boxs', 'boxes')] : []),
    ...(graph.arrows.length > 0 ? [count(graph.arrows.length, 'arrow')] : []),
  ]
  head.append(el('span', 'graph-block-counts', kinds.join(' · ')))
  const openIt = () =>
    window.dispatchEvent(
      new CustomEvent<GraphOpenDetail>(GRAPH_OPEN_EVENT, { detail: { title, graph } }),
    )
  // The picture of the graph: the canvas from far. A click opens the graph.
  const picture = el('div', 'graph-block-preview')
  picture.setAttribute('role', 'button')
  picture.tabIndex = 0
  picture.setAttribute('aria-label', `Open the graph: ${title}`)
  picture.addEventListener('click', openIt)
  picture.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return
    e.preventDefault()
    openIt()
  })
  const place = el('div', 'graph-block-canvas')
  picture.append(place, el('span', 'graph-block-open', 'Open graph'))
  card.append(picture)
  whenNear(picture, () => {
    prunePreviews()
    setPreviews([...previews, { id: nextPreview++, el: place, title, graph }])
  })
  return card
}

/** Turns each graph fence under `root` into its card. `mark` is the value that
 * only the markdown renderer knows, so a <pre> that a writer typed as raw HTML
 * is never a graph. */
export function renderGraphsIn(root: HTMLElement, mark: string): void {
  for (const pre of root.querySelectorAll<HTMLElement>('pre[data-graph]')) {
    if (pre.dataset.graph !== mark) continue
    pre.replaceWith(buildCard(pre))
  }
}
