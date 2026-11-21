// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LeftPanel } from './LeftPanel.js'

afterEach(cleanup)

const panel = (over: Partial<Parameters<typeof LeftPanel>[0]> = {}) =>
  render(
    <LeftPanel
      view="files"
      onSetView={vi.fn()}
      fileCount={14}
      threadCount={3}
      layers={<div data-testid="layers" />}
      files={<div data-testid="files" />}
      commits={<div data-testid="commits" />}
      threads={<div data-testid="threads" />}
      {...over}
    />,
  )

const tabNames = () => screen.getAllByRole('tab').map((t) => t.textContent?.trim())

describe('LeftPanel — the reading plan', () => {
  it('leads with Layers, which carries no count without layers', () => {
    panel()
    expect(tabNames()).toEqual(['Layers', 'Files 14', 'Threads 3'])
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

  it('offers Commits only when the branch has some to step through', () => {
    const { unmount } = panel()
    expect(screen.queryByRole('tab', { name: /Commits/ })).toBeNull()
    unmount()
    panel({ commitCount: 4 })
    expect(tabNames()).toEqual(['Layers', 'Files 14', 'Threads 3', 'Commits 4'])
  })

  it('lists the threads in a tab of their own, with a dot when one waits on you', () => {
    const { unmount } = panel({ view: 'threads' })
    expect(screen.getByTestId('threads')).toBeTruthy()
    expect(screen.getByRole('tab', { name: /Threads/ }).querySelector('.tab-dot')).toBeNull()
    unmount()
    panel({ wantsYou: 2 })
    expect(screen.getByRole('tab', { name: /Threads/ }).querySelector('.tab-dot')).toBeTruthy()
  })

  it('shows one body at a time, and reports the switch', () => {
    const onSetView = vi.fn()
    const { unmount } = panel({ onSetView, commitCount: 2 })
    expect(screen.getByTestId('files')).toBeTruthy()
    expect(screen.queryByTestId('layers')).toBeNull()
    fireEvent.click(screen.getByRole('tab', { name: /Layers/ }))
    expect(onSetView).toHaveBeenCalledWith('layers')
    fireEvent.click(screen.getByRole('tab', { name: /Commits/ }))
    expect(onSetView).toHaveBeenCalledWith('commits')
    unmount()
    panel({ view: 'layers' })
    expect(screen.getByTestId('layers')).toBeTruthy()
    expect(screen.queryByTestId('files')).toBeNull()
    cleanup()
    panel({ view: 'commits', commitCount: 2 })
    expect(screen.getByTestId('commits')).toBeTruthy()
  })
})
