// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { FileChange } from '../shared/types.js'
import { layerReadOrder, useLayerList } from './layerListPref.js'
import { resolveLayers } from './layers.js'

afterEach(() => {
  localStorage.clear()
})

describe('useLayerList', () => {
  it('is Order until chosen, and an unknown stored value is Order too', () => {
    expect(renderHook(() => useLayerList()).result.current[0]).toBe('order')
    localStorage.setItem('diffo:ui:layerList', 'sideways')
    expect(renderHook(() => useLayerList()).result.current[0]).toBe('order')
  })

  it('remembers Tree across mounts, and Order again after', () => {
    const first = renderHook(() => useLayerList())
    act(() => first.result.current[1]('tree'))
    expect(first.result.current[0]).toBe('tree')
    expect(localStorage.getItem('diffo:ui:layerList')).toBe('tree')
    first.unmount()
    const second = renderHook(() => useLayerList())
    expect(second.result.current[0]).toBe('tree')
    act(() => second.result.current[1]('order'))
    expect(localStorage.getItem('diffo:ui:layerList')).toBe('order')
    expect(renderHook(() => useLayerList()).result.current[0]).toBe('order')
  })
})

describe('layerReadOrder', () => {
  const file = (path: string): FileChange => ({
    path,
    oldPath: null,
    status: 'modified',
    kind: 'text',
    staged: false,
    hunks: [],
  })
  // Listed out of folder order, so the two readings differ.
  const [layer] = resolveLayers(
    {
      postedAt: '2026-09-20T00:00:00Z',
      items: [{ id: 'z', title: 'Zigzag', files: ['src/b.ts', 'README.md', 'src/a.ts'] }],
    },
    [file('README.md'), file('src/a.ts'), file('src/b.ts')],
  )

  it('Order is the agent’s list as posted', () => {
    expect(layerReadOrder(layer!, 'order').map((f) => f.path)).toEqual([
      'src/b.ts',
      'README.md',
      'src/a.ts',
    ])
  })

  it('Tree is the rail’s tree flattened: folders first, files by name', () => {
    expect(layerReadOrder(layer!, 'tree').map((f) => f.path)).toEqual([
      'src/a.ts',
      'src/b.ts',
      'README.md',
    ])
  })
})
