// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LayersEmpty } from './LayersEmpty.js'

afterEach(cleanup)

// The picker reads "Layer by <name>": the name is what a pick changes.
const pickName = () => document.querySelector('.la-pick-name')?.textContent

describe('LayersEmpty', () => {
  it('quiet: one line and the one action; the tab is the title', () => {
    const onOutline = vi.fn()
    render(<LayersEmpty state="quiet" onOutline={onOutline} />)
    expect(screen.queryByRole('heading')).toBeNull()
    expect(document.querySelector('.ch-empty')?.textContent).toBe(
      'The agent groups related changes into layers, so you review one idea at a time.Ask the agent for layers',
    )
    // No presets to pick from: no picker, and the ask names none.
    expect(document.querySelector('.la-by')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /Ask the agent for layers/ }))
    expect(onOutline).toHaveBeenCalledWith(undefined)
  })

  it('quiet, with presets: "Layer by" opens on the default, and the ask carries the pick', () => {
    const onOutline = vi.fn()
    const onManagePresets = vi.fn()
    render(
      <LayersEmpty
        state="quiet"
        onOutline={onOutline}
        presets={[
          { id: 'concept', name: 'Concept' },
          { id: 'importance', name: 'Importance' },
        ]}
        defaultPreset="importance"
        onManagePresets={onManagePresets}
      />,
    )
    const picker = screen.getByRole('button', { name: 'What the layers are for' })
    expect(pickName()).toBe('Importance')
    fireEvent.click(screen.getByRole('button', { name: /Ask the agent for layers/ }))
    expect(onOutline).toHaveBeenLastCalledWith({ preset: 'importance' })
    fireEvent.click(picker)
    expect(
      [...document.querySelectorAll('.menu-panel .menu-item')].map((i) => i.textContent),
    ).toEqual([
      'Let the agent choose',
      'Concept',
      'Importance',
      'One-time instructions',
      'Manage presets',
    ])
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Let the agent choose' }))
    expect(pickName()).toBe('Let the agent choose')
    fireEvent.click(screen.getByRole('button', { name: /Ask the agent for layers/ }))
    expect(onOutline).toHaveBeenLastCalledWith({ preset: 'agent' })
    // What the pick gives is a tooltip on it, not a line; the note on top of
    // the pick is one link away, under the button, and rides with the ask.
    expect(document.querySelector('.la-desc')).toBeNull()
    expect(picker.getAttribute('data-tip')).toBe(
      'The agent picks the preset that fits this change.',
    )
    expect(document.querySelector('.la-note-input')).toBeNull()
    expect(
      screen.getByRole('button', { name: /Ask the agent for layers/ }).nextElementSibling
        ?.textContent,
    ).toBe('Add instructions')
    // Instructions for this change are written in the ask sheet, opened on the
    // pick in view; closing it leaves the tab as it was.
    fireEvent.click(screen.getByRole('button', { name: 'Add instructions' }))
    const sheet = screen.getByRole('dialog', { name: 'Ask for layers' })
    expect(sheet.querySelector('.la-pick-name')?.textContent).toBe('Let the agent choose')
    fireEvent.click(within(sheet).getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.querySelector('.la-note-input')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Add instructions' }))
    fireEvent.change(screen.getByLabelText('For this change only (optional)'), {
      target: { value: ' tests in background ' },
    })
    fireEvent.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: 'Ask for layers' }),
    )
    expect(onOutline).toHaveBeenLastCalledWith({ preset: 'agent', note: 'tests in background' })
    expect(screen.queryByRole('dialog')).toBeNull()
    // The presets dialog is the last item of the picker's menu.
    fireEvent.click(picker)
    fireEvent.click(screen.getByRole('menuitem', { name: 'Manage presets' }))
    expect(onManagePresets).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('button', { name: 'Manage presets' })).toBeNull()
  })

  it('one-time instructions: no preset, and the ask waits for the words', () => {
    const onOutline = vi.fn()
    render(
      <LayersEmpty
        state="quiet"
        onOutline={onOutline}
        presets={[{ id: 'concept', name: 'Concept' }]}
      />,
    )
    // In the tab it is an action, not a pick: it opens the ask sheet on
    // one-time instructions, and the tab's own picker stays where it was.
    fireEvent.click(screen.getByRole('button', { name: 'What the layers are for' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'One-time instructions' }))
    const sheet = screen.getByRole('dialog', { name: 'Ask for layers' })
    expect(sheet.querySelector('.la-pick-name')?.textContent).toBe('One-time instructions')
    expect(pickName()).toBe('Let the agent choose')
    const cta = within(sheet).getByRole('button', { name: 'Ask for layers' }) as HTMLButtonElement
    expect(cta.disabled).toBe(true)
    fireEvent.change(screen.getByLabelText('Your instructions for this change'), {
      target: { value: 'only the database changes' },
    })
    expect(cta.disabled).toBe(false)
    fireEvent.click(cta)
    expect(onOutline).toHaveBeenLastCalledWith({ preset: null, note: 'only the database changes' })
  })

  const two = [
    { id: 'concept', name: 'Concept' },
    { id: 'importance', name: 'Importance' },
  ]

  it('the agent’s suggested preset is where the picker opens, with its reason', () => {
    const onOutline = vi.fn()
    render(
      <LayersEmpty
        state="quiet"
        onOutline={onOutline}
        presets={two}
        suggested={{ preset: two[1]!, reason: '38 files, mostly implementation' }}
      />,
    )
    const picker = screen.getByRole('button', { name: 'What the layers are for' })
    expect(pickName()).toBe('Importance')
    expect(document.querySelector('.la-suggest')?.textContent).toBe(
      'Suggested by the agent: 38 files, mostly implementation',
    )
    fireEvent.click(screen.getByRole('button', { name: /Ask the agent for layers/ }))
    expect(onOutline).toHaveBeenLastCalledWith({ preset: 'importance' })
    // Picked away from it: the suggestion stays, as a line to take. The menu
    // marks the one the agent suggested.
    fireEvent.click(picker)
    expect(
      [...document.querySelectorAll('.la-pick-tag')].map((t) => t.parentElement?.textContent),
    ).toEqual(['Importancesuggested'])
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Concept' }))
    fireEvent.click(screen.getByRole('button', { name: 'The agent suggests Importance' }))
    expect(pickName()).toBe('Importance')
  })

  it('a default of the reviewer’s own stands: the suggestion is a line to take', () => {
    render(
      <LayersEmpty
        state="quiet"
        onOutline={() => {}}
        presets={two}
        defaultPreset="concept"
        suggested={{ preset: two[1]! }}
      />,
    )
    expect(pickName()).toBe('Concept')
    fireEvent.click(screen.getByRole('button', { name: 'The agent suggests Importance' }))
    expect(pickName()).toBe('Importance')
    expect(document.querySelector('.la-suggest')?.textContent).toBe('Suggested by the agent')
  })

  it('a suggestion that lands after the tab is open moves the picker, unless it was touched', () => {
    const { rerender } = render(<LayersEmpty state="quiet" onOutline={() => {}} presets={two} />)
    expect(pickName()).toBe('Let the agent choose')
    rerender(
      <LayersEmpty
        state="quiet"
        onOutline={() => {}}
        presets={two}
        suggested={{ preset: two[1]! }}
      />,
    )
    expect(pickName()).toBe('Importance')
  })

  it('a default set while the tab is open moves the picker, unless it was touched', () => {
    const tab = (defaultPreset: string) => (
      <LayersEmpty
        state="quiet"
        onOutline={() => {}}
        presets={two}
        defaultPreset={defaultPreset}
        suggested={{ preset: two[1]! }}
      />
    )
    // No default: the suggestion. The reviewer makes Concept their default
    // in the presets dialog, and the tab under it follows.
    const { rerender } = render(tab('agent'))
    expect(pickName()).toBe('Importance')
    rerender(tab('concept'))
    expect(pickName()).toBe('Concept')
    expect(screen.getByRole('button', { name: 'The agent suggests Importance' })).toBeTruthy()
    // A pick of their own is not moved by a later default.
    fireEvent.click(screen.getByRole('button', { name: 'What the layers are for' }))
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Let the agent choose' }))
    rerender(tab('importance'))
    expect(pickName()).toBe('Let the agent choose')
  })

  it('a default that is no longer on falls back to the agent’s choice', () => {
    render(
      <LayersEmpty
        state="quiet"
        onOutline={() => {}}
        presets={[{ id: 'concept', name: 'Concept' }]}
        defaultPreset="gone"
      />,
    )
    expect(pickName()).toBe('Let the agent choose')
  })

  it('outlining: no button — the agent is writing them', () => {
    render(<LayersEmpty state="outlining" onOutline={() => {}} />)
    expect(screen.getByRole('heading', { name: /Layering…/ })).toBeTruthy()
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('queued: says the ask is parked behind the open threads, not being written', () => {
    render(<LayersEmpty state="queued" onOutline={() => {}} />)
    expect(screen.getByRole('heading', { name: /Asked/ })).toBeTruthy()
    expect(screen.getByText(/once it finishes the threads/)).toBeTruthy()
    expect(screen.queryByText(/Layering/)).toBeNull()
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('stalled: says the post never came and why it might not have, and gives the action back', () => {
    const onOutline = vi.fn()
    render(<LayersEmpty state="stalled" onOutline={onOutline} />)
    expect(screen.getByRole('heading', { name: 'No layers yet' })).toBeTruthy()
    expect(screen.getByText(/harness may have refused/)).toBeTruthy()
    expect(screen.queryByText(/Layering/)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /Ask again/ }))
    expect(onOutline).toHaveBeenCalled()
  })

  it('noagent: nobody to ask, so Invite instead', () => {
    const onInvite = vi.fn()
    render(<LayersEmpty state="noagent" onOutline={() => {}} onInvite={onInvite} />)
    expect(screen.getByText('No agent is attached to layer it.')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Ask the agent/ })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Invite an agent' }))
    expect(onInvite).toHaveBeenCalled()
  })
})
