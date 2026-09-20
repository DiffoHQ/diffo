// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LayersEmpty } from './LayersEmpty.js'

afterEach(cleanup)

describe('LayersEmpty', () => {
  it('quiet: says there are none, and offers the one action', () => {
    const onOutline = vi.fn()
    render(<LayersEmpty state="quiet" onOutline={onOutline} />)
    expect(screen.getByText('No layers yet.')).toBeTruthy()
    const button = screen.getByRole('button', { name: /Outline in layers/ })
    expect(button.className).not.toContain('btn-primary')
    fireEvent.click(button)
    expect(onOutline).toHaveBeenCalled()
  })

  it('suggested: quotes the agent’s reason next to a primary button', () => {
    render(
      <LayersEmpty state="suggested" reason="the parser explains the rest" onOutline={() => {}} />,
    )
    expect(screen.getByText('The agent suggests reading this in layers.')).toBeTruthy()
    expect(screen.getByText('“the parser explains the rest”')).toBeTruthy()
    expect(screen.getByRole('button', { name: /Outline in layers/ }).className).toContain(
      'btn-primary',
    )
  })

  it('suggested without a reason still argues for the button', () => {
    render(<LayersEmpty state="suggested" onOutline={() => {}} />)
    expect(screen.getByText('The agent suggests reading this in layers.')).toBeTruthy()
    expect(screen.getByText(/can outline it as steps/)).toBeTruthy()
  })

  it('working: no button — the agent is writing them', () => {
    render(<LayersEmpty state="working" onOutline={() => {}} />)
    expect(screen.getByText(/Outlining…/)).toBeTruthy()
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('noagent: nobody to ask, so Invite instead', () => {
    const onInvite = vi.fn()
    render(<LayersEmpty state="noagent" onOutline={() => {}} onInvite={onInvite} />)
    expect(screen.getByText('No session attached.')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Outline/ })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Invite' }))
    expect(onInvite).toHaveBeenCalled()
  })
})
