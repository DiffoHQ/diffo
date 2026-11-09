import {
  type ClaimOptions,
  claimedHunks,
  claimsOf,
  highlightedRows,
  litChangedRows,
  uncoveredByLayers,
} from '../shared/layers.js'
import {
  type Decision,
  type DecisionAt,
  type Layers,
  type LineRange,
  layerFileHighlight,
  layerFileRange,
  type ReviewThread,
  startedByAgent,
} from '../shared/review.js'
import type { FileChange, Hunk } from '../shared/types.js'
import { changedLineMarks, fileMarks } from './fileMarks.js'

// Resolution happens at render, never at write. The agent posts paths; the
// changeset moves under them; every render re-asks which files each layer
// holds right now. Nothing here is stored, so nothing here can go stale.

export const SINCE_TITLE = 'Since your review'

export interface ResolvedLayerFile {
  file: FileChange
  /** The agent's one line on why this file is in this step. */
  note?: string
  /** The hunks this layer shows of the file, in file order: all of them for
   * a whole-file entry, the ones its ranges touch otherwise. */
  hunks: Hunk[]
  /** Some of the file's hunks belong to other steps: the pane shows `hunks`
   * and folds the rest, and the marks this entry counts are `hunks` alone. */
  partial: boolean
  /** The head-side lines this step is about within the file; absent when the
   * agent highlighted none, or none of `hunks`' changed lines. */
  highlight?: LineRange[]
}

/** What this entry's read mark is made of: its highlighted lines when it has
 * any, so a hunk two steps share is read a step at a time; else its hunks when
 * it holds part of the file, else the file's own marks (which cover a hunkless
 * file too). */
export function entryMarks(entry: ResolvedLayerFile): string[] {
  const highlight = entry.highlight
  if (highlight && entry.hunks.length > 0) {
    return entry.hunks.flatMap((h) => highlightMarks(h, highlight))
  }
  return entry.partial ? entry.hunks.map((h) => h.id) : fileMarks(entry.file)
}

export function entryMarksLines(entry: ResolvedLayerFile): boolean {
  return entry.partial || (entry.highlight !== undefined && entry.hunks.length > 0)
}

function highlightMarks(hunk: Hunk, highlight: readonly LineRange[]): string[] {
  const lit = changedLineMarks(hunk, highlightedRows(hunk.lines, highlight))
  return lit.length > 0 ? lit : [hunk.id]
}

export function entryViewed(entry: ResolvedLayerFile, viewed: ReadonlySet<string>): boolean {
  return entryMarks(entry).every((m) => viewed.has(m))
}

/**
 * One place a decision names, against the live changeset: the file, when the
 * changeset has it, and the hunk that shows its line on the head side, when
 * one does. Nothing here is stored — like the layer's files, it is re-asked
 * on every render, so a place whose code moved simply loses its hunk rather
 * than pointing at the wrong one.
 */
export interface ResolvedPlace {
  at: DecisionAt
  file?: FileChange
  hunkId?: string
}

export interface ResolvedDecision {
  decision: Decision
  /** The decision's places, in the order the agent named them; empty when it
   * points at nothing. The first is where `.` lands. */
  places: ResolvedPlace[]
}

export interface ResolvedLayer {
  /** Null on the derived trailing layer, which has no stored identity. */
  id: string | null
  /** 1-based position in the outline; the derived layer carries none. */
  number: number | null
  title: string
  summary?: string
  kind?: 'mechanical'
  /** The listed files the changeset still has, in the order they were listed. */
  files: ResolvedLayerFile[]
  /** Listed paths that resolve to nothing today — an unknown path, a file that
   * no longer differs, a rename's old name. Shown so the reviewer can see the
   * outline drifted, never treated as an error. */
  missing: string[]
  /** The trailing layer the UI derives for files no layer lists. */
  derived: boolean
  /** Listed files the reviewer's filter took out of `files` — still in the
   * changeset, not shown (see `hideLayerFiles`). Absent when nothing was. */
  hidden?: number
  /** The agent's decisions for this step, resolved. Absent when it posted none. */
  decisions?: ResolvedDecision[]
}

/** The hunk showing a head-side line, if the diff has one. */
function hunkAtLine(file: FileChange, line: number): Hunk | undefined {
  return file.hunks.find((h) => h.lines.some((l) => l.kind !== 'del' && l.newNo === line))
}

function resolvePlace(at: DecisionAt, byPath: ReadonlyMap<string, FileChange>): ResolvedPlace {
  const file = byPath.get(at.path)
  if (!file) return { at }
  const hunk = at.line === undefined ? undefined : hunkAtLine(file, at.line)
  return hunk ? { at, file, hunkId: hunk.id } : { at, file }
}

export function resolveDecisions(
  decisions: readonly Decision[] | undefined,
  byPath: ReadonlyMap<string, FileChange>,
): ResolvedDecision[] | undefined {
  if (!decisions || decisions.length === 0) return undefined
  return decisions.map((decision) => ({
    decision,
    places: (decision.at ?? []).map((at) => resolvePlace(at, byPath)),
  }))
}

/** The outline names a part of some file, by range or by highlight — the
 * split switch has something to switch. */
export function outlineSplitsFiles(layers: Layers | undefined): boolean {
  return (layers?.items ?? []).some((l) =>
    l.files.some((f) => layerFileRange(f) !== null || layerFileHighlight(f).length > 0),
  )
}

/**
 * Layers against the live changeset. Empty when there are no layers — the UI is
 * exactly today's then. Otherwise every layer in order, plus, when something
 * escaped the outline, one derived layer at the end holding the rest in the
 * order `files` came in (the rail's tree order, so the two never disagree):
 * the files no layer lists, and the hunks with changed lines no entry claims,
 * those lines highlighted.
 *
 * A path listed twice in one layer counts once; a path listed in two layers
 * appears in both, and the reviewer marks it once because marks live on hunks.
 * An entry resolves to the hunks `claimedHunks` gives it today, so a range or
 * highlight the code moved from under simply holds fewer hunks, and the rest
 * surface in the derived layer. A renamed file lands there under its new name — the agent
 * absorbs it by re-posting; the resolver does not guess.
 */
export function resolveLayers(
  layers: Layers | undefined,
  files: readonly FileChange[],
  options: ClaimOptions = {},
): ResolvedLayer[] {
  if (!layers || layers.items.length === 0) return []
  const byPath = new Map(files.map((f) => [f.path, f]))
  const resolved: ResolvedLayer[] = layers.items.map((layer, i) => {
    const present: ResolvedLayerFile[] = []
    const missing: string[] = []
    for (const claim of claimsOf(layer)) {
      const file = byPath.get(claim.path)
      if (!file) {
        missing.push(claim.path)
        continue
      }
      const hunks = claimedHunks(file.hunks, claim, options)
      if (!options.wholeFiles && !claim.whole && hunks.length === 0) {
        // The file is here, the lines are not: say which part drifted away.
        missing.push(...claim.refs)
        continue
      }
      const lit = hunks.some((h) => litChangedRows(h, claim.highlight).size > 0)
      present.push({
        file,
        ...(claim.note ? { note: claim.note } : {}),
        ...(lit ? { highlight: claim.highlight } : {}),
        hunks,
        partial: hunks.length < file.hunks.length,
      })
    }
    const decisions = resolveDecisions(layer.decisions, byPath)
    return {
      id: layer.id,
      number: i + 1,
      title: layer.title,
      ...(layer.summary ? { summary: layer.summary } : {}),
      ...(layer.kind ? { kind: layer.kind } : {}),
      files: present,
      missing,
      derived: false,
      ...(decisions ? { decisions } : {}),
    }
  })
  const rest = uncoveredByLayers(layers.items, files, options)
  if (rest.length > 0) {
    resolved.push({
      id: null,
      number: null,
      title: SINCE_TITLE,
      files: rest.map(({ path, hunks, lines, unlisted }) => {
        const file = byPath.get(path)!
        return unlisted
          ? { file, hunks: file.hunks, partial: false }
          : { file, hunks, partial: hunks.length < file.hunks.length, highlight: lines }
      }),
      missing: [],
      derived: true,
    })
  }
  return resolved
}

/**
 * The outline with a filter applied: each layer keeps the files `hide` lets
 * through, and counts the rest as `hidden`. `Hide tests` is the one filter that
 * follows the reviewer into layer mode — it retires a category of file, which
 * the outline's narrowing has nothing to say about — and the count is what
 * lets the rail and the layer card say so instead of quietly showing less.
 * A layer nothing was taken from is returned as is.
 */
export function hideLayerFiles(
  resolved: readonly ResolvedLayer[],
  hide: (file: FileChange) => boolean,
): ResolvedLayer[] {
  return resolved.map((layer) => {
    const files = layer.files.filter((f) => !hide(f.file))
    const hidden = layer.files.length - files.length
    return hidden === 0 ? layer : { ...layer, files, hidden }
  })
}

/** What the UI remembers the active layer by: the stored id, which a re-post
 * keeps for a matching title, or a fixed key for the derived layer. */
export function layerKey(layer: ResolvedLayer): string {
  return layer.id ?? 'since'
}

/** Row 0 of the outline: the guide comment, when the review has one — the same
 * rule the CLI applies (`findGuideThread`), the newest agent thread on the whole
 * changeset. */
export function findGuide(threads: readonly ReviewThread[]): ReviewThread | undefined {
  return threads.filter((t) => t.anchor.kind === 'changeset' && startedByAgent(t)).at(-1)
}

/** The pull request's description, imported as a thread: the author's own map
 * of the change, and the Overview of a PR whether or not the agent adds a guide. */
export function findDescription(threads: readonly ReviewThread[]): ReviewThread | undefined {
  return threads.find((t) => t.github?.kind === 'description')
}

/** The layer each file belongs to — the first one that lists it — for opening
 * a file inside its layer. */
export function layerByPath(resolved: readonly ResolvedLayer[]): Map<string, ResolvedLayer> {
  const map = new Map<string, ResolvedLayer>()
  for (const layer of resolved) {
    for (const { file } of layer.files) {
      if (!map.has(file.path)) map.set(file.path, layer)
    }
  }
  return map
}

/** Every layer a file has a part in, in outline order: one for most files,
 * several for a file whose hunks the agent split across steps. */
export function layersByPath(resolved: readonly ResolvedLayer[]): Map<string, ResolvedLayer[]> {
  const map = new Map<string, ResolvedLayer[]>()
  for (const layer of resolved) {
    for (const { file } of layer.files) {
      const list = map.get(file.path)
      if (list) list.push(layer)
      else map.set(file.path, [layer])
    }
  }
  return map
}

/** The layer each hunk reads in — the first that holds it — so a jump to a
 * hunk, and the fold that hides it elsewhere, both know where it lives. */
export function layerByHunk(resolved: readonly ResolvedLayer[]): Map<string, ResolvedLayer> {
  const map = new Map<string, ResolvedLayer>()
  for (const layer of resolved) {
    for (const { hunks } of layer.files) {
      for (const hunk of hunks) if (!map.has(hunk.id)) map.set(hunk.id, layer)
    }
  }
  return map
}

export interface LayerProgress {
  files: number
  doneFiles: number
  /** The entries' marks (`entryMarks`): highlighted lines, hunks, or one per
   * hunkless file. Only the ratio is meaningful. */
  marks: number
  doneMarks: number
}

export function layerProgress(layer: ResolvedLayer, viewed: ReadonlySet<string>): LayerProgress {
  let marks = 0
  let doneMarks = 0
  let doneFiles = 0
  for (const entry of layer.files) {
    const own = entryMarks(entry)
    const done = own.filter((m) => viewed.has(m)).length
    marks += own.length
    doneMarks += done
    if (done === own.length) doneFiles++
  }
  return { files: layer.files.length, doneFiles, marks, doneMarks }
}

/** Lines added and removed across a layer's shown hunks — the layer's size,
 * so the outline says how big a step is before the reviewer takes it. Hidden
 * files are left out, the same way `layerProgress` leaves them out, and so is
 * the part of a split file that reads in another step. */
export function layerLineStats(layer: ResolvedLayer): { additions: number; deletions: number } {
  let additions = 0
  let deletions = 0
  for (const { hunks } of layer.files) {
    for (const hunk of hunks) {
      for (const line of hunk.lines) {
        if (line.kind === 'add') additions++
        else if (line.kind === 'del') deletions++
      }
    }
  }
  return { additions, deletions }
}

/** Read through, or nothing left to read: a layer whose paths all resolved to
 * nothing is done too. */
export function layerDone(layer: ResolvedLayer, viewed: ReadonlySet<string>): boolean {
  const p = layerProgress(layer, viewed)
  return p.doneFiles === p.files
}

/**
 * The next layer worth landing on, walking from `from` in `dir`, skipping the
 * ones `skip` rules out (the filters left nothing to show there). Null when the
 * walk runs off the end — the caller stays put.
 */
export function stepLayer(
  resolved: readonly ResolvedLayer[],
  from: number,
  dir: 1 | -1,
  skip: (layer: ResolvedLayer) => boolean = () => false,
): number | null {
  for (let i = from + dir; i >= 0 && i < resolved.length; i += dir) {
    if (!skip(resolved[i]!)) return i
  }
  return null
}

/**
 * Where to open: the first layer with something unread, else the first layer.
 * Keyed by id so a re-post that keeps a title keeps the reviewer's place.
 */
export function startingLayer(
  resolved: readonly ResolvedLayer[],
  viewed: ReadonlySet<string>,
): number {
  const unread = resolved.findIndex((l) => l.files.length > 0 && !layerDone(l, viewed))
  return unread === -1 ? 0 : unread
}

// ---------- references in a summary ----------
//
// "Read `weekday.ts` first" should be a click. A summary is markdown, so the
// cheapest honest hook is the code span: a span naming a file in the changeset
// (`src/weekday.ts`, or `weekday.ts` when only one file has that basename),
// with an optional `:line` or `:from-to`, becomes a link the card intercepts.
// Prose outside backticks is left alone — a bare word that happens to be a
// path is the author's to mark, not ours to guess — and fenced blocks are
// skipped whole, so a mermaid diagram is never rewritten under itself.

/** The href prefix the card recognises. Kept under `#` so the sanitiser's URI
 * rule lets it through and no browser ever navigates on it. */
export const LAYER_LINK = '#diffo-file:'

export function layerLinkHref(path: string, line: number | null): string {
  return `${LAYER_LINK}${encodeURIComponent(path)}${line === null ? '' : `:${line}`}`
}

export function parseLayerLink(href: string): { path: string; line: number | null } | null {
  if (!href.startsWith(LAYER_LINK)) return null
  const rest = href.slice(LAYER_LINK.length)
  const at = /^(.*):(\d+)$/.exec(rest)
  try {
    return at
      ? { path: decodeURIComponent(at[1]!), line: Number.parseInt(at[2]!, 10) }
      : { path: decodeURIComponent(rest), line: null }
  } catch {
    return null
  }
}

const SPAN = /`([^`\n]+)`/g
export const REF = /^([^\s:`]+?)(?::(\d+)(?:-\d+)?)?$/

/** What a rendered body needs to turn a file reference into a jump: the paths
 * a reference may resolve to, and where the click goes. The guide thread gets
 * one; so does a layer card. */
export interface RefLinks {
  paths: readonly string[]
  onJump: (path: string, line: number | null) => void
}

/** The reference a click landed on, if any: a link `linkPaths` wrote, or a
 * diagram node `linkDiagramRefs` tagged. Both carry the same `#diffo-file:`
 * href, so one resolver serves the prose and the picture. */
export function refClickTarget(target: Element): { path: string; line: number | null } | null {
  const el = target.closest('a[href], [data-diffo-jump]')
  if (!el) return null
  return parseLayerLink(el.getAttribute('data-diffo-jump') ?? el.getAttribute('href') ?? '')
}

/** The changeset path a reference names: exact, or a basename only one file has. */
export function resolveRef(name: string, paths: readonly string[]): string | null {
  if (paths.includes(name)) return name
  const hits = paths.filter((p) => p.slice(p.lastIndexOf('/') + 1) === name)
  return hits.length === 1 ? hits[0]! : null
}

export function linkPaths(summary: string, paths: readonly string[]): string {
  if (paths.length === 0) return summary
  // Fences are opaque, and so is a link the author already wrote — a span
  // inside `[…](…)` would otherwise become a link inside a link, which no
  // renderer survives. Split on both and only touch the prose between.
  return summary
    .split(/(```[\s\S]*?```|\[[^\]\n]*\]\([^)\n]*\))/)
    .map((part, i) =>
      i % 2 === 1
        ? part
        : part.replace(SPAN, (span, inner: string) => {
            const ref = REF.exec(inner)
            if (!ref) return span
            const path = resolveRef(ref[1]!, paths)
            if (path === null) return span
            const line = ref[2] === undefined ? null : Number.parseInt(ref[2], 10)
            return `[${span}](${layerLinkHref(path, line)})`
          }),
    )
    .join('')
}
