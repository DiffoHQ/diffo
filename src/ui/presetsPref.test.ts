// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_PRESET_SETTINGS } from '../shared/presets.js'
import { notifyPresetsChanged, useLayersPresets, usePresetThread } from './presetsPref.js'

function stubSettingsApi(shared: unknown = undefined, ok = true) {
  const puts: unknown[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === 'PUT') {
        puts.push(JSON.parse(String(init.body)))
        return new Response(ok ? '{"ok":true}' : '{"error":"no"}', { status: ok ? 200 : 400 })
      }
      return new Response(JSON.stringify({ layersPresets: shared }))
    }),
  )
  return puts
}

afterEach(() => {
  vi.unstubAllGlobals()
})

const mine = {
  id: 'mine1',
  name: 'Data and storage',
  blurb: 'types and keys',
  whenToUse: 'stored state',
  instructions: 'type files whole',
  builtIn: false,
}

describe('useLayersPresets', () => {
  it('starts as the defaults and takes the shared copy once it arrives', async () => {
    stubSettingsApi({ presets: [mine], disabled: ['importance'], default: 'mine1' })
    const { result } = renderHook(() => useLayersPresets())
    expect(result.current.settings).toEqual(DEFAULT_PRESET_SETTINGS)
    await waitFor(() => expect(result.current.loaded).toBe(true))
    expect(result.current.settings).toEqual({
      presets: [mine],
      disabled: ['importance'],
      default: 'mine1',
    })
  })

  it('a bad shared copy is the defaults; a save sends the whole blob', async () => {
    const puts = stubSettingsApi('garbage')
    const { result } = renderHook(() => useLayersPresets())
    await waitFor(() => expect(result.current.loaded).toBe(true))
    expect(result.current.settings).toEqual(DEFAULT_PRESET_SETTINGS)
    const next = { presets: [mine], disabled: [], default: 'agent' }
    await act(async () => expect(await result.current.save(next)).toBe(true))
    expect(result.current.settings).toEqual(next)
    expect(puts).toEqual([{ layersPresets: next }])
  })

  it('a refused save leaves the local copy alone and says so', async () => {
    stubSettingsApi(undefined, false)
    const { result } = renderHook(() => useLayersPresets())
    await waitFor(() => expect(result.current.loaded).toBe(true))
    await act(async () =>
      expect(await result.current.save({ presets: [mine], disabled: [], default: 'agent' })).toBe(
        false,
      ),
    )
    expect(result.current.settings).toEqual(DEFAULT_PRESET_SETTINGS)
  })
})

describe('usePresetThread', () => {
  it('reads the conversation, re-reads when the presets move, and sends the reviewer’s words', async () => {
    const posts: unknown[] = []
    let messages: unknown[] = [{ id: 'm1', author: 'agent', text: 'Hi', at: 't' }]
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        if (init?.method === 'DELETE') {
          posts.push([`DELETE ${url}`, null])
          messages = []
          return new Response(JSON.stringify({ cleared: true }))
        }
        if (init?.method === 'POST') {
          posts.push([url, JSON.parse(String(init.body))])
          messages = [...messages, { id: 'm2', author: 'reviewer', text: 'tests first', at: 't' }]
          return new Response(
            JSON.stringify({ message: messages[1], thread: { presetId: 'mine1', messages } }),
          )
        }
        return new Response(JSON.stringify({ thread: { presetId: 'mine1', messages } }))
      }),
    )
    const { result } = renderHook(() => usePresetThread('mine1'))
    await waitFor(() => expect(result.current.thread.messages).toHaveLength(1))
    await act(async () => {
      expect(await result.current.send('tests first')).toMatchObject({ author: 'reviewer' })
    })
    expect(posts).toEqual([['/api/presets/mine1/messages', { text: 'tests first' }]])
    expect(result.current.thread.messages).toHaveLength(2)
    messages = [...messages, { id: 'm3', author: 'agent', text: 'Done', at: 't' }]
    act(() => notifyPresetsChanged())
    await waitFor(() => expect(result.current.thread.messages).toHaveLength(3))
    // A new conversation: the messages go at once, without waiting on a re-read.
    await act(async () => {
      expect(await result.current.clear()).toBe(true)
    })
    expect(result.current.thread.messages).toHaveLength(0)
    expect(posts.at(-1)).toEqual(['DELETE /api/presets/mine1/thread', null])
  })
})
