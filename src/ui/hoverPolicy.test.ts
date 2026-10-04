import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HoverPolicy } from './hoverPolicy.js'

type T = { id: string }

function policy() {
  const show = vi.fn<(t: T) => void>()
  const hide = vi.fn()
  const p = new HoverPolicy<T>(
    { show, hide, same: (a, b) => a.id === b.id },
    { showDelay: 600, leaveGrace: 250 },
  )
  return { p, show, hide }
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('HoverPolicy', () => {
  it('opens only after the pointer rests on one name for the delay', () => {
    const { p, show } = policy()
    p.over({ id: 'a' })
    vi.advanceTimersByTime(599)
    expect(show).not.toHaveBeenCalled()
    p.over({ id: 'a' }) // moving within the word keeps the clock
    vi.advanceTimersByTime(1)
    expect(show).toHaveBeenCalledTimes(1)
    expect(p.isShown).toBe(true)
  })

  it('never opens for a pointer passing across names', () => {
    const { p, show } = policy()
    p.over({ id: 'a' })
    vi.advanceTimersByTime(400)
    p.over({ id: 'b' })
    vi.advanceTimersByTime(400)
    p.away()
    vi.advanceTimersByTime(1000)
    expect(show).not.toHaveBeenCalled()
  })

  it('does not follow the pointer from one name to the next: the card closes after its grace, the next waits its full delay', () => {
    const { p, show, hide } = policy()
    p.over({ id: 'a' })
    vi.advanceTimersByTime(600)
    p.over({ id: 'b' })
    expect(hide).not.toHaveBeenCalled()
    vi.advanceTimersByTime(250)
    expect(hide).toHaveBeenCalledTimes(1)
    expect(show).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(349)
    expect(show).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(1)
    expect(show).toHaveBeenLastCalledWith({ id: 'b' })
  })

  it('crossing other names on the way into the card keeps it', () => {
    const { p, show, hide } = policy()
    p.over({ id: 'a' })
    vi.advanceTimersByTime(600)
    p.over({ id: 'line-above-1' }) // the row between the word and the card
    vi.advanceTimersByTime(60)
    p.over({ id: 'line-above-2' })
    vi.advanceTimersByTime(60)
    p.away()
    vi.advanceTimersByTime(60)
    p.inCard()
    vi.advanceTimersByTime(5000)
    expect(hide).not.toHaveBeenCalled()
    expect(show).toHaveBeenCalledTimes(1)
  })

  it('stays while the pointer crosses into the card, and while it is inside', () => {
    const { p, hide } = policy()
    p.over({ id: 'a' })
    vi.advanceTimersByTime(600)
    p.away() // the gap between the word and the card
    vi.advanceTimersByTime(200)
    p.inCard()
    vi.advanceTimersByTime(5000)
    expect(hide).not.toHaveBeenCalled()
    p.away()
    vi.advanceTimersByTime(249)
    expect(hide).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(hide).toHaveBeenCalledTimes(1)
  })

  it('coming back to the name within the grace keeps the card', () => {
    const { p, hide } = policy()
    p.over({ id: 'a' })
    vi.advanceTimersByTime(600)
    p.away()
    vi.advanceTimersByTime(200)
    p.over({ id: 'a' })
    vi.advanceTimersByTime(1000)
    expect(hide).not.toHaveBeenCalled()
  })

  it('inside the card, a name armed earlier never opens over it', () => {
    const { p, show } = policy()
    p.over({ id: 'a' })
    vi.advanceTimersByTime(600)
    p.away()
    p.over({ id: 'b' })
    p.inCard()
    vi.advanceTimersByTime(2000)
    expect(show).toHaveBeenCalledTimes(1)
  })

  it('dismiss closes at once and cancels a pending open', () => {
    const { p, show, hide } = policy()
    p.over({ id: 'a' })
    p.dismiss()
    vi.advanceTimersByTime(1000)
    expect(show).not.toHaveBeenCalled()
    expect(hide).not.toHaveBeenCalled() // nothing was open
    p.over({ id: 'a' })
    vi.advanceTimersByTime(600)
    p.dismiss()
    expect(hide).toHaveBeenCalledTimes(1)
    expect(p.isShown).toBe(false)
  })
})
