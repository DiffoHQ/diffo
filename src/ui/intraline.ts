import type { DiffLine } from '../shared/types.js'

/** Beyond this a line is minified, generated, or a data blob — marking is noise. */
const MAX_LINE = 400

/** Below this the two lines aren't versions of each other, they're different lines
 * that happen to share a `const` and a brace. A wrong word-diff reads *worse* than
 * none. */
const MIN_SIMILARITY = 0.3

/** Cap on the del×add cross product before we stop trying to pair at all. */
const MAX_PAIRINGS = 400

/** Marks separated by a matched gap this small merge into one — without it, a
 * half-changed sentence renders as word confetti. */
const MERGE_GAP = 3

/** Past this fraction of a line marked, the line wasn't edited but rewritten, so the
 * pair keeps its pairing and shows no word marks at all. */
const MAX_COVERAGE = 0.65

export interface Range {
  start: number
  end: number
}

/** Identifiers, whitespace runs, and every other character on its own. Keeping
 * separators as tokens is what makes the marks land on word boundaries: splitting on
 * whitespace alone would mark the whole of `foo(bar)` when only `bar` moved. */
export function tokenize(text: string): string[] {
  return text.match(/[A-Za-z0-9_$]+|\s+|[^A-Za-z0-9_$\s]/g) ?? []
}

function lcsPairs(a: string[], b: string[]): Array<[number, number]> {
  const m = a.length
  const n = b.length
  const dp: Uint32Array[] = Array.from({ length: m + 1 }, () => new Uint32Array(n + 1))
  for (let i = m - 1; i >= 0; i--) {
    const row = dp[i]!
    const next = dp[i + 1]!
    for (let j = n - 1; j >= 0; j--) {
      row[j] = a[i] === b[j] ? next[j + 1]! + 1 : Math.max(next[j]!, row[j + 1]!)
    }
  }
  const pairs: Array<[number, number]> = []
  let i = 0
  let j = 0
  while (i < m && j < n) {
    if (a[i] === b[j]) {
      pairs.push([i, j])
      i++
      j++
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) i++
    else j++
  }
  return pairs
}

function toRanges(tokens: string[], matched: boolean[]): Range[] {
  const ranges: Range[] = []
  let offset = 0
  for (let i = 0; i < tokens.length; i++) {
    const length = tokens[i]!.length
    if (!matched[i]) {
      const last = ranges[ranges.length - 1]
      if (last && last.end === offset) last.end = offset + length
      else ranges.push({ start: offset, end: offset + length })
    }
    offset += length
  }
  return ranges.filter((r) => tokens.length > 0 && r.end > r.start)
}

function mergeClose(ranges: Range[]): Range[] {
  const out: Range[] = []
  for (const range of ranges) {
    const last = out[out.length - 1]
    if (last && range.start - last.end <= MERGE_GAP) last.end = range.end
    else out.push({ ...range })
  }
  return out
}

const coverage = (ranges: Range[], length: number) =>
  length === 0 ? 0 : ranges.reduce((sum, r) => sum + (r.end - r.start), 0) / length

interface Comparison {
  similarity: number
  del: Range[]
  add: Range[]
}

export function comparePair(delText: string, addText: string): Comparison | null {
  if (delText.length > MAX_LINE || addText.length > MAX_LINE) return null
  const a = tokenize(delText)
  const b = tokenize(addText)
  if (a.length === 0 || b.length === 0) return null

  const pairs = lcsPairs(a, b)
  const aMatched = new Array<boolean>(a.length).fill(false)
  const bMatched = new Array<boolean>(b.length).fill(false)
  let matchedChars = 0
  for (const [i, j] of pairs) {
    aMatched[i] = true
    bMatched[j] = true
    matchedChars += a[i]!.length
  }

  const similarity = (2 * matchedChars) / (delText.length + addText.length)
  if (similarity < MIN_SIMILARITY) return null

  const del = mergeClose(toRanges(a, aMatched))
  const add = mergeClose(toRanges(b, bMatched))
  if (
    coverage(del, delText.length) > MAX_COVERAGE ||
    coverage(add, addText.length) > MAX_COVERAGE
  ) {
    return { similarity, del: [], add: [] }
  }
  return { similarity, del, add }
}

/**
 * Pair a del-run with the add-run that follows it. Equal-length runs pair
 * positionally — that is what a line-by-line edit looks like, and it beats
 * similarity scoring, which would happily cross two lines over each other. Unequal
 * runs pair by best similarity, greedily, and leftovers stay unpaired.
 */
function pairRuns(
  lines: DiffLine[],
  dels: number[],
  adds: number[],
): Array<[number, number, Comparison]> {
  const out: Array<[number, number, Comparison]> = []
  if (dels.length === adds.length) {
    for (let k = 0; k < dels.length; k++) {
      const cmp = comparePair(lines[dels[k]!]!.text, lines[adds[k]!]!.text)
      if (cmp) out.push([dels[k]!, adds[k]!, cmp])
    }
    return out
  }
  if (dels.length * adds.length > MAX_PAIRINGS) return out

  const scored: Array<{ d: number; a: number; cmp: Comparison }> = []
  for (const d of dels) {
    for (const a of adds) {
      const cmp = comparePair(lines[d]!.text, lines[a]!.text)
      if (cmp) scored.push({ d, a, cmp })
    }
  }
  scored.sort((x, y) => y.cmp.similarity - x.cmp.similarity)
  const usedD = new Set<number>()
  const usedA = new Set<number>()
  for (const { d, a, cmp } of scored) {
    if (usedD.has(d) || usedA.has(a)) continue
    usedD.add(d)
    usedA.add(a)
    out.push([d, a, cmp])
  }
  return out
}

export function intralineRanges(lines: DiffLine[]): (Range[] | null)[] {
  const out: (Range[] | null)[] = lines.map(() => null)
  let i = 0
  while (i < lines.length) {
    if (lines[i]!.kind !== 'del') {
      i++
      continue
    }
    const dels: number[] = []
    while (i < lines.length && lines[i]!.kind === 'del') dels.push(i++)
    const adds: number[] = []
    while (i < lines.length && lines[i]!.kind === 'add') adds.push(i++)
    if (adds.length === 0) continue
    for (const [d, a, cmp] of pairRuns(lines, dels, adds)) {
      if (cmp.del.length > 0) out[d] = cmp.del
      if (cmp.add.length > 0) out[a] = cmp.add
    }
  }
  return out
}

export function splitByRanges(
  text: string,
  offset: number,
  ranges: Range[] | null,
): Array<{ text: string; changed: boolean }> {
  if (!ranges || ranges.length === 0) return [{ text, changed: false }]
  const out: Array<{ text: string; changed: boolean }> = []
  let cursor = 0
  const push = (from: number, to: number, changed: boolean) => {
    if (to <= from) return
    const slice = text.slice(from, to)
    const last = out[out.length - 1]
    if (last && last.changed === changed) last.text += slice
    else out.push({ text: slice, changed })
  }
  for (const range of ranges) {
    const start = Math.max(0, range.start - offset)
    const end = Math.min(text.length, range.end - offset)
    if (end <= 0 || start >= text.length || end <= start) continue
    push(cursor, start, false)
    push(start, end, true)
    cursor = Math.max(cursor, end)
  }
  push(cursor, text.length, false)
  return out
}
