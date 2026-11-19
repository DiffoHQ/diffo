import type { FileChange } from '../../../shared/types.js'
import type { GraphEdge, GraphNode } from '../basic/build.js'
import type { CppIdioms } from '../language/idioms.js'
import type { GraphFunction, ResolvedCall } from '../language/resolve.js'

/**
 * The repo layer of the code graph. The graph and the language steps know
 * no repo. A repo tells them how its files are grouped, and it adds the
 * connections that the language cannot see: a call that goes across a process,
 * an event, a message. See `README.md`.
 */

/** A kind of arrow that the repo adds, with its name and color in the view. */
export interface EdgeKind {
  id: string
  name: string
  /** What the arrows of this kind are, for the switch of the kind. */
  tip: string
  /** The color, as `r, g, b`. */
  rgb: string
}

/** What a repo gets to make its connections. */
export interface RepoContext {
  files: readonly FileChange[]
  /** path → head text. */
  texts: ReadonlyMap<string, string>
  /** path → base text. */
  baseTexts: ReadonlyMap<string, string>
  /** The functions of all the parsed files. */
  functions: readonly GraphFunction[]
  /** The nodes that the language steps made. The repo can change the
   * group or the realm of one. */
  nodes: readonly GraphNode[]
  /** The function has a node in the graph. */
  hasNode(id: string): boolean
  /** The change added this line of the function. */
  added(fn: GraphFunction, line: number): boolean
}

/** The connections of a repo. */
export interface RepoJoin {
  /** Nodes that are not functions: a contract, an event. */
  nodes: GraphNode[]
  edges: GraphEdge[]
  /** The files that these nodes show. Such a file gets no card of its own. */
  shown: string[]
  /** The direct call is one of the edges of the repo, so it is not also a
   * call edge. */
  replaces(call: ResolvedCall): boolean
  /** Calls with a reply: `impl` runs its callback parameter, and the flow
   * comes back to `caller`. For the callback join. */
  replies: { caller: GraphFunction; line: number; impl: GraphFunction }[]
  /** Function id → the node that runs the callbacks that the function gives
   * to code outside the change. For the callback join. */
  outside: ReadonlyMap<string, string>
}

export interface GraphRepo {
  name: string
  /** The kinds of arrow that `connect` adds. */
  kinds: readonly EdgeKind[]
  /** A file that the language steps do not parse, but that `connect` reads. */
  reads(path: string): boolean
  /** The group of a file: where its code runs, or what it is a part of. */
  groupOf(path: string): string
  /** The boxes inside the group, the outer one first. */
  boxes(path: string, cls: string | undefined): (string | undefined)[]
  /** Short marks for the card of a file. */
  tags(path: string): string[]
  /** The names of the C++ library of the repo. */
  cpp: CppIdioms
  /**
   * Mark each function of the logic with what the tests of the change call.
   * Only for a repo that knows its test library: without it, the calls of
   * the tests are not in the graph, and "no test calls it" would be wrong.
   */
  testMark: boolean
  /** `byName`: the name of the file says that it is a test. */
  isTest(path: string, byName: boolean): boolean
  connect(context: RepoContext): RepoJoin
}

/** The rules of one repo, and how Diffo knows that a change is of that repo. */
export interface RepoRules {
  repo: GraphRepo
  /** The paths of the changed files tell that the change is of this repo. */
  detects(paths: readonly string[]): boolean
}

/** A repo with no connections of its own. */
export const NO_JOIN: RepoJoin = {
  nodes: [],
  edges: [],
  shown: [],
  replaces: () => false,
  replies: [],
  outside: new Map(),
}

/** The folder of a file. */
export function folderOf(path: string): string {
  const cut = path.lastIndexOf('/')
  return cut < 0 ? '' : path.slice(0, cut)
}
