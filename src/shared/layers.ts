import type { Layer, LayerFile } from './review.js'

// Validation for a layers post, shared by the CLI (so the agent hears about a
// bad payload before it leaves the machine) and the server (which trusts
// nothing that arrives over HTTP). Both sides produce the same message for the
// same mistake, so the agent never sees two voices.

/** What the agent sends: a layer without the server-minted id. */
export type LayerInput = Omit<Layer, 'id'>

export type LayersParse = { ok: true; items: LayerInput[] } | { ok: false; error: string }

/** A summary is one or two sentences by doctrine; this is the backstop against
 * an essay, the same cap a closing note gets. */
const SUMMARY_CAP = 4000

/** A note is one line by contract — anything past the first newline is dropped,
 * and the line itself is capped so the file header stays a header. */
const NOTE_CAP = 200

const REPO_PATH = /^[^\0]+$/

/**
 * Paths are relative to the repo root: no leading slash, no `..` segment, no
 * Windows drive. Unknown paths are fine — the file may land later — but a path
 * that could never name a file in this repo is a mistake worth naming now.
 */
function badPath(path: string): string | null {
  if (path === '' || !REPO_PATH.test(path)) return 'is empty'
  if (path.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(path))
    return 'is absolute — use a repo-relative path'
  if (path.split('/').some((seg) => seg === '..')) return 'escapes the repo with `..`'
  return null
}

function parseFile(
  raw: unknown,
  where: string,
): { ok: true; file: LayerFile } | { ok: false; error: string } {
  if (typeof raw === 'string') {
    const path = raw.trim()
    const why = badPath(path.replace(/:\d+-\d+$/, ''))
    if (why) return { ok: false, error: `${where}: path "${raw}" ${why}` }
    return { ok: true, file: path }
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, error: `${where}: each file is a path string or { path, note? }` }
  }
  const f = raw as Record<string, unknown>
  if (typeof f.path !== 'string')
    return { ok: false, error: `${where}: a file object needs a "path"` }
  const path = f.path.trim()
  const why = badPath(path.replace(/:\d+-\d+$/, ''))
  if (why) return { ok: false, error: `${where}: path "${f.path}" ${why}` }
  if (f.note !== undefined && typeof f.note !== 'string') {
    return { ok: false, error: `${where}: "note" on ${path} must be a string` }
  }
  const note = typeof f.note === 'string' ? oneLine(f.note, NOTE_CAP) : undefined
  return { ok: true, file: note ? { path, note } : { path } }
}

/** First line, trimmed, capped. Empty when nothing survives. */
function oneLine(text: string, cap: number): string {
  const line = text.split('\n', 1)[0]!.trim()
  return line.length > cap ? `${line.slice(0, cap - 1).trimEnd()}…` : line
}

/** The reason behind `--suggest`, fit for the one line the empty state quotes
 * it in. Undefined when there is nothing usable — the suggestion stands alone. */
export function parseSuggestReason(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined
  const line = oneLine(raw, NOTE_CAP)
  return line === '' ? undefined : line
}

/**
 * The whole post, or the first thing wrong with it. Titles and file lists are
 * required and non-empty; everything else is optional and normalised — a
 * summary trimmed and capped, a note cut to one line, an unknown `kind`
 * refused rather than silently dropped (the agent meant something by it). Any
 * `id` the agent sends is ignored: the server mints them.
 */
export function parseLayersInput(raw: unknown): LayersParse {
  if (!Array.isArray(raw)) return { ok: false, error: 'layers must be a JSON array of layers' }
  if (raw.length === 0) return { ok: false, error: 'layers must list at least one layer' }
  const items: LayerInput[] = []
  const titles = new Set<string>()
  for (const [i, entry] of raw.entries()) {
    const where = `layer ${i + 1}`
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      return {
        ok: false,
        error: `${where}: each layer is an object { title, files, summary?, kind? }`,
      }
    }
    const l = entry as Record<string, unknown>
    const title = typeof l.title === 'string' ? oneLine(l.title, 120) : ''
    if (title === '') return { ok: false, error: `${where}: needs a non-empty "title"` }
    // Titles carry identity across re-posts (ids are preserved by title), so
    // two layers sharing one would collapse into each other.
    if (titles.has(title)) return { ok: false, error: `${where}: title "${title}" is used twice` }
    titles.add(title)
    if (!Array.isArray(l.files) || l.files.length === 0) {
      return { ok: false, error: `${where} ("${title}"): needs a non-empty "files" list` }
    }
    const files: LayerFile[] = []
    for (const f of l.files) {
      const parsed = parseFile(f, `${where} ("${title}")`)
      if (!parsed.ok) return parsed
      files.push(parsed.file)
    }
    if (l.summary !== undefined && typeof l.summary !== 'string') {
      return { ok: false, error: `${where} ("${title}"): "summary" must be a markdown string` }
    }
    const summary = typeof l.summary === 'string' ? l.summary.trim().slice(0, SUMMARY_CAP) : ''
    if (l.kind !== undefined && l.kind !== 'mechanical') {
      return {
        ok: false,
        error: `${where} ("${title}"): "kind" can only be "mechanical" — leave it out otherwise`,
      }
    }
    items.push({
      title,
      files,
      ...(summary !== '' ? { summary } : {}),
      ...(l.kind === 'mechanical' ? { kind: 'mechanical' as const } : {}),
    })
  }
  return { ok: true, items }
}
