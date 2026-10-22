// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LayerSource } from './LayerSource.js'

afterEach(cleanup)

describe('LayerSource', () => {
  it('lights the picked source and carries the counts', () => {
    const onPick = vi.fn()
    render(<LayerSource source="commits" onPick={onPick} stepCount={3} commitCount={5} />)
    const [steps, commits] = screen.getAllByRole('radio')
    expect(steps!.getAttribute('aria-checked')).toBe('false')
    expect(commits!.getAttribute('aria-checked')).toBe('true')
    expect(steps!.textContent).toBe('Steps 3')
    expect(commits!.textContent).toBe('Commits 5')
    fireEvent.click(steps!)
    expect(onPick).toHaveBeenCalledWith('steps')
  })

  it('shows no step count before the agent has outlined', () => {
    render(<LayerSource source="commits" onPick={vi.fn()} stepCount={null} commitCount={2} />)
    expect(screen.getByRole('radio', { name: /Steps/ }).querySelector('.tab-n')).toBeNull()
  })
})
