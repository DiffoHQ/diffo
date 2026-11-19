// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { StarBubble } from './StarAsk.js'

afterEach(cleanup)

describe('StarBubble', () => {
  it('links to the repo in a new tab; following it ends the ask and cheers', () => {
    const ask = { onStar: vi.fn(), onDismiss: vi.fn() }
    const cheer = vi.fn()
    render(<StarBubble ask={ask} onStar={cheer} />)
    const link = screen.getByText('Star on GitHub').closest('a')!
    expect(link.getAttribute('href')).toBe('https://github.com/DiffoHQ/diffo')
    expect(link.getAttribute('target')).toBe('_blank')
    fireEvent.click(link)
    expect(cheer).toHaveBeenCalledTimes(1)
    expect(ask.onStar).toHaveBeenCalledTimes(1)
    expect(ask.onDismiss).not.toHaveBeenCalled()
  })

  it('Not now ends it without a star', () => {
    const ask = { onStar: vi.fn(), onDismiss: vi.fn() }
    render(<StarBubble ask={ask} />)
    fireEvent.click(screen.getByLabelText('Not now'))
    expect(ask.onDismiss).toHaveBeenCalledTimes(1)
    expect(ask.onStar).not.toHaveBeenCalled()
  })
})
