// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  AGENT_PICKS_SET,
  BUILT_IN_ROLES,
  BUILT_IN_SETS,
  type ReviewerRole,
  type ReviewerSet,
  type RoleMessage,
} from '../../shared/roles.js'
import { notifyRolesChanged } from '../rolesPref.js'
import { ReviewerAgents, type ReviewerAgentsPick } from './ReviewerAgents.js'

afterEach(cleanup)

const at = new Date().toISOString()

/** The server's roles and conversations, and what the page sent. */
let custom: ReviewerRole[] = []
let threads: Record<string, RoleMessage[]> = {}
const puts: unknown[] = []
let posted: Array<[string, unknown]> = []
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })

let moved: [string, boolean][] = []
const activeOf = (roles: ReviewerRole[]) =>
  roles
    .filter((r) => {
      const said = moved.findLast(([id]) => id === r.id)
      return said ? said[1] : r.quick || !r.builtIn
    })
    .map((r) => r.id)

let mySets: ReviewerSet[] = []
let defaultSet: string = AGENT_PICKS_SET
/** The sets saves the page made, as sent. */
const setPuts: unknown[] = []
const payload = (roles: ReviewerRole[]) => ({
  roles,
  default: 'general',
  active: activeOf(roles),
  sets: [...BUILT_IN_SETS, ...mySets],
  defaultSet,
})

beforeEach(() => {
  mySets = []
  defaultSet = AGENT_PICKS_SET
  setPuts.length = 0
  moved = []
  custom = []
  threads = {}
  puts.length = 0
  posted = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init?: RequestInit) => {
      if (input === '/api/reviewer/roles') {
        if (init?.method === 'PUT') {
          const body = JSON.parse(init.body as string) as { roles: ReviewerRole[] }
          puts.push(body)
          custom = body.roles
        }
        const roles = [...BUILT_IN_ROLES, ...custom]
        return json(payload(roles))
      }
      if (input === '/api/reviewer/sets') {
        const body = JSON.parse(String(init?.body)) as { sets: (ReviewerSet & { id?: string })[] }
        setPuts.push(body.sets)
        // The server names a new one from its name.
        mySets = body.sets.map((set) => ({
          ...set,
          id: set.id ?? set.name.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
        }))
        return json(payload([...BUILT_IN_ROLES, ...custom]))
      }
      if (input === '/api/reviewer/sets/default') {
        defaultSet = (JSON.parse(String(init?.body)) as { id: string }).id
        return json(payload([...BUILT_IN_ROLES, ...custom]))
      }
      const act = /^\/api\/reviewer\/roles\/([^/]+)\/active$/.exec(input)
      if (act) {
        moved.push([act[1]!, (JSON.parse(String(init?.body)) as { active: boolean }).active])
        const roles = [...BUILT_IN_ROLES, ...custom]
        return json(payload(roles))
      }
      const m = /^\/api\/reviewer\/roles\/([^/]+)\/(thread|messages)$/.exec(input)
      if (m) {
        const key = decodeURIComponent(m[1]!)
        if (init?.method === 'DELETE') {
          posted.push([`DELETE ${input}`, null])
          threads[key] = []
          return json({ cleared: true, thread: { messages: [] } })
        }
        if (init?.method === 'POST') {
          const body = JSON.parse(String(init.body)) as { text: string }
          posted.push([input, body])
          const message = {
            id: `m${posted.length}`,
            author: 'reviewer' as const,
            text: body.text,
            at,
          }
          threads[key] = [...(threads[key] ?? []), message]
          return json({ message, thread: { messages: threads[key] } })
        }
        return json({ thread: { messages: threads[key] ?? [] } })
      }
      return json({ error: 'unexpected' }, 404)
    }),
  )
})

let client: QueryClient

/** What the page's events stream does on `roles`: the roles and the
 * conversations re-read. */
const stream = () => {
  void client.invalidateQueries({ queryKey: ['reviewer-roles'] })
  notifyRolesChanged()
}

function show(
  options: {
    initial?: ReviewerAgentsPick
    onAdd?: (roles: readonly string[]) => void
    agent?: boolean
    onClose?: () => void
  } = {},
) {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <ReviewerAgents
        onClose={options.onClose ?? (() => {})}
        agentAttached={options.agent ?? true}
        {...(options.initial ? { initial: options.initial } : {})}
        {...(options.onAdd ? { onAdd: options.onAdd } : {})}
      />
    </QueryClientProvider>,
  )
}

const row = (name: RegExp) => screen.findByRole('button', { name })
const title = () => document.querySelector('.lp-title')?.textContent
const askBox = () => screen.getByLabelText('Tell the agent what to change') as HTMLTextAreaElement
const messages = () => [
  ...document.querySelectorAll('.thread-message:not(.thread-message-pending)'),
]
const send = async (text: string) => {
  fireEvent.change(askBox(), { target: { value: text } })
  fireEvent.click(screen.getByRole('button', { name: /Send/ }))
  await waitFor(() => expect(askBox().value).toBe(''))
}
const perf: ReviewerRole = {
  id: 'perf',
  name: 'Performance',
  blurb: 'slow',
  focus: 'A query inside a loop.',
}

describe('ReviewerAgents — active and library', () => {
  it('lists the active reviewers first and the library under them; one click moves one', async () => {
    show()
    const group = (cap: string) => {
      const caps = [...document.querySelectorAll('.lp-side .lp-cap')]
      const at = caps.find((c) => c.textContent?.startsWith(cap))
      return [...(at?.nextElementSibling?.querySelectorAll('.lp-row-name') ?? [])].map(
        (n) => n.textContent,
      )
    }
    await screen.findByRole('heading', { name: 'General' })
    expect(group('Active')).toEqual([
      'General',
      'Blast radius',
      'AI slop',
      'Simplicity',
      'Code comments',
      'Error handling',
      'New agent',
    ])
    // The library is folded until it is opened, with how many wait in it.
    const fold = screen.getByRole('button', { name: /^Library/ })
    expect(fold.getAttribute('aria-expanded')).toBe('false')
    expect(fold.textContent).toBe('Library11')
    expect(screen.queryByRole('button', { name: /^Security/ })).toBeNull()
    fireEvent.click(fold)
    expect(group('Library')).toContain('Security')
    fireEvent.click(screen.getByRole('button', { name: /^Security/ }))
    fireEvent.click(await screen.findByRole('button', { name: 'Make active' }))
    await waitFor(() => expect(group('Active')).toContain('Security'))
    expect(moved).toEqual([['security', true]])
    fireEvent.click(screen.getByRole('button', { name: 'Move to library' }))
    await waitFor(() => expect(group('Library')).toContain('Security'))
  })

  it('opens the library for an agent that waits in it', async () => {
    show({ initial: { kind: 'role', id: 'security' } })
    await screen.findByRole('heading', { name: 'Security' })
    expect(screen.getByRole('button', { name: /^Library/ }).getAttribute('aria-expanded')).toBe(
      'true',
    )
  })
})

describe('ReviewerAgents — roles', () => {
  it('opens on the first role: what it looks for, and under it the ask to the agent', async () => {
    show()
    expect(await screen.findByRole('heading', { name: 'General' })).toBeTruthy()
    expect(screen.getByText(/Read the whole change for what would go wrong/)).toBeTruthy()
    // A built-in is read, not edited: the agent answers with a copy.
    expect(screen.queryByRole('button', { name: 'Manual edit' })).toBeNull()
    expect(document.querySelector('.lp-card-thread .cbox-title')?.textContent).toBe(
      'Want it different? Ask your agent',
    )
    expect(document.querySelector('.cbox-hint')?.textContent).toBe(
      'It answers with a copy under your agents',
    )
  })

  it('the bar at the foot adds a reviewer in the role in view', async () => {
    const onAdd = vi.fn()
    show({ onAdd })
    fireEvent.click(await row(/^Library/))
    fireEvent.click(await row(/^Security/))
    fireEvent.click(screen.getByRole('button', { name: 'Add to review' }))
    expect(onAdd).toHaveBeenCalledWith(['security'])
  })

  it('has no bar where reviewers cannot be added', async () => {
    show()
    expect(await screen.findByRole('heading', { name: 'General' })).toBeTruthy()
    expect(document.querySelector('.lp-bar')).toBeNull()
  })

  it('a role of your own typed by hand is a name, one line and what it looks for', async () => {
    show()
    fireEvent.click(await row(/^New agent/))
    // A blank one opens on the conversation; the form is behind Manual edit.
    expect(document.querySelector('.lp-fields')).toBeNull()
    expect(document.querySelector('.cbox-title')?.textContent).toBe('Describe it to your agent')
    fireEvent.click(screen.getByRole('button', { name: 'Manual edit' }))
    const save = screen.getByRole('button', { name: 'Save' })
    expect(save).toHaveProperty('disabled', true)
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'API & Contracts' } })
    fireEvent.change(screen.getByLabelText('One line'), { target: { value: 'What clients see' } })
    fireEvent.change(screen.getByLabelText('What it looks for'), {
      target: { value: 'A response shape a client depends on.' },
    })
    fireEvent.click(save)
    expect(await screen.findByRole('heading', { name: 'API & Contracts' })).toBeTruthy()
    expect(puts).toEqual([
      {
        roles: [
          {
            id: 'api-contracts',
            name: 'API & Contracts',
            blurb: 'What clients see',
            focus: 'A response shape a client depends on.',
          },
        ],
      },
    ])
  })

  it('your own role can be edited by hand, and deleted after asking', async () => {
    custom = [perf]
    show({ initial: { kind: 'role', id: 'perf' } })
    fireEvent.click(await screen.findByRole('button', { name: 'Manual edit' }))
    fireEvent.change(screen.getByLabelText('What it looks for'), {
      target: { value: 'Work repeated on every request.' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(await screen.findByText('Work repeated on every request.')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Agent options' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete' }))
    expect(screen.getByRole('dialog', { name: 'Delete agent' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Delete agent' }))
    await waitFor(() => expect(custom).toEqual([]))
    await waitFor(() => expect(title()).toBe('General'))
  })

  it('a built-in can be copied into a role of your own', async () => {
    show({ initial: { kind: 'role', id: 'tests' } })
    fireEvent.click(await screen.findByRole('button', { name: 'Agent options' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Make a copy to edit' }))
    expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('Tests (mine)')
    expect((screen.getByLabelText('What it looks for') as HTMLTextAreaElement).value).toMatch(
      /whether its behaviour is tested/,
    )
  })

  it('says why a save was refused and keeps the form', async () => {
    show()
    fireEvent.click(await row(/^New agent/))
    fireEvent.click(screen.getByRole('button', { name: 'Manual edit' }))
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: '!!!' } })
    fireEvent.change(screen.getByLabelText('What it looks for'), { target: { value: 'x' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(await screen.findByText(/a name with a letter or a digit/)).toBeTruthy()
    expect(puts).toEqual([])
  })
})

describe('ReviewerAgents — the conversation with the agent', () => {
  it('needs an agent on the review to talk to', async () => {
    show({ agent: false })
    expect(await screen.findByRole('heading', { name: 'General' })).toBeTruthy()
    expect(screen.getByText('No agent on the review to talk to')).toBeTruthy()
    fireEvent.change(askBox(), { target: { value: 'stricter' } })
    expect(screen.getByRole('button', { name: /Send/ })).toHaveProperty('disabled', true)
  })

  it('your own role: the reviewer writes, the agent’s edit shows with an undo', async () => {
    custom = [perf]
    show({ initial: { kind: 'role', id: 'perf' } })
    expect(await screen.findByRole('heading', { name: 'Performance' })).toBeTruthy()
    expect(document.querySelector('.cbox-title')?.textContent).toBe('Ask your agent to change it')
    expect(document.querySelector('.cbox-hint')?.textContent).toBe(
      'It edits this agent; every edit has an undo',
    )
    await send('memory too')
    expect(posted[0]).toEqual(['/api/reviewer/roles/perf/messages', { text: 'memory too' }])
    // The reviewer spoke last: the card shows the agent at work.
    expect(document.querySelector('.thread.conv')).toBeTruthy()
    await waitFor(() => expect(document.querySelector('.thread-message-pending')).toBeTruthy())
    // The agent's edit arrives through the stream.
    custom = [{ ...perf, focus: 'Queries in loops, and memory held.' }]
    threads.perf = [
      ...(threads.perf ?? []),
      {
        id: 'a1',
        author: 'agent',
        text: 'Memory is in now.',
        at,
        change: { fields: ['focus'], before: { focus: 'A query inside a loop.' } },
      },
    ]
    stream()
    await waitFor(() => expect(screen.getByText('Memory is in now.')).toBeTruthy())
    await waitFor(() => expect(screen.getByText('Queries in loops, and memory held.')).toBeTruthy())
    expect(screen.getByText(/Changed what it looks for/)).toBeTruthy()
    expect(document.querySelector('.thread-message-pending')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'undo' }))
    await waitFor(() => expect(puts).toHaveLength(1))
    expect(custom[0]?.focus).toBe('A query inside a loop.')
    await waitFor(() => expect(screen.getByText(/Changed what it looks for · undone/)).toBeTruthy())
    expect(screen.queryByRole('button', { name: 'undo' })).toBeNull()
  })

  it('a new role talks under a draft key; the agent making it switches to the role', async () => {
    show()
    fireEvent.click(await row(/^New agent/))
    expect(askBox().placeholder).toMatch(/what gets slower/)
    await send('a performance reviewer')
    const key = decodeURIComponent((posted[0]![0] as string).split('/')[4]!)
    expect(key).toMatch(/^draft-[0-9a-f]{8}$/)
    // Nothing is saved until the agent makes it.
    expect(puts).toEqual([])
    // The agent made "perf": its answer lands in the draft, naming the role,
    // and the conversation carries on under the role.
    custom = [perf]
    const made: RoleMessage = {
      id: 'a1',
      author: 'agent',
      text: 'Made it.',
      at,
      change: { fields: ['name', 'focus'], before: {}, created: true, roleId: 'perf' },
    }
    threads[key] = [...(threads[key] ?? []), made]
    threads.perf = [...(threads[key] ?? [])]
    stream()
    await waitFor(() => expect(title()).toBe('Performance'))
    await waitFor(() => expect(messages()).toHaveLength(2))
    expect(screen.getByText('Made the agent')).toBeTruthy()
  })

  it('a built-in answered with a copy links to the copy', async () => {
    custom = [{ ...perf, id: 'tests-strict', name: 'Tests, strict' }]
    threads.tests = [
      { id: 'r1', author: 'reviewer', text: 'stricter', at },
      {
        id: 'a1',
        author: 'agent',
        text: 'The copy is “Tests, strict”, under your reviewer agents.',
        at,
        change: { fields: ['name'], before: {}, created: true, roleId: 'tests-strict' },
      },
    ]
    show({ initial: { kind: 'role', id: 'tests' } })
    fireEvent.click(await screen.findByRole('button', { name: 'open it' }))
    await waitFor(() => expect(title()).toBe('Tests, strict'))
  })

  it('New conversation clears the messages after asking, and leaves the role alone', async () => {
    custom = [perf]
    threads.perf = [
      { id: 'm1', author: 'reviewer', text: 'memory too', at },
      { id: 'a1', author: 'agent', text: 'Done.', at },
    ]
    show({ initial: { kind: 'role', id: 'perf' } })
    await waitFor(() => expect(messages()).toHaveLength(2))
    fireEvent.click(screen.getByRole('button', { name: 'New conversation' }))
    fireEvent.click(screen.getByRole('button', { name: 'Clear conversation' }))
    await waitFor(() => expect(messages()).toHaveLength(0))
    expect(posted).toEqual([['DELETE /api/reviewer/roles/perf/thread', null]])
    expect(puts).toEqual([])
  })

  it('asks before closing while the agent owes an answer, and says the answer is kept', async () => {
    threads.general = [{ id: 'q', author: 'reviewer', text: 'make me a test one', at }]
    const onClose = vi.fn()
    show({ initial: { kind: 'role', id: 'general' }, onClose })
    await waitFor(() => expect(messages()).toHaveLength(1))
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(onClose).not.toHaveBeenCalled()
    expect(screen.getByText('Your agent is still answering')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Close anyway' }))
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1))
  })

  it('closes at once when nothing waits on the agent', async () => {
    threads.general = [
      { id: 'q', author: 'reviewer', text: 'make me a test one', at },
      { id: 'a', author: 'agent', text: 'done', at },
    ]
    const onClose = vi.fn()
    show({ initial: { kind: 'role', id: 'general' }, onClose })
    await waitFor(() => expect(messages()).toHaveLength(2))
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})

describe('ReviewerAgents — sets', () => {
  const openSets = async () => {
    await screen.findByRole('heading', { name: 'General' })
    fireEvent.click(screen.getByRole('tab', { name: 'Sets' }))
  }
  const setRows = () =>
    [...document.querySelectorAll('nav[aria-label="Sets"] .lp-row-name')].map((n) => n.textContent)

  it('lists the sets under the default, which is the agent choosing until you name one', async () => {
    show()
    await openSets()
    expect(setRows()).toEqual([
      'Let the agent chooseDefault',
      'Agent-written change',
      'Refactor',
      'New API or command',
      'UI change',
      'Data or settings',
      'Before release',
      'New set',
    ])
    expect(title()).toBe('Let the agent choose')
    fireEvent.click(screen.getByRole('button', { name: /^Refactor/ }))
    expect(title()).toBe('Refactor')
    expect([...document.querySelectorAll('.rs-name')].map((n) => n.textContent)).toEqual([
      'Blast radius',
      'Simplicity',
      'Tests',
    ])
    // A built-in is read, not edited.
    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Make default' }))
    await waitFor(() => expect(setRows()).toContain('RefactorDefault'))
    expect(defaultSet).toBe('refactor')
    expect(setRows()).toContain('Let the agent choose')
  })

  it('makes a set of your own: a name, when to use it, and the agents ticked', async () => {
    show()
    await openSets()
    fireEvent.click(screen.getByRole('button', { name: 'New set' }))
    const save = screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement
    expect(save.disabled).toBe(true)
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Auth changes' } })
    fireEvent.change(screen.getByLabelText('When to use it'), { target: { value: 'Login.' } })
    // The library's agents are on offer too.
    fireEvent.click(screen.getByRole('checkbox', { name: /^Security/ }))
    fireEvent.click(screen.getByRole('checkbox', { name: /^Error handling/ }))
    fireEvent.click(save)
    await waitFor(() => expect(title()).toBe('Auth changes'))
    // Sent with no id, in the order the agents are listed.
    expect(setPuts).toEqual([
      [{ name: 'Auth changes', when: 'Login.', roles: ['errors', 'security'] }],
    ])
    expect(setRows()).toContain('Auth changes')
    expect(screen.getByRole('button', { name: 'Edit' })).toBeTruthy()
  })

  it('edits and deletes one of your own, and copies a built-in', async () => {
    mySets = [{ id: 'auth', name: 'Auth changes', when: 'Login.', roles: ['security'] }]
    show()
    await openSets()
    fireEvent.click(screen.getByRole('button', { name: /^Auth changes/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
    fireEvent.click(screen.getByRole('checkbox', { name: /^Tests/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() =>
      expect([...document.querySelectorAll('.rs-name')].map((n) => n.textContent)).toEqual([
        'Tests',
        'Security',
      ]),
    )
    expect(mySets[0]).toMatchObject({ id: 'auth', roles: ['tests', 'security'] })

    fireEvent.click(screen.getByRole('button', { name: 'Set options' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete' }))
    fireEvent.click(screen.getByRole('button', { name: 'Delete set' }))
    await waitFor(() => expect(setRows()).not.toContain('Auth changes'))

    fireEvent.click(screen.getByRole('button', { name: /^Refactor/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Set options' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Make a copy to edit' }))
    expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('Refactor (mine)')
    expect([...document.querySelectorAll<HTMLInputElement>('.rs-pick input:checked')].length).toBe(
      3,
    )
  })

  it('"Add to review" opens the picker on the set in view', async () => {
    const onAdd = vi.fn()
    show({ onAdd })
    await openSets()
    fireEvent.click(screen.getByRole('button', { name: /^Data or settings/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Add to review' }))
    expect(onAdd).toHaveBeenCalledWith(['data', 'blast-radius'])
  })

  it('keeps the Agents tab as it was left while you look at the sets', async () => {
    show()
    await openSets()
    fireEvent.click(screen.getByRole('tab', { name: 'Agents' }))
    expect(screen.getByRole('heading', { name: 'General' })).toBeTruthy()
  })
})
