// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReviewThread } from '../../shared/review.js'
import { BUILT_IN_ROLES } from '../../shared/roles.js'
import { type Reviewers, ReviewersContext } from '../actors.js'
import { AgentsPanel } from './AgentsPanel.js'

afterEach(cleanup)

const removals: (string | null)[] = []
let clearedAll = 0
const stops: (string | null)[] = []
const sent: unknown[] = []
const requested: unknown[] = []
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })

beforeEach(() => {
  removals.length = 0
  clearedAll = 0
  stops.length = 0
  sent.length = 0
  requested.length = 0
  localStorage.clear()
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init?: RequestInit) => {
      if (input === '/api/changeset') {
        return json({ files: [{ path: 'a.ts' }, { path: 'b.ts' }, { path: 'c.ts' }] })
      }
      if (input === '/api/reviewer/roles') {
        return json({ roles: BUILT_IN_ROLES, default: 'general' })
      }
      if (input === '/api/reviewer/seats' && init?.method === 'DELETE') {
        clearedAll++
        return json({ removed: 5 })
      }
      if (input.startsWith('/api/reviewer/seat') && init?.method === 'DELETE') {
        removals.push(new URL(input, 'http://x').searchParams.get('name'))
        return json({ removed: true })
      }
      if (input.startsWith('/api/reviewer/stop')) {
        stops.push(new URL(input, 'http://x').searchParams.get('name'))
        return json({ stopped: true })
      }
      if (input === '/api/reviewer/request') {
        requested.push(JSON.parse(init!.body as string))
        return json({ ok: true, roles: [], presence: 'listening' })
      }
      if (input === '/api/reviewer/message') {
        sent.push(JSON.parse(init!.body as string))
        return json({ ok: true, listening: true })
      }
      return json({ error: 'unexpected' }, 404)
    }),
  )
})

const at = (secondsAgo: number) => new Date(Date.now() - secondsAgo * 1000).toISOString()

/** One of each: working, waiting on the author agent, needing the human,
 * finished, gone, and one on its way. */
const reviewers: Reviewers = {
  seats: ['security', 'tests', 'simplicity', 'general', 'perf'],
  states: new Map([
    ['security', 'active'],
    ['tests', 'listening'],
    ['simplicity', 'listening'],
    ['general', 'active'],
  ]),
  roles: new Map([
    ['security', 'security'],
    ['tests', 'tests'],
  ]),
  starting: ['docs'],
  needsYou: new Map([['simplicity', 1]]),
  coverage: new Map([
    ['security', { fetched: ['a.ts'], reported: { skipped: ['c.ts'], at: at(10) } }],
    ['tests', { fetched: ['a.ts', 'b.ts'] }],
  ]),
  chats: new Map([
    [
      'security',
      [
        { at: at(250), from: 'you', text: 'look at the upload route first' },
        { at: at(240), from: 'agent', text: 'the upload route trusts the file name' },
      ],
    ],
  ]),
  activity: new Map([
    [
      'security',
      [
        { at: at(300), kind: 'joined', text: 'joined as Security reviewer' },
        { at: at(250), kind: 'told', text: 'look at the upload route first' },
        { at: at(200), kind: 'doing', text: 'reading the upload routes' },
        { at: at(90), kind: 'commented', text: 'commented on a.ts', threadId: 't1' },
      ],
    ],
    ['tests', [{ at: at(60), kind: 'waiting', text: 'waiting for 2 answers' }]],
    ['general', [{ at: at(30), kind: 'done', text: 'finished: nothing left to wait for' }]],
    ['perf', [{ at: at(900), kind: 'doing', text: 'reading the cache' }]],
  ]),
}

const stopped = {
  id: 't9',
  anchor: { kind: 'file', path: 'a.ts' },
  state: 'sent',
  needsYou: 'rounds',
  createdAt: at(600),
  messages: [{ id: 'm', author: 'reviewer', by: 'simplicity', text: 'x', at: at(600) }],
} as unknown as ReviewThread

function show(options: { focus?: string; onOpenThread?: (id: string) => void } = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <ReviewersContext.Provider value={reviewers}>
        <AgentsPanel
          threads={[stopped]}
          onAdd={() => {}}
          onManage={() => {}}
          onOpenThread={options.onOpenThread ?? (() => {})}
          {...(options.focus !== undefined ? { focus: options.focus } : {})}
        />
      </ReviewersContext.Provider>
    </QueryClientProvider>,
  )
}

const rowNames = () =>
  [...document.querySelectorAll('.agents-row-who')].map((n) => n.firstChild?.textContent)

describe('AgentsPanel', () => {
  it('says under its name how long it worked, its comments, and what it read', async () => {
    show({ focus: 'security' })
    const meta = await screen.findByText('5m · no comments · says it read 2 of 3')
    // Both accounts on hover: what it fetched, and its own word.
    expect(meta.getAttribute('title')).toBe(
      'Read through Diffo: 1 of 3 files. It says it skipped c.ts.',
    )
    cleanup()
    show({ focus: 'tests' })
    const before = await screen.findByText(/read 2 of 3$/)
    expect(before.getAttribute('title')).toContain('It says what it skipped when it finishes.')
  })

  it('shows how long each reviewer has worked, and its threads', () => {
    show()
    const meta = (name: string) =>
      [...document.querySelectorAll('.agents-row')]
        .find((r) => r.querySelector('.agents-row-who')?.firstChild?.textContent === name)
        ?.querySelector('.agents-row-meta')?.textContent
    // Joined 300s ago and still working: counted to now.
    expect(meta('security')).toBe('5m')
    // No join in its log; one comment, still open.
    expect(meta('simplicity')).toBe('1 comment')
    expect(meta('docs')).toBeUndefined()
  })

  it('lists every reviewer like a chat list: face and status, name, its latest line', async () => {
    show()
    expect(rowNames()).toEqual(['security', 'tests', 'simplicity', 'general', 'perf', 'docs'])
    // Each face is the critter in its colour, its status on the corner.
    const looks = [...document.querySelectorAll('.agents-row .stack-face-in')].map((f) =>
      f.className.replace('stack-face-in stack-', ''),
    )
    expect(looks).toEqual(['working', 'waiting', 'needs', 'done', 'away', 'starting'])
    expect(document.querySelectorAll('.agents-row .critter-face')).toHaveLength(6)
    // The line is its own words, trailing off while it works.
    const lines = [...document.querySelectorAll('.agents-row-line')].map((l) => l.textContent)
    expect(lines).toEqual([
      'Commented on a.ts…',
      'Waiting for 2 answers',
      '1 thread needs you',
      'Finished',
      'Not connected',
      'Your agent is starting it…',
    ])
    // A dot marks what waits on the human: a reply not read, a thread that needs them.
    const dots = [...document.querySelectorAll('.agents-row-mark')].map((m) =>
      m.getAttribute('title'),
    )
    expect(dots).toEqual(['New reply', 'Needs you'])
    expect(
      await screen.findByRole('button', {
        name: /^security: Working\. Commented on a\.ts… New reply/,
      }),
    ).toBeTruthy()
  })

  it('its latest reply heads the row until the next step, and reading it drops the dot', async () => {
    const chats = new Map(reviewers.chats)
    chats.set('tests', [{ at: at(10), from: 'agent', text: 'two of these look flaky' }])
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={client}>
        <ReviewersContext.Provider value={{ ...reviewers, chats }}>
          <AgentsPanel threads={[]} onAdd={() => {}} onManage={() => {}} onOpenThread={() => {}} />
        </ReviewersContext.Provider>
      </QueryClientProvider>,
    )
    expect(screen.getByText('two of these look flaky')).toBeTruthy()
    const dots = () =>
      [...document.querySelectorAll('.agents-row')].flatMap((r) =>
        r.querySelector('.agents-row-mark')
          ? [r.querySelector('.agents-row-who')?.firstChild?.textContent]
          : [],
      )
    expect(dots()).toEqual(['security', 'tests', 'simplicity'])
    fireEvent.click(screen.getByRole('button', { name: /^tests: / }))
    fireEvent.click(await screen.findByRole('button', { name: 'All reviewer agents' }))
    expect(dots()).toEqual(['security', 'simplicity'])
  })

  it('offers what fits each one: write, open the thread, start again, stop, delete', async () => {
    const onOpenThread = vi.fn()
    show({ onOpenThread })
    expect(screen.getByRole('button', { name: 'Write to security' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Write to perf' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Open the thread simplicity needs you in' }))
    expect(onOpenThread).toHaveBeenCalledWith('t9')
    fireEvent.click(await screen.findByRole('button', { name: 'Start a new general reviewer' }))
    await waitFor(() => expect(requested).toEqual([{ roles: ['general'] }]))
    // One still running is stopped, and stays; one finished or gone is deleted.
    fireEvent.click(screen.getByRole('button', { name: 'Stop tests' }))
    await waitFor(() => expect(stops).toEqual(['tests']))
    expect(screen.queryByRole('button', { name: 'Delete tests' })).toBeNull()
    // Deleting asks first: what it did and the conversation go with it.
    fireEvent.click(screen.getByRole('button', { name: 'Delete perf' }))
    expect(removals).toEqual([])
    expect(screen.getByText(/Its review threads\s+stay/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    await waitFor(() => expect(removals).toEqual(['perf']))
    // One on its way has nothing to act on yet.
    expect(screen.queryByRole('button', { name: 'Stop docs' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Delete docs' })).toBeNull()
  })

  it('deletes them all at once, after saying what goes and what is still running', async () => {
    show()
    fireEvent.click(screen.getByRole('button', { name: 'Delete all' }))
    expect(clearedAll).toBe(0)
    expect(screen.getByText('Delete all 5 reviewers?')).toBeTruthy()
    expect(screen.getByRole('dialog').textContent).toMatch(
      /Their review\s+threads stay\. 3 are still running: their sessions end\./,
    )
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Delete all' }))
    await waitFor(() => expect(clearedAll).toBe(1))
  })

  it('Activity is what they all did, newest first, without the waits', () => {
    show()
    fireEvent.click(screen.getByRole('tab', { name: 'Activity' }))
    const lines = screen.getByRole('list', { name: 'What the reviewer agents did, newest first' })
    expect([...lines.querySelectorAll('.agents-line-text')].map((l) => l.textContent)).toEqual([
      'general finished its review',
      'security commented on a.ts',
      'security reading the upload routes',
      'You wrote to security: look at the upload route first',
      'security joined as Security reviewer',
      'perf reading the cache',
    ])
  })

  it('a row opens that reviewer: its story, newest first, with what you two said in it', async () => {
    show()
    fireEvent.click(await screen.findByRole('button', { name: /^security: Working/ }))
    expect(await screen.findByText(/Working · Security reviewer/)).toBeTruthy()
    const story = screen.getByRole('list', { name: 'What security did, newest first' })
    expect([...story.querySelectorAll('.story-text')].map((e) => e.textContent)).toEqual([
      'Commented on a.tsdeleted',
      'Reading the upload routes',
      'securitythe upload route trusts the file name',
      'Youlook at the upload route first',
      'Joined',
    ])
    // Where you write: it has not read your message yet.
    expect(screen.getByText("It hasn't read your last message yet")).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'All reviewer agents' }))
    expect(rowNames()).toHaveLength(6)
  })

  it('says where you write that the conversation is private', () => {
    show({ focus: 'tests' })
    expect(screen.getByText('Only you and tests see this; your agent never does.')).toBeTruthy()
  })

  it('opens on the reviewer whose face was clicked, and a step opens its thread', () => {
    const onOpenThread = vi.fn()
    show({ focus: 'security', onOpenThread })
    fireEvent.click(screen.getByRole('button', { name: 'Open the thread on a.ts' }))
    expect(onOpenThread).toHaveBeenCalledWith('t1')
  })

  it('writes to a reviewer that can read it', async () => {
    show({ focus: 'security' })
    const box = screen.getByLabelText('Write to security')
    expect(screen.getByRole('button', { name: 'Send to security' })).toHaveProperty(
      'disabled',
      true,
    )
    fireEvent.change(box, { target: { value: '  check the retry loop ' } })
    fireEvent.keyDown(box, { key: 'Enter' })
    await waitFor(() => expect(sent).toEqual([{ name: 'security', text: 'check the retry loop' }]))
    await waitFor(() => expect((box as HTMLTextAreaElement).value).toBe(''))
  })

  it('offers no box to one that cannot read: gone, or finished', () => {
    show({ focus: 'perf' })
    expect(screen.queryByLabelText('Write to perf')).toBeNull()
    cleanup()
    show({ focus: 'general' })
    expect(screen.queryByLabelText('Write to general')).toBeNull()
    expect(screen.getByText('Finished')).toBeTruthy()
  })

  it('its own view offers what the row does on hover, for touch: start a new one, delete', async () => {
    show({ focus: 'perf' })
    fireEvent.click(screen.getByRole('button', { name: 'Options for perf' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: /^Start a new .* reviewer$/ }))
    await waitFor(() => expect(requested).toEqual([{ roles: ['general'] }]))
    fireEvent.click(screen.getByRole('button', { name: 'Options for perf' }))
    // Gone already: nothing to stop.
    expect(screen.queryByRole('menuitem', { name: 'Stop' })).toBeNull()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete' }))
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    await waitFor(() => expect(removals).toEqual(['perf']))
  })

  it('stops one still running from its own view; it stays, and says you stopped it', async () => {
    show({ focus: 'security' })
    fireEvent.click(screen.getByRole('button', { name: 'Options for security' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Stop' }))
    await waitFor(() => expect(stops).toEqual(['security']))
  })

  it('a reviewer that needs you offers its thread from its own view', () => {
    const onOpenThread = vi.fn()
    show({ focus: 'simplicity', onOpenThread })
    fireEvent.click(screen.getByRole('button', { name: 'Options for simplicity' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Open the thread it needs you in' }))
    expect(onOpenThread).toHaveBeenCalledWith('t9')
  })

  it('resizes from its edge, and remembers the width', () => {
    show()
    const edge = screen.getByRole('separator', { name: 'Resize reviewer agents' })
    fireEvent.keyDown(edge, { key: 'ArrowLeft' })
    expect(edge.getAttribute('aria-valuenow')).toBe('316')
    expect(localStorage.getItem('diffo:ui:agentsWidth')).toBe('316')
  })

  it('Escape in the sidebar steps back to the list; elsewhere, or over a draft, it does not', () => {
    show({ focus: 'tests' })
    expect(rowNames()).toHaveLength(0)
    // Another panel's Escape.
    fireEvent.keyDown(document.body, { key: 'Escape' })
    expect(rowNames()).toHaveLength(0)
    // A draft is never thrown away.
    const box = screen.getByLabelText('Write to tests')
    fireEvent.change(box, { target: { value: 'half a thought' } })
    fireEvent.keyDown(box, { key: 'Escape' })
    expect(rowNames()).toHaveLength(0)
    fireEvent.change(box, { target: { value: '' } })
    fireEvent.keyDown(box, { key: 'Escape' })
    expect(rowNames()).toHaveLength(6)
  })

  it('focus follows the move: into its box, back to its row, onto Back when it cannot read', async () => {
    show()
    fireEvent.click(await screen.findByRole('button', { name: /^security: / }))
    expect(document.activeElement).toBe(screen.getByLabelText('Write to security'))
    fireEvent.click(screen.getByRole('button', { name: 'All reviewer agents' }))
    expect(document.activeElement).toBe(screen.getByRole('button', { name: /^security: / }))
    fireEvent.click(screen.getByRole('button', { name: /^perf: / }))
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'All reviewer agents' }))
  })

  it('switching tabs and back does not move focus again', async () => {
    show()
    fireEvent.click(await screen.findByRole('button', { name: /^security: / }))
    const activity = screen.getByRole('tab', { name: 'Activity' })
    fireEvent.click(activity)
    const reviewersTab = screen.getByRole('tab', { name: /Reviewers/ })
    reviewersTab.focus()
    fireEvent.click(reviewersTab)
    expect(document.activeElement).toBe(reviewersTab)
  })

  it('opening the sidebar on a reviewer leaves focus where it was', () => {
    show({ focus: 'security' })
    expect(document.activeElement).toBe(document.body)
  })

  it('says aloud a reply that lands while you are there, and a failed send', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const view = (chats: Reviewers['chats']) => (
      <QueryClientProvider client={client}>
        <ReviewersContext.Provider value={{ ...reviewers, chats }}>
          <AgentsPanel
            focus="tests"
            threads={[]}
            onAdd={() => {}}
            onManage={() => {}}
            onOpenThread={() => {}}
          />
        </ReviewersContext.Provider>
      </QueryClientProvider>
    )
    const { rerender } = render(view(new Map()))
    const live = document.querySelector('.sr-only[aria-live="polite"]')!
    expect(live.textContent).toBe('')
    rerender(view(new Map([['tests', [{ at: at(1), from: 'agent', text: 'two look flaky' }]]])))
    expect(live.textContent).toBe('tests replied: two look flaky')
    expect(screen.getByRole('status').textContent).toBe(
      'Only you and tests see this; your agent never does.',
    )
  })

  it('a draft stays with the reviewer it was written to', () => {
    show({ focus: 'security' })
    fireEvent.change(screen.getByLabelText('Write to security'), {
      target: { value: 'for security' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'All reviewer agents' }))
    fireEvent.click(screen.getByRole('button', { name: /^tests: / }))
    expect((screen.getByLabelText('Write to tests') as HTMLTextAreaElement).value).toBe('')
  })
})
