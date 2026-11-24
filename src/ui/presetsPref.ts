import { useCallback, useEffect, useState } from 'react'
import {
  DEFAULT_PRESET_SETTINGS,
  type LayersPresetSettings,
  normalizePresetSettings,
  type PresetMessage,
  type PresetThread,
} from '../shared/presets.js'
import { type ConversationThreadState, useConversationThread } from './conversationThread.js'

/**
 * The reviewer's layers presets (see shared/presets.ts): their own presets,
 * which are switched off, and the default for a new review. Like the voice,
 * the server is the one reader — the ask carries the preset to the agent — so
 * the setting lives only in the shared DB behind `/api/settings`, and a save
 * waits for the server before the dialog shows it as kept.
 *
 * The agent edits presets too, through the CLI, and writes in their
 * conversations; the events stream says so (`presets`), and every hook here
 * re-reads on `notifyPresetsChanged`.
 */
export interface PresetsPref {
  settings: LayersPresetSettings
  loaded: boolean
  /** Replaces the whole blob. Resolves false when the server refused or could
   * not be reached; the local copy is left as it was then. */
  save: (next: LayersPresetSettings) => Promise<boolean>
}

const changeListeners = new Set<() => void>()

/** The server said the presets or their conversations moved: re-read. */
export function notifyPresetsChanged(): void {
  for (const listener of changeListeners) listener()
}

function onPresetsChanged(listener: () => void): () => void {
  changeListeners.add(listener)
  return () => {
    changeListeners.delete(listener)
  }
}

async function fetchPresets(): Promise<LayersPresetSettings> {
  try {
    const res = await fetch('/api/settings')
    if (!res.ok) return DEFAULT_PRESET_SETTINGS
    const body = (await res.json()) as { layersPresets?: unknown }
    return normalizePresetSettings(body?.layersPresets)
  } catch {
    return DEFAULT_PRESET_SETTINGS
  }
}

export function useLayersPresets(): PresetsPref {
  const [settings, setLocal] = useState<LayersPresetSettings>(DEFAULT_PRESET_SETTINGS)
  const [loaded, setLoaded] = useState(false)
  useEffect(() => {
    let cancelled = false
    const load = () =>
      void fetchPresets().then((shared) => {
        if (cancelled) return
        setLocal(shared)
        setLoaded(true)
      })
    load()
    const off = onPresetsChanged(load)
    return () => {
      cancelled = true
      off()
    }
  }, [])
  const save = useCallback(async (next: LayersPresetSettings) => {
    try {
      const res = await fetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ layersPresets: next }),
      })
      if (!res.ok) return false
    } catch {
      return false
    }
    setLocal(next)
    return true
  }, [])
  return { settings, loaded, save }
}

/** A preset's conversation with the agent, kept current from the stream. */
export type PresetThreadState = ConversationThreadState<PresetThread, PresetMessage>

export function usePresetThread(id: string | null): PresetThreadState {
  return useConversationThread<PresetThread, PresetMessage>(
    id === null ? null : `/api/presets/${encodeURIComponent(id)}`,
    () => ({ presetId: id ?? '', messages: [] }),
    onPresetsChanged,
    // A first message about a preset nobody has yet makes it (see
    // `PresetStore.start`): the settings re-read now, not when the stream
    // gets round to it.
    notifyPresetsChanged,
  )
}
