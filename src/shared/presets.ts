import { normalizeConversationMessage, normalizeConversations } from './conversation.js'

/**
 * Layers presets: what the layers are for, chosen before the agent outlines.
 *
 * One change can be layered more than one way, and what the reviewer means to
 * do with it decides. Read whole, it wants one layer per concept, in the
 * order the change was built ("Concept"). Signed off rather than read, or too
 * big to read whole, it wants only the lines that matter most, inside a
 * budget, with the rest set aside ("Importance"). Two built-ins, each with a
 * rule that can be checked, and each named for what the change is layered
 * by, so the name finishes the rail's "Layered by …"; anything narrower — a
 * domain, a concern — is a preset the reviewer makes. Each
 * preset is a name, a one-liner for the menu, a line on when it fits (what
 * "Agent picks" reads), and the instructions the agent is given on top of the
 * layers doctrine. Built-ins ship here; the reviewer's own live in the shared
 * settings store, beside the voice — typed by hand, or written and revised by
 * the agent in a conversation about the preset (`PresetThread`, stored beside
 * the presets). Nothing here is per repo: a preset says how one human reads,
 * not what one codebase is.
 */

export interface LayersPreset {
  /** A built-in's fixed id, or a uuid minted when the reviewer saved it. */
  id: string
  name: string
  /** Shown under the name wherever the preset is listed. */
  blurb: string
  /** When this preset fits — what "Agent picks" reads to choose. */
  whenToUse: string
  /** What the agent is told, on top of the layers doctrine: what goes in the
   * review layers, in what order, and what goes to background. */
  instructions: string
  builtIn: boolean
}

/** A preset without the bookkeeping: what the agent writes when asked for one,
 * and what the dialog edits. */
export type LayersPresetDraft = Pick<LayersPreset, 'name' | 'blurb' | 'whenToUse' | 'instructions'>

/** The reviewer's preset settings as stored: their own presets, which ids are
 * switched off (built-in or theirs), and the default for a new review. */
export interface LayersPresetSettings {
  presets: LayersPreset[]
  disabled: string[]
  /** `AGENT_PICKS`, or a preset id. */
  default: string
}

/** The default's "let the agent choose" value — not a preset. */
export const AGENT_PICKS = 'agent'

export const PRESET_NAME_MAX = 40
export const PRESET_BLURB_MAX = 80
export const PRESET_WHEN_MAX = 400
export const PRESET_INSTRUCTIONS_MAX = 3000
export const PRESETS_MAX = 20
/** One message in a preset's conversation. */
export const PRESET_MESSAGE_MAX = 2000
/** Messages a preset's conversation keeps; the oldest go first. */
export const PRESET_THREAD_MAX = 200

export const BUILT_IN_PRESETS: readonly LayersPreset[] = [
  {
    id: 'concept',
    name: 'Concept',
    blurb: 'one idea per layer, in the order the change was built',
    whenToUse:
      'The reviewer will read the whole change. A feature, a fix or a refactor of ordinary size, up to a few hundred changed lines, or a bigger one made of parts that each stand alone. The one to use when nothing says otherwise.',
    instructions:
      'Give each concept in the change its own layer. A concept is one idea the reviewer can hold and approve on its own — one behaviour, one refactor, one fix — with everything that belongs to it together: the code, its call sites, its tests. It is the change you would have opened as one small pull request, and its title is the title that pull request would have had. Order the layers the way the change was built, so each needs only the ones before it: what others depend on first (a type, a schema, a helper), then what uses it, the entry point’s wiring last. Two files that change for the same reason are one layer; one file that changes for two reasons is split by range. A layer that changes behaviour which already existed says so in its summary, and anything the request did not ask for is a layer of its own, titled as what it is. Use a mechanical layer for renames and call sites that only follow a signature. Use a background layer only for generated files, lockfiles and snapshots: under this preset the reviewer reads everything else.',
    builtIn: true,
  },
  {
    id: 'importance',
    name: 'Importance',
    blurb: 'the lines that matter most; the rest in background',
    whenToUse:
      'The reviewer will sign the change off rather than read it. A change too big to read whole — dozens of files, most of them implementation — or one they directed and trust, with minutes for it, not an hour. Also a second look at a change that was already reviewed once.',
    instructions:
      'Layer only the lines that matter most, the most important first, and keep to a budget: at most five layers, and about 150 changed lines across all of them. A line matters when the change could be wrong there in a way that is costly and nothing else would catch it. In order of importance: the data — new or changed types, schemas and stored shapes, and any line a migration cannot take back; the contracts — interfaces, public functions, routes, flags, permissions, limits and defaults that other code or people rely on; and the decisions — the few places where the change’s real logic lives: the condition that decides, the value written to disk or sent over the wire, the place an error is now swallowed or raised. Never list a file whole in a review layer, a new file included: give every file as highlights, each a range of a few lines — the type, the signature, the branch that decides — and never a whole function when its one deciding line will do. Each layer is one concern, titled as the question the reviewer answers ("Is the retry bounded?"), and its summary says in a sentence or two why these lines matter and what sits around them that was left out. When the budget cannot hold everything that qualifies, keep what is hardest to undo and name what was cut in the last layer’s summary. Everything else goes to background layers, listed whole and titled by what they are: the implementation behind the contracts, call sites, UI plumbing, tests, docs, build wiring. The test for a piece: if removing it would not change what the reviewer has to agree to, it is background.',
    builtIn: true,
  },
]

export const DEFAULT_PRESET_SETTINGS: LayersPresetSettings = {
  presets: [],
  disabled: [],
  default: AGENT_PICKS,
}

const oneLine = (text: string, cap: number) => text.replace(/\s+/g, ' ').trim().slice(0, cap).trim()

/** A draft, checked: the name is required, the rest is trimmed and capped.
 * Returns what to store, or what is wrong with it. */
export function parsePresetDraft(
  raw: unknown,
  where = 'preset',
): { ok: true; draft: LayersPresetDraft } | { ok: false; error: string } {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, error: `${where}: expected { name, blurb?, whenToUse?, instructions? }` }
  }
  const p = raw as Record<string, unknown>
  for (const key of ['name', 'blurb', 'whenToUse', 'instructions'] as const) {
    if (p[key] !== undefined && typeof p[key] !== 'string') {
      return { ok: false, error: `${where}: "${key}" must be a string` }
    }
  }
  const name = oneLine(typeof p.name === 'string' ? p.name : '', PRESET_NAME_MAX)
  if (name === '') return { ok: false, error: `${where}: a preset needs a "name"` }
  return {
    ok: true,
    draft: {
      name,
      blurb: oneLine(typeof p.blurb === 'string' ? p.blurb : '', PRESET_BLURB_MAX),
      whenToUse: (typeof p.whenToUse === 'string' ? p.whenToUse : '')
        .trim()
        .slice(0, PRESET_WHEN_MAX),
      instructions: (typeof p.instructions === 'string' ? p.instructions : '')
        .trim()
        .slice(0, PRESET_INSTRUCTIONS_MAX),
    },
  }
}

const PRESET_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/

/**
 * The settings as a PUT sends them, or as the store holds them: strict, so a
 * malformed save is refused with the field at fault rather than half-kept.
 * A custom preset's id is whatever the client minted (a uuid), never a
 * built-in's; `disabled` may name either. A default that names nothing
 * active falls back to "Agent picks" at read time (`presetDefault`), not here.
 */
export function parsePresetSettings(
  raw: unknown,
): { ok: true; settings: LayersPresetSettings } | { ok: false; error: string } {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, error: 'expected { presets, disabled, default }' }
  }
  const s = raw as Record<string, unknown>
  if (!Array.isArray(s.presets)) return { ok: false, error: '"presets" must be a list' }
  if (s.presets.length > PRESETS_MAX) {
    return { ok: false, error: `keep "presets" to ${PRESETS_MAX}` }
  }
  const builtIn = new Set(BUILT_IN_PRESETS.map((p) => p.id))
  const presets: LayersPreset[] = []
  const seen = new Set<string>()
  for (const [i, item] of s.presets.entries()) {
    const where = `preset ${i + 1}`
    const parsed = parsePresetDraft(item, where)
    if (!parsed.ok) return parsed
    const id = (item as { id?: unknown }).id
    if (typeof id !== 'string' || !PRESET_ID.test(id)) {
      return { ok: false, error: `${where}: needs an "id" (letters, digits, - and _)` }
    }
    if (builtIn.has(id)) return { ok: false, error: `${where}: "${id}" is a built-in's id` }
    if (seen.has(id)) return { ok: false, error: `${where}: id "${id}" is listed twice` }
    seen.add(id)
    presets.push({ id, ...parsed.draft, builtIn: false })
  }
  const disabledRaw = s.disabled === undefined ? [] : s.disabled
  if (!Array.isArray(disabledRaw) || disabledRaw.some((d) => typeof d !== 'string')) {
    return { ok: false, error: '"disabled" must be a list of preset ids' }
  }
  const known = new Set([...builtIn, ...seen])
  const disabled = [...new Set(disabledRaw as string[])].filter((id) => known.has(id))
  const def = s.default === undefined ? AGENT_PICKS : s.default
  if (typeof def !== 'string' || (def !== AGENT_PICKS && !known.has(def))) {
    return { ok: false, error: `"default" must be "${AGENT_PICKS}" or a listed preset id` }
  }
  return { ok: true, settings: { presets, disabled, default: def } }
}

/** The stored blob, or the defaults when there is none or it does not parse:
 * a setting is never a reason the review fails to open. */
export function normalizePresetSettings(value: unknown): LayersPresetSettings {
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value)
    } catch {
      return DEFAULT_PRESET_SETTINGS
    }
  }
  const parsed = parsePresetSettings(value)
  return parsed.ok ? parsed.settings : DEFAULT_PRESET_SETTINGS
}

/** Every preset there is, built-ins first, switched off ones included. */
export function allPresets(settings: LayersPresetSettings): LayersPreset[] {
  return [...BUILT_IN_PRESETS, ...settings.presets]
}

/** The presets in play: what the menu lists and the agent may pick from.
 * Not the ones switched off, and not the empty ones. */
export function activePresets(settings: LayersPresetSettings): LayersPreset[] {
  const off = new Set(settings.disabled)
  return allPresets(settings).filter((p) => !off.has(p.id) && !isEmptyPreset(p))
}

export function findPreset(
  settings: LayersPresetSettings,
  id: string | undefined,
): LayersPreset | undefined {
  return id === undefined ? undefined : allPresets(settings).find((p) => p.id === id)
}

/** The default a new review opens with: "Agent picks", or an active preset.
 * A default that was switched off or deleted is "Agent picks" again. */
export function presetDefault(settings: LayersPresetSettings): string {
  if (settings.default === AGENT_PICKS) return AGENT_PICKS
  return activePresets(settings).some((p) => p.id === settings.default)
    ? settings.default
    : AGENT_PICKS
}

/** What the agent is told to use when "Agent picks" has nothing to pick from:
 * layers have to come out as something, and Concept is the plain one. */
export function fallbackPreset(): LayersPreset {
  return BUILT_IN_PRESETS[0]!
}

/**
 * A preset's conversation with the agent (see `LayersPresets`): the reviewer
 * says what to change, the agent answers and edits the preset through the CLI,
 * and each edit is a message carrying what it changed and the values before,
 * so the reviewer can undo it. Kept beside the presets, per human, keyed by
 * preset id; a built-in's conversation is where the agent is asked to copy
 * it under the reviewer's own.
 */
export type PresetField = keyof LayersPresetDraft

export const PRESET_FIELDS: readonly PresetField[] = ['name', 'blurb', 'whenToUse', 'instructions']

export interface PresetChange {
  /** The fields the agent set. */
  fields: PresetField[]
  /** Their values before, for undo. Empty when the preset was created. */
  before: Partial<LayersPresetDraft>
  /** The agent made the preset with this message. */
  created?: boolean
}

export interface PresetMessage {
  id: string
  author: 'reviewer' | 'agent'
  text: string
  at: string
  change?: PresetChange
}

export interface PresetThread {
  presetId: string
  messages: PresetMessage[]
}

export type PresetThreads = Record<string, PresetThread>

/** What a preset is called from the reviewer's first word about it until
 * someone names it. */
export const NEW_PRESET_NAME = 'New preset'

/**
 * A preset with nothing to tell the agent: one the reviewer just started
 * (see `PresetStore.start`), or one whose instructions were cleared. It is a
 * preset like any other in the dialog, and it is not offered anywhere: not
 * in "Layer by", not to an agent choosing.
 */
export const isEmptyPreset = (preset: LayersPreset): boolean =>
  !preset.builtIn && preset.instructions.trim() === ''

/** The stored conversations, read leniently: a bad one is dropped alone. */
export function normalizePresetThreads(value: unknown): PresetThreads {
  return normalizeConversations(
    value,
    (id) => PRESET_ID.test(id),
    (raw) => normalizeConversationMessage(raw, PRESET_FIELDS),
    (presetId, messages) => ({ presetId, messages }),
  )
}

/**
 * The fields an agent's `diffo preset update` sends: any subset of the four,
 * each checked and capped the way a whole preset is. A name, when sent, may
 * not be empty.
 */
export function parsePresetPatch(
  raw: unknown,
): { ok: true; patch: Partial<LayersPresetDraft> } | { ok: false; error: string } {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, error: 'expected { name?, blurb?, whenToUse?, instructions? }' }
  }
  const p = raw as Record<string, unknown>
  const patch: Partial<LayersPresetDraft> = {}
  for (const key of PRESET_FIELDS) {
    if (p[key] === undefined) continue
    if (typeof p[key] !== 'string') return { ok: false, error: `"${key}" must be a string` }
  }
  if (p.name !== undefined) {
    const name = oneLine(p.name as string, PRESET_NAME_MAX)
    if (name === '') return { ok: false, error: 'a preset needs a "name"' }
    patch.name = name
  }
  if (p.blurb !== undefined) patch.blurb = oneLine(p.blurb as string, PRESET_BLURB_MAX)
  if (p.whenToUse !== undefined) {
    patch.whenToUse = (p.whenToUse as string).trim().slice(0, PRESET_WHEN_MAX)
  }
  if (p.instructions !== undefined) {
    patch.instructions = (p.instructions as string).trim().slice(0, PRESET_INSTRUCTIONS_MAX)
  }
  if (Object.keys(patch).length === 0)
    return { ok: false, error: 'nothing to change: send a field' }
  return { ok: true, patch }
}

/**
 * What an outline says it followed. `picked` when the request left the choice
 * to the agent (and `why` is its one line on the choice); absent when the
 * reviewer named the preset.
 */
export interface LayersPresetUse {
  id: string
  picked?: boolean
  why?: string
}

export const PRESET_WHY_MAX = 200

/** The most a note on a layers ask holds. */
export const LAYERS_NOTE_MAX = 1000

/**
 * The reviewer's words for one change, sent with a layers ask: what they want
 * from the layers this time, on top of the preset or in place of one. Never
 * saved with the presets. Trimmed and capped; empty is none.
 */
export function parseLayersNote(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined
  const note = raw.trim().slice(0, LAYERS_NOTE_MAX).trim()
  return note === '' ? undefined : note
}

export function parsePresetUse(
  raw: unknown,
): { ok: true; use: LayersPresetUse | undefined } | { ok: false; error: string } {
  if (raw === undefined) return { ok: true, use: undefined }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, error: '"preset" must be { id, picked?, why? }' }
  }
  const p = raw as Record<string, unknown>
  if (typeof p.id !== 'string' || !PRESET_ID.test(p.id)) {
    return { ok: false, error: '"preset" needs an "id": a built-in\'s, or one of the reviewer\'s' }
  }
  if (p.picked !== undefined && typeof p.picked !== 'boolean') {
    return { ok: false, error: '"preset.picked" must be true or false' }
  }
  if (p.why !== undefined && typeof p.why !== 'string') {
    return { ok: false, error: '"preset.why" must be a string' }
  }
  const why = typeof p.why === 'string' ? oneLine(p.why, PRESET_WHY_MAX) : ''
  return {
    ok: true,
    use: {
      id: p.id,
      ...(p.picked === true ? { picked: true } : {}),
      ...(why !== '' ? { why } : {}),
    },
  }
}
