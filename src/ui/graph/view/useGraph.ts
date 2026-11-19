import { useEffect, useState } from 'react'
import cppUrl from 'tree-sitter-cpp/tree-sitter-cpp.wasm?url'
import tsxUrl from 'tree-sitter-typescript/tree-sitter-tsx.wasm?url'
import tsUrl from 'tree-sitter-typescript/tree-sitter-typescript.wasm?url'
import runtimeUrl from 'web-tree-sitter/web-tree-sitter.wasm?url'
import type { FileChange } from '../../../shared/types.js'
import { isTestFile } from '../../reviewFilter.js'
import { buildSides, type GraphSides } from '../basic/build.js'
import { graphGrammar, graphLang } from '../language/extract.js'
import { loadParser } from '../language/parser.js'
import type { GraphRepo } from '../repo/repo.js'
import { MAX_FILE_BYTES } from './constants.js'

export async function fileText(file: FileChange, side: 'head' | 'base'): Promise<string | null> {
  const rev = side === 'head' && file.rev ? `&rev=${encodeURIComponent(file.rev)}` : ''
  const path = side === 'base' ? (file.oldPath ?? file.path) : file.path
  const res = await fetch(`/api/file?path=${encodeURIComponent(path)}&side=${side}${rev}`)
  if (!res.ok) return null
  const text = await res.text()
  return text.length > MAX_FILE_BYTES ? null : text
}

export function useGraph(
  files: readonly FileChange[],
  repo: GraphRepo,
): {
  graph: GraphSides | null
  error: string | null
} {
  const [graph, setGraph] = useState<GraphSides | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let cancelled = false
    const readable = files.filter(
      (f) =>
        f.kind === 'text' &&
        // A file that is not parsed, but that the repo reads.
        (graphLang(f.path) !== null || repo.reads(f.path)),
    )
    const sides = (side: 'head' | 'base') =>
      Promise.all(
        readable
          // A deleted file has no head text. An added file has no base text.
          .filter((f) => (side === 'head' ? f.status !== 'deleted' : f.status !== 'added'))
          .map(async (f) => [f.path, await fileText(f, side)] as const),
      )
    const grammars = new Set(readable.flatMap((f) => graphGrammar(f.path) ?? []))
    Promise.all([
      loadParser({ runtime: runtimeUrl, cpp: cppUrl, ts: tsUrl, tsx: tsxUrl }, [...grammars]),
      sides('head'),
      // The base text tells what the change removes.
      sides('base'),
    ])
      .then(([parse, head, base]) => {
        if (cancelled) return
        const texts = new Map<string, string>()
        for (const [path, text] of head) if (text !== null) texts.set(path, text)
        const baseTexts = new Map<string, string>()
        for (const [path, text] of base) if (text !== null) baseTexts.set(path, text)
        setGraph(buildSides(files, texts, parse, isTestFile, baseTexts, repo))
        setError(null)
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err))
      })
    return () => {
      cancelled = true
    }
  }, [files, repo])
  return { graph, error }
}
