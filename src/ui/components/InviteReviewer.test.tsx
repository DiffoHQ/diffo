// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BUILT_IN_ROLES, type ReviewerRole } from '../../shared/roles.js'
import { type Reviewers, ReviewersContext } from '../actors.js'
import { InviteReviewer } from './InviteReviewer.js'

afterEach(cleanup)

const copied: string[] = []
/** What the page sent, in order: `METHOD path` and the body. */
const sent: { call: string; body: unknown }[] = []
let custom: ReviewerRole[] = []

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })

beforeEach(() => {
  copied.length = 0
  sent.length = 0
  custom = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET'
      const body = init?.body ? JSON.parse(init.body as string) : undefined
      sent.push({ call: `${method} ${input}`, body })
      if (input === '/api/reviewer/roles') {
        if (method === 'PUT') custom = (body as { roles: ReviewerRole[] }).roles
        const roles = [...BUILT_IN_ROLES, ...custom]
        // The quick picks and the reviewer's own are active, as the server says.
        const active = roles.filter((r) => r.quick || !r.builtIn).map((r) => r.id)
        return json({ roles, default: 'general', active })
      }
      if (input.startsWith('/api/reviewer/invite')) {
        const role = new URL(input, 'http://x').searchParams.get('role')
        return json({ role, ask: `Join the code review as ${role}: run join --role ${role}` })
      }
      if (input === '/api/reviewer/request')
        return json({ ok: true, roles: [], presence: 'working' })
      if (input === '/api/reviewer/suggestion') return json({ cleared: true })
      return json({ error: 'unexpected' }, 404)
    }),
  )
  Object.assign(navigator, {
    clipboard: { writeText: vi.fn(async (t: string) => void copied.push(t)) },
  })
  Object.defineProperty(document, 'execCommand', { value: () => false, configurable: true })
})

const NOBODY: Reviewers = { seats: [], states: new Map() }

function show(
  options: {
    agentAttached?: boolean
    onClose?: () => void
    onManage?: () => void
    suggested?: { role: string; reason?: string }
    preselect?: string
    reviewers?: Reviewers
  } = {},
) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <ReviewersContext.Provider value={options.reviewers ?? NOBODY}>
        <InviteReviewer
          agentAttached={options.agentAttached ?? true}
          onClose={options.onClose ?? (() => {})}
          {...(options.onManage ? { onManage: options.onManage } : {})}
          {...(options.suggested ? { suggested: options.suggested } : {})}
          {...(options.preselect ? { preselect: options.preselect } : {})}
        />
      </ReviewersContext.Provider>
    </QueryClientProvider>,
  )
}

const box = (name: string) => screen.findByRole('checkbox', { name: new RegExp(`^${name}`) })
const ticked = async (name: string) => ((await box(name)) as HTMLInputElement).checked

describe('InviteReviewer — picking roles', () => {
  it('lists every role with its one line, the general one ticked, and no prompt in sight', async () => {
    show()
    expect(await ticked('General')).toBe(true)
    expect(await ticked('Blast radius')).toBe(false)
    expect(screen.getByText('Anything that would bite, bugs first')).toBeTruthy()
    // What a role looks for is one click away, not on the page.
    expect(screen.queryByText(/Read the whole change for what would go wrong/)).toBeNull()
    fireEvent.click(
      screen.getByRole('button', { name: 'View what the General reviewer looks for' }),
    )
    // The quick read first: when to open it. The whole instructions on demand.
    expect(screen.getByText(/The safe default when you want one reviewer/)).toBeTruthy()
    expect(screen.queryByText(/Read the whole change for what would go wrong/)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Full instructions' }))
    expect(screen.getByText(/Read the whole change for what would go wrong/)).toBeTruthy()
    fireEvent.click(
      screen.getByRole('button', { name: 'Hide what the General reviewer looks for' }),
    )
    expect(screen.queryByText(/Read the whole change for what would go wrong/)).toBeNull()
  })

  it('starts several reviewers in one ask, and closes', async () => {
    const onClose = vi.fn()
    show({ onClose })
    fireEvent.click(await box('Blast radius'))
    fireEvent.click(await box('AI slop'))
    fireEvent.click(screen.getByRole('button', { name: 'Start 3 reviewers' }))
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce())
    expect(sent.find((s) => s.call === 'POST /api/reviewer/request')?.body).toEqual({
      roles: ['general', 'blast-radius', 'ai-slop'],
    })
  })

  it('needs a role ticked before it starts anything', async () => {
    show()
    fireEvent.click(await box('General'))
    expect(screen.getByRole('button', { name: 'Start reviewer' })).toHaveProperty('disabled', true)
  })

  it('does not tick a role that is already in the review, and says it is there', async () => {
    show({
      reviewers: {
        seats: ['general'],
        states: new Map(),
        roles: new Map([['general', 'general']]),
        starting: ['simplicity'],
      },
    })
    expect(await ticked('General')).toBe(false)
    expect(screen.getByText('in this review')).toBeTruthy()
    expect(screen.getByText('on its way')).toBeTruthy()
  })

  it('lists the active reviewers; the rest wait in the library, one click away', async () => {
    const onManage = vi.fn()
    show({ onManage })
    expect(await ticked('Code comments')).toBe(false)
    expect(screen.queryByRole('checkbox', { name: /^Security/ })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '11 more in the library' }))
    expect(onManage).toHaveBeenCalledOnce()
  })

  it('a quick set ticks the roles a kind of change wants, in one click', async () => {
    show()
    await box('General')
    const refactor = screen.getByRole('button', { name: 'Refactor' })
    fireEvent.click(refactor)
    expect(refactor.getAttribute('aria-pressed')).toBe('true')
    // Tests is in the library, so it joins the list ticked.
    expect(await ticked('Tests')).toBe(true)
    expect(await ticked('Blast radius')).toBe(true)
    expect(await ticked('Simplicity')).toBe(true)
    expect(await ticked('General')).toBe(false)
    expect(screen.getByRole('button', { name: 'Start 3 reviewers' })).toBeTruthy()
  })

  it('opens on a role the page asked for', async () => {
    show({ preselect: 'simplicity' })
    expect(await ticked('Simplicity')).toBe(true)
    expect(await ticked('General')).toBe(false)
  })

  it('"Edit agents" hands over to the page', async () => {
    const onManage = vi.fn()
    show({ onManage })
    fireEvent.click(await screen.findByRole('button', { name: 'Edit agents' }))
    expect(onManage).toHaveBeenCalledOnce()
  })
})

describe('InviteReviewer — how they join', () => {
  it('offers both ways, the agent first while one is connected', async () => {
    show()
    await box('General')
    expect(screen.getByRole('radio', { name: /My agent starts them/ })).toHaveProperty(
      'checked',
      true,
    )
    // No line to paste until that way is picked.
    expect(screen.queryByText(/run join --role/)).toBeNull()
  })

  it('another session: one line per role ticked, each with its own Copy', async () => {
    show()
    fireEvent.click(await box('Blast radius'))
    fireEvent.click(screen.getByRole('radio', { name: /Another session/ }))
    await screen.findByText('Join the code review as general: run join --role general')
    fireEvent.click(
      await screen.findByRole('button', { name: "Copy the Blast radius reviewer's invite" }),
    )
    await waitFor(() =>
      expect(copied).toEqual([
        'Join the code review as blast-radius: run join --role blast-radius',
      ]),
    )
    // Copying asks nothing of the agent.
    expect(sent.some((s) => s.call === 'POST /api/reviewer/request')).toBe(false)
    expect(screen.queryByRole('button', { name: /Start/ })).toBeNull()
  })

  it('with no agent connected only the line is on offer', async () => {
    show({ agentAttached: false })
    await box('General')
    expect(screen.getByRole('radio', { name: /My agent starts them/ })).toHaveProperty(
      'disabled',
      true,
    )
    expect(screen.getByText('No agent is connected to this review')).toBeTruthy()
    fireEvent.click(
      await screen.findByRole('button', { name: "Copy the General reviewer's invite" }),
    )
    await waitFor(() => expect(copied).toHaveLength(1))
  })
})

describe('InviteReviewer — the agent suggested one', () => {
  const suggested = { role: 'security', reason: 'builds a shell command' }

  it('ticks the suggested role and says why', async () => {
    show({ suggested })
    expect(await ticked('Security')).toBe(true)
    expect(await ticked('General')).toBe(false)
    expect(screen.getByText('Your agent suggests a security reviewer')).toBeTruthy()
    expect(screen.getByText(/builds a shell command/)).toBeTruthy()
  })

  it('"Not now" passes on it and closes, starting nothing', async () => {
    const onClose = vi.fn()
    show({ onClose, suggested })
    fireEvent.click(await screen.findByRole('button', { name: 'Not now' }))
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce())
    expect(sent.some((s) => s.call === 'DELETE /api/reviewer/suggestion')).toBe(true)
    expect(sent.some((s) => s.call === 'POST /api/reviewer/request')).toBe(false)
  })

  it('without a suggestion there is nothing to pass on', async () => {
    show()
    await box('General')
    expect(screen.queryByRole('button', { name: 'Not now' })).toBeNull()
  })
})
