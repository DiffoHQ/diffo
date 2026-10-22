// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LeftPanel } from './LeftPanel.js'

afterEach(cleanup)

const panel = (over: Partial<Parameters<typeof LeftPanel>[0]> = {}) =>
  render(
    <LeftPanel
      tab="files"
      onSetTab={vi.fn()}
      fileCount={14}
      threadCount={3}
      wantsYou={0}
      layers={<div data-testid="layers" />}
      files={<div data-testid="files" />}
      threads={<div data-testid="threads" />}
      {...over}
    />,
  )

describe('LeftPanel — the Layers tab', () => {
  it('is always present, last, and carries no count without layers', () => {
    panel()
    const tabs = screen.getAllByRole('tab').map((t) => t.textContent?.trim())
    expect(tabs[0]).toMatch(/^Files/)
    expect(tabs[1]).toMatch(/^Threads/)
    expect(tabs[2]).toBe('Layers')
    expect(screen.getByRole('tab', { name: /Layers/ }).querySelector('.tab-n')).toBeNull()
  })

  it('carries the count once layers exist', () => {
    panel({ layerCount: 6 })
    expect(screen.getByRole('tab', { name: /Layers/ }).textContent).toContain('6')
  })

  it('an amber dot marks a standing suggestion, and goes once layers are posted', () => {
    const { unmount } = panel({ layersSuggested: true })
    expect(screen.getByRole('tab', { name: /Layers/ }).querySelector('.tab-dot')).toBeTruthy()
    unmount()
    panel({ layersSuggested: true, layerCount: 2 })
    expect(screen.getByRole('tab', { name: /Layers/ }).querySelector('.tab-dot')).toBeNull()
  })

  it('shows its body when selected, and reports the switch', () => {
    const onSetTab = vi.fn()
    const { unmount } = panel({ onSetTab })
    expect(screen.queryByTestId('layers')).toBeNull()
    fireEvent.click(screen.getByRole('tab', { name: /Layers/ }))
    expect(onSetTab).toHaveBeenCalledWith('layers')
    unmount()
    panel({ tab: 'layers' })
    expect(screen.getByTestId('layers')).toBeTruthy()
    expect(screen.queryByTestId('files')).toBeNull()
  })
})
