// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_VOICE, VOICE_MAX } from '../../shared/voice.js'
import { Voice } from './Voice.js'

afterEach(cleanup)

function show(voice: string | null, ok = true) {
  const onSave = vi.fn(async () => ok)
  const onClose = vi.fn()
  render(<Voice voice={voice} onSave={onSave} onClose={onClose} />)
  const box = screen.getByRole('textbox') as HTMLTextAreaElement
  const save = () => screen.getByRole('button', { name: /^Save/ }) as HTMLButtonElement
  return { onSave, onClose, box, save }
}

describe('Voice', () => {
  it('opens on the default text when nothing is set, with nothing to save yet', () => {
    const { box, save } = show(null)
    expect(box.value).toBe(DEFAULT_VOICE)
    expect(save().disabled).toBe(true)
    expect(screen.getByText('This is the default voice.')).toBeTruthy()
  })

  it('saves an edit, trimmed, and closes once the server took it', async () => {
    const { box, save, onSave, onClose } = show(null)
    fireEvent.change(box, { target: { value: '  Blunt. Short.\n' } })
    expect(save().disabled).toBe(false)
    expect(screen.getByText(/Your own voice/)).toBeTruthy()
    fireEvent.click(save())
    await waitFor(() => expect(onClose).toHaveBeenCalled())
    expect(onSave).toHaveBeenCalledWith('Blunt. Short.')
  })

  it('⌘↵ saves too', async () => {
    const { box, onSave } = show(null)
    fireEvent.change(box, { target: { value: 'Blunt.' } })
    fireEvent.keyDown(box, { key: 'Enter', metaKey: true })
    await waitFor(() => expect(onSave).toHaveBeenCalledWith('Blunt.'))
  })

  it('a failed save stays open and says so', async () => {
    const { box, save, onClose } = show(null, false)
    fireEvent.change(box, { target: { value: 'Blunt.' } })
    fireEvent.click(save())
    await waitFor(() => expect(screen.getByText(/Could not save/)).toBeTruthy())
    expect(onClose).not.toHaveBeenCalled()
  })

  it('opens on the stored voice; Reset puts the default back and saves as a reset', async () => {
    const { box, save, onSave } = show('Blunt.')
    expect(box.value).toBe('Blunt.')
    expect(save().disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Reset to default' }))
    expect(box.value).toBe(DEFAULT_VOICE)
    fireEvent.click(save())
    await waitFor(() => expect(onSave).toHaveBeenCalledWith(null))
  })

  it('an emptied box also means the default', async () => {
    const { box, save, onSave } = show('Blunt.')
    fireEvent.change(box, { target: { value: '  ' } })
    expect(screen.getByText('This is the default voice.')).toBeTruthy()
    fireEvent.click(save())
    await waitFor(() => expect(onSave).toHaveBeenCalledWith(null))
  })

  it('refuses to save past the cap, and counts', () => {
    const { box, save } = show(null)
    fireEvent.change(box, { target: { value: 'x'.repeat(VOICE_MAX + 1) } })
    expect(save().disabled).toBe(true)
    expect(screen.getByText(`${VOICE_MAX + 1} / ${VOICE_MAX}`).className).toContain(
      'voice-count-over',
    )
  })
})
