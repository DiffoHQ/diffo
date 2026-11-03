// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useVoice } from './voicePref.js'

/** The server side: GET answers `shared`, PUT records its body and answers `ok`. */
function stubSettingsApi(shared: unknown = null, ok = true) {
  const puts: unknown[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === 'PUT') {
        puts.push(JSON.parse(String(init.body)))
        return new Response(ok ? '{"ok":true}' : '{"error":"no"}', { status: ok ? 200 : 400 })
      }
      return new Response(JSON.stringify({ voice: shared }))
    }),
  )
  return puts
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('useVoice', () => {
  it('starts as the default and takes the shared copy once it arrives', async () => {
    stubSettingsApi('Blunt.')
    const { result } = renderHook(() => useVoice())
    expect(result.current.voice).toBeNull()
    expect(result.current.loaded).toBe(false)
    await waitFor(() => expect(result.current.loaded).toBe(true))
    expect(result.current.voice).toBe('Blunt.')
  })

  it('saves trimmed, and a reset as the empty string', async () => {
    const puts = stubSettingsApi()
    const { result } = renderHook(() => useVoice())
    await waitFor(() => expect(result.current.loaded).toBe(true))
    await act(async () => expect(await result.current.setVoice(' Short. ')).toBe(true))
    expect(result.current.voice).toBe('Short.')
    await act(async () => expect(await result.current.setVoice(null)).toBe(true))
    expect(result.current.voice).toBeNull()
    expect(puts).toEqual([{ voice: 'Short.' }, { voice: '' }])
  })

  it('a refused save leaves the local copy alone and says so', async () => {
    stubSettingsApi('Old.', false)
    const { result } = renderHook(() => useVoice())
    await waitFor(() => expect(result.current.voice).toBe('Old.'))
    await act(async () => expect(await result.current.setVoice('New.')).toBe(false))
    expect(result.current.voice).toBe('Old.')
  })
})
