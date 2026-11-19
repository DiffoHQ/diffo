import { describe, expect, it } from 'vitest'
import {
  AGENT_PICKS,
  activePresets,
  BUILT_IN_PRESETS,
  DEFAULT_PRESET_SETTINGS,
  fallbackPreset,
  findPreset,
  normalizePresetSettings,
  normalizePresetThreads,
  PRESET_BLURB_MAX,
  PRESET_INSTRUCTIONS_MAX,
  PRESET_NAME_MAX,
  parseLayersNote,
  parsePresetDraft,
  parsePresetPatch,
  parsePresetSettings,
  parsePresetUse,
  presetDefault,
} from './presets.js'

const mine = {
  id: 'a1b2',
  name: 'Data and storage',
  blurb: 'types, keys, where things are saved',
  whenToUse: 'A change that adds stored state.',
  instructions: 'Type files whole; storage keys highlighted; the rest in background.',
}

describe('parsePresetDraft', () => {
  it('needs a name, trims the rest, and caps every field', () => {
    const parsed = parsePresetDraft({
      name: `  ${'N'.repeat(PRESET_NAME_MAX + 5)}  `,
      blurb: ' one\nline ',
      whenToUse: '  when  ',
      instructions: 'x'.repeat(PRESET_INSTRUCTIONS_MAX + 1),
    })
    if (!parsed.ok) throw new Error(parsed.error)
    expect(parsed.draft.name).toHaveLength(PRESET_NAME_MAX)
    expect(parsed.draft.blurb).toBe('one line')
    expect(parsed.draft.whenToUse).toBe('when')
    expect(parsed.draft.instructions).toHaveLength(PRESET_INSTRUCTIONS_MAX)
  })

  it('refuses what is not a preset, naming the field', () => {
    expect(parsePresetDraft(null)).toMatchObject({ ok: false })
    expect(parsePresetDraft({ name: '' })).toMatchObject({ ok: false, error: /needs a "name"/ })
    expect(parsePresetDraft({ name: 'A', instructions: 3 }, 'draft')).toMatchObject({
      ok: false,
      error: 'draft: "instructions" must be a string',
    })
  })
})

describe('parsePresetSettings', () => {
  it('accepts the stored shape and normalises each preset', () => {
    const parsed = parsePresetSettings({
      presets: [{ ...mine, name: ' Data and storage ' }],
      disabled: ['importance', 'importance', 'nope'],
      default: 'a1b2',
    })
    if (!parsed.ok) throw new Error(parsed.error)
    expect(parsed.settings).toEqual({
      presets: [{ ...mine, builtIn: false }],
      // Deduplicated, and an id nothing has is dropped rather than refused.
      disabled: ['importance'],
      default: 'a1b2',
    })
  })

  it('defaults the optional fields', () => {
    const parsed = parsePresetSettings({ presets: [] })
    expect(parsed).toEqual({ ok: true, settings: DEFAULT_PRESET_SETTINGS })
  })

  it('refuses a built-in id, a duplicate id, a bad id, and an unknown default', () => {
    expect(parsePresetSettings({ presets: [{ ...mine, id: 'concept' }] })).toMatchObject({
      ok: false,
      error: /built-in/,
    })
    expect(parsePresetSettings({ presets: [mine, mine] })).toMatchObject({
      ok: false,
      error: /listed twice/,
    })
    expect(parsePresetSettings({ presets: [{ ...mine, id: 'has space' }] })).toMatchObject({
      ok: false,
      error: /needs an "id"/,
    })
    expect(parsePresetSettings({ presets: [], default: 'a1b2' })).toMatchObject({
      ok: false,
      error: /"default"/,
    })
    expect(parsePresetSettings({ presets: [], disabled: 'concept' })).toMatchObject({
      ok: false,
      error: /"disabled"/,
    })
    expect(parsePresetSettings([])).toMatchObject({ ok: false })
  })

  it('normalizes a stored blob leniently: a bad one is the defaults, never an error', () => {
    expect(normalizePresetSettings(null)).toEqual(DEFAULT_PRESET_SETTINGS)
    expect(normalizePresetSettings('not json')).toEqual(DEFAULT_PRESET_SETTINGS)
    expect(normalizePresetSettings('{"presets":[{"id":"concept","name":"x"}]}')).toEqual(
      DEFAULT_PRESET_SETTINGS,
    )
    expect(normalizePresetSettings(JSON.stringify({ presets: [mine] })).presets).toEqual([
      { ...mine, builtIn: false },
    ])
  })
})

describe('the presets in play', () => {
  const settings = {
    presets: [{ ...mine, builtIn: false }],
    disabled: ['concept'],
    default: 'concept',
  }

  it('lists built-ins first, then yours, minus the switched-off ones', () => {
    expect(activePresets(settings).map((p) => p.id)).toEqual(['importance', 'a1b2'])
    expect(findPreset(settings, 'concept')?.builtIn).toBe(true)
    expect(findPreset(settings, 'a1b2')?.name).toBe('Data and storage')
    expect(findPreset(settings, undefined)).toBeUndefined()
  })

  it('a default that was switched off is "Agent picks" again', () => {
    expect(presetDefault(settings)).toBe(AGENT_PICKS)
    expect(presetDefault({ ...settings, disabled: [] })).toBe('concept')
    expect(presetDefault(DEFAULT_PRESET_SETTINGS)).toBe(AGENT_PICKS)
  })

  it('every built-in says what its layers show and when to use it; the fallback is Concept', () => {
    for (const p of BUILT_IN_PRESETS) {
      expect(p.blurb.length).toBeGreaterThan(10)
      expect(p.blurb.length).toBeLessThanOrEqual(PRESET_BLURB_MAX)
      expect(p.whenToUse.length).toBeGreaterThan(20)
      expect(p.instructions.length).toBeGreaterThan(50)
    }
    expect(fallbackPreset().id).toBe('concept')
  })
})

describe('parseLayersNote', () => {
  it('trims, caps, and reads anything else as none', () => {
    expect(parseLayersNote('  start with the migration\n')).toBe('start with the migration')
    expect(parseLayersNote('two\nlines')).toBe('two\nlines')
    expect(parseLayersNote('   ')).toBeUndefined()
    expect(parseLayersNote(undefined)).toBeUndefined()
    expect(parseLayersNote(7)).toBeUndefined()
    expect(parseLayersNote('x'.repeat(5000))).toHaveLength(1000)
  })
})

describe('parsePresetUse', () => {
  it('is optional, keeps a picked flag and a one-line why', () => {
    expect(parsePresetUse(undefined)).toEqual({ ok: true, use: undefined })
    expect(parsePresetUse({ id: 'importance', picked: true, why: ' large\nfeature ' })).toEqual({
      ok: true,
      use: { id: 'importance', picked: true, why: 'large feature' },
    })
    expect(parsePresetUse({ id: 'a1b2', picked: false })).toEqual({
      ok: true,
      use: { id: 'a1b2' },
    })
  })

  it('refuses a bad id or flag', () => {
    expect(parsePresetUse({ id: 'has space' })).toMatchObject({ ok: false })
    expect(parsePresetUse({ id: 'draft' })).toMatchObject({ ok: true })
    expect(parsePresetUse({ id: 'importance', picked: 'yes' })).toMatchObject({ ok: false })
    expect(parsePresetUse('importance')).toMatchObject({ ok: false })
  })
})

describe('parsePresetPatch', () => {
  it('takes any subset of the four fields, capped; a sent name may not be empty', () => {
    expect(parsePresetPatch({ instructions: ' x ' })).toEqual({
      ok: true,
      patch: { instructions: 'x' },
    })
    expect(parsePresetPatch({ name: 'N'.repeat(PRESET_NAME_MAX + 3), blurb: 'a\nb' })).toEqual({
      ok: true,
      patch: { name: 'N'.repeat(PRESET_NAME_MAX), blurb: 'a b' },
    })
    expect(parsePresetPatch({ name: ' ' })).toMatchObject({ ok: false, error: /needs a "name"/ })
    expect(parsePresetPatch({})).toMatchObject({ ok: false, error: /nothing to change/ })
    expect(parsePresetPatch({ blurb: 3 })).toMatchObject({ ok: false, error: /"blurb"/ })
    expect(parsePresetPatch([])).toMatchObject({ ok: false })
  })
})

describe('normalizePresetThreads', () => {
  it('keeps well-formed conversations and drops the rest, message by message', () => {
    const good = {
      id: 'm1',
      author: 'agent',
      text: 'Done',
      at: 't',
      change: {
        fields: ['instructions', 'nope'],
        before: { instructions: 'old', x: 1 },
        created: true,
      },
    }
    const threads = normalizePresetThreads(
      JSON.stringify({
        mine1: { messages: [good, { id: 'm2', author: 'nobody', text: 'x', at: 't' }, null] },
        'has space': { messages: [good] },
        empty: { messages: [] },
      }),
    )
    expect(Object.keys(threads)).toEqual(['mine1'])
    expect(threads.mine1?.messages).toEqual([
      {
        id: 'm1',
        author: 'agent',
        text: 'Done',
        at: 't',
        change: { fields: ['instructions'], before: { instructions: 'old' }, created: true },
      },
    ])
    expect(normalizePresetThreads('nope')).toEqual({})
    expect(normalizePresetThreads([])).toEqual({})
  })
})
