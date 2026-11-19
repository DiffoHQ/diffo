import type { DiffLine, FileChange, Hunk } from '../../../shared/types.js'
import { CallbackJoin } from '../language/callbacks.js'
import { type FunctionInfo, type GraphLang, graphLang } from '../language/extract.js'
import { objectEscapes, overrideBases } from '../language/objects.js'
import { type GraphFunction, Resolver } from '../language/resolve.js'
import { plainRepo } from '../repo/plain.js'
import type { GraphRepo } from '../repo/repo.js'

/**
 * The code graph of a changeset: one node for each function that a hunk
 * changes, and one edge for each call between two nodes. A hunk that changes
 * two functions gives two nodes. Changed lines outside a function stay one
 * node for their hunk.
 *
 * Each node is in one realm. `tests`: the node is from a test file. `boilerplate`:
 * a declaration with no body, changed lines outside a function, or a file that
 * the graph does not parse (build files, strings, data). `logic`: each other
 * function.
 *
 * This file is the language step and the model. It knows no repo: the
 * groups of the files and the connections that the language cannot see come
 * from a `GraphRepo`.
 */

export type Realm = 'logic' | 'tests' | 'boilerplate'

/**
 * What the calls of the tests say about a logic node. `direct`: a test node
 * calls it. `reached`: a test reaches it through other logic nodes. `none`: no
 * test of the change calls it. This reads the calls in the code. It is not
 * coverage from a run: a test that drives the code through a page or a message
 * has no call to it.
 */
export type Tested = 'direct' | 'reached' | 'none'

export interface GraphNode {
  id: string
  path: string
  /** The function name, or null for changed lines outside a function. */
  name: string | null
  /** The diff lines of the node, in hunk order. */
  lines: DiffLine[]
  /** The hunks that the lines come from. The first one is where a click goes. */
  hunkIds: string[]
  realm: Realm
  /** The group of the node in the logic: from the repo. */
  group: string
  /** Short marks for the card: from the repo. */
  tags?: string[]
  /** The class of the function, when it is a method. */
  cls?: string
  /** The function is an override: the base classes of its class, when a
   * class body of the change tells them. Its caller can be outside the
   * change, because the call is through a base class. */
  override?: string[]
  /** A file that the graph does not parse: the node is the file, with the
   * lines of all its hunks. */
  file?: { additions: number; deletions: number }
  /** Set on a logic node when the change has test nodes. */
  tested?: Tested
  /** The node is a part of a schema, not a function: a repo makes it.
   * Its lines are the hunk of the schema. */
  schema?: boolean
  /**
   * The node is a contract between two groups: it defines what crosses
   * the boundary between them, and it belongs to neither. The view puts it
   * between their two boxes.
   */
  between?: [string, string]
  /** The change removes this function or this event. Its lines are the
   * deleted lines, from the base text. */
  removed?: boolean
  /** The node is a part of a function: the lines of one step of the outline.
   * The key of the step. */
  step?: string
  /** A card of the agent, from a step of its outline: the key of the step,
   * and the title of the box of the step that the card is in. */
  agent?: { step: string; box?: string; note: boolean }
  /** The node is not code of the change: it stands for something outside it,
   * such as the extension that listens to an event. The text says what. */
  outside?: string
}

export interface GraphEdge {
  from: string
  to: string
  /** 1-based head line of the call. */
  line: number
  /**
   * How the target was found. `syntax` and `name`: see `resolve.ts`. `flow`: a
   * callback, followed from its bind site to its run site. `open`: a
   * callback or an object that the function gives to a call; the edge is at
   * that line, and `via` is the name of the call. The code that gets it runs
   * it.
   */
  method: 'syntax' | 'name' | 'flow' | 'open'
  /** `call`: a direct call. `callback`: the run of a callback; `from` runs
   * it, `to` is the function that was bound. Each other kind is from the
   * repo (`GraphRepo.kinds`). */
  kind: string
  /** What the arrow goes through. For an object that escapes: the function
   * that gets it. For a kind of the repo: the name of the message. */
  via?: string
  /** The change added the line of the call. */
  added: boolean
  /** The arrow is from a function that the change removes. */
  removed?: boolean
}

export interface CodeGraph {
  nodes: GraphNode[]
  edges: GraphEdge[]
  /** Paths the graph could not read: no parser for the language, or no text. */
  skipped: string[]
}

export type ParseFile = (lang: GraphLang, text: string) => FunctionInfo[]

/** The head line a diff line sits at. A deleted line sits where the next head
 * line is, so it counts for the function that it was removed from. */
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

function changed(line: DiffLine): boolean {
  return line.kind !== 'context'
}

export function buildGraph(
  files: readonly FileChange[],
  texts: ReadonlyMap<string, string>,
  parse: ParseFile,
  isTest: (path: string) => boolean = () => false,
  /** path → the base text of the file, to find what the change removes. */
  baseTexts: ReadonlyMap<string, string> = new Map(),
  /**
   * The rules of the repository of the change. The plain repo has none:
   * then the graph is basic, with what the diff and the language tell.
   */
  repo: GraphRepo = plainRepo,
): CodeGraph {
  const testFile = (path: string) => repo.isTest(path, isTest(path))
  const card = (path: string) => {
    const tags = repo.tags(path)
    return { group: repo.groupOf(path), ...(tags.length > 0 ? { tags } : {}) }
  }
  const functions: GraphFunction[] = []
  const skipped: string[] = []
  const byPath = new Map<string, GraphFunction[]>()
  /** path → the functions of the base text that the head text does not have. */
  const goneOf = new Map<string, GraphFunction[]>()
  for (const file of files) {
    if (file.kind !== 'text') continue
    const lang = graphLang(file.path)
    const deleted = file.status === 'deleted'
    const text = deleted ? undefined : texts.get(file.path)
    const baseText = baseTexts.get(file.path)
    if (lang === null || (text === undefined && baseText === undefined)) {
      if (lang !== null) skipped.push(file.path)
      continue
    }
    // A test that a macro of the library of the repo makes is a method
    // of its fixture.
    const named = (f: FunctionInfo): FunctionInfo => {
      const m = f.macro
      const [fixture, test] = m?.args ?? []
      if (m?.args.length !== 2 || !fixture || !test || !repo.cpp.testMacro.test(m.name)) {
        return f
      }
      const own = `${fixture}::${test}`
      return { ...f, name: m.scope ? `${m.scope}::${own}` : own, cls: fixture }
    }
    const rows =
      text === undefined
        ? []
        : parse(lang, text)
            .map(named)
            .map((f) => ({
              ...f,
              id: `${file.path}#${f.name}@${f.first}`,
              path: file.path,
              lang,
            }))
    // A function of the base text with no function of that name in the head
    // text: the change removes it.
    const names = new Set(rows.map((f) => f.name))
    const gone =
      baseText === undefined
        ? []
        : parse(lang, baseText)
            .map(named)
            .filter((f) => !names.has(f.name))
            .map((f) => ({
              ...f,
              id: `${file.path}#removed:${f.name}@${f.first}`,
              path: file.path,
              lang,
            }))
    byPath.set(file.path, rows)
    goneOf.set(file.path, gone)
    functions.push(...rows, ...gone)
  }

  const nodes: GraphNode[] = []
  const nodeOf = new Map<string, GraphNode>()
  const addedCalls = new Set<string>()
  for (const file of files) {
    const rows = byPath.get(file.path)
    if (rows === undefined) continue
    const gone = goneOf.get(file.path) ?? []
    const nodeFor = (fn: GraphFunction, removed: boolean): GraphNode => {
      let node = nodeOf.get(fn.id)
      if (node === undefined) {
        node = {
          id: fn.id,
          path: file.path,
          name: fn.name,
          lines: [],
          hunkIds: [],
          realm: testFile(file.path) ? 'tests' : fn.kind === 'decl' ? 'boilerplate' : 'logic',
          ...card(file.path),
          ...(fn.cls ? { cls: fn.cls } : {}),
          ...(removed ? { removed: true } : {}),
        }
        nodeOf.set(fn.id, node)
      }
      return node
    }
    for (const hunk of file.hunks) {
      const at = headPositions(hunk)
      const loose: DiffLine[] = []
      let looseChanged = false
      hunk.lines.forEach((line, i) => {
        const pos = at[i] ?? hunk.newStart
        if (line.kind === 'add') addedCalls.add(`${file.path}:${pos}`)
        // A deleted line of a function that the change removes belongs to the
        // node of that function, not to the function that is now at its place.
        const oldNo = line.kind === 'del' ? line.oldNo : null
        const old =
          oldNo === null ? undefined : gone.find((f) => f.first <= oldNo && oldNo <= f.last)
        const fn = old ?? rows.find((f) => f.first <= pos && pos <= f.last)
        if (fn === undefined) {
          loose.push(line)
          looseChanged ||= changed(line) && line.text.trim() !== ''
          return
        }
        const node = nodeFor(fn, old !== undefined)
        node.lines.push(line)
        if (!node.hunkIds.includes(hunk.id)) node.hunkIds.push(hunk.id)
      })
      if (looseChanged) {
        nodes.push({
          id: `${file.path}#@${hunk.id}`,
          path: file.path,
          name: null,
          lines: loose,
          hunkIds: [hunk.id],
          realm: testFile(file.path) ? 'tests' : 'boilerplate',
          ...card(file.path),
        })
      }
    }
  }
  // A function node needs a changed line. A function that a hunk shows only as
  // context is not part of the change.
  for (const node of nodeOf.values()) {
    if (node.lines.some(changed)) nodes.push(node)
    else nodeOf.delete(node.id)
  }
  // The repo: the nodes and the edges that the language cannot see.
  const join = repo.connect({
    files,
    texts,
    baseTexts,
    functions,
    nodes,
    hasNode: (id) => nodeOf.has(id),
    added: (fn, line) =>
      nodeOf.get(fn.id)?.removed !== true && addedCalls.has(`${fn.path}:${line}`),
  })
  nodes.push(...join.nodes)
  const shown = new Set(join.shown)
  // A file that the graph does not parse is one node with the lines of its
  // hunks, so the canvas holds the whole change.
  for (const file of files) {
    const first = file.hunks[0]
    if (byPath.has(file.path) || shown.has(file.path) || first === undefined) continue
    const lines = file.hunks.flatMap((h) => h.lines)
    nodes.push({
      id: `${file.path}#file`,
      path: file.path,
      name: null,
      lines,
      hunkIds: file.hunks.map((h) => h.id),
      realm: testFile(file.path) ? 'tests' : 'boilerplate',
      ...card(file.path),
      file: {
        additions: lines.filter((l) => l.kind === 'add').length,
        deletions: lines.filter((l) => l.kind === 'del').length,
      },
    })
  }
  nodes.sort((a, b) => a.path.localeCompare(b.path) || firstLine(a) - firstLine(b))

  const resolver = new Resolver(functions, repo.cpp)
  const edges: GraphEdge[] = [...join.edges]
  const byId = new Map(functions.map((f) => [f.id, f]))
  for (const fn of functions) {
    if (!nodeOf.has(fn.id)) continue
    // The lines of a removed function are lines of the base text.
    const gone = nodeOf.get(fn.id)?.removed === true
    for (const call of resolver.resolve(fn)) {
      if (!nodeOf.has(call.to) || call.to === call.from || join.replaces(call)) continue
      edges.push({
        ...call,
        kind: 'call',
        added: !gone && addedCalls.has(`${fn.path}:${call.line}`),
      })
    }
  }
  // Callbacks. An edge needs its two ends in the graph.
  const inGraph = new Set(nodes.map((n) => n.id))
  const callbacks = new CallbackJoin(functions, resolver, repo.cpp).resolve(
    (fn) => join.outside.get(fn.id) ?? null,
    join.replies,
  )
  for (const cb of callbacks) {
    if (!inGraph.has(cb.from) || !inGraph.has(cb.to) || cb.from === cb.to) continue
    const from = byId.get(cb.from)
    edges.push({
      from: cb.from,
      to: cb.to,
      line: cb.line,
      method: cb.method,
      kind: 'callback',
      ...(cb.via !== undefined ? { via: cb.via } : {}),
      added: from !== undefined && addedCalls.has(`${from.path}:${cb.line}`),
    })
  }
  for (const [id, bases] of overrideBases(functions)) {
    const node = nodeOf.get(id)
    if (node) node.override = bases
  }
  // Objects. The function that gets an object of the change can call its
  // overrides.
  for (const o of objectEscapes(functions, resolver, repo.cpp)) {
    if (!inGraph.has(o.from) || !inGraph.has(o.to)) continue
    const from = byId.get(o.from)
    edges.push({
      ...o,
      method: 'open',
      kind: 'callback',
      added: from !== undefined && addedCalls.has(`${from.path}:${o.line}`),
    })
  }
  for (const e of edges) {
    if (nodeOf.get(e.from)?.removed) e.removed = true
  }
  // The mark says what the arrows of the tests reach. With only the basic
  // arrows, "no test calls it" would be wrong too often.
  if (repo.testMark) markTested(nodes, edges)
  return { nodes, edges, skipped }
}

/** Sets `tested` on each logic node, when the change has test nodes. */
function markTested(nodes: GraphNode[], edges: readonly GraphEdge[]): void {
  const byId = new Map(nodes.map((n) => [n.id, n]))
  // A callback edge tells which function a run site can run. Which one it
  // runs depends on who gave the callback, so a test does not reach a function
  // through it.
  const flow = edges.filter((e) => e.kind !== 'callback')
  if (!nodes.some((n) => n.realm === 'tests')) return
  const logic = (id: string) => byId.get(id)?.realm === 'logic'
  const direct = new Set<string>()
  for (const e of flow) {
    if (byId.get(e.from)?.realm === 'tests' && logic(e.to)) direct.add(e.to)
  }
  const reached = new Set(direct)
  const stack = [...direct]
  for (let id = stack.pop(); id !== undefined; id = stack.pop()) {
    for (const e of flow) {
      if (e.from === id && logic(e.to) && !reached.has(e.to)) {
        reached.add(e.to)
        stack.push(e.to)
      }
    }
  }
  for (const node of nodes) {
    if (node.realm !== 'logic' || node.schema || node.name === null || node.removed) continue
    node.tested = direct.has(node.id) ? 'direct' : reached.has(node.id) ? 'reached' : 'none'
  }
}

function firstLine(node: GraphNode): number {
  for (const line of node.lines) if (line.newNo !== null) return line.newNo
  return 0
}

/** The change in the other direction: the head is the base and the base is
 * the head. An added line is a deleted line, and an added file is a deleted
 * file. */
function mirror(files: readonly FileChange[]): FileChange[] {
  const flip = { add: 'del', del: 'add', context: 'context' } as const
  const status = { added: 'deleted', deleted: 'added' } as const
  return files.map((file) => ({
    ...file,
    status:
      file.status === 'added' || file.status === 'deleted' ? status[file.status] : file.status,
    rev: undefined,
    hunks: file.hunks.map((h) => ({
      ...h,
      oldStart: h.newStart,
      newStart: h.oldStart,
      lines: h.lines.map((l) => ({ ...l, kind: flip[l.kind], oldNo: l.newNo, newNo: l.oldNo })),
    })),
  }))
}

/** One side of a graph: the nodes that are there on that side, with only the
 * lines of that side. */
function oneSide(graph: CodeGraph, before: boolean): CodeGraph {
  const nodes = graph.nodes
    // A node that the change removes is not on this side. (In the mirrored
    // graph of the base side, that is a function that the change adds.)
    .filter((n) => !n.removed)
    .map((n) => ({
      ...n,
      lines: n.lines
        .filter((l) => l.kind !== 'del')
        // The base side comes from the mirrored change: its added lines are
        // the lines that the change deletes.
        .map((l) => (before && l.kind === 'add' ? { ...l, kind: 'del' as const } : l)),
      ...(n.file && before
        ? { file: { additions: n.file.deletions, deletions: n.file.additions } }
        : {}),
    }))
    .filter((n) => n.lines.length > 0 || n.file !== undefined || n.outside !== undefined)
  const kept = new Set(nodes.map((n) => n.id))
  const edges = graph.edges
    .filter((e) => kept.has(e.from) && kept.has(e.to) && !e.removed)
    // On the base side, a call on a line that the change deletes is an arrow
    // that the change removes.
    .map((e) => (before && e.added ? { ...e, added: false, removed: true } : e))
  return { nodes, edges, skipped: graph.skipped }
}

export interface GraphSides {
  /** The change in one graph: what it adds, changes and removes. */
  all: CodeGraph
  /** The code before the change: the functions that the change touches, as
   * they were, with the calls of the base text. */
  before: CodeGraph
  /** The code after the change, with no removed function. */
  after: CodeGraph
}

export function buildSides(
  files: readonly FileChange[],
  texts: ReadonlyMap<string, string>,
  parse: ParseFile,
  isTest: (path: string) => boolean,
  baseTexts: ReadonlyMap<string, string>,
  repo: GraphRepo = plainRepo,
): GraphSides {
  const all = buildGraph(files, texts, parse, isTest, baseTexts, repo)
  return {
    all,
    before: oneSide(buildGraph(mirror(files), baseTexts, parse, isTest, texts, repo), true),
    after: oneSide(all, false),
  }
}
