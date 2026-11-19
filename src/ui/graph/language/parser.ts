import { Language, Parser } from 'web-tree-sitter'
import { extractFunctions, type FunctionInfo, type Grammar } from './extract.js'

/**
 * The tree-sitter parsers of the graph view. The runtime and the grammars
 * are WebAssembly files. The runtime loads the first time a graph is built.
 * A grammar loads the first time a change has a file for it, so a change
 * with no C++ file does not get the C++ grammar.
 */

export interface GrammarUrls {
  runtime: string
  cpp: string
  ts: string
  tsx: string
}

export type ParseFile = (lang: Grammar, text: string) => FunctionInfo[]

const ALL: readonly Grammar[] = ['cpp', 'ts', 'tsx']

let runtime: Promise<void> | null = null
const loading = new Map<Grammar, Promise<Parser>>()
const parsers = new Map<Grammar, Parser>()

function grammar(urls: GrammarUrls, lang: Grammar): Promise<Parser> {
  let parser = loading.get(lang)
  if (parser === undefined) {
    runtime ??= Parser.init({ locateFile: () => urls.runtime }).catch((err: unknown) => {
      runtime = null
      throw err
    })
    parser = runtime
      .then(() => Language.load(urls[lang]))
      .then((language) => {
        const made = new Parser()
        made.setLanguage(language)
        parsers.set(lang, made)
        return made
      })
      .catch((err: unknown) => {
        loading.delete(lang)
        throw err
      })
    loading.set(lang, parser)
  }
  return parser
}

const parseFile: ParseFile = (lang, text) => {
  const tree = parsers.get(lang)?.parse(text)
  if (!tree) return []
  try {
    return extractFunctions(tree.rootNode, lang)
  } finally {
    tree.delete()
  }
}

/**
 * The parse function of the graph, with the grammars of `langs` loaded. Each
 * grammar loads one time.
 */
export async function loadParser(
  urls: GrammarUrls,
  langs: readonly Grammar[] = ALL,
): Promise<ParseFile> {
  await Promise.all(langs.map((lang) => grammar(urls, lang)))
  return parseFile
}
