import { useCallback, useEffect, useState } from 'react'

/**
 * Whether the header critter shows. On by default; the Settings menu switches it.
 *
 * Stored the way the theme is (see theme.ts): the durable copy in the shared DB
 * behind `/api/settings`, so switching it off once switches it off in every
 * review on every port, and localStorage as this origin's cache for first
 * paint. "On" is the absence of the key, so a fresh profile and the default are
 * the same state.
 */

const KEY = 'diffo:ui:critter'

function loadCritter(): boolean {
  try {
    return localStorage.getItem(KEY) !== 'off'
  } catch {
    return true
  }
}

function storeCritter(on: boolean) {
  try {
    if (on) localStorage.removeItem(KEY)
    else localStorage.setItem(KEY, 'off')
  } catch {
    // no storage: the server copy still carries it
  }
}

async function fetchSharedCritter(): Promise<boolean | null> {
  try {
    const res = await fetch('/api/settings')
    if (!res.ok) return null
    const body = (await res.json()) as { critter?: unknown }
    return body?.critter === 'on' ? true : body?.critter === 'off' ? false : null
  } catch {
    return null
  }
}

export function useCritter(): [boolean, (on: boolean) => void] {
  const [on, setOn] = useState<boolean>(loadCritter)
  useEffect(() => {
    let cancelled = false
    void fetchSharedCritter().then((shared) => {
      if (cancelled || shared === null || shared === loadCritter()) return
      storeCritter(shared)
      setOn(shared)
    })
    return () => {
      cancelled = true
    }
  }, [])
  const set = useCallback((next: boolean) => {
    setOn(next)
    storeCritter(next)
    // Fire-and-forget, as the theme does: the local copy is already applied.
    void fetch('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ critter: next ? 'on' : 'off' }),
    }).catch(() => {})
  }, [])
  return [on, set]
}
