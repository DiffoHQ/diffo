import { randomUUID } from 'node:crypto'
import {
  activePresets,
  allPresets,
  BUILT_IN_PRESETS,
  findPreset,
  isEmptyPreset,
  type LayersPreset,
  type LayersPresetDraft,
  type LayersPresetSettings,
  NEW_PRESET_NAME,
  normalizePresetSettings,
  normalizePresetThreads,
  PRESET_MESSAGE_MAX,
  PRESET_THREAD_MAX,
  PRESETS_MAX,
  type PresetChange,
  type PresetMessage,
  type PresetThread,
  type PresetThreads,
} from '../shared/presets.js'
import type { UiSettings } from './index.js'

/**
 * The layers presets and their conversations, over the shared settings
 * store (see shared/presets.ts): the reviewer's presets, what is switched
 * off and the default under `layersPresets`, and each preset's thread with
 * the agent under `layersPresetThreads`. Per human, not per repo: the one
 * DiffoDb every server shares. Listeners hear every write, so the events
 * stream can tell an open dialog to re-read.
 */
/** What an agent is told when it answers about a preset that is gone. */
export const DELETED =
  'the reviewer deleted this preset before you answered: nothing was changed, and nothing is owed for it'

export class PresetStore {
  private listeners = new Set<() => void>()

  constructor(private readonly store: UiSettings) {}

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private notify(): void {
    for (const listener of this.listeners) listener()
  }

  settings(): LayersPresetSettings {
    return normalizePresetSettings(this.store.get('layersPresets'))
  }

  /** Replaces the settings. A conversation is kept only with its preset:
   * deleting a preset deletes what was said about it, and one left behind by
   * a preset that is gone goes too. */
  saveSettings(next: LayersPresetSettings): void {
    const kept = new Set(next.presets.map((p) => p.id))
    const gone = this.settings()
      .presets.map((p) => p.id)
      .filter((id) => !kept.has(id))
    this.store.set('layersPresets', JSON.stringify(next))
    // A deleted preset stays deleted: an agent answering late about it must
    // not bring it back (see `upsert`). The newest hundred are remembered.
    const deleted = this.deleted().filter((id) => !kept.has(id))
    if (gone.length > 0 || deleted.length !== this.deleted().length) {
      this.store.set('layersPresetsDeleted', JSON.stringify([...deleted, ...gone].slice(-100)))
    }
    const known = new Set(allPresets(next).map((p) => p.id))
    const threads = this.threads()
    const orphans = Object.keys(threads).filter((id) => !known.has(id))
    if (orphans.length > 0) {
      for (const id of orphans) delete threads[id]
      this.store.set('layersPresetThreads', JSON.stringify(threads))
    }
    this.notify()
  }

  /** Ids of presets the reviewer deleted. */
  private deleted(): string[] {
    try {
      const raw: unknown = JSON.parse(this.store.get('layersPresetsDeleted') ?? '[]')
      return Array.isArray(raw) ? raw.filter((id): id is string => typeof id === 'string') : []
    } catch {
      return []
    }
  }

  /** The reviewer deleted this preset: nothing may be said or changed about
   * it any more. */
  wasDeleted(id: string): boolean {
    return !this.find(id) && this.deleted().includes(id)
  }

  /**
   * The reviewer's first word about a preset nobody has yet makes it: a real
   * preset from then on, named `NEW_PRESET_NAME` and empty, so its
   * conversation has a card to live on and nothing is left hanging if they
   * move away. Empty, it is offered nowhere (see `isEmptyPreset`); the agent
   * fills it in. Does nothing when the preset exists.
   */
  start(id: string): { ok: true } | { ok: false; error: string } {
    const settings = this.settings()
    if (findPreset(settings, id)) return { ok: true }
    if (settings.presets.length >= PRESETS_MAX) {
      return { ok: false, error: `you already have ${PRESETS_MAX} presets of your own` }
    }
    // A second one started before the first is named is told apart the way
    // a second download is: "New preset (1)".
    const taken = new Set(settings.presets.map((p) => p.name))
    let name = NEW_PRESET_NAME
    for (let n = 1; taken.has(name); n++) name = `${NEW_PRESET_NAME} (${n})`
    const preset: LayersPreset = {
      id,
      name,
      blurb: '',
      whenToUse: '',
      instructions: '',
      builtIn: false,
    }
    this.saveSettings({ ...settings, presets: [...settings.presets, preset] })
    return { ok: true }
  }

  /** A new conversation: the messages go, the preset stays as it is. False
   * when there was nothing to clear. */
  clearThread(id: string): boolean {
    const threads = this.threads()
    if (!threads[id]) return false
    delete threads[id]
    this.store.set('layersPresetThreads', JSON.stringify(threads))
    this.notify()
    return true
  }

  threads(): PresetThreads {
    return normalizePresetThreads(this.store.get('layersPresetThreads'))
  }

  thread(id: string): PresetThread {
    return this.threads()[id] ?? { presetId: id, messages: [] }
  }

  /** Every preset, with whether it is on: what `diffo preset list` prints. */
  list(): Array<LayersPreset & { on: boolean }> {
    const settings = this.settings()
    const on = new Set(activePresets(settings).map((p) => p.id))
    return allPresets(settings).map((p) => ({ ...p, on: on.has(p.id) }))
  }

  find(id: string): LayersPreset | undefined {
    return findPreset(this.settings(), id)
  }

  /**
   * The built-in whose conversation waits on the agent: the reviewer spoke
   * last there. The latest, when there is more than one. The agent cannot
   * edit a built-in, so it answers with a copy under an id of its own, and
   * that answer has to reach the conversation that asked for it.
   */
  waitingBuiltIn(): LayersPreset | undefined {
    const threads = this.threads()
    let found: { preset: LayersPreset; at: string } | undefined
    for (const preset of BUILT_IN_PRESETS) {
      const last = threads[preset.id]?.messages.at(-1)
      if (last?.author !== 'reviewer') continue
      if (!found || last.at > found.at) found = { preset, at: last.at }
    }
    return found?.preset
  }

  /** Appends a message to a preset's conversation. The text is capped, and
   * the thread keeps its newest `PRESET_THREAD_MAX`. */
  addMessage(
    presetId: string,
    author: PresetMessage['author'],
    text: string,
    change?: PresetChange,
  ): PresetMessage {
    const message: PresetMessage = {
      id: randomUUID(),
      author,
      text: text.trim().slice(0, PRESET_MESSAGE_MAX),
      at: new Date().toISOString(),
      ...(change ? { change } : {}),
    }
    const threads = this.threads()
    const current = threads[presetId] ?? { presetId, messages: [] }
    const messages = [...current.messages, message].slice(-PRESET_THREAD_MAX)
    this.store.set(
      'layersPresetThreads',
      JSON.stringify({ ...threads, [presetId]: { presetId, messages } }),
    )
    this.notify()
    return message
  }

  /**
   * The agent's edit: the fields it sent replace the preset's, and a preset
   * nobody has yet is made from them (a name is required then). A built-in
   * is never written: the agent is told to copy it under a new id instead.
   * Returns the preset as it stands now and what changed, for the thread.
   */
  upsert(
    id: string,
    patch: Partial<LayersPresetDraft>,
  ): { ok: true; preset: LayersPreset; change: PresetChange } | { ok: false; error: string } {
    const settings = this.settings()
    const current = findPreset(settings, id)
    if (current?.builtIn) {
      return {
        ok: false,
        error: `"${id}" is built in and cannot be edited; copy it under a new id`,
      }
    }
    const fields = Object.keys(patch) as PresetChange['fields']
    if (!current && this.wasDeleted(id)) return { ok: false, error: DELETED }
    if (!current) {
      if (patch.name === undefined) {
        return { ok: false, error: `no preset "${id}" yet: a new one needs a "name"` }
      }
      if (settings.presets.length >= PRESETS_MAX) {
        return { ok: false, error: `the reviewer already has ${PRESETS_MAX} presets` }
      }
      const preset: LayersPreset = {
        id,
        name: patch.name,
        blurb: patch.blurb ?? '',
        whenToUse: patch.whenToUse ?? '',
        instructions: patch.instructions ?? '',
        builtIn: false,
      }
      this.saveSettings({ ...settings, presets: [...settings.presets, preset] })
      return { ok: true, preset, change: { fields, before: {}, created: true } }
    }
    const before: Partial<LayersPresetDraft> = {}
    for (const f of fields) before[f] = current[f]
    const preset: LayersPreset = { ...current, ...patch }
    this.saveSettings({
      ...settings,
      presets: settings.presets.map((p) => (p.id === id ? preset : p)),
    })
    // Filling in a preset the reviewer only started is making it: there is
    // nothing before it to go back to.
    const started = isEmptyPreset(current) && current.blurb === '' && current.whenToUse === ''
    return {
      ok: true,
      preset,
      change: started ? { fields, before: {}, created: true } : { fields, before },
    }
  }
}
