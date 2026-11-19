// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  AGENT_PICKS,
  DEFAULT_PRESET_SETTINGS,
  type LayersPresetSettings,
  type PresetMessage,
} from '../../shared/presets.js'
import { notifyPresetsChanged } from '../presetsPref.js'
import { LayersPresets, type PresetsReview } from './LayersPresets.js'

afterEach(cleanup)

const mine = {
  id: 'mine1',
  name: 'Data and storage',
  blurb: 'types and keys',
  whenToUse: 'stored state',
  instructions: 'type files whole',
  builtIn: false,
}

const at = new Date().toISOString()

/** The conversations the server would hold, and what the dialog posted. */
let threads: Record<string, PresetMessage[]>
let posted: Array<[string, unknown]>
beforeEach(() => {
  threads = {}
  posted = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const id = decodeURIComponent(url.split('/')[3] ?? '')
      if (init?.method === 'DELETE') {
        posted.push([`DELETE ${url}`, null])
        threads[id] = []
        return new Response(
          JSON.stringify({ cleared: true, thread: { presetId: id, messages: [] } }),
        )
      }
      if (init?.method === 'POST') {
        const body = JSON.parse(String(init.body)) as { text: string }
        posted.push([url, body])
        const message = {
          id: `m${posted.length}`,
          author: 'reviewer' as const,
          text: body.text,
          at,
        }
        threads[id] = [...(threads[id] ?? []), message]
        return new Response(
          JSON.stringify({ message, thread: { presetId: id, messages: threads[id] } }),
        )
      }
      return new Response(JSON.stringify({ thread: { presetId: id, messages: threads[id] ?? [] } }))
    }),
  )
})
afterEach(() => vi.unstubAllGlobals())

function mount(settings: LayersPresetSettings, review?: PresetsReview) {
  const saves: LayersPresetSettings[] = []
  const onSave = vi.fn(async (next: LayersPresetSettings) => {
    saves.push(next)
    return true
  })
  const onClose = vi.fn()
  const view = render(
    <LayersPresets settings={settings} onSave={onSave} review={review} onClose={onClose} />,
  )
  return { saves, onSave, onClose, view }
}

const button = (name: string | RegExp) => screen.getByRole('button', { name })
const pick = (name: string | RegExp) => fireEvent.click(button(name))
// What can be done to the preset in view sits behind its "more".
const option = (name: string) => {
  fireEvent.click(screen.getByRole('button', { name: 'Preset options' }))
  return screen.getByRole('menuitem', { name }) as HTMLButtonElement
}
const choose = (name: string) => fireEvent.click(option(name))
const closeMenu = () => fireEvent.keyDown(document, { key: 'Escape' })
const tags = () => [...document.querySelectorAll('.lp-dhead-tags > *')].map((t) => t.textContent)
// The form is one press away: Manual edit, on a preset of yours or a new one.
const openFields = (name: string | RegExp) => fireEvent.click(screen.getByRole('button', { name }))
const cards = () => [...document.querySelectorAll('.lp-row:not(.lp-row-new)')]
const cardNames = () => cards().map((r) => r.querySelector('.lp-row-name')?.textContent)
const title = () => document.querySelector('.lp-title')?.textContent
const field = (label: string) =>
  screen.getByLabelText(label) as HTMLInputElement | HTMLTextAreaElement
const messages = () => [
  ...document.querySelectorAll('.thread-message:not(.thread-message-pending)'),
]

const reviewCtx = (over: Partial<PresetsReview> = {}): PresetsReview => ({
  agentAttached: true,
  onUse: vi.fn(),
  ...over,
})

describe('LayersPresets', () => {
  it('lists the agent, the built-ins and yours as cards; a click shows one, a badge marks the default', () => {
    mount({ presets: [mine], disabled: ['importance'], default: 'mine1' })
    // The agent's own card says what it picks from: the enabled ones, each
    // with when it is the pick.
    expect([...document.querySelectorAll('.lp-pick-name')].map((n) => n.textContent)).toEqual([
      'Concept',
      'Data and storage',
    ])
    expect(document.querySelectorAll('.lp-pick-when')[1]?.textContent).toBe('stored state')
    expect(cardNames()).toEqual([
      'Let the agent choose',
      'Concept',
      'Importancedisabled',
      'Data and storagedefault',
    ])
    expect(cards()[1]?.querySelector('.lp-row-sub')?.textContent).toBe(
      'one idea per layer, in the order the change was built',
    )
    expect(cards()[2]?.className).toContain('lp-row-off')
    // A card is one button: nothing on it but its name, its line and its badge.
    expect(document.querySelector('.lp-row input')).toBeNull()
    // The card in view is marked; which one is the default is a different thing.
    expect(cards()[0]?.getAttribute('aria-current')).toBe('true')
    pick(/^Concept/)
    expect(cards()[0]?.getAttribute('aria-current')).toBeNull()
    expect(cards()[1]?.getAttribute('aria-current')).toBe('true')
    expect(cardNames()[3]).toBe('Data and storagedefault')
  })

  it('a preset opens on what it says, with the conversation attached under it; one menu holds what can be done', async () => {
    const { saves } = mount({ presets: [mine], disabled: [], default: 'agent' })
    pick(/^Importance/)
    expect(title()).toBe('Importance')
    expect(tags()).toEqual(['Built in'])
    expect(document.querySelector('.lp-dsub')?.textContent).toBe(
      'The lines that matter most; the rest in background.',
    )
    // It reads as text, not a form: when to use it, and what the agent is
    // told, which opens on its first lines.
    expect(document.querySelector('.lp-fields')).toBeNull()
    expect([...document.querySelectorAll('.lp-fact-cap')].map((c) => c.textContent)).toEqual([
      'Use it when',
      'What the agent is told',
    ])
    const told = () => document.querySelectorAll('.lp-fro')[1]!
    expect(told().className).toContain('lp-clamp')
    pick('Show all')
    expect(told().className).not.toContain('lp-clamp')
    pick('Show less')
    expect(told().className).toContain('lp-clamp')
    // The conversation is part of the same card, named for what it does here.
    const card = document.querySelector('.lp-card')!
    expect(card.querySelector('.lp-facts')).toBeTruthy()
    expect(card.querySelector('.lp-card-thread .cbox-title')?.textContent).toBe(
      'Want it different? Ask your agent',
    )
    expect(screen.getByLabelText('Tell the agent what to change')).toBeTruthy()
    choose('Make default')
    await waitFor(() => expect(saves).toHaveLength(1))
    expect(saves[0]?.default).toBe('importance')
    choose('Disable')
    await waitFor(() => expect(saves).toHaveLength(2))
    expect(saves[1]?.disabled).toEqual(['importance'])
    // Without a review there is nothing to outline.
    expect(document.querySelector('.lp-bar')).toBeNull()
  })

  it('disabling the default makes the agent the default again', async () => {
    const { saves, view } = mount({ presets: [], disabled: [], default: 'concept' })
    pick(/^Concept/)
    expect(tags()).toEqual(['Built in', 'Default'])
    choose('Disable')
    await waitFor(() => expect(saves).toHaveLength(1))
    expect(saves[0]).toEqual({ presets: [], disabled: ['concept'], default: AGENT_PICKS })
    view.rerender(
      <LayersPresets settings={saves[0]!} onSave={vi.fn()} review={undefined} onClose={vi.fn()} />,
    )
    expect(cardNames()).toEqual(['Let the agent choosedefault', 'Conceptdisabled', 'Importance'])
    expect(tags()).toEqual(['Built in', 'Disabled'])
    expect(option('Make default').disabled).toBe(true)
    closeMenu()
    expect(option('Enable')).toBeTruthy()
  })

  it('a built-in is read-only, with no Manual edit; a copy opens prefilled, to save as yours', async () => {
    const { saves, view } = mount(DEFAULT_PRESET_SETTINGS)
    pick(/^Importance/)
    expect(screen.queryByRole('button', { name: 'Manual edit' })).toBeNull()
    // The name and the line are in the head: the card holds the other two.
    const ro = [...document.querySelectorAll('.lp-fro')].map((e) => e.textContent)
    expect(ro).toHaveLength(2)
    expect(ro[1]).toContain('Layer only the lines that matter most')
    expect(document.querySelector('.lp-detail input')).toBeNull()
    choose('Make a copy to edit')
    expect(title()).toBe('New preset')
    expect(field('Name').value).toBe('Importance (mine)')
    expect(field('Instructions').value).toContain('Layer only the lines that matter most')
    pick('Save')
    await waitFor(() => expect(saves).toHaveLength(1))
    const saved = saves[0]!
    expect(saved.presets[0]).toMatchObject({ name: 'Importance (mine)', builtIn: false })
    view.rerender(
      <LayersPresets settings={saved} onSave={vi.fn()} review={undefined} onClose={vi.fn()} />,
    )
    expect(cardNames()).toContain('Importance (mine)')
  })

  it('yours reads as text until Manual edit: the card turns into a form with Save and Cancel; Delete removes it', async () => {
    const { saves } = mount({ presets: [mine], disabled: [], default: 'mine1' })
    pick(/^Data and storage/)
    expect(title()).toBe('Data and storage')
    expect([...document.querySelectorAll('.lp-fro')].map((e) => e.textContent)).toEqual([
      'stored state',
      'type files whole',
    ])
    // Short instructions are shown whole: nothing to open.
    expect(screen.queryByRole('button', { name: 'Show all' })).toBeNull()
    openFields('Manual edit')
    expect(document.querySelector('.lp-card .lp-fields')).toBeTruthy()
    expect(field('Name').value).toBe('Data and storage')
    expect((button('Save') as HTMLButtonElement).disabled).toBe(true)
    fireEvent.change(field('Name'), { target: { value: 'Data' } })
    expect((button('Save') as HTMLButtonElement).disabled).toBe(false)
    // Cancel leaves the form, and what was typed with it.
    pick('Cancel')
    expect(document.querySelector('.lp-fields')).toBeNull()
    openFields('Manual edit')
    expect(field('Name').value).toBe('Data and storage')
    fireEvent.change(field('Name'), { target: { value: 'Data' } })
    pick('Save')
    await waitFor(() => expect(saves).toHaveLength(1))
    expect(saves[0]?.presets[0]?.name).toBe('Data')
    // Saved: the card reads as text again.
    await waitFor(() => expect(document.querySelector('.lp-fields')).toBeNull())
    // Delete asks first, in a dialog of its own: Cancel keeps the preset.
    choose('Delete')
    expect(screen.getByRole('dialog', { name: 'Delete preset' })).toBeTruthy()
    expect(screen.getByText(/Deletes “Data and storage” and its conversation/)).toBeTruthy()
    pick('Cancel')
    expect(screen.queryByRole('dialog', { name: 'Delete preset' })).toBeNull()
    expect(saves).toHaveLength(1)
    // Escape closes the question, not the Layers dialog under it.
    choose('Delete')
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('dialog', { name: 'Delete preset' })).toBeNull()
    expect(screen.getByRole('dialog', { name: 'Layers presets' })).toBeTruthy()
    choose('Delete')
    pick('Delete preset')
    await waitFor(() => expect(saves).toHaveLength(2))
    expect(saves[1]).toEqual({ presets: [], disabled: [], default: AGENT_PICKS })
  })

  it('the default is set from the preset in view, and reads as a tag on the one that is', async () => {
    const { saves, view } = mount({ presets: [mine], disabled: ['importance'], default: 'agent' })
    // The agent is in view and is the default: a badge, nothing to press.
    expect(document.querySelector('.lp-dhead .lp-tag-lg')?.textContent).toBe('Default')
    expect(screen.queryByRole('button', { name: 'Make default' })).toBeNull()
    // A disabled preset cannot be the default.
    pick(/^Importance/)
    expect(option('Make default').disabled).toBe(true)
    closeMenu()
    expect(tags()).toEqual(['Built in', 'Disabled'])
    pick(/^Data and storage/)
    expect(tags()).toEqual([])
    choose('Make default')
    await waitFor(() => expect(saves).toHaveLength(1))
    expect(saves[0]?.default).toBe('mine1')
    view.rerender(
      <LayersPresets settings={saves[0]!} onSave={vi.fn()} review={undefined} onClose={vi.fn()} />,
    )
    expect(tags()).toEqual(['Default'])
    // Already the default: nothing to make.
    fireEvent.click(screen.getByRole('button', { name: 'Preset options' }))
    expect(screen.queryByRole('menuitem', { name: 'Make default' })).toBeNull()
    expect(cardNames()).toContain('Data and storagedefault')
  })

  it('with a review, the bar at the foot outlines it with the card in view, and closes', () => {
    const review = reviewCtx({ inUse: 'concept' })
    const { onClose, view } = mount(DEFAULT_PRESET_SETTINGS, review)
    // Opens on the preset in use.
    expect(title()).toBe('Concept')
    expect(document.querySelector('.lp-bar-text')?.textContent).toBe('This review follows Concept.')
    expect(button('Layer again')).toBeTruthy()
    pick(/^Importance/)
    pick('Layer by Importance')
    expect(review.onUse).toHaveBeenCalledWith('importance')
    expect(onClose).toHaveBeenCalledTimes(1)
    pick(/^Let the agent choose/)
    pick('Layer by the agent’s choice')
    expect(review.onUse).toHaveBeenLastCalledWith(AGENT_PICKS)
    // A preset that is off, or no agent: the bar is there but inert.
    view.rerender(
      <LayersPresets
        settings={{ presets: [], disabled: ['importance'], default: 'agent' }}
        onSave={vi.fn()}
        review={review}
        onClose={vi.fn()}
      />,
    )
    pick(/^Importance/)
    expect((button('Layer by Importance') as HTMLButtonElement).disabled).toBe(true)
    view.rerender(
      <LayersPresets
        settings={DEFAULT_PRESET_SETTINGS}
        onSave={vi.fn()}
        review={reviewCtx({ agentAttached: false })}
        onClose={vi.fn()}
      />,
    )
    pick(/^Concept/)
    expect((button('Layer by Concept') as HTMLButtonElement).disabled).toBe(true)
    // No layers yet, so no preset to name: the bar is the action alone.
    expect(document.querySelector('.lp-bar')).toBeTruthy()
    expect(document.querySelector('.lp-bar-text')).toBeNull()
    expect((button(/Send/) as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByText(/No agent on the review to talk to/)).toBeTruthy()
  })

  it('a preset’s conversation is a thread card: the reviewer writes, the agent’s edit shows with an undo', async () => {
    const { saves, view } = mount({ presets: [mine], disabled: [], default: 'agent' }, reviewCtx())
    pick(/^Data and storage/)
    // Nothing said yet: the review's own "Ask your agent" box.
    expect(document.querySelector('.cbox.thread-composer')).toBeTruthy()
    expect(document.querySelector('.cbox-hint')?.textContent).toBe(
      'It edits this preset; every edit has an undo',
    )
    const askBox = () =>
      screen.getByLabelText('Tell the agent what to change') as HTMLTextAreaElement
    const box = askBox()
    expect(box.placeholder).toBe('Tell the agent what to change.')
    expect((button(/Send/) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.change(box, { target: { value: 'tests first' } })
    pick(/Send/)
    await waitFor(() => expect(posted).toHaveLength(1))
    expect(posted[0]).toEqual(['/api/presets/mine1/messages', { text: 'tests first' }])
    // The example was for the first message: the box is a reply box now, and empty.
    // It is the card a review thread is, from here on.
    await waitFor(() => expect(askBox().placeholder).toBe('Reply…'))
    expect(document.querySelector('.thread.conv')).toBeTruthy()
    expect(askBox().value).toBe('')
    // The reviewer spoke last: the card shows the agent at work, as a review thread does.
    await waitFor(() => expect(document.querySelector('.thread-message-pending')).toBeTruthy())
    expect(messages()).toHaveLength(1)
    expect(messages()[0]?.querySelector('.cmt-who')?.textContent).toBe('You')
    // The agent's edit arrives through the stream: the message, the change line, the undo.
    threads.mine1 = [
      ...(threads.mine1 ?? []),
      {
        id: 'a1',
        author: 'agent',
        text: 'Tests lead now.',
        at,
        change: { fields: ['instructions'], before: { instructions: 'type files whole' } },
      },
    ]
    const edited = { ...mine, instructions: 'Tests first, then type files whole.' }
    view.rerender(
      <LayersPresets
        settings={{ presets: [edited], disabled: [], default: 'agent' }}
        onSave={async (next) => {
          saves.push(next)
          return true
        }}
        review={reviewCtx()}
        onClose={vi.fn()}
      />,
    )
    notifyPresetsChanged()
    await waitFor(() => expect(screen.getByText('Tests lead now.')).toBeTruthy())
    expect(messages()[1]?.querySelector('.cmt-who')?.textContent).toBe('Agent')
    expect(screen.getByText(/Changed instructions/)).toBeTruthy()
    expect(document.querySelector('.thread-message-pending')).toBeNull()
    // The card follows the agent's edit, as text and in the form.
    expect(document.querySelectorAll('.lp-fro')[1]?.textContent).toBe(
      'Tests first, then type files whole.',
    )
    openFields('Manual edit')
    expect(field('Instructions').value).toBe('Tests first, then type files whole.')
    pick('undo')
    await waitFor(() => expect(saves).toHaveLength(1))
    expect(saves[0]?.presets[0]?.instructions).toBe('type files whole')
    // With the field back where it was the change reads as undone, and the
    // link is gone: there is nothing left for it to do.
    view.rerender(
      <LayersPresets
        settings={saves[0]!}
        onSave={async () => true}
        review={reviewCtx()}
        onClose={vi.fn()}
      />,
    )
    await waitFor(() => expect(screen.getByText(/Changed instructions · undone/)).toBeTruthy())
    expect(screen.queryByRole('button', { name: 'undo' })).toBeNull()
  })

  it('New conversation clears the messages after asking, and leaves the preset alone', async () => {
    threads.mine1 = [
      { id: 'm1', author: 'reviewer', text: 'tests first', at },
      { id: 'a1', author: 'agent', text: 'Done.', at },
    ]
    const { saves } = mount({ presets: [mine], disabled: [], default: 'agent' }, reviewCtx())
    pick(/^Data and storage/)
    // What the agent is sent besides the messages is the caption's tooltip:
    // the thread never shows it, and the page does not spend a line on it.
    await waitFor(() => expect(messages()).toHaveLength(2))
    expect(screen.getByText('Conversation with the agent').getAttribute('title')).toContain(
      'sent this preset’s fields',
    )
    pick('New conversation')
    expect(screen.getByRole('dialog', { name: 'New conversation' })).toBeTruthy()
    pick('Cancel')
    expect(messages()).toHaveLength(2)
    pick('New conversation')
    pick('Clear conversation')
    await waitFor(() => expect(messages()).toHaveLength(0))
    expect(posted).toEqual([['DELETE /api/presets/mine1/thread', null]])
    expect(screen.queryByRole('dialog', { name: 'New conversation' })).toBeNull()
    // Nothing to clear now, so nothing to offer; and the preset was not saved over.
    expect(screen.queryByRole('button', { name: 'New conversation' })).toBeNull()
    expect(saves).toHaveLength(0)
    openFields('Manual edit')
    expect(field('Name').value).toBe('Data and storage')
  })

  it('a new preset has empty fields and a conversation under a fresh id; the agent making it switches to it', async () => {
    const { view } = mount(DEFAULT_PRESET_SETTINGS, reviewCtx())
    pick('New preset')
    expect(title()).toBe('New preset')
    // A blank one opens on the conversation; the form is one button away, where a saved preset has it.
    expect(document.querySelector('.lp-fields')).toBeNull()
    expect(document.querySelector('.cbox-title')?.textContent).toBe('Describe it to your agent')
    openFields('Manual edit')
    expect(field('Name').value).toBe('')
    expect((button('Save') as HTMLButtonElement).disabled).toBe(true)
    // Nothing to outline with yet.
    expect(document.querySelector('.lp-bar')).toBeNull()
    fireEvent.change(screen.getByLabelText('Tell the agent what to change'), {
      target: { value: 'only the API' },
    })
    pick(/Send/)
    await waitFor(() => expect(posted).toHaveLength(1))
    const id = decodeURIComponent((posted[0]![0] as string).split('/')[3]!)
    expect(id.length).toBeGreaterThan(8)
    // The agent made it: the settings now hold the id, and the detail is the preset's.
    view.rerender(
      <LayersPresets
        settings={{
          presets: [{ ...mine, id, name: 'API only' }],
          disabled: [],
          default: 'agent',
        }}
        onSave={vi.fn()}
        review={reviewCtx()}
        onClose={vi.fn()}
      />,
    )
    await waitFor(() => expect(title()).toBe('API only'))
    openFields('Manual edit')
    expect(field('Name').value).toBe('API only')
  })

  it('a new preset is a real one from the first message: a card under yours, empty until written', async () => {
    const started = {
      id: 'n1',
      name: 'New preset',
      blurb: '',
      whenToUse: '',
      instructions: '',
      builtIn: false,
    }
    threads.n1 = [{ id: 'r1', author: 'reviewer', text: 'only the API', at }]
    mount({ presets: [mine, started], disabled: [], default: 'agent' }, reviewCtx())
    expect(cardNames()).toContain('New presetempty')
    // Empty, it is offered nowhere: the agent's card lists only what is in play.
    expect([...document.querySelectorAll('.lp-pick-name')].map((n) => n.textContent)).toEqual([
      'Concept',
      'Importance',
      'Data and storage',
    ])
    // It opens like any preset, with its conversation; a line stands where its text will be.
    fireEvent.click(cards().find((c) => c.textContent?.startsWith('New presetempty'))!)
    expect(title()).toBe('New preset')
    expect(tags()).toEqual(['Empty'])
    expect(document.querySelector('.lp-empty-note')?.textContent).toContain('Nothing in it yet')
    expect(document.querySelector('.lp-facts')).toBeNull()
    await waitFor(() => expect(messages()).toHaveLength(1))
    // It cannot layer the review or be the default until it has instructions.
    expect((button('Layer by New preset') as HTMLButtonElement).disabled).toBe(true)
    expect(option('Make default').disabled).toBe(true)
    closeMenu()
    // Moving away and back loses nothing, and Manual edit works as on any preset.
    pick(/^Concept/)
    fireEvent.click(cards().find((c) => c.textContent?.startsWith('New presetempty'))!)
    await waitFor(() => expect(messages()).toHaveLength(1))
    openFields('Manual edit')
    expect(field('Name').value).toBe('New preset')
    pick('Cancel')
    expect(document.querySelector('.lp-fields')).toBeNull()
  })

  it('a new preset typed by hand saves from the fields', async () => {
    const { saves } = mount(DEFAULT_PRESET_SETTINGS, reviewCtx())
    pick('New preset')
    openFields('Manual edit')
    // Cancel is the form's: it closes the form and leaves the new preset open.
    fireEvent.change(field('Name'), { target: { value: 'Never mind' } })
    pick('Cancel')
    expect(document.querySelector('.lp-fields')).toBeNull()
    expect(title()).toBe('New preset')
    openFields('Manual edit')
    expect(field('Name').value).toBe('')
    fireEvent.change(field('Name'), { target: { value: 'Hand-typed' } })
    pick('Save')
    await waitFor(() => expect(saves).toHaveLength(1))
    expect(saves[0]?.presets[0]).toMatchObject({ name: 'Hand-typed', builtIn: false })
  })

  it('Escape with the menu open closes the menu, not the dialog', () => {
    const { onClose } = mount(DEFAULT_PRESET_SETTINGS)
    pick(/^Importance/)
    fireEvent.click(screen.getByRole('button', { name: 'Preset options' }))
    expect(document.querySelector('.menu-panel')).toBeTruthy()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(document.querySelector('.menu-panel')).toBeNull()
    expect(onClose).not.toHaveBeenCalled()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('a refused save says so and keeps the dialog', async () => {
    const onSave = vi.fn(async () => false)
    render(<LayersPresets settings={DEFAULT_PRESET_SETTINGS} onSave={onSave} onClose={vi.fn()} />)
    pick(/^Concept/)
    choose('Make default')
    await waitFor(() => expect(screen.getByText(/Could not save/)).toBeTruthy())
    expect(title()).toBe('Concept')
  })
})
