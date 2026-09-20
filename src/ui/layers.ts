import { type Layers, layerFileNote, layerFilePath } from '../shared/review.js'
import type { FileChange } from '../shared/types.js'
import { fileMarks } from './fileMarks.js'

// Resolution happens at render, never at write. The agent posts paths; the
// changeset moves under them; every render re-asks which files each layer
// holds right now. Nothing here is stored, so nothing here can go stale.

export const SINCE_TITLE = 'Since your review'

export interface ResolvedLayerFile {
  file: FileChange
  /** The agent's one line on why this file is in this step. */
  note?: string
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
}

/**
 * Layers against the live changeset. Empty when there are no layers — the UI is
 * exactly today's then. Otherwise every layer in order, plus, when some file
 * escaped the outline, one derived layer at the end holding the rest in the
 * order `files` came in (the rail's tree order, so the two never disagree).
 *
 * A path listed twice in one layer counts once; a path listed in two layers
 * appears in both, and the reviewer marks it once because marks live on hunks.
 * A renamed file lands here under its new name — the agent absorbs it by
 * re-posting; the resolver does not guess.
 */
export function resolveLayers(
  layers: Layers | undefined,
  files: readonly FileChange[],
): ResolvedLayer[] {
  if (!layers || layers.items.length === 0) return []
  const byPath = new Map(files.map((f) => [f.path, f]))
  const listed = new Set<string>()
  const resolved: ResolvedLayer[] = layers.items.map((layer, i) => {
    const seen = new Set<string>()
    const present: ResolvedLayerFile[] = []
    const missing: string[] = []
    for (const entry of layer.files) {
      const path = layerFilePath(entry)
      if (seen.has(path)) continue
      seen.add(path)
      listed.add(path)
      const file = byPath.get(path)
      if (!file) {
        missing.push(path)
        continue
      }
      const note = layerFileNote(entry)
      present.push(note ? { file, note } : { file })
    }
    return {
      id: layer.id,
      number: i + 1,
      title: layer.title,
      ...(layer.summary ? { summary: layer.summary } : {}),
      ...(layer.kind ? { kind: layer.kind } : {}),
      files: present,
      missing,
      derived: false,
    }
  })
  const rest = files.filter((f) => !listed.has(f.path))
  if (rest.length > 0) {
    resolved.push({
      id: null,
      number: null,
      title: SINCE_TITLE,
      files: rest.map((file) => ({ file })),
      missing: [],
      derived: true,
    })
  }
  return resolved
}

/** The layer each file belongs to — the first one that lists it — for the Files
 * tab's index numbers and for opening a file inside its layer. */
export function layerByPath(resolved: readonly ResolvedLayer[]): Map<string, ResolvedLayer> {
  const map = new Map<string, ResolvedLayer>()
  for (const layer of resolved) {
    for (const { file } of layer.files) {
      if (!map.has(file.path)) map.set(file.path, layer)
    }
  }
  return map
}

export interface LayerProgress {
  files: number
  doneFiles: number
  /** Hunks, with a hunkless file counting as one mark — the same arithmetic
   * coverage uses, so the row's bar and Finish's report agree. */
  marks: number
  doneMarks: number
}

export function layerProgress(layer: ResolvedLayer, viewed: ReadonlySet<string>): LayerProgress {
  let marks = 0
  let doneMarks = 0
  let doneFiles = 0
  for (const { file } of layer.files) {
    const own = fileMarks(file)
    const done = own.filter((m) => viewed.has(m)).length
    marks += own.length
    doneMarks += done
    if (done === own.length) doneFiles++
  }
  return { files: layer.files.length, doneFiles, marks, doneMarks }
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
