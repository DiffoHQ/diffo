import { findFences, kb, oneLine } from './artifacts.js'
import { parseDecisionAt } from './places.js'
import type { DecisionAt } from './review.js'
import type { DiffLine, FileChange, Hunk } from './types.js'

/**
 * Graphs: a picture of how parts connect, which the agent writes as data
 * inside ordinary markdown, as a fenced block whose info string starts with
 * `graph`:
 *
 *     ```graph title="How a save reaches the disk"
 *     { "cards": [ … ], "arrows": [ … ] }
 *     ```
 *
 * It is the sibling of an artifact (src/shared/artifacts.ts), and it rides the
 * same text: a guide, a reply, a layer summary. The difference is who draws.
 * An artifact is HTML that the agent lays out. A graph is cards and arrows
 * only: Diffo places them, routes the arrows, and gives the reviewer a canvas
 * to move in. The agent says what connects, not where it goes.
 *
 * A card is one of three kinds, told by its key:
 * - `hunk`: changed lines of the review, at a place. It is the same code the
 *   file list shows, so it takes comments and marks.
 * - `code`: lines that the change does not touch, at a place. Read only.
 * - `note`: no code. An actor, a store, a decision.
 *
 * This module is the one reading of the format, shared by the CLI, the
 * server and the page. It checks the shape only. Whether a place has code
 * in this review is known where the changeset is.
 */

export const GRAPH_LANG = 'graph'

export const GRAPH_COLORS = [
  'blue',
  'green',
  'purple',
  'orange',
  'red',
  'teal',
  'pink',
  'yellow',
] as const
export type GraphColor = (typeof GRAPH_COLORS)[number]

/** The caps. A graph that needs more is two graphs. */
export const GRAPH_LIMITS = {
  cards: 40,
  arrows: 80,
  boxesPerLevel: 12,
  boxDepth: 4,
  /** The lines of one `code` card. */
  codeLines: 80,
  title: 80,
  noteText: 400,
  label: 60,
  bytes: 64 * 1024,
} as const

/** Per message or summary, as for artifacts. */
export const GRAPHS_PER_TEXT = 3

const GRAPH_TITLE_MAX = 120
const ID = /^[a-z][a-z0-9_-]{0,39}$/

interface CardBase {
  /** The name that arrows, boxes and the order use. Unique in the graph. */
  id: string
  /** The header of the card. A code card with no title shows its place. */
  title?: string
}

/** Changed lines of the review. With no lines in `at`: all the changed lines
 * of the file. */
export interface HunkCard extends CardBase {
  kind: 'hunk'
  at: DecisionAt
}

/** Lines that the change does not touch. `at` always has lines. */
export interface CodeCard extends CardBase {
  kind: 'code'
  at: DecisionAt & { line: number }
}

export interface NoteCard extends CardBase {
  kind: 'note'
  title: string
  text?: string
}

export type GraphCard = HunkCard | CodeCard | NoteCard

export interface GraphBox {
  title: string
  color?: GraphColor
  /** The ids of the cards directly in the box. */
  cards: string[]
  boxes: GraphBox[]
}

export interface GraphArrow {
  from: string
  to: string
  label?: string
}

export interface Graph {
  cards: GraphCard[]
  boxes: GraphBox[]
  arrows: GraphArrow[]
  /** The ids of the cards in the order to read them. */
  order: string[]
}

export type GraphParse = { ok: true; graph: Graph } | { ok: false; errors: string[] }

/** True when a fence's info string opens a graph: its first word is exactly
 * `graph`. */
export function isGraphInfo(info: string): boolean {
  return /^graph(?:\s|$)/.test(info.trim())
}

export interface GraphInfo {
  title: string | null
  /** `key=value` pairs this format does not know. */
  unknown: string[]
}

/** Reads `title="…"` off an info string. A graph has no size: Diffo lays it
 * out, so its card is as large as its content. */
export function parseGraphInfo(info: string): GraphInfo {
  const rest = info.trim().replace(/^graph\b/, '')
  const out: GraphInfo = { title: null, unknown: [] }
  const pair = /([A-Za-z][\w-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|(\S+))/g
  for (const m of rest.matchAll(pair)) {
    const key = (m[1] ?? '').toLowerCase()
    const value = (m[2] ?? m[3] ?? m[4] ?? '').trim()
    if (key === 'title') {
      const t = oneLine(value)
      out.title = t === '' ? null : t.slice(0, GRAPH_TITLE_MAX)
    } else out.unknown.push(key)
  }
  return out
}

function isObject(raw: unknown): raw is Record<string, unknown> {
  return typeof raw === 'object' && raw !== null && !Array.isArray(raw)
}

function text(raw: unknown, cap: number): string {
  return typeof raw === 'string' ? oneLine(raw).slice(0, cap) : ''
}

function place(raw: unknown): DecisionAt | string {
  if (typeof raw !== 'string' || raw.trim() === '') return 'needs a place, as "path:from-to"'
  const at = parseDecisionAt(raw.trim())
  // The message of a layer names its key `at`. Here the key is the kind.
  return typeof at === 'string' ? at.replace(/^"at" /, '') : at
}

function parseCard(raw: unknown, where: string, errors: string[]): GraphCard | null {
  if (!isObject(raw)) {
    errors.push(`${where}: a card is { id, hunk | code | note, title?, text? }`)
    return null
  }
  const id = typeof raw.id === 'string' ? raw.id.trim() : ''
  if (!ID.test(id)) {
    errors.push(
      `${where}: needs an "id" of lower-case letters, digits, "-" or "_", which starts with a letter`,
    )
    return null
  }
  const here = `${where} ("${id}")`
  const kinds = (['hunk', 'code', 'note'] as const).filter((k) => raw[k] !== undefined)
  if (kinds.length !== 1) {
    errors.push(`${here}: needs exactly one of "hunk", "code" or "note"`)
    return null
  }
  const kind = kinds[0] ?? 'note'
  const title = text(raw.title, GRAPH_LIMITS.title)
  if (kind === 'note') {
    const name = text(raw.note, GRAPH_LIMITS.title)
    if (name === '') {
      errors.push(`${here}: "note" is the title of the card, a non-empty string`)
      return null
    }
    if (raw.text !== undefined && typeof raw.text !== 'string') {
      errors.push(`${here}: "text" must be a string`)
      return null
    }
    const body = typeof raw.text === 'string' ? raw.text.trim().slice(0, GRAPH_LIMITS.noteText) : ''
    return { kind, id, title: name, ...(body ? { text: body } : {}) }
  }
  const at = place(raw[kind as 'hunk' | 'code'])
  if (typeof at === 'string') {
    errors.push(`${here}: "${kind}" ${at}`)
    return null
  }
  if (kind === 'hunk') return { kind, id, at, ...(title ? { title } : {}) }
  if (at.line === undefined) {
    errors.push(`${here}: "code" needs lines, as "path:from-to"`)
    return null
  }
  const lines = (at.endLine ?? at.line) - at.line + 1
  if (lines > GRAPH_LIMITS.codeLines) {
    errors.push(
      `${here}: ${lines} lines of code; keep a card to ${GRAPH_LIMITS.codeLines}, the part that the arrow is about`,
    )
    return null
  }
  return { kind, id, at: { ...at, line: at.line }, ...(title ? { title } : {}) }
}

function parseBoxes(
  raw: unknown,
  where: string,
  depth: number,
  ids: ReadonlySet<string>,
  placed: Map<string, string>,
  errors: string[],
): GraphBox[] {
  if (raw === undefined) return []
  if (!Array.isArray(raw)) {
    errors.push(`${where}: "boxes" must be a list`)
    return []
  }
  if (depth > GRAPH_LIMITS.boxDepth) {
    errors.push(`${where}: keep "boxes" to ${GRAPH_LIMITS.boxDepth} levels`)
    return []
  }
  if (raw.length > GRAPH_LIMITS.boxesPerLevel) {
    errors.push(`${where}: keep "boxes" to ${GRAPH_LIMITS.boxesPerLevel} at one level`)
    return []
  }
  const out: GraphBox[] = []
  for (const [i, entry] of raw.entries()) {
    const here = `${where} box ${i + 1}`
    if (!isObject(entry)) {
      errors.push(`${here}: a box is { title, cards?, boxes?, color? }`)
      continue
    }
    const title = text(entry.title, GRAPH_LIMITS.title)
    if (title === '') {
      errors.push(`${here}: a box needs a "title"`)
      continue
    }
    const named = `${here} ("${title}")`
    let color: GraphColor | undefined
    if (entry.color !== undefined) {
      if (!GRAPH_COLORS.includes(entry.color as GraphColor)) {
        errors.push(`${named}: "color" is one of ${GRAPH_COLORS.join(', ')}`)
        continue
      }
      color = entry.color as GraphColor
    }
    const cards: string[] = []
    if (entry.cards !== undefined && !Array.isArray(entry.cards)) {
      errors.push(`${named}: "cards" must be a list of card ids`)
      continue
    }
    for (const id of (entry.cards as unknown[] | undefined) ?? []) {
      if (typeof id !== 'string' || !ids.has(id)) {
        errors.push(`${named}: no card has the id ${JSON.stringify(id)}`)
        continue
      }
      const other = placed.get(id)
      if (other !== undefined) {
        errors.push(`${named}: the card "${id}" is already in the box "${other}"`)
        continue
      }
      placed.set(id, title)
      cards.push(id)
    }
    const boxes = parseBoxes(entry.boxes, named, depth + 1, ids, placed, errors)
    if (cards.length === 0 && boxes.length === 0) {
      errors.push(`${named}: a box needs "cards" or "boxes"`)
      continue
    }
    out.push({ title, ...(color ? { color } : {}), cards, boxes })
  }
  return out
}

/** Untrusted JSON text → a graph, or every problem with it. Each message
 * names the card or the box, so one post is enough to fix them all. */
export function parseGraph(json: string): GraphParse {
  let raw: unknown
  try {
    raw = JSON.parse(json)
  } catch (err) {
    return {
      ok: false,
      errors: [`is not JSON: ${oneLine(err instanceof Error ? err.message : String(err))}`],
    }
  }
  if (!isObject(raw)) return { ok: false, errors: ['is { cards, boxes?, arrows?, order? }'] }
  const errors: string[] = []
  const known = new Set(['cards', 'boxes', 'arrows', 'order'])
  for (const key of Object.keys(raw)) {
    if (!known.has(key))
      errors.push(`does not know "${key}"; the keys are cards, boxes, arrows, order`)
  }
  if (!Array.isArray(raw.cards) || raw.cards.length === 0) {
    return { ok: false, errors: [...errors, 'needs a non-empty "cards" list'] }
  }
  if (raw.cards.length > GRAPH_LIMITS.cards) {
    errors.push(
      `has ${raw.cards.length} cards; keep it to ${GRAPH_LIMITS.cards} — a graph that needs more is two graphs`,
    )
  }
  const cards: GraphCard[] = []
  const ids = new Set<string>()
  for (const [i, entry] of raw.cards.slice(0, GRAPH_LIMITS.cards).entries()) {
    const card = parseCard(entry, `card ${i + 1}`, errors)
    if (card === null) continue
    if (ids.has(card.id)) {
      errors.push(`card ${i + 1}: the id "${card.id}" is used two times`)
      continue
    }
    ids.add(card.id)
    cards.push(card)
  }
  const boxes = parseBoxes(raw.boxes, 'boxes', 1, ids, new Map(), errors)
  const arrows: GraphArrow[] = []
  if (raw.arrows !== undefined && !Array.isArray(raw.arrows)) {
    errors.push('has "arrows" that is not a list')
  } else {
    const list = (raw.arrows as unknown[] | undefined) ?? []
    if (list.length > GRAPH_LIMITS.arrows) {
      errors.push(`has ${list.length} arrows; keep it to ${GRAPH_LIMITS.arrows}`)
    }
    const seen = new Set<string>()
    for (const [i, entry] of list.slice(0, GRAPH_LIMITS.arrows).entries()) {
      const here = `arrow ${i + 1}`
      if (!isObject(entry)) {
        errors.push(`${here}: an arrow is { from, to, label? }`)
        continue
      }
      const { from, to } = entry
      const bad = [from, to].find((end) => typeof end !== 'string' || !ids.has(end))
      if (bad !== undefined || typeof from !== 'string' || typeof to !== 'string') {
        errors.push(`${here}: no card has the id ${JSON.stringify(bad)}`)
        continue
      }
      if (from === to) {
        errors.push(`${here}: goes from "${from}" to itself`)
        continue
      }
      const label = text(entry.label, GRAPH_LIMITS.label)
      const key = `${from}>${to}:${label}`
      if (seen.has(key)) continue
      seen.add(key)
      arrows.push({ from, to, ...(label ? { label } : {}) })
    }
  }
  const order: string[] = []
  if (raw.order !== undefined && !Array.isArray(raw.order)) {
    errors.push('has an "order" that is not a list of card ids')
  } else {
    for (const id of (raw.order as unknown[] | undefined) ?? []) {
      if (typeof id !== 'string' || !ids.has(id)) {
        errors.push(`order: no card has the id ${JSON.stringify(id)}`)
      } else if (!order.includes(id)) order.push(id)
    }
  }
  return errors.length > 0
    ? { ok: false, errors }
    : { ok: true, graph: { cards, boxes, arrows, order } }
}

export interface FoundGraph {
  /** 0-based, in text order. */
  index: number
  info: GraphInfo
  json: string
  /** Byte length of `json` as UTF-8. */
  bytes: number
  /** 1-based line of the opening fence. */
  line: number
  closed: boolean
  /** Character offsets of the whole fence, opener through closer. */
  start: number
  end: number
}

/** Every graph in `text`, in order: the top-level fences whose info string
 * opens with `graph`. */
export function findGraphs(text: string): FoundGraph[] {
  return findFences(text, isGraphInfo).map((f, index) => ({
    index,
    info: parseGraphInfo(f.info),
    json: f.text,
    bytes: new TextEncoder().encode(f.text).length,
    line: f.line,
    closed: f.closed,
    start: f.start,
    end: f.end,
  }))
}

export interface GraphCheck {
  graphs: FoundGraph[]
  /** Refuse the post: the reviewer would see a broken card. */
  errors: string[]
  /** Post anyway, but tell the agent what was not read. */
  warnings: string[]
}

function label(g: FoundGraph): string {
  return g.info.title ? `graph "${g.info.title}"` : `graph ${g.index + 1} (line ${g.line})`
}

/** The preflight. Same messages on the CLI and the server. */
export function checkGraphs(text: string): GraphCheck {
  const graphs = findGraphs(text)
  const errors: string[] = []
  const warnings: string[] = []
  if (graphs.length > GRAPHS_PER_TEXT) {
    errors.push(`${graphs.length} graphs in one text; keep it to ${GRAPHS_PER_TEXT} at most`)
  }
  for (const g of graphs) {
    const what = label(g)
    if (!g.closed) {
      errors.push(
        `${what} opened at line ${g.line} is never closed — end it with a fence line of its own`,
      )
      continue
    }
    if (g.info.title === null)
      errors.push(`${what} needs a title: \`\`\`graph title="What it shows"`)
    if (g.info.unknown.length > 0) {
      warnings.push(
        `${what}: ignoring ${g.info.unknown.map((k) => `${k}=`).join(', ')} — only title= is read`,
      )
    }
    if (g.bytes > GRAPH_LIMITS.bytes) {
      errors.push(`${what} is ${kb(g.bytes)}; the cap is ${kb(GRAPH_LIMITS.bytes)}`)
      continue
    }
    const parsed = parseGraph(g.json)
    if (!parsed.ok) for (const e of parsed.errors) errors.push(`${what} ${e}`)
  }
  return { graphs, errors, warnings }
}

/** One line per graph, for the CLI to print after a post. */
export function describeGraph(g: FoundGraph): string {
  const parsed = parseGraph(g.json)
  const size = parsed.ok
    ? `${parsed.graph.cards.length} cards, ${parsed.graph.arrows.length} arrows`
    : kb(g.bytes)
  return `graph "${g.info.title ?? `#${g.index + 1}`}" (${size})`
}

/** The text with each closed graph fence swapped for a one-line stand-in, for
 * the prompts that replay the agent's own messages back to it. */
export function stripGraphs(
  text: string,
  as: (g: FoundGraph) => string = (g) =>
    `[${describeGraph(g)} — drawn for the reviewer; its JSON is not repeated here]`,
): string {
  const found = findGraphs(text).filter((g) => g.closed)
  if (found.length === 0) return text
  const src = text.replace(/\r\n?/g, '\n')
  let out = ''
  let at = 0
  for (const g of found) {
    out += src.slice(at, g.start)
    out += as(g)
    at = g.end
  }
  return out + src.slice(at)
}

/** Layers on their way to someone else, as `withoutArtifacts`: a graph names
 * code of this review, so it does not travel. A line naming it stays. */
export function withoutGraphs<T extends { summary?: string }>(layer: T): T {
  if (!layer.summary || findGraphs(layer.summary).length === 0) return layer
  return {
    ...layer,
    summary: stripGraphs(layer.summary, (g) =>
      g.info.title ? `_(graph: ${g.info.title})_` : '_(graph)_',
    ),
  }
}

/** The head line a diff line sits at. A deleted line sits where the next head
 * line is, so it is in the range of the code that it was removed from. */
function headPositions(hunk: Hunk): number[] {
  const out = new Array<number>(hunk.lines.length)
  let next = hunk.newStart
  for (let i = hunk.lines.length - 1; i >= 0; i--) {
    const no = hunk.lines[i]?.newNo ?? null
    if (no !== null) next = no
    out[i] = next
  }
  // Deleted lines at the end of a hunk have no head line after them.
  let last = hunk.newStart
  for (let i = 0; i < hunk.lines.length; i++) {
    const line = hunk.lines[i]
    if (line?.newNo != null) last = line.newNo
    else if (out[i] === hunk.newStart && i > 0) out[i] = last + 1
  }
  return out
}

/** The lines of a file's hunks that are in a range of head lines, with the
 * hunks that they come from. With no range: each line of each hunk. A hunk
 * with no changed line in the range gives nothing. */
export function hunkLines(
  file: FileChange,
  from: number | undefined,
  to: number | undefined,
): { lines: DiffLine[]; hunkIds: string[] } {
  const lines: DiffLine[] = []
  const hunkIds: string[] = []
  for (const hunk of file.hunks) {
    const at = headPositions(hunk)
    const own = hunk.lines.filter((_, i) => {
      if (from === undefined) return true
      const pos = at[i] ?? hunk.newStart
      return from <= pos && pos <= (to ?? from)
    })
    if (!own.some((l) => l.kind !== 'context')) continue
    lines.push(...own)
    hunkIds.push(hunk.id)
  }
  return { lines, hunkIds }
}

function placeOf(at: DecisionAt): string {
  if (at.line === undefined) return at.path
  return `${at.path}:${at.line}${at.endLine !== undefined ? `-${at.endLine}` : ''}`
}

/**
 * What a graph names that the review does not have: a hunk card whose file
 * is not in the change, or whose lines have no changed line. And the other
 * way: a code card on lines that the change touches, which the reviewer
 * could not comment on. The graph still draws, so this is for the agent to
 * fix.
 */
export function graphProblems(graph: Graph, files: readonly FileChange[]): string[] {
  const byPath = new Map(files.map((f) => [f.path, f]))
  const out: string[] = []
  for (const card of graph.cards) {
    if (card.kind === 'note') continue
    const file = byPath.get(card.at.path)
    if (card.kind === 'code') {
      if (file && hunkLines(file, card.at.line, card.at.endLine).lines.length > 0) {
        out.push(
          `card "${card.id}": the change touches ${placeOf(card.at)} — make it a "hunk" card, so the reviewer can comment on it`,
        )
      }
      continue
    }
    if (!file) {
      out.push(
        `card "${card.id}": ${card.at.path} is not a file of the change — for code that the change does not touch, use "code" with lines`,
      )
    } else if (hunkLines(file, card.at.line, card.at.endLine).lines.length === 0) {
      out.push(
        `card "${card.id}": the change has no changed line at ${placeOf(card.at)} — give the lines of a hunk, or use "code" for lines that did not change`,
      )
    }
  }
  return out
}
