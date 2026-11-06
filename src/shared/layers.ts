import {
  DECISION_PLACES,
  type Decision,
  type DecisionAt,
  type Layer,
  type LayerFile,
  type LineRange,
  layerFilePath,
  layerFileRange,
} from './review.js'
import type { FileChange, Hunk } from './types.js'

// Validation for a layers post, shared by the CLI (so the agent hears about a
// bad payload before it leaves the machine) and the server (which trusts
// nothing that arrives over HTTP). Both sides produce the same message for the
// same mistake, so the agent never sees two voices.

/** What the agent sends: a layer without the server-minted id. */
export type LayerInput = Omit<Layer, 'id'>

export type LayersParse = { ok: true; items: LayerInput[] } | { ok: false; error: string }

/** A summary is short by doctrine; this is the backstop against an essay, the
 * same cap a closing note gets. */
const SUMMARY_CAP = 4000

/** A note is one line by contract — anything past the first newline is dropped,
 * and the line itself is capped so the file header stays a header. */
const NOTE_CAP = 200

/** A decision is one short line and, on open, one sentence. The caps are the
 * backstop; the doctrine asks for far less. Five per layer, hard: a sixth
 * means the agent is retelling the diff, and the post says so. */
export const DECISIONS_PER_LAYER = 5
const DECISION_TEXT_CAP = 120
const DECISION_DETAIL_CAP = 400

const REPO_PATH = /^[^\0]+$/

/**
 * Paths are relative to the repo root: no leading slash, no `..` segment, no
 * Windows drive. Unknown paths are fine — the file may land later — but a path
 * that could never name a file in this repo is a mistake worth naming now.
 */
function badPath(path: string): string | null {
  if (path === '' || !REPO_PATH.test(path)) return 'is empty'
  if (path.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(path))
    return 'is absolute; use a repo-relative path'
  if (path.split('/').some((seg) => seg === '..')) return 'escapes the repo with `..`'
  return null
}

/**
 * A file entry's reference, checked and normalised: the path is repo-relative,
 * and a `:from-to` range, when there is one, is 1-based with `from` first.
 * Returns the reference to store, or what is wrong with it.
 */
function parseFileRef(raw: string): { ok: true; ref: string } | { ok: false; error: string } {
  const ref = raw.trim()
  const path = layerFilePath(ref)
  const why = badPath(path)
  if (why) return { ok: false, error: `path "${raw}" ${why}` }
  const range = layerFileRange(ref)
  if (range === null) return { ok: true, ref }
  if (range.from < 1 || range.to < 1) {
    return { ok: false, error: `line range in "${raw}" must start at 1 or more` }
  }
  const [from, to] = range.from <= range.to ? [range.from, range.to] : [range.to, range.from]
  return { ok: true, ref: `${path}:${from}-${to}` }
}

function parseFile(
  raw: unknown,
  where: string,
): { ok: true; file: LayerFile } | { ok: false; error: string } {
  if (typeof raw === 'string') {
    const parsed = parseFileRef(raw)
    if (!parsed.ok) return { ok: false, error: `${where}: ${parsed.error}` }
    return { ok: true, file: parsed.ref }
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, error: `${where}: each file is a path string or { path, note? }` }
  }
  const f = raw as Record<string, unknown>
  if (typeof f.path !== 'string')
    return { ok: false, error: `${where}: a file object needs a "path"` }
  const parsed = parseFileRef(f.path)
  if (!parsed.ok) return { ok: false, error: `${where}: ${parsed.error}` }
  const path = parsed.ref
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

/**
 * Where a decision points: `path`, `path:line` or `path:from-to`, the same
 * spelling a file reference in a summary uses. Lines are head-side and
 * 1-based; a range is normalised so `from` never exceeds `to`.
 */
export function parseDecisionAt(raw: string): DecisionAt | string {
  const m = /^(.*?)(?::(\d+)(?:-(\d+))?)?$/.exec(raw.trim())
  const path = m?.[1] ?? ''
  const why = badPath(path)
  if (why) return `"at" path "${raw}" ${why}`
  if (m?.[2] === undefined) return { path }
  const a = Number.parseInt(m[2], 10)
  const b = m[3] === undefined ? a : Number.parseInt(m[3], 10)
  if (a < 1 || b < 1) return `"at" line in "${raw}" must be 1 or more`
  const [line, endLine] = a <= b ? [a, b] : [b, a]
  return endLine === line ? { path, line } : { path, line, endLine }
}

/** The object form of `at` back as the string the agent would have written;
 * null for anything that is not that object. */
function atToString(raw: unknown): string | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const a = raw as Record<string, unknown>
  if (typeof a.path !== 'string') return null
  if (a.line === undefined) return a.endLine === undefined ? a.path : null
  if (typeof a.line !== 'number' || !Number.isInteger(a.line)) return null
  if (a.endLine === undefined) return `${a.path}:${a.line}`
  if (typeof a.endLine !== 'number' || !Number.isInteger(a.endLine)) return null
  return `${a.path}:${a.line}-${a.endLine}`
}

function parseDecision(
  raw: unknown,
  where: string,
): { ok: true; decision: Decision } | { ok: false; error: string } {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, error: `${where}: each decision is an object { text, detail?, at? }` }
  }
  const d = raw as Record<string, unknown>
  const text = typeof d.text === 'string' ? oneLine(d.text, DECISION_TEXT_CAP) : ''
  if (text === '') return { ok: false, error: `${where}: needs a non-empty "text"` }
  if (d.detail !== undefined && typeof d.detail !== 'string') {
    return { ok: false, error: `${where} ("${text}"): "detail" must be a string` }
  }
  const detail =
    typeof d.detail === 'string' ? d.detail.trim().slice(0, DECISION_DETAIL_CAP) : undefined
  let at: DecisionAt[] | undefined
  if (d.at !== undefined) {
    // The agent writes `at` as one string, or a few. What comes back out of
    // this parser is the object form, and it passes through here again — the
    // CLI validates before the server does, and the store re-validates on
    // load — so the object form is accepted too, as the one spelling of itself.
    const raws = Array.isArray(d.at) ? d.at : [d.at]
    if (raws.length === 0) {
      return { ok: false, error: `${where} ("${text}"): "at" must name at least one place` }
    }
    if (raws.length > DECISION_PLACES) {
      return {
        ok: false,
        error: `${where} ("${text}"): "at" names ${raws.length} places; keep it to ${DECISION_PLACES} — the layer's files are the file list`,
      }
    }
    at = []
    for (const raw of raws) {
      const str = typeof raw === 'string' ? raw : atToString(raw)
      if (str === null) {
        return {
          ok: false,
          error: `${where} ("${text}"): "at" is a string — "path", "path:line" or "path:from-to" — or a list of up to ${DECISION_PLACES}`,
        }
      }
      const parsed = parseDecisionAt(str)
      if (typeof parsed === 'string') return { ok: false, error: `${where} ("${text}"): ${parsed}` }
      at.push(parsed)
    }
  }
  return {
    ok: true,
    decision: {
      text,
      ...(detail ? { detail } : {}),
      ...(at ? { at } : {}),
    },
  }
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
 * refused rather than silently dropped (the agent meant something by it), a
 * decisions list checked entry by entry and refused past five. Any `id` the
 * agent sends is ignored: the server mints them.
 */
export function parseLayersInput(raw: unknown): LayersParse {
  if (!Array.isArray(raw)) return { ok: false, error: 'layers must be a JSON array of layers' }
  if (raw.length === 0) return { ok: false, error: 'layers must list at least one layer' }
  const items: LayerInput[] = []
  const titles = new Set<string>()
  // Where each path was first listed whole, and first listed by range: the
  // two cannot mix, or "whole" would have to mean "the rest".
  const whole = new Map<string, string>()
  const ranged = new Map<string, string>()
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
      const path = layerFilePath(parsed.file)
      const isRange = layerFileRange(parsed.file) !== null
      const other = (isRange ? whole : ranged).get(path)
      if (other !== undefined) {
        const here = `${where} ("${title}")`
        return {
          ok: false,
          error: `${here}: "${path}" is listed ${isRange ? 'by range here and whole' : 'whole here and by range'} in ${other} — range it in every step that has a part of it, or list it whole once`,
        }
      }
      ;(isRange ? ranged : whole).set(path, `${where} ("${title}")`)
    }
    if (l.summary !== undefined && typeof l.summary !== 'string') {
      return { ok: false, error: `${where} ("${title}"): "summary" must be a markdown string` }
    }
    const summary = typeof l.summary === 'string' ? l.summary.trim().slice(0, SUMMARY_CAP) : ''
    if (l.kind !== undefined && l.kind !== 'mechanical') {
      return {
        ok: false,
        error: `${where} ("${title}"): "kind" can only be "mechanical"; leave it out otherwise`,
      }
    }
    let decisions: Decision[] | undefined
    if (l.decisions !== undefined) {
      if (!Array.isArray(l.decisions)) {
        return { ok: false, error: `${where} ("${title}"): "decisions" must be a list` }
      }
      if (l.decisions.length > DECISIONS_PER_LAYER) {
        return {
          ok: false,
          error: `${where} ("${title}"): keep "decisions" to ${DECISIONS_PER_LAYER} — the ones a reviewer could want done differently, not a retelling of the diff`,
        }
      }
      decisions = []
      for (const [j, raw] of l.decisions.entries()) {
        const parsed = parseDecision(raw, `${where} ("${title}") decision ${j + 1}`)
        if (!parsed.ok) return parsed
        decisions.push(parsed.decision)
      }
    }
    items.push({
      title,
      files,
      ...(summary !== '' ? { summary } : {}),
      ...(l.kind === 'mechanical' ? { kind: 'mechanical' as const } : {}),
      ...(decisions && decisions.length > 0 ? { decisions } : {}),
    })
  }
  return { ok: true, items }
}

// ---------- ranges against hunks ----------
//
// A layer entry with a range names the hunks that range touches. Lines are
// head-side, the side the reviewer reads, and the test is an overlap, not an
// exact match: a range the agent copied from the ask still lands after a line
// or two moved under it. Shared by the UI's resolver and the server's post-time
// coverage report, so the two can never disagree about which hunk is whose.

/**
 * The head-side lines a hunk shows, inclusive. A hunk that only deletes shows
 * no head line; git names the line before it, so that is its span — one line,
 * never below 1.
 */
export function hunkHeadSpan(hunk: Hunk): LineRange {
  let count = 0
  for (const line of hunk.lines) if (line.kind !== 'del') count++
  if (count === 0) {
    const at = Math.max(1, hunk.newStart)
    return { from: at, to: at }
  }
  return { from: hunk.newStart, to: hunk.newStart + count - 1 }
}

export function rangeTouchesHunk(range: LineRange, hunk: Hunk): boolean {
  const span = hunkHeadSpan(hunk)
  return range.from <= span.to && range.to >= span.from
}

/** `12-40`, the way the ask lists a hunk and the agent writes it back. */
export function formatSpan(span: LineRange): string {
  return span.from === span.to ? `${span.from}` : `${span.from}-${span.to}`
}

/**
 * The hunks of a file the outline leaves in no layer, by path, plus the files
 * it does not name at all. Against the live changeset, like everything about
 * layers; a whole-file entry claims every hunk, a ranged one the hunks it
 * touches. Empty when every hunk is somewhere. Hunkless files count as one
 * unit: listed or not.
 */
export interface UncoveredFile {
  path: string
  /** The hunks no range claimed, in file order; empty when the file itself
   * is not in the outline. */
  hunks: Hunk[]
  /** The file appears in no layer at all. */
  unlisted: boolean
}

export function uncoveredByLayers(
  layers: readonly Pick<Layer, 'files'>[],
  files: readonly FileChange[],
): UncoveredFile[] {
  const wholePaths = new Set<string>()
  const ranges = new Map<string, LineRange[]>()
  for (const layer of layers) {
    for (const entry of layer.files) {
      const path = layerFilePath(entry)
      const range = layerFileRange(entry)
      if (range === null) wholePaths.add(path)
      else {
        const list = ranges.get(path)
        if (list) list.push(range)
        else ranges.set(path, [range])
      }
    }
  }
  const out: UncoveredFile[] = []
  for (const file of files) {
    if (wholePaths.has(file.path)) continue
    const own = ranges.get(file.path)
    if (!own) {
      out.push({ path: file.path, hunks: [], unlisted: true })
      continue
    }
    const rest = file.hunks.filter((h) => !own.some((r) => rangeTouchesHunk(r, h)))
    if (rest.length > 0) out.push({ path: file.path, hunks: rest, unlisted: false })
  }
  return out
}

/** One uncovered file as the post's ack reports it: the whole file when the
 * outline never names it, else the head-side ranges of the hunks it missed. */
export interface UncoveredRef {
  path: string
  ranges?: string[]
}

export function describeUncovered(u: UncoveredFile): UncoveredRef {
  return u.unlisted
    ? { path: u.path }
    : { path: u.path, ranges: u.hunks.map((h) => formatSpan(hunkHeadSpan(h))) }
}

/** `src/a.ts:88-95, src/a.ts:140-162, src/b.ts (whole)` — the ack's one line. */
export function uncoveredLine(refs: readonly UncoveredRef[]): string {
  return refs
    .flatMap((u) => (u.ranges ? u.ranges.map((r) => `${u.path}:${r}`) : [`${u.path} (whole)`]))
    .join(', ')
}
