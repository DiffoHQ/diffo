import { useCallback, useState } from 'react'

/**
 * Theme choice. Both palettes live in styles.css: light is the sheet's default, dark
 * arrives via `prefers-color-scheme`, and `[data-theme]` rules exist so an explicit
 * choice can win in *both* directions. This module is the setter.
 *
 * `system` is the absence of the attribute, not a third palette — that keeps the media
 * query in charge, live. Storage mirrors it: `system` removes the key, so a fresh
 * profile and "follow the system" are the same state.
 */

export type Theme = 'system' | 'light' | 'dark'

export const THEMES: readonly Theme[] = ['system', 'light', 'dark']

const KEY = 'diffo:ui:theme'

export function loadTheme(): Theme {
  const raw = localStorage.getItem(KEY)
  return raw === 'light' || raw === 'dark' ? raw : 'system'
}

export function applyTheme(theme: Theme) {
  if (theme === 'system') document.documentElement.removeAttribute('data-theme')
  else document.documentElement.setAttribute('data-theme', theme)
}

export function useTheme(): [Theme, (theme: Theme) => void] {
  const [theme, setThemeState] = useState<Theme>(loadTheme)
  const setTheme = useCallback((next: Theme) => {
    setThemeState(next)
    applyTheme(next)
    if (next === 'system') localStorage.removeItem(KEY)
    else localStorage.setItem(KEY, next)
  }, [])
  return [theme, setTheme]
}
