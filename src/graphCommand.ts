import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { isTestFile } from './shared/testFiles.js'
import type { Changeset, FileChange } from './shared/types.js'
import { buildGraph } from './ui/graph/basic/build.js'
import { graphGrammar, graphLang } from './ui/graph/language/extract.js'
import { loadParser } from './ui/graph/language/parser.js'

/**
 * The code graph of the changeset, for `diffo graph`: the basic graph that
 * the review shows, as data for the agent. It has only what the diff and the
 * language tell for a fact, and a list of what the text cannot tell: the
 * places where the code gives a callback or an object to code that is not in
 * the change.
 */

export interface GraphReport {
  ok: true
  cards: {
    id: string
    path: string
    name: string | null
    /** The first and the last head line of the card. */
    lines: [number, number] | null
    /** The change removes the function. */
    removed?: true
    class?: string
    override_of?: string[]
  }[]
  arrows: { from: string; to: string; line: number; kind: string }[]
  open: { from: string; runs: string; line: number; given_to: string | null }[]
  /** Files with a parser whose text was not read. */
  skipped: string[]
}

/** The grammars are the WebAssembly files that the build of the page makes. */
function grammars(clientDir: string): { runtime: string; cpp: string; ts: string; tsx: string } {
  const assets = join(clientDir, 'assets')
  const names = existsSync(assets) ? readdirSync(assets) : []
  const find = (prefix: string) => {
    const name = names.find((n) => n.startsWith(prefix) && n.endsWith('.wasm'))
    if (name === undefined) throw new Error(`no ${prefix} grammar in ${assets}`)
    return join(assets, name)
  }
  return {
    runtime: find('web-tree-sitter'),
    cpp: find('tree-sitter-cpp'),
    ts: find('tree-sitter-typescript'),
    tsx: find('tree-sitter-tsx'),
  }
}

export async function graphReport(
  clientDir: string,
  get: (path: string) => Promise<Response>,
): Promise<GraphReport> {
  const changeset = (await (await get('/api/changeset')).json()) as Changeset
  const files = changeset.files
  const text = async (file: FileChange, side: 'head' | 'base'): Promise<string | null> => {
    const rev = side === 'head' && file.rev ? `&rev=${encodeURIComponent(file.rev)}` : ''
    const path = side === 'base' ? (file.oldPath ?? file.path) : file.path
    const res = await get(`/api/file?path=${encodeURIComponent(path)}&side=${side}${rev}`)
    return res.ok ? await res.text() : null
  }
  const parsed = files.filter((f) => f.kind === 'text' && graphLang(f.path) !== null)
  const texts = new Map<string, string>()
  const baseTexts = new Map<string, string>()
  await Promise.all(
    parsed.flatMap((f) => [
      f.status === 'deleted'
        ? null
        : text(f, 'head').then((t) => t !== null && texts.set(f.path, t)),
      f.status === 'added'
        ? null
        : text(f, 'base').then((t) => t !== null && baseTexts.set(f.path, t)),
    ]),
  )
  const needed = new Set(parsed.flatMap((f) => graphGrammar(f.path) ?? []))
  const parse = await loadParser(grammars(clientDir), [...needed])
  const graph = buildGraph(files, texts, parse, isTestFile, baseTexts)
  const span = (lines: { newNo: number | null }[]): [number, number] | null => {
    const numbers = lines.flatMap((l) => (l.newNo === null ? [] : [l.newNo]))
    return numbers.length > 0 ? [Math.min(...numbers), Math.max(...numbers)] : null
  }
  return {
    ok: true,
    cards: graph.nodes.map((n) => ({
      id: n.id,
      path: n.path,
      name: n.name,
      lines: span(n.lines),
      ...(n.removed ? { removed: true as const } : {}),
      ...(n.cls ? { class: n.cls } : {}),
      ...(n.override ? { override_of: n.override } : {}),
    })),
    arrows: graph.edges
      .filter((e) => e.method !== 'open')
      .map((e) => ({ from: e.from, to: e.to, line: e.line, kind: e.kind })),
    open: graph.edges
      .filter((e) => e.method === 'open')
      .map((e) => ({ from: e.from, runs: e.to, line: e.line, given_to: e.via ?? null })),
    skipped: graph.skipped,
  }
}
