// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { useLayerSplit } from './layerSplitPref.js'

afterEach(() => {
  localStorage.clear()
})

describe('useLayerSplit', () => {
  it('is parts until chosen, and an unknown stored value is parts too', () => {
    expect(renderHook(() => useLayerSplit()).result.current[0]).toBe('parts')
    localStorage.setItem('diffo:ui:layerSplit', 'sideways')
    expect(renderHook(() => useLayerSplit()).result.current[0]).toBe('parts')
  })

  it('remembers whole across mounts, and parts again after', () => {
    const first = renderHook(() => useLayerSplit())
    act(() => first.result.current[1]('whole'))
    expect(first.result.current[0]).toBe('whole')
    expect(localStorage.getItem('diffo:ui:layerSplit')).toBe('whole')
    first.unmount()
    expect(renderHook(() => useLayerSplit()).result.current[0]).toBe('whole')
  })
})
