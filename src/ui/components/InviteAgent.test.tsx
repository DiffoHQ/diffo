// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Presence, PresenceReason } from '../api.js'
import { InviteAgent } from './InviteAgent.js'

afterEach(cleanup)

const INVITE = {
  install: {
    global: 'npx skills add DiffoHQ/diffo --skill diffo -g',
    project: 'npx skills add DiffoHQ/diffo --skill diffo',
  },
  join: 'join the diffo review',
}

const copied: string[] = []
beforeEach(() => {
  copied.length = 0
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify(INVITE))),
  )
  Object.assign(navigator, {
    clipboard: { writeText: vi.fn(async (t: string) => void copied.push(t)) },
  })
  Object.defineProperty(document, 'execCommand', { value: () => false, configurable: true })
})

function show(
  presence: Presence = 'waiting',
  onClose: () => void = () => {},
  reason: PresenceReason = 'no-agent',
) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const ui = (p: Presence, r: PresenceReason) => (
    <QueryClientProvider client={client}>
      <InviteAgent presence={p} reason={r} onClose={onClose} />
    </QueryClientProvider>
  )
  const view = render(ui(presence, reason))
  return {
    ...view,
    presence: (next: Presence, nextReason: PresenceReason = reason) =>
      view.rerender(ui(next, nextReason)),
  }
}

describe('InviteAgent', () => {
  it('has one job: install the skill', async () => {
    show()
    fireEvent.click(await screen.findByText(INVITE.install.global))
    await waitFor(() => expect(copied).toEqual([INVITE.install.global]))
    expect(await screen.findByTitle('Copied')).toBeTruthy()
  })

  it('says what you get, not what to do next', async () => {
    show()
    expect(await screen.findByText(/open reviews and act on your comments/)).toBeTruthy()
  })

  it("does not teach the loop — that is the skill's job", async () => {
    show()
    await screen.findByText(INVITE.install.global)
    expect(screen.queryByText(/diffo reply/)).toBeNull()
    expect(screen.queryByText(/diffo end/)).toBeNull()
    expect(screen.queryByText(/diffo poll/)).toBeNull()
  })

  it('lets you choose the scope, and defaults to every project', async () => {
    show()
    expect(await screen.findByText(INVITE.install.global)).toBeTruthy()
    const box = screen.getByRole('checkbox')
    expect((box as HTMLInputElement).checked).toBe(true)
    fireEvent.click(box)
    expect(await screen.findByText(INVITE.install.project)).toBeTruthy()
    fireEvent.click(screen.getByText(INVITE.install.project))
    await waitFor(() => expect(copied).toEqual([INVITE.install.project]))
  })

  it('offers no second way in, and no button competing with the two chips', async () => {
    show()
    await screen.findByText(INVITE.install.global)
    expect(screen.queryByText(/Paste an invite instead/)).toBeNull()
    expect(screen.queryByText('Copy command')).toBeNull()
    expect(screen.queryByText('Close')).toBeNull()
  })

  it('gives the already-installed reviewer something to paste', async () => {
    show()
    fireEvent.click(await screen.findByText(INVITE.join))
    await waitFor(() => expect(copied).toEqual([INVITE.join]))
  })

  it('never claims a copy that did not happen', async () => {
    Object.assign(navigator, {
      clipboard: { writeText: vi.fn(async () => Promise.reject(new Error('denied'))) },
    })
    show()
    fireEvent.click(await screen.findByText(INVITE.install.global))
    expect(await screen.findByText(/Couldn't reach the clipboard/)).toBeTruthy()
    expect(screen.queryByTitle('Copied')).toBeNull()
  })

  it('says what went wrong instead of showing an empty box', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('nope', { status: 500 })),
    )
    show()
    expect(await screen.findByText(/Couldn't build the invite/)).toBeTruthy()
  })
})

describe('InviteAgent handshake', () => {
  it('watches for the agent after a copy, then confirms when it attaches', async () => {
    const view = show('waiting')
    fireEvent.click(await screen.findByText(INVITE.install.global))
    expect(await screen.findByText(/Listening for your agent/)).toBeTruthy()

    view.presence('listening')
    expect(await screen.findByText('Agent attached')).toBeTruthy()
    expect(screen.getByText(/lands in that thread/)).toBeTruthy()
  })

  it('keeps listening past the "Copied" flash', async () => {
    vi.useFakeTimers()
    try {
      show('waiting')
      await vi.waitFor(() => expect(screen.getByText(INVITE.install.global)).toBeTruthy())
      fireEvent.click(screen.getByText(INVITE.install.global))
      await vi.waitFor(() => expect(screen.getByText(/Listening for your agent/)).toBeTruthy())
      act(() => vi.advanceTimersByTime(5000))
      expect(screen.queryByTitle('Copied')).toBeNull()
      expect(screen.getByText(/Listening for your agent/)).toBeTruthy()
    } finally {
      vi.useRealTimers()
    }
  })

  it('closes itself once the handshake lands', async () => {
    vi.useFakeTimers()
    try {
      let closed = 0
      const view = show('waiting', () => {
        closed++
      })
      await vi.waitFor(() => expect(screen.getByText(INVITE.install.global)).toBeTruthy())
      view.presence('listening')
      expect(closed).toBe(0)
      vi.advanceTimersByTime(2000)
      expect(closed).toBe(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('tells a goodbye from a death — that is what `reason` is for', async () => {
    const polite = show('listening', () => {}, 'polling')
    expect(await screen.findByText('Agent attached')).toBeTruthy()
    polite.presence('waiting', 'ended')
    expect(await screen.findByText(/left the review/)).toBeTruthy()
    expect(screen.getByText(INVITE.install.global)).toBeTruthy()
    cleanup()

    const dead = show('listening', () => {}, 'polling')
    await screen.findByText('Agent attached')
    dead.presence('waiting', 'disconnected')
    expect(await screen.findByText(/disconnected/)).toBeTruthy()
  })
})
