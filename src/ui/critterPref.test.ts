// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useCritter } from './critterPref.js'

/** The server side of the sync: GET answers `shared`, PUT records its body. */
function stubSettingsApi(shared: unknown = null) {
  const puts: unknown[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === 'PUT') {
        puts.push(JSON.parse(String(init.body)))
        return new Response(JSON.stringify({ ok: true }))
      }
      return new Response(JSON.stringify({ critter: shared }))
    }),
  )
  return puts
}

beforeEach(() => {
  stubSettingsApi()
})

afterEach(() => {
  vi.unstubAllGlobals()
  localStorage.clear()
  document.documentElement.removeAttribute('data-motion')
})

describe('useCritter', () => {
  it('is on by default and leaves the root without data-motion', () => {
    const { result } = renderHook(() => useCritter())
    expect(result.current[0]).toBe(true)
    expect(document.documentElement.hasAttribute('data-motion')).toBe(false)
  })

  it('switching it off marks the root so the logo loops still too', () => {
    const puts = stubSettingsApi()
    const { result } = renderHook(() => useCritter())
    act(() => result.current[1](false))
    expect(result.current[0]).toBe(false)
    expect(document.documentElement.getAttribute('data-motion')).toBe('off')
    expect(localStorage.getItem('diffo:ui:critter')).toBe('off')
    expect(puts).toEqual([{ critter: 'off' }])

    act(() => result.current[1](true))
    expect(document.documentElement.hasAttribute('data-motion')).toBe(false)
  })

  it('a stored "off" applies on first render', () => {
    localStorage.setItem('diffo:ui:critter', 'off')
    const { result } = renderHook(() => useCritter())
    expect(result.current[0]).toBe(false)
    expect(document.documentElement.getAttribute('data-motion')).toBe('off')
  })

  it('the shared copy wins over the local cache', async () => {
    stubSettingsApi('off')
    const { result } = renderHook(() => useCritter())
    await waitFor(() => expect(result.current[0]).toBe(false))
    expect(document.documentElement.getAttribute('data-motion')).toBe('off')
  })
})
