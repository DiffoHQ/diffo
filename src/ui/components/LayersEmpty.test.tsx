// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LayersEmpty } from './LayersEmpty.js'

afterEach(cleanup)

describe('LayersEmpty', () => {
  it('quiet: says there are none, and offers the one action', () => {
    const onOutline = vi.fn()
    render(<LayersEmpty state="quiet" onOutline={onOutline} />)
    expect(screen.getByText('Read this change in layers.')).toBeTruthy()
    // The feature explains itself, shows an example, then asks for a click.
    expect(screen.getByText(/reading plan/)).toBeTruthy()
    expect(screen.getByText('Example')).toBeTruthy()
    const button = screen.getByRole('button', { name: /Ask the agent to outline this/ })
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
    expect(screen.getByRole('button', { name: /Ask the agent/ }).className).toContain('btn-primary')
  })

  it('suggested without a reason still argues for the button', () => {
    render(<LayersEmpty state="suggested" onOutline={() => {}} />)
    expect(screen.getByText('The agent suggests reading this in layers.')).toBeTruthy()
    expect(screen.getByRole('button', { name: /Ask the agent/ })).toBeTruthy()
    expect(screen.queryByText(/“/)).toBeNull()
  })

  it('working: no button — the agent is writing them', () => {
    render(<LayersEmpty state="working" onOutline={() => {}} />)
    expect(screen.getByText(/The agent is outlining…/)).toBeTruthy()
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('noagent: nobody to ask, so Invite instead', () => {
    const onInvite = vi.fn()
    render(<LayersEmpty state="noagent" onOutline={() => {}} onInvite={onInvite} />)
    expect(screen.getByText('No session attached.')).toBeTruthy()
    expect(screen.getByText(/reading plan/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Ask the agent/ })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Invite an agent' }))
    expect(onInvite).toHaveBeenCalled()
  })
})
