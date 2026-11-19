import { createRequire } from 'node:module'
import type { DiffLine, FileChange } from '../../shared/types.js'
import { loadParser, type ParseFile } from './language/parser.js'

/** What the tests of the code graph share. Not a part of the page. */

const require = createRequire(import.meta.url)

/** The parser of the page, with the grammars from the packages. */
export function loadTestParser(): Promise<ParseFile> {
  return loadParser({
    runtime: require.resolve('web-tree-sitter/web-tree-sitter.wasm'),
    cpp: require.resolve('tree-sitter-cpp/tree-sitter-cpp.wasm'),
    ts: require.resolve('tree-sitter-typescript/tree-sitter-typescript.wasm'),
    tsx: require.resolve('tree-sitter-typescript/tree-sitter-tsx.wasm'),
  })
}

/** A file whose listed head lines are additions, as one hunk for each run. */
export function added(path: string, text: string, lines: number[]): FileChange {
  const all = text.split('\n')
  const want = new Set(lines)
  const hunks: FileChange['hunks'] = []
  let run: DiffLine[] = []
  let start = 0
  const flush = () => {
    if (run.length === 0) return
    hunks.push({
      id: `${path}:${start}`,
      path,
      oldStart: start,
      newStart: start,
      lines: run,
    })
    run = []
  }
  all.forEach((line, i) => {
    const no = i + 1
    const near = want.has(no) || want.has(no - 1) || want.has(no + 1)
    if (!near) {
      flush()
      return
    }
    if (run.length === 0) start = no
    run.push({
      kind: want.has(no) ? 'add' : 'context',
      oldNo: want.has(no) ? null : no,
      newNo: no,
      text: line,
    })
  })
  flush()
  return { path, oldPath: null, status: 'modified', kind: 'text', staged: false, hunks }
}
