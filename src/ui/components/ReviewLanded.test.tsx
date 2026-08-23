// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ReviewLanded } from './ReviewLanded.js'

afterEach(cleanup)

const notice = (over: Partial<Parameters<typeof ReviewLanded>[0]> = {}) => ({
  sha: 'abc1234def',
  subject: 'ship the thing',
  threads: 3,
  onClear: vi.fn().mockResolvedValue(undefined),
  onDismiss: vi.fn(),
  shape: 'full' as const,
  ...over,
})

describe('ReviewLanded', () => {
  it('names the commit and the honest cost of clearing, and only acts on the click', () => {
    const props = notice()
    render(<ReviewLanded {...props} />)

    const text = document.body.textContent!
    expect(text).toContain('abc1234')
    expect(text).not.toContain('abc1234def') // short sha, not the whole thing
    expect(text).toContain('ship the thing')
    expect(props.onClear).not.toHaveBeenCalled()

    fireEvent.click(screen.getByText('Start fresh — clear 3 threads'))
    expect(props.onClear).toHaveBeenCalled()
  })

  it('"Keep them" dismisses without clearing', () => {
    const props = notice()
    render(<ReviewLanded {...props} />)
    fireEvent.click(screen.getByText('Keep them'))
    expect(props.onDismiss).toHaveBeenCalled()
    expect(props.onClear).not.toHaveBeenCalled()
  })

  it('a failed clear says nothing was deleted and re-arms the button', async () => {
    const props = notice({ onClear: vi.fn().mockRejectedValue(new Error('down')) })
    render(<ReviewLanded {...props} />)
    fireEvent.click(screen.getByText('Start fresh — clear 3 threads'))
    await waitFor(() => expect(screen.getByText(/Nothing was deleted/)).toBeTruthy())
    expect((screen.getByText('Start fresh — clear 3 threads') as HTMLButtonElement).disabled).toBe(
      false,
    )
  })

  it('the docked banner offers the same clear over a new changeset', () => {
    const props = notice({ shape: 'docked' as const, threads: 1 })
    render(<ReviewLanded {...props} />)
    expect(document.querySelector('.landed-card')).toBeTruthy()
    fireEvent.click(screen.getByText('Start fresh — clear the thread'))
    expect(props.onClear).toHaveBeenCalled()
  })
})
