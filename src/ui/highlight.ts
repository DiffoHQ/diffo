import type { HighlighterCore, ThemedToken } from 'shiki/core'
import { patchRuns, targetFromPatchName } from './patch.js'

const LANG_BY_EXT: Record<string, string> = {
  ts: 'typescript',
  tsx: 'tsx',
  js: 'javascript',
  jsx: 'jsx',
  mjs: 'javascript',
  cjs: 'javascript',
  json: 'json',
  css: 'css',
  scss: 'scss',
  html: 'html',
  md: 'markdown',
  py: 'python',
  rb: 'ruby',
  go: 'go',
  rs: 'rust',
  java: 'java',
  kt: 'kotlin',
  swift: 'swift',
  c: 'c',
  // C++ grammar reads C fine; the reverse leaves templates and namespaces plain.
  h: 'cpp',
  cc: 'cpp',
  cpp: 'cpp',
  cxx: 'cpp',
  hh: 'cpp',
  hpp: 'cpp',
  hxx: 'cpp',
  m: 'objective-c',
  mm: 'objective-cpp',
  proto: 'proto',
  gn: 'gn',
  gni: 'gn',
  cs: 'csharp',
  sh: 'shellscript',
  bash: 'shellscript',
  zsh: 'shellscript',
  yml: 'yaml',
  yaml: 'yaml',
  toml: 'toml',
  sql: 'sql',
  vue: 'vue',
  svelte: 'svelte',
  php: 'php',
  xml: 'xml',
  dockerfile: 'docker',
  patch: 'diff',
  diff: 'diff',
}

type LangModule = { default: Parameters<HighlighterCore['loadLanguage']>[0] }

/**
 * One lazy import per grammar we ship — and the reason the client is ~1 MB instead
 * of ~10 MB. Importing `shiki` directly pulls its full registry (~200 grammars) and
 * the bundler emits every one as a chunk.
 *
 * A grammar brings its own embedded languages: `vue` arrives with html/css/js/ts
 * attached. Keep this in sync with `LANG_BY_EXT` — a language mapped there with no
 * loader here silently falls back to plain text.
 */
const LOADERS: Record<string, () => Promise<LangModule>> = {
  c: () => import('shiki/langs/c.mjs'),
  cpp: () => import('shiki/langs/cpp.mjs'),
  csharp: () => import('shiki/langs/csharp.mjs'),
  css: () => import('shiki/langs/css.mjs'),
  diff: () => import('shiki/langs/diff.mjs'),
  docker: () => import('shiki/langs/docker.mjs'),
  gn: () => import('shiki/langs/gn.mjs'),
  go: () => import('shiki/langs/go.mjs'),
  html: () => import('shiki/langs/html.mjs'),
  java: () => import('shiki/langs/java.mjs'),
  javascript: () => import('shiki/langs/javascript.mjs'),
  json: () => import('shiki/langs/json.mjs'),
  jsx: () => import('shiki/langs/jsx.mjs'),
  kotlin: () => import('shiki/langs/kotlin.mjs'),
  markdown: () => import('shiki/langs/markdown.mjs'),
  'objective-c': () => import('shiki/langs/objective-c.mjs'),
  'objective-cpp': () => import('shiki/langs/objective-cpp.mjs'),
  php: () => import('shiki/langs/php.mjs'),
  proto: () => import('shiki/langs/proto.mjs'),
  python: () => import('shiki/langs/python.mjs'),
  ruby: () => import('shiki/langs/ruby.mjs'),
  rust: () => import('shiki/langs/rust.mjs'),
  scss: () => import('shiki/langs/scss.mjs'),
  shellscript: () => import('shiki/langs/shellscript.mjs'),
  sql: () => import('shiki/langs/sql.mjs'),
  svelte: () => import('shiki/langs/svelte.mjs'),
  swift: () => import('shiki/langs/swift.mjs'),
  toml: () => import('shiki/langs/toml.mjs'),
  tsx: () => import('shiki/langs/tsx.mjs'),
  typescript: () => import('shiki/langs/typescript.mjs'),
  vue: () => import('shiki/langs/vue.mjs'),
  xml: () => import('shiki/langs/xml.mjs'),
  yaml: () => import('shiki/langs/yaml.mjs'),
}

export function langForPath(path: string): string | null {
  const name = path.slice(path.lastIndexOf('/') + 1).toLowerCase()
  if (name === 'dockerfile') return 'docker'
  const ext = name.slice(name.lastIndexOf('.') + 1)
  return LANG_BY_EXT[ext] ?? null
}

let highlighterPromise: Promise<HighlighterCore> | null = null

async function getHighlighter(): Promise<HighlighterCore> {
  if (!highlighterPromise) {
    highlighterPromise = (async () => {
      // Dynamic, not top-level: the engine and its wasm are ~600 kB, and a reviewer
      // looking at a changeset of images never needs them.
      const [{ createHighlighterCore }, { createOnigurumaEngine }] = await Promise.all([
        import('shiki/core'),
        import('shiki/engine/oniguruma'),
      ])
      return createHighlighterCore({
        themes: [import('shiki/themes/github-light.mjs'), import('shiki/themes/github-dark.mjs')],
        langs: [],
        engine: createOnigurumaEngine(import('shiki/wasm')),
      })
    })()
  }
  return highlighterPromise
}

const loading = new Map<string, Promise<void>>()

function loadLang(highlighter: HighlighterCore, lang: string): Promise<void> | null {
  if (highlighter.getLoadedLanguages().includes(lang)) return null
  const inFlight = loading.get(lang)
  if (inFlight) return inFlight
  const load = LOADERS[lang]
  if (!load) return null
  const promise = load()
    .then((module) => highlighter.loadLanguage(module.default))
    .finally(() => loading.delete(lang))
  loading.set(lang, promise)
  return promise
}

export type LineTokens = ThemedToken[]

export async function tokenizeLines(
  lines: string[],
  path: string,
  dark: boolean,
): Promise<LineTokens[] | null> {
  const lang = langForPath(path)
  if (!lang || lines.length === 0) return null
  try {
    const highlighter = await getHighlighter()
    await loadLang(highlighter, lang)
    if (!highlighter.getLoadedLanguages().includes(lang)) return null
    if (lang === 'diff') return await tokenizePatch(highlighter, lines, path, dark)
    return tokenize(highlighter, lines, lang, dark)
  } catch {
    return null
  }
}

function tokenize(
  highlighter: HighlighterCore,
  lines: string[],
  lang: string,
  dark: boolean,
): LineTokens[] {
  return highlighter.codeToTokensBase(lines.join('\n'), {
    lang: lang as never,
    theme: dark ? 'github-dark' : 'github-light',
    // Scope names ride along so the hover layer can tell a name from a comment,
    // a string or a keyword without parsing anything itself.
    includeExplanation: 'scopeName',
  })
}

/** A language for code inside a patch: a patch of a patch reads as plain diff. */
function codeLangForPath(path: string): string | null {
  const lang = langForPath(path)
  return lang === 'diff' ? null : lang
}

/** A patch line's marker, in the diff grammar's colour, ahead of its code. */
function withMarker(line: string, code: LineTokens, asDiff: LineTokens | undefined): LineTokens {
  if (line === '') return code
  const marker = line[0]!
  const prefix: ThemedToken = {
    content: marker,
    offset: 0,
    color: asDiff?.[0]?.color,
    explanation: [
      {
        content: marker,
        scopes: [{ scopeName: 'punctuation.definition.patch', themeMatches: [] }],
      },
    ],
  }
  return [prefix, ...code]
}

/**
 * A patch reads in two grammars: headers and markers in the diff grammar, and
 * each line's code — past its `+`/`-`/` ` — in the language of the file it
 * targets.
 */
async function tokenizePatch(
  highlighter: HighlighterCore,
  lines: string[],
  path: string,
  dark: boolean,
): Promise<LineTokens[]> {
  const asDiff = tokenize(highlighter, lines, 'diff', dark)
  const target = targetFromPatchName(path)
  const runs = patchRuns(lines, target ? codeLangForPath(target) : null, codeLangForPath)
  await Promise.all([...new Set(runs.map((r) => r.lang))].map((l) => loadLang(highlighter, l)))

  const result = asDiff.slice()
  for (const run of runs) {
    if (!highlighter.getLoadedLanguages().includes(run.lang)) continue
    // Old last, so context lines take the old side's tokens, as HunkCard does.
    for (const side of [run.new, run.old]) {
      const code = tokenize(
        highlighter,
        side.map((i) => lines[i]!.slice(1)),
        run.lang,
        dark,
      )
      for (const [k, i] of side.entries())
        result[i] = withMarker(lines[i]!, code[k] ?? [], asDiff[i])
    }
  }
  return result
}

/** Scopes whose text is never a hoverable name: prose, literals, syntax. A scope
 * anywhere in the stack counts — a word inside a comment is a comment, and a
 * whole Markdown or HTML file is prose (`text.*` roots), code fences included. */
const NOT_SYMBOL =
  /^(text|comment|string|keyword|storage|punctuation|constant\.(numeric|language|character)|variable\.language|support\.type\.primitive)\b/

export interface SymbolRun {
  content: string
  /** Whether this stretch may hold an identifier worth looking up. */
  sym: boolean
}

/**
 * A themed token, cut where its hoverability changes.
 *
 * Shiki merges neighbouring grammar tokens that share a colour, so one token is
 * often `{ name, ` — brace, name and comma together — with the grammar's view of
 * each part kept in `explanation`. The usages hover must not lose the name to its
 * punctuation, nor light the comma: each part is judged on its own scopes and
 * same-verdict neighbours are glued back. A token without scopes (plain text, or
 * a grammar that said nothing) is one run that leans yes, leaving the word list
 * to decide.
 */
export function symbolRuns(token: ThemedToken): SymbolRun[] {
  const explanation = token.explanation
  if (!explanation || explanation.length === 0) return [{ content: token.content, sym: true }]
  const runs: SymbolRun[] = []
  for (const part of explanation) {
    const sym = !part.scopes.some((scope) => NOT_SYMBOL.test(scope.scopeName))
    const last = runs[runs.length - 1]
    if (last && last.sym === sym) last.content += part.content
    else runs.push({ content: part.content, sym })
  }
  return runs
}
