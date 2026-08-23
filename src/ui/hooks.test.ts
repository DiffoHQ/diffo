// @vitest-environment jsdom
import { renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { glideTo, useDarkMode } from './hooks.js'

function stubMatchMedia(matches: boolean) {
  vi.stubGlobal(
    'matchMedia',
    vi.fn().mockReturnValue({
      matches,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }),
  )
}

afterEach(() => {
  vi.unstubAllGlobals()
  document.documentElement.removeAttribute('data-theme')
})

describe('useDarkMode', () => {
  it('follows the OS when no explicit theme is set', () => {
    stubMatchMedia(true)
    const { result } = renderHook(() => useDarkMode())
    expect(result.current).toBe(true)
  })

  it('an explicit light theme beats a dark OS — the token-on-paper bug', () => {
    stubMatchMedia(true)
    document.documentElement.setAttribute('data-theme', 'light')
    const { result } = renderHook(() => useDarkMode())
    expect(result.current).toBe(false)
  })

  it('an explicit dark theme beats a light OS', () => {
    stubMatchMedia(false)
    document.documentElement.setAttribute('data-theme', 'dark')
    const { result } = renderHook(() => useDarkMode())
    expect(result.current).toBe(true)
  })

  it('reacts live when the theme menu writes the attribute', async () => {
    stubMatchMedia(true)
    const { result } = renderHook(() => useDarkMode())
    expect(result.current).toBe(true)
    document.documentElement.setAttribute('data-theme', 'light')
    await waitFor(() => expect(result.current).toBe(false))
  })
})

describe('glideTo', () => {
  /** A pane > column > target, with the two DOM bits jsdom doesn't implement stubbed:
   *  scrollIntoView (recorded, so we can count aims) and a settable offsetTop. */
  function scene() {
    document.body.innerHTML =
      '<div class="reading-pane"><div class="reading-col"><div id="target"></div></div></div>'
    const pane = document.querySelector('.reading-pane') as HTMLElement
    const node = document.getElementById('target') as HTMLElement
    const aims: string[] = []
    node.scrollIntoView = vi.fn((o: ScrollIntoViewOptions) => {
      aims.push(o.behavior as string)
    }) as unknown as HTMLElement['scrollIntoView']
    let top = 0
    Object.defineProperty(node, 'offsetTop', { get: () => top, configurable: true })
    let grew = () => {}
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(fn: () => void) {
          grew = fn
        }
        observe() {}
        disconnect() {
          grew = () => {}
        }
      },
    )
    const grow = (to: number) => {
      top = to
      grew()
    }
    return { pane, node, aims, grow }
  }

  it('re-aims when the page grows under the target, and lands it once', () => {
    stubMatchMedia(false)
    const { pane, node, aims, grow } = scene()
    const arrived = vi.fn()
    glideTo(node, arrived)
    expect(aims).toEqual(['smooth'])

    // A batch of files renders above the target: the destination the browser locked
    // in is now the wrong one, so the glide is retargeted mid-flight.
    grow(900)
    expect(aims).toEqual(['smooth', 'smooth'])
    // Growth that doesn't move the target is not worth a second aim.
    grow(900)
    expect(aims).toEqual(['smooth', 'smooth'])

    pane.scrollTop = 900
    pane.dispatchEvent(new Event('scrollend'))
    expect(arrived).toHaveBeenCalledTimes(1)
    // Arrived and disconnected: later growth is the reader's page now, not our jump.
    grow(1500)
    expect(aims).toEqual(['smooth', 'smooth'])
  })

  it('a smooth scroll that never ran is landed the blunt way', () => {
    stubMatchMedia(false)
    const { pane, node, aims } = scene()
    glideTo(node)
    // The pane never moved a pixel — the scroll didn't happen at all.
    expect(pane.scrollTop).toBe(0)
    pane.dispatchEvent(new Event('scrollend'))
    expect(aims).toEqual(['smooth', 'instant'])
  })

  it('reduced motion cuts straight there', () => {
    stubMatchMedia(true)
    const { node, aims } = scene()
    const arrived = vi.fn()
    glideTo(node, arrived)
    expect(aims).toEqual(['instant'])
    expect(arrived).toHaveBeenCalledTimes(1)
  })
})
