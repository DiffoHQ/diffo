// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { useLayerScope } from './layerScopePref.js'

afterEach(() => {
  localStorage.clear()
})

describe('useLayerScope', () => {
  it('is lines until chosen, and an unknown stored value is lines too', () => {
    expect(renderHook(() => useLayerScope()).result.current[0]).toBe('highlights')
    localStorage.setItem('diffo:ui:layerSplit', 'sideways')
    expect(renderHook(() => useLayerScope()).result.current[0]).toBe('highlights')
  })

  it('keeps a pick made with the two-way switch, either way', () => {
    localStorage.setItem('diffo:ui:layerSplit', 'whole')
    expect(renderHook(() => useLayerScope()).result.current[0]).toBe('whole')
    localStorage.setItem('diffo:ui:layerSplit', 'parts')
    expect(renderHook(() => useLayerScope()).result.current[0]).toBe('parts')
  })

  it('remembers each pick across mounts', () => {
    for (const kind of ['highlights', 'whole', 'parts'] as const) {
      const first = renderHook(() => useLayerScope())
      act(() => first.result.current[1](kind))
      first.unmount()
      expect(renderHook(() => useLayerScope()).result.current[0]).toBe(kind)
    }
  })
})
