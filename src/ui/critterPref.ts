import { useCallback, useEffect, useState } from 'react'

/**
 * Whether the page's decorative motion runs: the header critter, and the logo's
 * living mark and wordmark loops. On by default; the Settings menu ("Animations")
 * switches it. The stored key keeps its old name, `critter`, since it is shared
 * with the server and older clients.
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

/** Mirrors the pref onto the root, so CSS can still the logo loops the way it
 * does for `prefers-reduced-motion` (see "the living mark" in styles.css). */
function applyMotion(on: boolean) {
  if (on) document.documentElement.removeAttribute('data-motion')
  else document.documentElement.setAttribute('data-motion', 'off')
}

export function useCritter(): [boolean, (on: boolean) => void] {
  const [on, setOn] = useState<boolean>(loadCritter)
  useEffect(() => {
    applyMotion(on)
  }, [on])
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
