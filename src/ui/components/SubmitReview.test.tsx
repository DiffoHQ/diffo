// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fixturePr } from '../../forge/fixture.js'
import type { Coverage, OutgoingThread } from '../../shared/review.js'
import type { PrInfo } from '../../shared/types.js'
import type { PublicOutcome, PublicPreview, ReviewEvent } from '../api.js'
import { PrContext } from '../prMode.js'
import { SubmitReview } from './SubmitReview.js'

// Finishing a pull request review is submitting a GitHub review: the body, the
// verdict, then Submit, with every pending comment in full above the button.

afterEach(cleanup)

const PROMPT = 'A reviewer finished reading pull request #482.'

const OUTGOING: OutgoingThread[] = [
  { id: 'p1', anchor: { kind: 'changeset' }, text: 'why the two passes?', fresh: true },
]

const PUBLIC: PublicPreview = {
  drafts: [
    {
      id: 'd1',
      anchor: 'src/upload.ts:11',
      text: 'Cap this delay.\nA runaway backoff will stall the queue.',
      downgraded: false,
      conversation: false,
    },
    {
      id: 'd2',
      anchor: 'src/db.ts',
      text: 'posts on the file',
      downgraded: true,
      conversation: false,
    },
  ],
  replies: [{ id: 'r1', anchor: 'src/upload.ts:40', count: 2, text: 'Agreed, resolving.' }],
  resolves: [{ id: 's1', anchor: 'src/upload.ts:40', resolve: true }],
  canApprove: true,
  pendingReview: false,
}

const COVERAGE: Coverage = {
  viewedHunks: 3,
  totalHunks: 9,
  viewedFiles: 1,
  totalFiles: 4,
  skippedFiles: [],
}

const copied: string[] = []
beforeEach(() => {
  copied.length = 0
  Object.assign(navigator, {
    clipboard: { writeText: vi.fn(async (t: string) => void copied.push(t)) },
  })
})

function show(
  opts: {
    pr?: PrInfo
    pub?: PublicPreview | null
    outgoing?: OutgoingThread[]
    presence?: 'waiting' | 'listening'
    onFinish?: (
      deliver: boolean,
      closing: { note: string; event?: ReviewEvent },
    ) => Promise<{ delivered: boolean; prompt: string; public?: PublicOutcome }>
    onClose?: () => void
    onInvite?: () => void
  } = {},
) {
  const pub = opts.pub === undefined ? PUBLIC : opts.pub
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            outgoing: opts.outgoing ?? OUTGOING,
            prompt: PROMPT,
            ...(pub ? { public: pub } : {}),
          }),
        ),
    ),
  )
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <PrContext.Provider value={opts.pr ?? fixturePr()}>
        <SubmitReview
          coverage={COVERAGE}
          presence={opts.presence ?? 'listening'}
          onFinish={
            opts.onFinish ??
            (async () => ({
              delivered: true,
              prompt: PROMPT,
              public: { posted: 3, resolved: 1, submitted: true, reviewId: 'R1' },
            }))
          }
          onInvite={opts.onInvite ?? (() => {})}
          onClose={opts.onClose ?? (() => {})}
        />
      </PrContext.Provider>
    </QueryClientProvider>,
  )
}

describe('SubmitReview, the shape', () => {
  it("is GitHub's dialog: body first, then a verdict with its meaning, then Submit", async () => {
    show()
    expect(screen.getByRole('dialog', { name: 'Submit review to GitHub' })).toBeTruthy()
    expect(screen.getByText('one review on acme/widgets #482')).toBeTruthy()
    expect(screen.getByText('Retry flaky uploads with jittered backoff')).toBeTruthy()
    expect(screen.getByPlaceholderText('Leave a comment')).toBeTruthy()
    expect(screen.getByRole('tab', { name: 'Write' })).toBeTruthy()
    expect(screen.getByRole('radio', { name: /Approve/ })).toBeTruthy()
    expect(screen.getByText('Submit feedback and approve merging these changes.')).toBeTruthy()
    expect(screen.getByRole('radio', { name: /Comment/ })).toHaveProperty('checked', true)
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /Submit to GitHub/ })).toBeTruthy(),
    )
    // Nothing about the local dialog's bookkeeping.
    expect(screen.queryByText(/Still on you/)).toBeNull()
    expect(screen.queryByText(/Your coverage/)).toBeNull()
    expect(screen.queryByText(/Going out/)).toBeNull()
  })

  it('lists every pending item in full, the reply, the resolve, and the downgrade', async () => {
    show()
    await screen.findByText(
      (_, el) =>
        el?.textContent === 'Cap this delay.\nA runaway backoff will stall the queue.' &&
        el.classList.contains('sub-pending-text'),
    )
    expect(screen.getByText('4')).toBeTruthy()
    expect(
      screen.getByText('post to GitHub with this review; nothing has posted yet', { exact: false }),
    ).toBeTruthy()
    expect(screen.getByText('2 replies')).toBeTruthy()
    expect(screen.getByText('Agreed, resolving.')).toBeTruthy()
    expect(screen.getByText('resolve')).toBeTruthy()
    expect(screen.getByText('line not in the diff; posts on the file')).toBeTruthy()
  })

  it('the agent side is one line in the footer, and the prompt stays out of sight', async () => {
    show()
    const line = await screen.findByText(/Also, privately/)
    expect(line.textContent).toContain('1 private thread and your coverage go to your agent')
    expect(screen.queryByRole('button', { name: /prompt/ })).toBeNull()
    expect(screen.queryByText(PROMPT)).toBeNull()
  })

  it('with no agent, the footer says the prompt is copied instead, and hosts the invite', async () => {
    const onInvite = vi.fn()
    show({ presence: 'waiting', onInvite })
    await screen.findByText(/No agent attached/)
    fireEvent.click(screen.getByRole('button', { name: 'Invite one' }))
    expect(onInvite).toHaveBeenCalled()
  })
})

describe('SubmitReview, the verdict', () => {
  it('a merged pull request takes a comment, not a verdict, and says so inline', async () => {
    show({ pr: fixturePr({ state: 'merged' }) })
    const approve = screen.getByRole('radio', { name: /Approve/ }) as HTMLInputElement
    expect(approve.disabled).toBe(true)
    expect(
      screen.getAllByText('Merged already: GitHub takes comments, not verdicts.'),
    ).toHaveLength(2)
  })

  it('your own pull request cannot be approved or blocked', async () => {
    show({ pub: { ...PUBLIC, canApprove: false } })
    await waitFor(() =>
      expect(
        (screen.getByRole('radio', { name: /Request changes/ }) as HTMLInputElement).disabled,
      ).toBe(true),
    )
    expect(screen.getAllByText(/Your own pull request/)).toHaveLength(2)
  })

  it('a verdict picked before the block lands falls back to Comment, and submits as one', async () => {
    const onFinish = vi.fn(async () => ({ delivered: true, prompt: PROMPT }))
    show({ pub: { ...PUBLIC, canApprove: false }, onFinish })
    // The preview is still in flight: the radios are live, so Approve takes.
    fireEvent.click(screen.getByRole('radio', { name: /Approve/ }))
    expect(screen.getByRole('radio', { name: /Approve/ })).toHaveProperty('checked', true)
    await waitFor(() =>
      expect((screen.getByRole('radio', { name: /Approve/ }) as HTMLInputElement).disabled).toBe(
        true,
      ),
    )
    expect(screen.getByRole('radio', { name: /Comment/ })).toHaveProperty('checked', true)
    fireEvent.change(screen.getByPlaceholderText('Leave a comment'), { target: { value: 'ok' } })
    fireEvent.click(screen.getByRole('button', { name: /Submit to GitHub/ }))
    await waitFor(() =>
      expect(onFinish).toHaveBeenCalledWith(true, { note: 'ok', event: 'COMMENT' }),
    )
  })
})

describe('SubmitReview, submitting', () => {
  it('stays off until there is something for GitHub: a comment, a verdict, or a pending item', async () => {
    show({ pub: { ...PUBLIC, drafts: [], replies: [], resolves: [] } })
    await screen.findByText(/nothing drafted; a comment above still submits a review to GitHub/)
    const submit = screen.getByRole('button', { name: /Submit to GitHub/ }) as HTMLButtonElement
    expect(submit.disabled).toBe(true)
    fireEvent.change(screen.getByPlaceholderText('Leave a comment'), { target: { value: 'LGTM' } })
    expect(submit.disabled).toBe(false)
  })

  it('a preview that failed to load leaves Submit on: the server knows what is pending', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('boom', { status: 500 })),
    )
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={client}>
        <PrContext.Provider value={fixturePr()}>
          <SubmitReview
            coverage={COVERAGE}
            presence="listening"
            onFinish={async () => ({ delivered: true, prompt: PROMPT })}
            onInvite={() => {}}
            onClose={() => {}}
          />
        </PrContext.Provider>
      </QueryClientProvider>,
    )
    await screen.findByText(/could not load what is pending; the review still submits/)
    const submit = screen.getByRole('button', { name: /Submit to GitHub/ }) as HTMLButtonElement
    expect(submit.disabled).toBe(false)
  })

  it('submits with the verdict and the body, then reports what posted and where', async () => {
    const onFinish = vi.fn(async () => ({
      delivered: true,
      prompt: PROMPT,
      public: {
        posted: 3,
        resolved: 1,
        submitted: true,
        reviewId: 'R1',
        url: 'https://github.com/acme/widgets/pull/482#pullrequestreview-1',
      },
    }))
    show({ onFinish })
    await screen.findByText('Agreed, resolving.')
    fireEvent.click(screen.getByRole('radio', { name: /Approve/ }))
    fireEvent.change(screen.getByPlaceholderText('Leave a comment'), {
      target: { value: 'One nit, otherwise good to go' },
    })
    fireEvent.click(screen.getByRole('button', { name: /Submit to GitHub/ }))
    await screen.findByRole('dialog', { name: 'Review submitted to GitHub' })
    expect(onFinish).toHaveBeenCalledWith(true, {
      note: 'One nit, otherwise good to go',
      event: 'APPROVE',
    })
    expect(screen.getByText('Approved')).toBeTruthy()
    expect(screen.getByText('3 comments posted · 1 thread resolved')).toBeTruthy()
    expect(screen.getByRole('link', { name: /Open on GitHub/ })).toBeTruthy()
    expect(screen.getByText(/went to your agent/)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Done' })).toBeTruthy()
    expect(copied).toEqual([])
  })

  it('shows it is working while GitHub answers, and holds Cancel meanwhile', async () => {
    let release!: () => void
    const onFinish = vi.fn(
      () =>
        new Promise<{ delivered: boolean; prompt: string }>((resolve) => {
          release = () => resolve({ delivered: true, prompt: PROMPT })
        }),
    )
    show({ onFinish })
    await screen.findByText('Agreed, resolving.')
    fireEvent.click(screen.getByRole('button', { name: /Submit to GitHub/ }))
    const busy = await screen.findByRole('button', { name: /Submitting to GitHub/ })
    expect((busy as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByRole('button', { name: 'Cancel' }) as HTMLButtonElement).disabled).toBe(
      true,
    )
    release()
    await screen.findByText('Review finished')
  })

  it('with no agent listening, the private side waits for the next poll, and says only that', async () => {
    show({
      presence: 'waiting',
      onFinish: async () => ({
        delivered: false,
        prompt: PROMPT,
        public: { posted: 2, resolved: 0, submitted: true, reviewId: 'R1' },
      }),
    })
    await screen.findByText('Agreed, resolving.')
    fireEvent.click(screen.getByRole('button', { name: /Submit to GitHub/ }))
    await screen.findByText('Private threads and coverage go to your agent on its next poll.')
    expect(screen.queryByText(/clipboard/)).toBeNull()
    expect(copied).toEqual([])
  })

  it('⌘↵ in the body submits', async () => {
    const onFinish = vi.fn(async () => ({ delivered: true, prompt: PROMPT }))
    show({ onFinish })
    await screen.findByText('Agreed, resolving.')
    fireEvent.keyDown(screen.getByPlaceholderText('Leave a comment'), {
      key: 'Enter',
      metaKey: true,
    })
    await waitFor(() => expect(onFinish).toHaveBeenCalled())
  })

  it('a GitHub failure midway names the step and keeps the dialog open to retry', async () => {
    show({
      onFinish: async () => ({
        delivered: false,
        prompt: PROMPT,
        public: {
          posted: 1,
          resolved: 0,
          submitted: false,
          reviewId: 'R1',
          failed: { step: 'submit', message: 'rate limited' },
        },
      }),
    })
    await screen.findByText('Agreed, resolving.')
    // After the stop, the server's pending list is what is left to post: the
    // comment that went out before it must not be offered again.
    vi.mocked(fetch).mockImplementation(
      async () =>
        new Response(
          JSON.stringify({
            outgoing: OUTGOING,
            prompt: PROMPT,
            public: { ...PUBLIC, drafts: [PUBLIC.drafts[1]!] },
          }),
        ),
    )
    fireEvent.click(screen.getByRole('button', { name: /Submit to GitHub/ }))
    await screen.findByText(/GitHub stopped at submit/)
    expect(screen.getByRole('button', { name: /Submit to GitHub/ })).toBeTruthy()
    await waitFor(() => expect(screen.queryByText(/Cap this delay/)).toBeNull())
    expect(screen.getByText('posts on the file')).toBeTruthy()
    expect(screen.getByText('3')).toBeTruthy()
  })

  it('closes from Cancel, the X, and Escape', async () => {
    const onClose = vi.fn()
    show({ onClose })
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(3)
  })
})
