import type { BeforeAfterSection } from './review.js'

// Validation for a before/after post, shared by the CLI and the server the
// same way layers are: one message for one mistake, whichever side finds it.

/** What the agent sends: the sections, without the server's timestamp. */
export type BeforeAfterInput = BeforeAfterSection[]

export type BeforeAfterParse = { ok: true; value: BeforeAfterInput } | { ok: false; error: string }

/** Each side is a few lines by doctrine; this is the backstop, the same cap a
 * layer summary gets. */
const SIDE_CAP = 4000
const TITLE_CAP = 120
/** One section per behaviour the change alters; more than this is a changeset
 * that wants layers, not a before/after. */
export const MAX_SECTIONS = 5

const SHAPE = '[{ "title": "…", "before": "…", "after": "…" }]'

/** Takes the list of sections, or a lone `{ before, after }` as a list of one. */
export function parseBeforeAfterInput(raw: unknown): BeforeAfterParse {
  const items = Array.isArray(raw) ? raw : [raw]
  if (items.length === 0) return { ok: false, error: 'needs at least one section' }
  if (items.length > MAX_SECTIONS) {
    return { ok: false, error: `at most ${MAX_SECTIONS} sections, got ${items.length}` }
  }
  const sections: BeforeAfterSection[] = []
  for (const [i, item] of items.entries()) {
    const where = items.length > 1 ? `section ${i + 1}: ` : ''
    const parsed = parseSection(item, items.length > 1)
    if (!parsed.ok) return { ok: false, error: `${where}${parsed.error}` }
    sections.push(parsed.value)
  }
  return { ok: true, value: sections }
}

function parseSection(
  raw: unknown,
  needsTitle: boolean,
): { ok: true; value: BeforeAfterSection } | { ok: false; error: string } {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, error: `a before/after must be JSON: ${SHAPE}` }
  }
  const b = raw as Record<string, unknown>
  if (b.title !== undefined && typeof b.title !== 'string') {
    return { ok: false, error: '"title" must be a string' }
  }
  const title = typeof b.title === 'string' ? b.title.trim().slice(0, TITLE_CAP) : ''
  if (needsTitle && title === '') {
    return {
      ok: false,
      error: 'needs a "title" naming the behaviour (every section does when there are several)',
    }
  }
  const sides: Partial<Record<'before' | 'after', string>> = {}
  for (const side of ['before', 'after'] as const) {
    const value = b[side]
    if (value !== undefined && typeof value !== 'string') {
      return { ok: false, error: `"${side}" must be a markdown string` }
    }
    const text = typeof value === 'string' ? value.trim().slice(0, SIDE_CAP) : ''
    if (text === '') return { ok: false, error: `needs a non-empty "${side}"` }
    sides[side] = text
  }
  return {
    ok: true,
    value: { ...(title ? { title } : {}), before: sides.before!, after: sides.after! },
  }
}
