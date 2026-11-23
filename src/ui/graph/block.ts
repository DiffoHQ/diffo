import { type Graph, type GraphBox, type GraphCard, hunkLines } from '../../shared/graphs.js'
import type { DiffLine, FileChange } from '../../shared/types.js'
import type { CanvasBox, CanvasCard, CanvasGraph } from './model.js'

/**
 * A graph block of the agent (src/shared/graphs.ts) as data for the canvas.
 * The block names its cards by id and its code by place. Here each card gets
 * its lines: a hunk card from the diff of the review, a code card from the
 * head text of its file.
 */

export interface BlockCanvas {
  graph: CanvasGraph
  /** What the block names and the review does not have, as lines for the
   * reviewer. */
  problems: string[]
}

function baseName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1)
}

/** For each card: the titles of the boxes that it is in, the outer one first. */
function boxesOfCards(
  boxes: readonly GraphBox[],
  around: readonly string[] = [],
  into = new Map<string, readonly string[]>(),
): Map<string, readonly string[]> {
  for (const box of boxes) {
    const path = [...around, box.title]
    for (const id of box.cards) into.set(id, path)
    boxesOfCards(box.boxes, path, into)
  }
  return into
}

function canvasBoxes(boxes: readonly GraphBox[]): CanvasBox[] {
  return boxes.map((b) => ({
    title: b.title,
    ...(b.color ? { color: b.color } : {}),
    boxes: canvasBoxes(b.boxes),
  }))
}

function placeName(card: Extract<GraphCard, { kind: 'hunk' | 'code' }>): string {
  const { path, line, endLine } = card.at
  if (line === undefined) return baseName(path)
  return `${baseName(path)}:${line}${endLine !== undefined ? `-${endLine}` : ''}`
}

const NO_BOX: readonly string[] = []

/**
 * The canvas data of a block. `texts` has the head text of the files of the
 * code cards that are loaded so far (null: the file did not load). A code
 * card whose text is not there yet is not in the result, and it is not a
 * problem.
 */
export function blockCanvas(
  block: Graph,
  files: readonly FileChange[],
  texts: ReadonlyMap<string, string | null>,
): BlockCanvas {
  const fileByPath = new Map(files.map((f) => [f.path, f]))
  const boxOf = boxesOfCards(block.boxes)
  const problems: string[] = []
  const cards: CanvasCard[] = []
  for (const card of block.cards) {
    const box = boxOf.get(card.id) ?? NO_BOX
    if (card.kind === 'note') {
      cards.push({
        id: card.id,
        path: '',
        title: card.title,
        lines: [],
        hunkIds: [],
        tag: 'note',
        ...(card.text ? { text: card.text } : {}),
        box,
      })
      continue
    }
    const base = { id: card.id, path: card.at.path, title: card.title ?? placeName(card), box }
    if (card.kind === 'hunk') {
      const file = fileByPath.get(card.at.path)
      const found = file ? hunkLines(file, card.at.line, card.at.endLine) : null
      if (found && found.lines.length > 0) {
        cards.push({ ...base, lines: found.lines, hunkIds: found.hunkIds })
        continue
      }
      // The card stays, so its arrows have an end and the gap is in the view.
      const gap = file
        ? `The change has no changed line at ${placeName(card)}.`
        : 'This file is not in the change.'
      problems.push(`${base.title}: ${gap}`)
      cards.push({ ...base, lines: [], hunkIds: [], text: gap })
      continue
    }
    const text = texts.get(card.at.path)
    // Not loaded yet: the card comes with the text.
    if (text === undefined) continue
    const from = card.at.line
    const lines = (text ?? '')
      .split('\n')
      .slice(from - 1, card.at.endLine ?? from)
      .map(
        (line, i): DiffLine => ({ kind: 'context', oldNo: from + i, newNo: from + i, text: line }),
      )
    if (lines.length === 0) {
      const gap = `The head has no such lines: ${placeName(card)}.`
      problems.push(`${base.title}: ${gap}`)
      cards.push({ ...base, lines, hunkIds: [], tag: 'code', text: gap })
      continue
    }
    cards.push({ ...base, lines, hunkIds: [], tag: 'code' })
  }
  const byId = new Map(cards.map((c) => [c.id, c]))
  // One arrow from a card to another: the canvas has one route for a pair.
  const pairs = new Set<string>()
  const arrows = block.arrows
    .filter((a) => {
      const pair = `${a.from}>${a.to}`
      if (!byId.has(a.from) || !byId.has(a.to) || pairs.has(pair)) return false
      pairs.add(pair)
      return true
    })
    .map((a) => ({
      from: a.from,
      to: a.to,
      ...(a.label ? { label: a.label } : {}),
      // The arrow leaves its card at the first line of the card.
      line: byId.get(a.from)?.lines.find((l) => l.newNo !== null)?.newNo ?? 0,
    }))
  return {
    graph: {
      cards,
      arrows,
      boxes: canvasBoxes(block.boxes),
      order: block.order.filter((id) => byId.has(id)),
    },
    problems,
  }
}
