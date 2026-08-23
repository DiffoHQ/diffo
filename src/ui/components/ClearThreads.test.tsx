// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ClearThreads } from './ClearThreads.js'

afterEach(cleanup)

describe('ClearThreads', () => {
  it('names what goes, including the hidden ones, before it destroys anything', () => {
    const onClear = vi.fn().mockResolvedValue(undefined)
    render(<ClearThreads total={7} past={5} onClear={onClear} onClose={() => {}} />)

    const body = document.querySelector('.modal-body')!.textContent!
    expect(body).toContain('7 in total')
    expect(body).toContain('5 of which are hidden')
    expect(body).toContain('2 still on the current changeset')
    expect(onClear).not.toHaveBeenCalled()

    fireEvent.click(screen.getByText('Delete 7 threads'))
    expect(onClear).toHaveBeenCalled()
  })

  it('a failed clear keeps the dialog open and says nothing was deleted', async () => {
    const onClose = vi.fn()
    render(
      <ClearThreads
        total={1}
        past={0}
        onClear={() => Promise.reject(new Error('server down'))}
        onClose={onClose}
      />,
    )
    fireEvent.click(screen.getByText('Delete 1 thread'))
    await waitFor(() => expect(screen.getByText(/Nothing was deleted/)).toBeTruthy())
    expect(onClose).not.toHaveBeenCalled()
  })
})
