// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TelemetryStatus } from '../telemetry.js'
import { Privacy } from './Privacy.js'

afterEach(cleanup)

const on: TelemetryStatus = {
  enabled: true,
  source: 'default',
  notice: 'acknowledged',
  machineId: 'abc',
  dev: false,
  docs: 'https://diffohq.github.io/diffo/telemetry',
}

function show(status: TelemetryStatus) {
  const onSetEnabled = vi.fn()
  const onClose = vi.fn()
  render(<Privacy status={status} onSetEnabled={onSetEnabled} onClose={onClose} />)
  return { onSetEnabled, onClose }
}

describe('Privacy', () => {
  it('turning off asks once: Keep sharing changes nothing, Turn off does', () => {
    const { onSetEnabled } = show(on)
    const sw = screen.getByRole('switch', { name: /Share anonymous usage data/ })
    expect(sw.getAttribute('aria-checked')).toBe('true')
    fireEvent.click(sw)
    expect(screen.getByText('Stop sharing?')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Keep sharing' }))
    expect(onSetEnabled).not.toHaveBeenCalled()
    expect(screen.queryByText('Stop sharing?')).toBeNull()
    fireEvent.click(sw)
    fireEvent.click(screen.getByRole('button', { name: 'Turn off' }))
    expect(onSetEnabled).toHaveBeenCalledWith(false)
  })

  it('turning on is immediate', () => {
    const { onSetEnabled } = show({ ...on, enabled: false, source: 'setting', machineId: null })
    fireEvent.click(screen.getByRole('switch'))
    expect(onSetEnabled).toHaveBeenCalledWith(true)
    expect(screen.queryByText('Stop sharing?')).toBeNull()
  })

  it('an environment variable locks the switch and is named', () => {
    const { onSetEnabled } = show({
      ...on,
      enabled: false,
      source: 'env',
      variable: 'DO_NOT_TRACK',
      machineId: null,
    })
    const sw = screen.getByRole('switch') as HTMLButtonElement
    expect(sw.disabled).toBe(true)
    fireEvent.click(sw)
    expect(onSetEnabled).not.toHaveBeenCalled()
    expect(screen.getByText(/DO_NOT_TRACK is set/)).toBeTruthy()
  })

  it('links the full list', () => {
    show(on)
    expect(screen.getByRole('link', { name: 'What is sent' }).getAttribute('href')).toBe(on.docs)
  })
})
