// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TelemetryStatus } from '../telemetry.js'
import { NOTICE_AUTO_DISMISS_MS, TelemetryNotice } from './TelemetryNotice.js'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

const base: TelemetryStatus = {
  enabled: true,
  source: 'default',
  notice: 'pending',
  machineId: null,
  dev: false,
  docs: 'https://diffohq.github.io/diffo/telemetry',
}

function show(status: TelemetryStatus) {
  const onShown = vi.fn()
  const onAcknowledge = vi.fn()
  const view = render(
    <TelemetryNotice status={status} onShown={onShown} onAcknowledge={onAcknowledge} />,
  )
  return { view, onShown, onAcknowledge }
}

describe('TelemetryNotice', () => {
  it('on first showing: says nothing has been sent, records that it was shown, links the list', () => {
    const { onShown } = show(base)
    expect(screen.getByRole('status').textContent).toContain('Diffo sends anonymous usage data')
    expect(screen.getByRole('status').textContent).toContain('nothing is during this review')
    expect(screen.getByRole('status').textContent).toContain('Settings → Privacy')
    expect(screen.getByRole('status').textContent).not.toContain('diffo telemetry')
    expect(onShown).toHaveBeenCalledTimes(1)
    const link = screen.getByRole('link', { name: 'What is sent' })
    expect(link.getAttribute('href')).toBe(base.docs)
    expect(link.getAttribute('target')).toBe('_blank')
  })

  it('after the status flips to shown, the first-showing wording stays put', () => {
    const { view } = show(base)
    view.rerender(
      <TelemetryNotice
        status={{ ...base, notice: 'shown' }}
        onShown={() => {}}
        onAcknowledge={() => {}}
      />,
    )
    expect(screen.getByRole('status').textContent).toContain('nothing is during this review')
  })

  it('a later review, notice still undismissed: shown again without the first-time line, not re-recorded', () => {
    const { onShown } = show({ ...base, notice: 'shown' })
    expect(screen.getByRole('status').textContent).not.toContain('nothing is during this review')
    expect(onShown).not.toHaveBeenCalled()
  })

  it('OK acknowledges; the only switch is where the text says it is, not on the card', () => {
    const { onAcknowledge } = show(base)
    fireEvent.click(screen.getByRole('button', { name: 'OK' }))
    expect(onAcknowledge).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('button', { name: 'Turn off' })).toBeNull()
  })

  it('dismisses itself after a dozen seconds in front of the reader', () => {
    vi.useFakeTimers()
    const { onAcknowledge } = show(base)
    act(() => void vi.advanceTimersByTime(NOTICE_AUTO_DISMISS_MS - 1))
    expect(onAcknowledge).not.toHaveBeenCalled()
    act(() => void vi.advanceTimersByTime(1))
    expect(onAcknowledge).toHaveBeenCalledTimes(1)
  })

  it('the ring around OK drains with the clock', () => {
    vi.useFakeTimers()
    show(base)
    const ring = () =>
      Number.parseFloat(
        document.querySelector('.telemetry-notice-ring-left')!.getAttribute('stroke-dashoffset')!,
      )
    const full = 2 * Math.PI * 18
    expect(ring()).toBeCloseTo(0, 1)
    act(() => void vi.advanceTimersByTime(NOTICE_AUTO_DISMISS_MS / 2))
    expect(Math.abs(ring() - full / 2)).toBeLessThan(full * 0.02)
  })

  it('the clock pauses while the pointer is on the card, and in a hidden tab', () => {
    vi.useFakeTimers()
    const { onAcknowledge } = show(base)
    const before = 4_000
    act(() => void vi.advanceTimersByTime(before))
    fireEvent.mouseEnter(screen.getByRole('status'))
    act(() => void vi.advanceTimersByTime(NOTICE_AUTO_DISMISS_MS))
    expect(onAcknowledge).not.toHaveBeenCalled()
    fireEvent.mouseLeave(screen.getByRole('status'))
    // The time spent before the hover still counts; only the rest remains.
    act(() => void vi.advanceTimersByTime(NOTICE_AUTO_DISMISS_MS - before - 1))
    expect(onAcknowledge).not.toHaveBeenCalled()
    act(() => void vi.advanceTimersByTime(1))
    expect(onAcknowledge).toHaveBeenCalledTimes(1)
  })

  it('a background tab does not count as reading', () => {
    vi.useFakeTimers()
    const visibility = vi.spyOn(document, 'visibilityState', 'get')
    visibility.mockReturnValue('hidden')
    const { onAcknowledge } = show(base)
    act(() => void vi.advanceTimersByTime(NOTICE_AUTO_DISMISS_MS * 2))
    expect(onAcknowledge).not.toHaveBeenCalled()
    visibility.mockReturnValue('visible')
    act(() => void document.dispatchEvent(new Event('visibilitychange')))
    act(() => void vi.advanceTimersByTime(NOTICE_AUTO_DISMISS_MS))
    expect(onAcknowledge).toHaveBeenCalledTimes(1)
    visibility.mockRestore()
  })

  it('renders nothing once acknowledged, or when reporting is off', () => {
    show({ ...base, notice: 'acknowledged' })
    expect(screen.queryByRole('status')).toBeNull()
    cleanup()
    const { onShown } = show({ ...base, enabled: false, source: 'env', variable: 'CI' })
    expect(screen.queryByRole('status')).toBeNull()
    expect(onShown).not.toHaveBeenCalled()
  })
})
