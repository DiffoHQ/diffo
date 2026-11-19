import type { DecisionAt, LayerArrowEnd, LayerBox } from '../../../shared/review.js'
import type { DiffLine, FileChange } from '../../../shared/types.js'
import type { GraphStep } from '../../components/ReadingPane.js'
import type { CodeGraph, GraphEdge, GraphNode } from '../basic/build.js'
import type { EdgeKind } from '../repo/repo.js'
import { baseName } from './names.js'

/**
 * With the steps of an outline, a function that has lines of two or more
 * steps is one card for each of those steps: each card has the lines of its
 * step. So each step has its code in its column, and a step that owns only a
 * part of a function is in the graph. A changed line is of the step that
 * has its hunk, and its line when the step names lines. A line with no
 * change goes with the changed line before it.
 */
export function splitBySteps(
  graph: CodeGraph,
  steps: readonly GraphStep[],
  files: readonly FileChange[],
): CodeGraph {
  if (steps.length === 0) return graph
  const lineKey = (l: DiffLine) => `${l.kind}:${l.oldNo}:${l.newNo}`
  const hunkOf = new Map<string, Map<string, string>>()
  for (const file of files) {
    const lines = new Map<string, string>()
    for (const hunk of file.hunks) for (const l of hunk.lines) lines.set(lineKey(l), hunk.id)
    hunkOf.set(file.path, lines)
  }
  const stepOf = (path: string, hunk: string | undefined, line: number | null): string | null => {
    for (const step of steps) {
      for (const part of step.parts) {
        if (part.path !== path || hunk === undefined || !part.hunkIds.includes(hunk)) continue
        if (part.ranges === undefined) return step.key
        if (line !== null && part.ranges.some((r) => r.from <= line && line <= r.to))
          return step.key
      }
    }
    return null
  }
  const parts = new Map<string, { id: string; lines: DiffLine[] }[]>()
  const nodes: GraphNode[] = []
  for (const node of graph.nodes) {
    const hunks = hunkOf.get(node.path)
    // The step of each line. A removed line has no head line: it goes with
    // the head line after it.
    const owner: (string | null)[] = node.lines.map(() => null)
    let after: number | null = null
    for (let i = node.lines.length - 1; i >= 0; i--) {
      const line = node.lines[i]!
      if (line.newNo !== null) after = line.newNo
      if (line.kind === 'context') continue
      owner[i] = stepOf(node.path, hunks?.get(lineKey(line)), line.newNo ?? after)
    }
    const used = [...new Set(owner.filter((o): o is string => o !== null))]
    if (used.length < 2) {
      nodes.push(node)
      continue
    }
    // A line with no change, and a changed line of no step, go with the
    // changed line before them; the first ones go with the first step.
    let now = used.includes(owner.find((o) => o !== null) ?? '')
      ? owner.find((o) => o !== null)!
      : used[0]!
    const byStep = new Map<string, DiffLine[]>(used.map((key) => [key, []]))
    node.lines.forEach((line, i) => {
      if (owner[i] !== null) now = owner[i]!
      byStep.get(now)?.push(line)
    })
    const made = used.map((key) => ({ id: `${node.id}#step:${key}`, lines: byStep.get(key) ?? [] }))
    parts.set(node.id, made)
    used.forEach((key, i) => {
      nodes.push({ ...node, id: made[i]!.id, lines: made[i]!.lines, step: key })
    })
  }
  if (parts.size === 0) return graph
  // An arrow leaves the part that has the line of the call, and it enters
  // the part with the first lines.
  const edges = graph.edges.map((e) => {
    const from = parts.get(e.from)
    const to = parts.get(e.to)
    if (!from && !to) return e
    return {
      ...e,
      from:
        from === undefined
          ? e.from
          : (from.find((part) => part.lines.some((l) => l.newNo === e.line)) ?? from[0]!).id,
      to: to === undefined ? e.to : to[0]!.id,
    }
  })
  return { ...graph, nodes, edges: edges.filter((e) => e.from !== e.to) }
}

/** The id of the card of a note of a step. */
export function noteId(step: string, id: string): string {
  return `note:${step}:${id}`
}

/**
 * The cards of the agent of each step: a note is a card with a title and a
 * text, and a context card has the lines of a file at a place.
 */
export function agentCards(
  steps: readonly GraphStep[],
  texts: ReadonlyMap<string, string>,
): GraphNode[] {
  const out: GraphNode[] = []
  for (const step of steps) {
    for (const note of step.notes ?? []) {
      out.push({
        id: noteId(step.key, note.id),
        path: '',
        name: note.title,
        lines: [],
        hunkIds: [],
        realm: 'logic',
        group: '',
        agent: { step: step.key, note: true, ...(note.box ? { box: note.box } : {}) },
        outside: note.text ?? '',
      })
    }
    for (const card of step.context ?? []) {
      const text = texts.get(card.at.path)
      // The text is not there yet, or the file is not in the head.
      if (!text || card.at.line === undefined) continue
      const from = card.at.line
      const to = card.at.endLine ?? from
      const lines = text
        .split('\n')
        .slice(from - 1, to)
        .map(
          (line, i): DiffLine => ({
            kind: 'context',
            oldNo: from + i,
            newNo: from + i,
            text: line,
          }),
        )
      if (lines.length === 0) continue
      out.push({
        id: `context:${step.key}:${card.at.path}:${from}`,
        path: card.at.path,
        name: card.title ?? `${baseName(card.at.path)}:${from}`,
        lines,
        hunkIds: [],
        realm: 'logic',
        group: '',
        agent: { step: step.key, note: false, ...(card.box ? { box: card.box } : {}) },
        outside: 'The change does not touch this code. The agent shows it.',
      })
    }
  }
  return out
}

/** The boxes from a layer to the box with a title, or undefined. */
export function boxByTitle(
  boxes: readonly LayerBox[] | undefined,
  title: string,
): LayerBox[] | undefined {
  for (const box of boxes ?? []) {
    if (box.title === title) return [box]
    const inner = boxByTitle(box.boxes, title)
    if (inner) return [box, ...inner]
  }
  return undefined
}

/** An arrow that the agent drew in a step of its outline. */
export const AGENT: EdgeKind = {
  id: 'agent',
  name: 'Agent',
  tip: 'An arrow that the agent drew in a step of its outline, with the name that the agent gave it',
  rgb: '255, 55, 95',
}

/**
 * The card of the code at a place: the card of the file with the most lines
 * there. A function is before the card of the lines outside each function,
 * which can have a line between two functions.
 */
export function cardAt(nodes: readonly GraphNode[], at: DecisionAt): GraphNode | undefined {
  const inFile = nodes.filter((n) => n.path === at.path)
  if (at.line === undefined) return inFile[0]
  const from = at.line
  const to = at.endLine ?? at.line
  let best: GraphNode | undefined
  let bestScore = 0
  for (const n of inFile) {
    const lines = n.lines.filter((l) => l.newNo !== null && from <= l.newNo && l.newNo <= to)
    if (lines.length === 0) continue
    const score = lines.length + (n.name !== null && !n.file ? 1000 : 0)
    if (score > bestScore) {
      best = n
      bestScore = score
    }
  }
  return best
}

/**
 * The boxes of the agent that hold a card, the outer one first: a box holds
 * the card when one of its places has a line of the card, or when a box
 * inside it holds the card.
 */
export function boxChain(
  boxes: readonly LayerBox[] | undefined,
  node: GraphNode,
): LayerBox[] | undefined {
  for (const box of boxes ?? []) {
    const inner = boxChain(box.boxes, node)
    if (inner) return [box, ...inner]
    const here = box.at?.some(
      (at) =>
        at.path === node.path &&
        (at.line === undefined ||
          node.lines.some(
            (l) => l.newNo !== null && at.line! <= l.newNo && l.newNo <= (at.endLine ?? at.line!),
          )),
    )
    if (here) return [box]
  }
  return undefined
}

/**
 * The arrows of the agent: from the card at one place to the card at a
 * second place. They are arrows of the graph as the calls are: the layout
 * has them, and they have a switch.
 */
export function agentEdges(nodes: readonly GraphNode[], steps: readonly GraphStep[]): GraphEdge[] {
  const out: GraphEdge[] = []
  const seen = new Set<string>()
  for (const step of steps) {
    for (const arrow of step.arrows ?? []) {
      const end = (at: LayerArrowEnd) =>
        'note' in at ? nodes.find((n) => n.id === noteId(step.key, at.note)) : cardAt(nodes, at)
      const from = end(arrow.from)
      const to = end(arrow.to)
      if (!from || !to || from === to) continue
      const line =
        ('note' in arrow.from ? undefined : arrow.from.line) ??
        from.lines.find((l) => l.newNo !== null)?.newNo ??
        0
      const key = `${from.id}>${to.id}:${line}`
      if (seen.has(key)) continue
      seen.add(key)
      out.push({
        from: from.id,
        to: to.id,
        line,
        method: 'syntax',
        kind: AGENT.id,
        ...(arrow.label ? { via: arrow.label } : {}),
        added: true,
      })
    }
  }
  return out
}

/**
 * The order of reading of the agent: the cards at the places of each step,
 * step by step. The Up and the Down keys follow it.
 */
export function agentOrder(nodes: readonly GraphNode[], steps: readonly GraphStep[]): string[] {
  const out: string[] = []
  for (const step of steps) {
    for (const at of step.order ?? []) {
      const card = cardAt(nodes, at)
      if (card && out[out.length - 1] !== card.id && !out.includes(card.id)) out.push(card.id)
    }
  }
  return out
}

/**
 * The steps of each card. A card of the agent is in the step that made it,
 * and a part of a function is in the step of its lines. Each other card is
 * in the steps that hold a line of it.
 */
export function stepsOfCards(
  nodes: readonly GraphNode[],
  steps: readonly GraphStep[],
): Map<string, GraphStep[]> {
  const out = new Map<string, GraphStep[]>()
  if (steps.length === 0) return out
  for (const n of nodes) {
    // A card of the agent is in the step that made it, and a part of a
    // function is in the step of its lines.
    if (n.agent || n.step !== undefined) {
      const step = steps.find((st) => st.key === (n.agent?.step ?? n.step))
      if (step) out.set(n.id, [step])
      continue
    }
    const own = steps.filter((step) =>
      step.parts.some(
        (part) =>
          part.path === n.path &&
          n.hunkIds.some((id) => part.hunkIds.includes(id)) &&
          (part.ranges === undefined ||
            n.lines.some(
              (l) =>
                l.newNo !== null &&
                part.ranges?.some((r) => r.from <= l.newNo! && l.newNo! <= r.to),
            )),
      ),
    )
    if (own.length > 0) out.set(n.id, own)
  }
  return out
}
