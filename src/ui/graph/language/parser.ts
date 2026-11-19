import { Language, Parser } from 'web-tree-sitter'
import { extractFunctions, type FunctionInfo, type GraphLang } from './extract.js'

/**
 * The tree-sitter parsers of the graph view. The runtime and the grammars
 * are WebAssembly files. The runtime loads the first time a graph is built.
 * A grammar loads the first time a change has a file of its language, so a
 * change with no C++ file does not get the C++ grammar.
 */

export interface GrammarUrls {
  runtime: string
  cpp: string
  ts: string
}

export type ParseFile = (lang: GraphLang, text: string) => FunctionInfo[]

const ALL: readonly GraphLang[] = ['cpp', 'ts']

let runtime: Promise<void> | null = null
const loading = new Map<GraphLang, Promise<Parser>>()
const parsers = new Map<GraphLang, Parser>()

function grammar(urls: GrammarUrls, lang: GraphLang): Promise<Parser> {
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
  langs: readonly GraphLang[] = ALL,
): Promise<ParseFile> {
  await Promise.all(langs.map((lang) => grammar(urls, lang)))
  return parseFile
}
