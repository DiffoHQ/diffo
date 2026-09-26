// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LayersEmpty } from './LayersEmpty.js'

afterEach(cleanup)

describe('LayersEmpty', () => {
  it('quiet: a title, one line, and the one action', () => {
    const onOutline = vi.fn()
    render(<LayersEmpty state="quiet" onOutline={onOutline} />)
    expect(screen.getByRole('heading', { name: 'Read in layers' })).toBeTruthy()
    expect(screen.getByText(/steps you read in order/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /Ask the agent to outline/ }))
    expect(onOutline).toHaveBeenCalled()
  })

  it('outlining: no button — the agent is writing them', () => {
    render(<LayersEmpty state="outlining" onOutline={() => {}} />)
    expect(screen.getByRole('heading', { name: /Outlining…/ })).toBeTruthy()
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('queued: says the ask is parked behind the open threads, not being written', () => {
    render(<LayersEmpty state="queued" onOutline={() => {}} />)
    expect(screen.getByRole('heading', { name: /Asked/ })).toBeTruthy()
    expect(screen.getByText(/once it finishes the threads/)).toBeTruthy()
    expect(screen.queryByText(/Outlining/)).toBeNull()
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('noagent: nobody to ask, so Invite instead', () => {
    const onInvite = vi.fn()
    render(<LayersEmpty state="noagent" onOutline={() => {}} onInvite={onInvite} />)
    expect(screen.getByText('No agent is attached to outline it.')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Ask the agent/ })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Invite an agent' }))
    expect(onInvite).toHaveBeenCalled()
  })
})
