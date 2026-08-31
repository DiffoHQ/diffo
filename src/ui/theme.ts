import { useCallback, useEffect, useState } from 'react'

/**
 * Theme choice. Both palettes live in styles.css: light is the sheet's default, dark
 * arrives via `prefers-color-scheme`, and `[data-theme]` rules exist so an explicit
 * choice can win in *both* directions. This module is the setter.
 *
 * `system` is the absence of the attribute, not a third palette — that keeps the media
 * query in charge, live. Storage mirrors it: `system` removes the key, so a fresh
 * profile and "follow the system" are the same state.
 *
 * Two stores, one choice. Every repo is served from its own port, so localStorage —
 * per-origin by nature — can only cache the choice for THIS origin's next paint.
 * The durable copy lives server-side in the shared DB (`/api/settings`), where every
 * review on every port reads it: pick dark once, and it's dark everywhere. On mount
 * the server's answer wins over the local cache; a set writes through to both.
 */

export type Theme = 'system' | 'light' | 'dark'

export const THEMES: readonly Theme[] = ['system', 'light', 'dark']

const KEY = 'diffo:ui:theme'

function asTheme(raw: unknown): Theme | null {
  return raw === 'system' || raw === 'light' || raw === 'dark' ? raw : null
}

export function loadTheme(): Theme {
  const raw = localStorage.getItem(KEY)
  return raw === 'light' || raw === 'dark' ? raw : 'system'
}

function storeTheme(theme: Theme) {
  if (theme === 'system') localStorage.removeItem(KEY)
  else localStorage.setItem(KEY, theme)
}

export function applyTheme(theme: Theme) {
  if (theme === 'system') document.documentElement.removeAttribute('data-theme')
  else document.documentElement.setAttribute('data-theme', theme)
}

/** The choice shared across every diffo origin, or null when the server has
 * none (or isn't reachable — a dev client without its proxy still themes). */
export async function fetchSharedTheme(): Promise<Theme | null> {
  try {
    const res = await fetch('/api/settings')
    if (!res.ok) return null
    const body = (await res.json()) as { theme?: unknown }
    return asTheme(body?.theme)
  } catch {
    return null
  }
}

function pushSharedTheme(theme: Theme): void {
  // Fire-and-forget: the local copy is already applied, and the next review to
  // load asks the server again anyway.
  void fetch('/api/settings', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ theme }),
  }).catch(() => {})
}

export function useTheme(): [Theme, (theme: Theme) => void] {
  const [theme, setThemeState] = useState<Theme>(loadTheme)
  useEffect(() => {
    let cancelled = false
    void fetchSharedTheme().then((shared) => {
      if (cancelled || shared === null || shared === loadTheme()) return
      storeTheme(shared)
      applyTheme(shared)
      setThemeState(shared)
    })
    return () => {
      cancelled = true
    }
  }, [])
  const setTheme = useCallback((next: Theme) => {
    setThemeState(next)
    applyTheme(next)
    storeTheme(next)
    pushSharedTheme(next)
  }, [])
  return [theme, setTheme]
}
