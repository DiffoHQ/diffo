// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fixturePr } from '../../forge/fixture.js'
import { PrContext } from '../prMode.js'
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

    fireEvent.click(screen.getByText('Start fresh: clear 3 threads'))
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
    fireEvent.click(screen.getByText('Start fresh: clear 3 threads'))
    await waitFor(() => expect(screen.getByText(/Nothing was deleted/)).toBeTruthy())
    expect((screen.getByText('Start fresh: clear 3 threads') as HTMLButtonElement).disabled).toBe(
      false,
    )
  })

  it('the docked banner offers the same clear over a new changeset', () => {
    const props = notice({ shape: 'docked' as const, threads: 1 })
    render(<ReviewLanded {...props} />)
    expect(document.querySelector('.landed-card')).toBeTruthy()
    fireEvent.click(screen.getByText('Start fresh: clear the thread'))
    expect(props.onClear).toHaveBeenCalled()
  })

  it('on a merged pull request it speaks of the PR, not a previous review', () => {
    const props = notice({ shape: 'docked' as const, threads: 12 })
    const pr = { ...fixturePr(), state: 'merged' as const }
    render(
      <PrContext.Provider value={pr}>
        <ReviewLanded {...props} />
      </PrContext.Provider>,
    )
    const strip = document.querySelector('.landed-strip-merged')!
    const text = strip.textContent!
    expect(text).toContain('Merged as abc1234')
    expect(text).toContain('comments still post to GitHub')
    // One line: the state is the header chip's job, the checkout is the tooltip's.
    expect(text).not.toContain('drops the checkout')
    expect(text).not.toContain('previous review')
    expect(text).not.toContain('new changeset')
    expect(strip.querySelector('.landed-seal')).toBeNull()
    const clear = screen.getByText('Clear 12 threads')
    expect(clear.getAttribute('title')).toContain('drops the checkout')
    fireEvent.click(clear)
    expect(props.onClear).toHaveBeenCalled()
  })

  it('a closed pull request says so without a merge sha', () => {
    const pr = { ...fixturePr(), state: 'closed' as const }
    render(
      <PrContext.Provider value={pr}>
        <ReviewLanded {...notice()} />
      </PrContext.Provider>,
    )
    expect(document.body.textContent).toContain('Closed without merging')
    expect(screen.getByText('This pull request closed')).toBeTruthy()
  })

  it('a closed pull request, docked, is a red line', () => {
    const pr = { ...fixturePr(), state: 'closed' as const }
    render(
      <PrContext.Provider value={pr}>
        <ReviewLanded {...notice({ shape: 'docked' as const })} />
      </PrContext.Provider>,
    )
    const strip = document.querySelector('.landed-strip-closed')!
    expect(strip.textContent).toContain('Closed without merging')
    fireEvent.click(screen.getByLabelText('Keep the review as it is'))
  })
})
