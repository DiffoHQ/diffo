/**
 * The command palette's list: what is in it, and which of it a typed word keeps.
 * Pure, so the ranking can be tested without a DOM (see CommandPalette.tsx for
 * the dialog).
 */

export type PaletteGroup = 'Actions' | 'Layers' | 'Files' | 'Threads'

export interface PaletteItem {
  id: string
  group: PaletteGroup
  label: string
  /** A quieter second part: a file's directory, a thread's place. Searched too. */
  hint?: string
  /** The key that does the same thing without the palette, when there is one. */
  kbd?: string
  run: () => void
}

/** How many rows the palette draws. A changeset can hold thousands of files;
 * the list is for picking, and nobody picks row 400 without typing first. */
export const PALETTE_LIMIT = 50

/**
 * Lower is better; null is no match. Every word of the query must appear in the
 * item (label or hint), in any order. A hit at the start of the label beats one
 * at the start of a word, which beats one mid-word, which beats one in the hint.
 */
export function scoreItem(item: PaletteItem, query: string): number | null {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (words.length === 0) return 0
  const label = item.label.toLowerCase()
  const hint = item.hint?.toLowerCase() ?? ''
  let score = 0
  for (const word of words) {
    const at = label.indexOf(word)
    if (at === 0) score += 0
    else if (at > 0) score += /[\s/._-]/.test(label[at - 1]!) ? 1 : 2
    else if (hint.includes(word)) score += 3
    else return null
  }
  return score
}

/** The rows to draw for a query: matches only, best first, in the order given
 * among equals (so an empty query is the list as composed), capped. */
export function filterPalette(
  items: readonly PaletteItem[],
  query: string,
  limit = PALETTE_LIMIT,
): PaletteItem[] {
  const scored: { item: PaletteItem; score: number; at: number }[] = []
  items.forEach((item, at) => {
    const score = scoreItem(item, query)
    if (score !== null) scored.push({ item, score, at })
  })
  scored.sort((a, b) => a.score - b.score || a.at - b.at)
  return scored.slice(0, limit).map((s) => s.item)
}
