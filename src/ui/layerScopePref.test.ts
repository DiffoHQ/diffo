// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { useLayerScope } from './layerScopePref.js'

afterEach(() => {
  localStorage.clear()
})

describe('useLayerScope', () => {
  it('is parts until chosen, and an unknown stored value is parts too', () => {
    expect(renderHook(() => useLayerScope()).result.current[0]).toBe('parts')
    localStorage.setItem('diffo:ui:layerSplit', 'sideways')
    expect(renderHook(() => useLayerScope()).result.current[0]).toBe('parts')
  })

  it('keeps a whole-file pick made with the two-way switch', () => {
    localStorage.setItem('diffo:ui:layerSplit', 'whole')
    expect(renderHook(() => useLayerScope()).result.current[0]).toBe('whole')
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
