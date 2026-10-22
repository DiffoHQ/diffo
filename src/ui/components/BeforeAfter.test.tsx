// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BeforeAfterCard } from './BeforeAfter.js'

afterEach(cleanup)

const login = {
  title: 'Expired-token login',
  before: 'Login with an expired token returns a 500.',
  after: 'The same login returns a 401.',
}
const session = { title: 'Session length', before: 'A day.', after: 'Two idle hours.' }
const post = { sections: [login, session], postedAt: '2026-10-22T00:00:00Z' }

describe('BeforeAfterCard', () => {
  it('shows each section under its title, both sides labelled', () => {
    render(<BeforeAfterCard post={post} request={null} agentAttached />)
    expect(screen.getByRole('heading', { name: 'Before / after' })).toBeTruthy()
    expect(screen.getByRole('heading', { name: login.title })).toBeTruthy()
    expect(screen.getByRole('heading', { name: session.title })).toBeTruthy()
    expect(screen.getAllByText('Before')).toHaveLength(2)
    expect(screen.getAllByText('After')).toHaveLength(2)
    expect(screen.getByText(login.before)).toBeTruthy()
    expect(screen.getByText(session.after)).toBeTruthy()
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('with nothing posted, one button asks the agent', () => {
    const onAsk = vi.fn()
    render(<BeforeAfterCard request={null} agentAttached onAsk={onAsk} />)
    fireEvent.click(screen.getByRole('button', { name: /Ask the agent for the before/ }))
    expect(onAsk).toHaveBeenCalled()
  })

  it('queued and writing say where the ask stands, with no button', () => {
    render(<BeforeAfterCard request="queued" agentAttached onAsk={() => {}} />)
    expect(screen.getByText(/finishes the threads/)).toBeTruthy()
    expect(screen.queryByRole('button')).toBeNull()
    cleanup()
    render(<BeforeAfterCard request="writing" agentAttached onAsk={() => {}} />)
    expect(screen.getByText(/The agent is writing it/)).toBeTruthy()
  })

  it('with nobody attached, Invite instead', () => {
    const onInvite = vi.fn()
    render(<BeforeAfterCard request="queued" agentAttached={false} onInvite={onInvite} />)
    expect(screen.getByText('No agent is attached to write it.')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Invite an agent' }))
    expect(onInvite).toHaveBeenCalled()
  })
})
