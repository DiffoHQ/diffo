// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Shortcuts } from './Shortcuts.js'

afterEach(cleanup)

describe('Shortcuts', () => {
  it('surfaces the shortcuts that nothing surfaced before', () => {
    render(<Shortcuts onClose={() => {}} />)
    const keys = [...document.querySelectorAll('.keys-row .kbd')].map((k) => k.textContent)
    expect(keys).toEqual([
      'j',
      'k',
      'J',
      'K',
      'n',
      '/',
      'v',
      'h',
      'u',
      'o',
      'b',
      'c',
      'drag ↓',
      '⇧ click',
      '⌘↵',
      'esc',
      '?',
    ])
    expect(screen.getByText('Move')).toBeTruthy()
    expect(screen.getByText('Read')).toBeTruthy()
    expect(screen.getByText('Comment')).toBeTruthy()
    expect(screen.getByText('Show / hide the file list')).toBeTruthy()
  })

  it('has a way out — the sheet is not a trap', () => {
    const onClose = vi.fn()
    render(<Shortcuts onClose={onClose} />)
    fireEvent.click(screen.getByLabelText('Close'))
    fireEvent.keyDown(document.querySelector('.modal')!, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(2)
  })
})
