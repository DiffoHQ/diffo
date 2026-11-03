import { useCallback, useEffect, useState } from 'react'
import { normalizeVoice } from '../shared/voice.js'

/**
 * The reviewer's voice: the standing instructions the agent reads before
 * drafting a PR comment for them (see shared/voice.ts). Null is the default,
 * which the client knows on its own.
 *
 * Unlike the theme, nothing here is applied locally: the server is the one
 * reader, so the setting lives only in the shared DB behind `/api/settings`
 * and a save waits for the server to confirm before the dialog closes.
 */
export interface VoicePref {
  /** Null until loaded, and when the default is in force. */
  voice: string | null
  loaded: boolean
  /** Resolves false when the server refused or could not be reached. */
  setVoice: (next: string | null) => Promise<boolean>
}

async function fetchVoice(): Promise<string | null> {
  try {
    const res = await fetch('/api/settings')
    if (!res.ok) return null
    const body = (await res.json()) as { voice?: unknown }
    return normalizeVoice(body?.voice)
  } catch {
    return null
  }
}

export function useVoice(): VoicePref {
  const [voice, setLocal] = useState<string | null>(null)
  const [loaded, setLoaded] = useState(false)
  useEffect(() => {
    let cancelled = false
    void fetchVoice().then((shared) => {
      if (cancelled) return
      setLocal(shared)
      setLoaded(true)
    })
    return () => {
      cancelled = true
    }
  }, [])
  const setVoice = useCallback(async (next: string | null) => {
    const text = normalizeVoice(next)
    try {
      const res = await fetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        // Empty is the reset: the server stores it and answers null from then on.
        body: JSON.stringify({ voice: text ?? '' }),
      })
      if (!res.ok) return false
    } catch {
      return false
    }
    setLocal(text)
    return true
  }, [])
  return { voice, loaded, setVoice }
}
