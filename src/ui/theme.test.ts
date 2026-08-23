// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { applyTheme, loadTheme, useTheme } from './theme.js'

afterEach(() => {
  localStorage.clear()
  document.documentElement.removeAttribute('data-theme')
})

describe('loadTheme', () => {
  it('defaults to system — a fresh profile follows the OS', () => {
    expect(loadTheme()).toBe('system')
  })

  it('round-trips an explicit choice', () => {
    localStorage.setItem('diffo:ui:theme', 'dark')
    expect(loadTheme()).toBe('dark')
  })

  it('treats junk in storage as system, not as a crash', () => {
    localStorage.setItem('diffo:ui:theme', 'neon')
    expect(loadTheme()).toBe('system')
  })
})

describe('applyTheme', () => {
  it('system is the absence of the attribute — the media query stays in charge', () => {
    applyTheme('dark')
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark')
    applyTheme('system')
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false)
  })
})

describe('useTheme', () => {
  it('setting a theme applies it and persists it', () => {
    const { result } = renderHook(() => useTheme())
    act(() => result.current[1]('light'))
    expect(result.current[0]).toBe('light')
    expect(document.documentElement.getAttribute('data-theme')).toBe('light')
    expect(localStorage.getItem('diffo:ui:theme')).toBe('light')
  })

  it('returning to system removes both the attribute and the key', () => {
    const { result } = renderHook(() => useTheme())
    act(() => result.current[1]('dark'))
    act(() => result.current[1]('system'))
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false)
    expect(localStorage.getItem('diffo:ui:theme')).toBeNull()
  })
})
