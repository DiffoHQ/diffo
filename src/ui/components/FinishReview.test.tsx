// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Coverage, OutgoingThread, ReviewThread } from '../../shared/review.js'
import type { Presence } from '../api.js'
import type { ThreadItem } from '../threads.js'
import { FinishReview } from './FinishReview.js'

afterEach(cleanup)

const PROMPT = 'A reviewer finished reading your changes in `demo`.\n\nCoverage: 1/4 files read.'

const OUTGOING: OutgoingThread[] = [
  {
    id: 't1',
    anchor: { kind: 'hunk', hunkId: 'h1', path: 'src/db.ts', side: 'new', line: 214 },
    text: 'This drops the table on every version bump — is that still what we want once\nthere are real users with data they care about?',
    fresh: true,
  },
  { id: 't2', anchor: { kind: 'changeset' }, text: 'Split the presence fix out.', fresh: true },
  {
    id: 't3',
    anchor: { kind: 'file', path: 'src/ui/App.tsx' },
    text: 'Still waiting.',
    fresh: false,
  },
]

const CHECK_OFF: ThreadItem[] = [
  {
    thread: { id: 'c1' } as ReviewThread,
    turn: 'yours',
    outcome: 'fixed',
    question: 'extract this into a helper',
    answer: 'done',
    anchor: 'src/parse.ts:88',
    path: 'src/parse.ts',
    updatedAt: '2026-08-12T00:00:00Z',
  },
  {
    thread: { id: 'c2' } as ReviewThread,
    turn: 'unanswered',
    outcome: 'no-answer',
    question: 'why the two passes?',
    answer: null,
    anchor: 'src/highlight.ts',
    path: 'src/highlight.ts',
    updatedAt: '2026-08-12T00:00:00Z',
  },
]

const PARTIAL: Coverage = {
  viewedHunks: 3,
  totalHunks: 9,
  viewedFiles: 1,
  totalFiles: 4,
  skippedFiles: ['a.ts', 'b.ts'],
}

const FULL: Coverage = {
  viewedHunks: 74,
  totalHunks: 74,
  viewedFiles: 22,
  totalFiles: 22,
  skippedFiles: [],
}

const copied: string[] = []
beforeEach(() => {
  copied.length = 0
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify({ outgoing: OUTGOING, prompt: PROMPT }))),
  )
  Object.assign(navigator, {
    clipboard: { writeText: vi.fn(async (t: string) => void copied.push(t)) },
  })
  Object.defineProperty(document, 'execCommand', { value: () => false, configurable: true })
})

function show(
  opts: {
    coverage?: Coverage
    presence?: Presence
    onFinish?: (deliver: boolean) => Promise<{ delivered: boolean; prompt: string }>
    onInvite?: () => void
    onClose?: () => void
    checkOff?: ThreadItem[]
    onResolve?: (threadId: string) => Promise<unknown>
    onReopen?: (threadId: string) => Promise<unknown>
  } = {},
) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <FinishReview
        coverage={opts.coverage ?? PARTIAL}
        presence={opts.presence ?? 'listening'}
        onFinish={opts.onFinish ?? (async () => ({ delivered: true, prompt: PROMPT }))}
        onInvite={opts.onInvite ?? (() => {})}
        onClose={opts.onClose ?? (() => {})}
        checkOff={opts.checkOff ?? []}
        {...(opts.onResolve ? { onResolve: opts.onResolve } : {})}
        {...(opts.onReopen ? { onReopen: opts.onReopen } : {})}
      />
    </QueryClientProvider>,
  )
}

describe('FinishReview — the outgoing batch', () => {
  it('names every comment that leaves the room, and which ones are new', async () => {
    show()
    expect(await screen.findByText('— 2 new · 1 resent')).toBeTruthy()
    expect(screen.getByText('Going out')).toBeTruthy()
    expect(screen.getByText('src/db.ts:214')).toBeTruthy()
    expect(screen.getByText('the whole changeset')).toBeTruthy()
    expect(screen.getByText(/is that still what we want/)).toBeTruthy()
    expect(screen.getAllByText('new')).toHaveLength(2)
    expect(screen.getByText('resent')).toBeTruthy()
  })

  it('discloses the exact prompt rather than a paraphrase of it', async () => {
    show()
    const toggle = await screen.findByText(/view the exact prompt/)
    expect(screen.queryByText(new RegExp(PROMPT.slice(0, 20)))).toBeNull()
    fireEvent.click(toggle)
    expect(await screen.findByText(new RegExp(PROMPT.slice(0, 20)))).toBeTruthy()
  })

  it('peeking at the prompt copies it without finishing anything', async () => {
    const onFinish = vi.fn(async () => ({ delivered: true, prompt: PROMPT }))
    show({ onFinish })
    fireEvent.click(await screen.findByLabelText('Copy the prompt without finishing'))
    await waitFor(() => expect(copied).toEqual([PROMPT]))
    expect(onFinish).not.toHaveBeenCalled()
  })

  it('an empty batch renders no batch section — finishing is still the action', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ outgoing: [], prompt: PROMPT }))),
    )
    show()
    expect(await screen.findByRole('button', { name: /Finish & send/ })).toBeTruthy()
    await waitFor(() => expect(screen.queryByText('Going out')).toBeNull())
  })

  it('still lets you finish when the preview itself fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('nope', { status: 500 })),
    )
    show()
    expect(await screen.findByText(/isn't previewed/)).toBeTruthy()
    expect(screen.getByRole('button', { name: /Finish & send/ })).toBeTruthy()
  })
})

describe('FinishReview — coverage', () => {
  it('one bar, one status line — counts, never file names', async () => {
    show()
    await screen.findByText('Going out')
    expect(screen.getByText('1 of 4 read')).toBeTruthy()
    expect(screen.getByText('3 not read')).toBeTruthy()
    expect(screen.queryByText('a.ts')).toBeNull()
    expect(document.querySelector('.warn')).toBeNull()
  })

  it('names the changed-since-read bucket for what it is — new work, not debt', async () => {
    show({
      coverage: {
        ...PARTIAL,
        changedFiles: ['moved.ts'],
        skippedFiles: ['a.ts'],
      },
    })
    expect(await screen.findByText('1 changed since you read it')).toBeTruthy()
    expect(screen.getByText('2 not read')).toBeTruthy()
  })

  it('reading everything earns the full-bar readout', async () => {
    show({ coverage: FULL })
    expect(await screen.findByText('all 22 files read')).toBeTruthy()
    expect(screen.queryByText(/not read/)).toBeNull()
  })

  it('falls back to hunks when an older payload has no file counts', async () => {
    show({ coverage: { viewedHunks: 9, totalHunks: 9, skippedFiles: [] } })
    expect(await screen.findByText('all 9 hunks read')).toBeTruthy()
  })

  it('never gates: partial coverage still finishes, and a clean send gets out of the way', async () => {
    const onFinish = vi.fn(async () => ({ delivered: true, prompt: PROMPT }))
    const onClose = vi.fn()
    show({ onFinish, onClose })
    fireEvent.click(await screen.findByRole('button', { name: /Finish & send/ }))
    expect(onFinish).toHaveBeenCalledWith(true, { note: '' })
    await waitFor(() => expect(onClose).toHaveBeenCalled())
  })

  it('the copy path stays up — an unconfirmed clipboard is the whole risk there', async () => {
    const onFinish = vi.fn(async () => ({ delivered: false, prompt: PROMPT }))
    const onClose = vi.fn()
    show({ onFinish, onClose, presence: 'waiting' })
    fireEvent.click(await screen.findByRole('button', { name: /Finish & copy prompt/ }))
    expect(await screen.findByText(/Review finished and the prompt copied/)).toBeTruthy()
    expect(onClose).not.toHaveBeenCalled()
  })
})

describe('FinishReview — still on you (check-off first: it mutates the batch)', () => {
  it('lists what came back and hands both directions to the reviewer', async () => {
    const onResolve = vi.fn(async () => undefined)
    const onReopen = vi.fn(async () => undefined)
    show({ checkOff: CHECK_OFF, onResolve, onReopen })
    expect(await screen.findByText('Still on you')).toBeTruthy()
    expect(screen.getByText(/settle these first/)).toBeTruthy()
    expect(screen.getByText('fixed')).toBeTruthy()
    expect(screen.getByText('no answer')).toBeTruthy()

    fireEvent.click(screen.getAllByRole('button', { name: /Done/ })[0]!)
    await waitFor(() => expect(onResolve).toHaveBeenCalledWith('c1'))
    fireEvent.click(screen.getAllByRole('button', { name: /Still not right/ })[1]!)
    await waitFor(() => expect(onReopen).toHaveBeenCalledWith('c2'))
  })

  it('renders above the outgoing batch — debts settle before the batch is confirmed', async () => {
    show({ checkOff: CHECK_OFF })
    await screen.findByText('Going out')
    const labels = Array.from(document.querySelectorAll('.fin-sect-label')).map(
      (el) => el.textContent,
    )
    expect(labels.indexOf('Still on you')).toBeLessThan(labels.indexOf('Going out'))
  })

  it('a departed thread is owed like any other, and says its file went', async () => {
    show({
      checkOff: [
        ...CHECK_OFF,
        { ...CHECK_OFF[0]!, thread: { id: 'c3' } as ReviewThread, gone: true },
      ],
    })
    await screen.findByText('Still on you')
    expect(document.querySelector('.fin-sect-n')!.textContent).toBe('3')
    expect(document.querySelectorAll('.fin-row-anchor-gone')).toHaveLength(1)

    // Reopening one can't put it back on the wire — the batch is scoped to the diff.
    const rows = document.querySelectorAll('.fin-row-checkoff')
    const back = rows[rows.length - 1]!.querySelector('button[title*="reopen"]')!
    expect(back.getAttribute('title')).toMatch(/lands in Not sent/)
    expect(rows[0]!.querySelector('button[title*="reopen"]')!.getAttribute('title')).toMatch(
      /goes out again in this batch/,
    )
  })

  it('no check-off section when nothing came back — an empty half is noise', async () => {
    show()
    await screen.findByText('Going out')
    expect(screen.queryByText('Still on you')).toBeNull()
  })
})

describe('FinishReview — your word (a note, in your own words)', () => {
  it('carries the note into the finish', async () => {
    const onFinish = vi.fn(async () => ({ delivered: true, prompt: PROMPT }))
    show({ onFinish })
    fireEvent.change(await screen.findByPlaceholderText(/LGTM, ship it/), {
      target: { value: 'all good, merge it please' },
    })
    fireEvent.click(screen.getByRole('button', { name: /Finish & send/ }))
    expect(onFinish).toHaveBeenCalledWith(true, { note: 'all good, merge it please' })
  })

  it('offers no verdict to pick — the note is the verdict, and the placeholder teaches it', async () => {
    show()
    await screen.findByText('Going out')
    expect(screen.queryByRole('radio')).toBeNull()
    expect(screen.getByPlaceholderText(/fix these, then show me again/)).toBeTruthy()
  })

  it('all clear — everything read, nothing owed, nothing outgoing — says so plainly', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ outgoing: [], prompt: PROMPT }))),
    )
    show({ coverage: FULL })
    expect(await screen.findByText('✓ every thread settled')).toBeTruthy()
    expect(screen.getByText('nothing going out')).toBeTruthy()
    expect(screen.getByRole('button', { name: /Finish & send/ })).toBeTruthy()
  })
})

describe('FinishReview — send vs copy', () => {
  it('offers copy alongside send, and copying finishes without delivering', async () => {
    const onFinish = vi.fn(async () => ({ delivered: false, prompt: PROMPT }))
    show({ onFinish })
    fireEvent.click(await screen.findByRole('button', { name: /Copy prompt instead/ }))
    expect(onFinish).toHaveBeenCalledWith(false, { note: '' })
    await waitFor(() => expect(copied).toEqual([PROMPT]))
    expect(await screen.findByText(/Review finished and the prompt copied/)).toBeTruthy()
    expect(document.querySelector('.modal-foot')).toBeNull()
    expect(screen.getByLabelText('Close')).toBeTruthy()
  })

  it('with no agent, the amber strip says the transport — and hosts the invite', async () => {
    const onInvite = vi.fn()
    const onFinish = vi.fn(async () => ({ delivered: false, prompt: PROMPT }))
    show({ presence: 'waiting', onFinish, onInvite })
    expect(await screen.findByText(/finishing copies the prompt for you to paste/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: /& send/ })).toBeNull()
    fireEvent.click(screen.getByText('Invite an agent'))
    expect(onInvite).toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: /Finish & copy prompt/ }))
    expect(onFinish).toHaveBeenCalledWith(false, { note: '' })
    await waitFor(() => expect(copied).toEqual([PROMPT]))
  })

  it('never claims a copy that did not happen — and hands over the text', async () => {
    Object.assign(navigator, {
      clipboard: { writeText: vi.fn(async () => Promise.reject(new Error('denied'))) },
    })
    show({ presence: 'waiting', onFinish: async () => ({ delivered: false, prompt: PROMPT }) })
    fireEvent.click(await screen.findByRole('button', { name: /Finish & copy prompt/ }))
    expect(await screen.findByText(/Couldn't reach the clipboard/)).toBeTruthy()
    expect(screen.getByText(new RegExp(PROMPT.slice(0, 20)))).toBeTruthy()
  })

  it('reports a failed finish instead of pretending it sent', async () => {
    show({ onFinish: async () => Promise.reject(new Error('down')) })
    fireEvent.click(await screen.findByRole('button', { name: /Finish & send/ }))
    expect(await screen.findByText(/Nothing was sent/)).toBeTruthy()
  })

  it('closes from the X, the backdrop, Cancel, and Escape', async () => {
    const onClose = vi.fn()
    show({ onClose })
    await screen.findByText('Going out')
    fireEvent.click(screen.getByText('Cancel'))
    fireEvent.click(document.querySelector('.modal-backdrop')!)
    fireEvent.click(screen.getByLabelText('Close'))
    fireEvent.keyDown(document.querySelector('.modal')!, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(4)
  })
})
