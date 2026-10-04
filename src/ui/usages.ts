import type { FileChange, LineKind } from '../shared/types.js'

/**
 * Where else a name appears in the change.
 *
 * Purely textual, on purpose: the reviewer reads one changeset at a time, in any
 * language, with nothing installed — so the search is word-boundary matching over
 * the diff lines already in the browser, not a language server. A same-named
 * local somewhere else will show up; the line preview is what lets the reviewer
 * tell. The hover layer (`SymbolHover.tsx`) decides *what* is hoverable using the
 * highlighter's scopes; this module only answers "where".
 */

/** Which version of the code a usage lives in. A deleted line's name is searched
 * in the base version, everything else in head. */
export type Side = 'base' | 'head'

export interface Usage {
  path: string
  hunkId: string
  /** Line number on `side`. */
  line: number
  text: string
  /** Column of the match in `text`, 0-based. */
  col: number
}

export interface UsageGroup {
  path: string
  usages: Usage[]
}

const IDENT = /[A-Za-z_$][\w$]*/g

/** The identifier under `offset` in `text` — the caret sits between characters, so
 * an offset at a word's end still belongs to that word. */
export function wordAt(
  text: string,
  offset: number,
): { word: string; start: number; end: number } | null {
  IDENT.lastIndex = 0
  for (const m of text.matchAll(IDENT)) {
    const start = m.index
    const end = start + m[0].length
    if (offset < start) return null
    if (offset <= end) return { word: m[0], start, end }
  }
  return null
}

/** Reserved words across the languages the highlighter knows. A hover on `return`
 * or `self` has nothing to find; the keyword list covers grammars whose tokens
 * carry no scope to say so. Case-sensitive: `None` is a keyword, `none` a name. */
const KEYWORDS = new Set(
  (
    'abstract and as assert async await begin bool boolean break case catch chan char class ' +
    'const continue crate debugger decimal def default defer del delete do done double dyn elif ' +
    'else elsif end ensure enum esac except export extends extern fallthrough false fi final ' +
    'finally float fn for from func function global go goto if impl implements import in ' +
    'include instanceof int interface internal is lambda let local long loop match mod module ' +
    'move mut namespace native new nil nonlocal not null of or override package pass private ' +
    'protected pub public raise readonly ref require rescue return satisfies sealed select ' +
    'self short signed sizeof static struct super switch template then this throw throws ' +
    'trait transient true try type typedef typename typeof undefined union unless unsigned ' +
    'until use using var virtual void volatile where while with yield ' +
    'None True False Self'
  ).split(' '),
)

export function isSymbolWord(word: string): boolean {
  return word.length > 0 && !KEYWORDS.has(word)
}

function onSide(kind: LineKind, side: Side): boolean {
  return side === 'base' ? kind !== 'add' : kind !== 'del'
}

/** Escape for use inside a RegExp — `$` is legal in a JS identifier. */
function forRegExp(word: string): string {
  return word.replace(/[$\\]/g, '\\$&')
}

/**
 * Every line of the changeset, on `side`, that mentions `word` as a whole
 * identifier — grouped by file in changeset order, lines in file order. Hunk
 * context lines count: they are code the change sits in.
 */
export function findUsages(files: readonly FileChange[], word: string, side: Side): UsageGroup[] {
  if (!word) return []
  const re = new RegExp(`(?<![\\w$])${forRegExp(word)}(?![\\w$])`)
  const groups: UsageGroup[] = []
  for (const file of files) {
    if (file.kind !== 'text') continue
    const usages: Usage[] = []
    for (const hunk of file.hunks) {
      for (const l of hunk.lines) {
        if (!onSide(l.kind, side)) continue
        const line = side === 'base' ? l.oldNo : l.newNo
        if (line === null) continue
        const m = re.exec(l.text)
        if (!m) continue
        usages.push({ path: file.path, hunkId: hunk.id, line, text: l.text, col: m.index })
      }
    }
    if (usages.length === 0) continue
    usages.sort((a, b) => a.line - b.line)
    groups.push({ path: file.path, usages })
  }
  return groups
}

export function countUsages(groups: readonly UsageGroup[]): number {
  return groups.reduce((n, g) => n + g.usages.length, 0)
}
