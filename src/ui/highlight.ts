import type { HighlighterCore, ThemedToken } from 'shiki/core'

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
  h: 'c',
  cpp: 'cpp',
  hpp: 'cpp',
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
  docker: () => import('shiki/langs/docker.mjs'),
  go: () => import('shiki/langs/go.mjs'),
  html: () => import('shiki/langs/html.mjs'),
  java: () => import('shiki/langs/java.mjs'),
  javascript: () => import('shiki/langs/javascript.mjs'),
  json: () => import('shiki/langs/json.mjs'),
  jsx: () => import('shiki/langs/jsx.mjs'),
  kotlin: () => import('shiki/langs/kotlin.mjs'),
  markdown: () => import('shiki/langs/markdown.mjs'),
  php: () => import('shiki/langs/php.mjs'),
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
    const result = highlighter.codeToTokensBase(lines.join('\n'), {
      lang: lang as never,
      theme: dark ? 'github-dark' : 'github-light',
    })
    return result
  } catch {
    return null
  }
}
