// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fixturePr } from '../../forge/fixture.js'
import type { ReviewThread } from '../../shared/review.js'
import type { Changeset, PrInfo } from '../../shared/types.js'
import { PrContext } from '../prMode.js'
import { bySide, threadItems, threadTurn } from '../threads.js'
import { CommentBox } from './CommentBox.js'
import { Header } from './Header.js'
import { ReadingPane } from './ReadingPane.js'
import { ThreadRail } from './ThreadRail.js'
import { promotionText, type ReviewActions, ThreadList } from './Threads.js'

// The pull request's side of the UI: the composer's switch, public and private
// cards, the bridges between them, the header chips, and the rail's turns.

afterEach(cleanup)

const pr = fixturePr()

function onPr(node: ReactNode) {
  return <PrContext.Provider value={pr}>{node}</PrContext.Provider>
}

function actions(over: Partial<ReviewActions> = {}): ReviewActions {
  return {
    create: vi.fn(async () => thread({})),
    reply: vi.fn(async () => ({})),
    send: vi.fn(async () => ({ delivered: true })),
    resolve: vi.fn(async () => ({})),
    reopen: vi.fn(async () => ({})),
    remove: vi.fn(async () => ({})),
    ...over,
  }
}

function thread(over: Partial<ReviewThread>): ReviewThread {
  const at = '2026-09-24T10:00:00Z'
  return {
    id: 't1',
    anchor: { kind: 'hunk', hunkId: 'h1', path: 'src/upload.ts', side: 'new', line: 11 },
    state: 'open',
    codeContext: null,
    codeChanged: false,
    messages: [{ id: 'm1', author: 'reviewer', text: 'consider a cap', at }],
    createdAt: at,
    updatedAt: at,
    ...over,
  }
}

describe('the composer on a pull request', () => {
  it('shows the audience switch and starts on the PR side: no intents, Add to review', () => {
    const onSubmit = vi.fn()
    render(
      onPr(<CommentBox title="Comment" placeholder="…" onSubmit={onSubmit} onCancel={() => {}} />),
    )
    expect(screen.getByRole('radio', { name: /Comment on PR/ })).toHaveProperty(
      'ariaChecked',
      'true',
    )
    expect(screen.getByRole('button', { name: /Add to review/ })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Send to agent/ })).toBeNull()
    expect(screen.getByText(/Posts to GitHub when you submit/)).toBeTruthy()
    fireEvent.change(screen.getByPlaceholderText('…'), { target: { value: 'cap the delay' } })
    fireEvent.click(screen.getByRole('button', { name: /Add to review/ }))
    expect(onSubmit).toHaveBeenCalledWith('cap the delay', false, undefined, 'pr')
  })

  it('flipping to Ask agent leaves one action — asking is sending — and no intent chips', () => {
    const onSubmit = vi.fn()
    const onSend = vi.fn()
    const { container } = render(
      onPr(
        <CommentBox
          title="Comment"
          placeholder="…"
          onSubmit={onSubmit}
          onSend={onSend}
          onCancel={() => {}}
        />,
      ),
    )
    expect(container.querySelector('.cbox-pr')).toBeTruthy()
    fireEvent.click(screen.getByRole('radio', { name: /Ask agent/ }))
    expect(container.querySelector('.cbox-agent')).toBeTruthy()
    expect(screen.getByRole('button', { name: /Send to agent/ })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Add comment/ })).toBeNull()
    expect(screen.queryByRole('button', { name: /Add to review/ })).toBeNull()
    expect(screen.getByText(/stays on this machine/)).toBeTruthy()
    expect(screen.queryByRole('radio', { name: 'Question' })).toBeNull()
    fireEvent.change(screen.getByPlaceholderText('…'), { target: { value: 'is it tested?' } })
    fireEvent.click(screen.getByRole('button', { name: /Send to agent/ }))
    expect(onSend).toHaveBeenCalledWith('is it tested?', false, undefined)
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('⌘. flips the side from the textarea', () => {
    render(
      onPr(
        <CommentBox
          title="Comment"
          placeholder="…"
          onSubmit={() => {}}
          onSend={() => {}}
          onCancel={() => {}}
        />,
      ),
    )
    fireEvent.keyDown(screen.getByPlaceholderText('…'), { key: '.', metaKey: true })
    expect(screen.getByRole('radio', { name: /Ask agent/ })).toHaveProperty('ariaChecked', 'true')
    fireEvent.keyDown(screen.getByPlaceholderText('…'), { key: '.', metaKey: true })
    expect(screen.getByRole('radio', { name: /Comment on PR/ })).toHaveProperty(
      'ariaChecked',
      'true',
    )
  })

  it('off a pull request nothing changes: no switch, three-argument submit', () => {
    const onSubmit = vi.fn()
    render(<CommentBox title="Comment" placeholder="…" onSubmit={onSubmit} onCancel={() => {}} />)
    expect(screen.queryByRole('radio', { name: /Comment on PR/ })).toBeNull()
    fireEvent.change(screen.getByPlaceholderText('…'), { target: { value: 'plain' } })
    fireEvent.click(screen.getByRole('button', { name: /Add comment/ }))
    expect(onSubmit).toHaveBeenCalledWith('plain', false, undefined)
  })
})

describe('public and private cards on a pull request', () => {
  it('a draft is a blue public card with no Send, a discard, and no way to the agent', () => {
    const acts = actions()
    const draft = thread({ audience: 'pr' })
    const { container } = render(
      onPr(<ThreadList threads={[draft]} actions={acts} agentConnected />),
    )
    expect(container.querySelector('.thread-public')).toBeTruthy()
    expect(screen.getByText('PR comment')).toBeTruthy()
    expect(screen.getByText('Draft')).toBeTruthy()
    expect(screen.getByText(/posts when you submit/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: /^Send$/ })).toBeNull()
    expect(screen.getByRole('button', { name: /Discard draft/ })).toBeTruthy()
    expect(screen.getByText(/· draft/)).toBeTruthy()
    // The row is GitHub's: nothing on a public card reaches the agent.
    expect(screen.queryByRole('button', { name: /Ask your agent/ })).toBeNull()
    expect(screen.queryByRole('button', { name: /agent/i })).toBeNull()
  })

  it('an imported GitHub thread shows the login, the link, and queues its resolve', () => {
    const acts = actions()
    const imported = thread({
      id: 'gh:T1',
      audience: 'pr',
      state: 'sent',
      github: {
        threadId: 'T1',
        kind: 'inline',
        resolved: false,
        outdated: false,
        url: 'https://github.com/acme/widgets/pull/482#r1',
      },
      messages: [
        {
          id: 'gh:C1',
          author: 'github',
          text: 'why not AbortSignal?',
          at: '2026-09-20T12:00:00Z',
          github: { id: 'C1', user: { login: 'jonas', avatarUrl: '' } },
        },
        { id: 'm2', author: 'reviewer', text: 'node 18 is gone', at: '2026-09-24T10:00:00Z' },
      ],
    })
    render(onPr(<ThreadList threads={[imported]} actions={acts} />))
    expect(screen.getByText('jonas')).toBeTruthy()
    expect(screen.getByText('On GitHub')).toBeTruthy()
    expect(screen.getByRole('link', { name: /GitHub/ }).getAttribute('href')).toContain('#r1')
    expect(screen.getByText(/reply posts when you submit/)).toBeTruthy()
    // No delete for a thread GitHub owns; Resolve is queued, not sent.
    expect(screen.queryByRole('button', { name: /delete this thread/ })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /^Resolve$/ }))
    expect(acts.resolve).toHaveBeenCalledWith('gh:T1')
  })

  it('a private thread is amber-dashed and can be posted as a PR comment, suggestion first', () => {
    const acts = actions()
    const priv = thread({
      state: 'sent',
      intent: 'fix',
      messages: [
        { id: 'm1', author: 'reviewer', text: 'cap it', at: '2026-09-24T10:00:00Z' },
        {
          id: 'm2',
          author: 'agent',
          text: 'Here you go:\n```suggestion\nawait sleep(Math.min(delay, maxDelay))\n```\nRan the tests.',
          at: '2026-09-24T10:01:00Z',
        },
      ],
    })
    const { container } = render(onPr(<ThreadList threads={[priv]} actions={acts} />))
    expect(container.querySelector('.thread-private')).toBeTruthy()
    expect(screen.getByText('Private')).toBeTruthy()
    expect(promotionText(priv)).toBe('```suggestion\nawait sleep(Math.min(delay, maxDelay))\n```')
    fireEvent.click(screen.getByRole('button', { name: /Post as PR comment/ }))
    const box = screen.getByPlaceholderText(/as GitHub will show it/) as HTMLTextAreaElement
    expect(box.value).toContain('```suggestion')
    fireEvent.change(box, { target: { value: box.value.replace('Math.min', 'clamp') } })
    fireEvent.click(screen.getByRole('button', { name: /Add to review/ }))
    expect(acts.create).toHaveBeenCalledWith(
      priv.anchor,
      expect.stringContaining('clamp'),
      undefined,
      { audience: 'pr' },
    )
  })

  it('a queued resolve stays visible on the collapsed card, apart from one already on GitHub', () => {
    const gh = (id: string, queued?: ReviewThread['queued']) =>
      thread({
        id,
        audience: 'pr',
        state: 'resolved',
        github: { threadId: id, kind: 'inline', resolved: queued === undefined, outdated: false },
        ...(queued ? { queued } : {}),
      })
    const { container } = render(
      onPr(
        <ThreadList threads={[gh('queued', { resolve: true }), gh('done')]} actions={actions()} />,
      ),
    )
    const queued = container.querySelector('[data-thread-id="queued"].thread-collapsed')!
    expect(queued.textContent).toContain('resolves when you submit')
    const done = container.querySelector('[data-thread-id="done"].thread-collapsed')!
    expect(done.textContent).not.toContain('when you submit')
  })

  it('renders a private aside nested inside its public parent', () => {
    const parent = thread({ id: 'p', audience: 'pr' })
    const aside = thread({
      id: 'a',
      parentId: 'p',
      messages: [
        { id: 'm', author: 'reviewer', text: 'privately: why?', at: '2026-09-24T10:00:00Z' },
      ],
    })
    const { container } = render(onPr(<ThreadList threads={[parent, aside]} actions={actions()} />))
    const parentCard = container.querySelector('[data-thread-id="p"]')!
    expect(parentCard.querySelector('.thread-asides [data-thread-id="a"]')).toBeTruthy()
    expect(container.querySelectorAll('.thread-list > .thread')).toHaveLength(1)
  })
})

describe("the agent's suggested PR comment inside a private thread", () => {
  const at = '2026-09-24T10:01:00Z'
  const suggested = (over: Partial<ReviewThread> = {}) =>
    thread({
      state: 'addressed',
      messages: [
        {
          id: 'm1',
          author: 'reviewer',
          text: 'resets the streak if late?',
          at: '2026-09-24T10:00:00Z',
        },
        {
          id: 'm2',
          author: 'agent',
          text: 'Yes — no test covers the late case. Worktree restored.',
          at,
          prComment: {
            text: 'Late completions reset the streak here.\n\n```suggestion\nconst streak = today > due ? streak : 0\n```',
          },
        },
      ],
      ...over,
    })

  it('renders under the reply with Add to review, Edit and Dismiss; the foot bridge steps aside', () => {
    const acts = actions({ dismissPrComment: vi.fn(async () => ({})) })
    const { container } = render(onPr(<ThreadList threads={[suggested()]} actions={acts} />))
    const block = screen.getByTestId('pr-suggestion')
    expect(block.textContent).toContain('Suggested PR comment')
    expect(block.textContent).toContain('Late completions reset the streak here.')
    // The comment renders as GitHub will show it: the suggestion block is a code block, not raw fences.
    expect(block.querySelector('pre, code')).toBeTruthy()
    expect(container.querySelector('.thread-badge-pr')!.textContent).toContain(
      'suggests a PR comment',
    )
    expect(screen.queryByRole('button', { name: /Post as PR comment/ })).toBeNull()

    fireEvent.click(within(block).getByRole('button', { name: /^Add to review$/ }))
    expect(acts.create).toHaveBeenCalledWith(
      suggested().anchor,
      expect.stringContaining('Late completions reset the streak here.'),
      undefined,
      { audience: 'pr', origin: { threadId: 't1', messageId: 'm2' } },
    )
  })

  it('Edit opens the PR composer in place, prefilled; the edited text is what joins the review', () => {
    const acts = actions()
    render(onPr(<ThreadList threads={[suggested()]} actions={acts} />))
    fireEvent.click(
      within(screen.getByTestId('pr-suggestion')).getByRole('button', { name: /^Edit$/ }),
    )
    const box = screen.getByPlaceholderText(/as GitHub will show it/) as HTMLTextAreaElement
    expect(box.value).toContain('```suggestion')
    fireEvent.change(box, { target: { value: 'Keep the streak when late?' } })
    fireEvent.click(screen.getByRole('button', { name: /Add to review/ }))
    expect(acts.create).toHaveBeenCalledWith(
      suggested().anchor,
      'Keep the streak when late?',
      undefined,
      {
        audience: 'pr',
        origin: { threadId: 't1', messageId: 'm2' },
      },
    )
  })

  it('Dismiss passes on it and leaves the thread open; a decided or superseded one is a receipt', () => {
    const acts = actions({ dismissPrComment: vi.fn(async () => ({})) })
    render(onPr(<ThreadList threads={[suggested()]} actions={acts} />))
    fireEvent.click(screen.getByRole('button', { name: /dismiss this suggested comment/ }))
    expect(acts.dismissPrComment).toHaveBeenCalledWith('t1', 'm2')
    expect(acts.resolve).not.toHaveBeenCalled()
    cleanup()

    const decided = suggested()
    decided.messages[1]!.prComment!.outcome = {
      kind: 'added',
      draftThreadId: 'd',
      edited: true,
      at,
    }
    const { container } = render(onPr(<ThreadList threads={[decided]} actions={acts} />))
    expect(screen.getByTestId('pr-suggestion-receipt').textContent).toContain(
      'Suggested PR comment · added to your review, edited',
    )
    expect(screen.queryByTestId('pr-suggestion')).toBeNull()
    // With nothing live, the manual bridge is back.
    expect(screen.getByRole('button', { name: /Post as PR comment/ })).toBeTruthy()
    expect(container.querySelector('.thread-badge-pr')).toBeNull()
    cleanup()

    const redrafted = suggested({
      messages: [
        ...suggested().messages,
        { id: 'm3', author: 'reviewer', text: 'mention the until bound too', at },
        {
          id: 'm4',
          author: 'agent',
          text: 'done',
          at,
          prComment: { text: 'v2, with the until bound.' },
        },
      ],
    })
    render(onPr(<ThreadList threads={[redrafted]} actions={acts} />))
    expect(screen.getByTestId('pr-suggestion-receipt').textContent).toContain('superseded')
    expect(screen.getByTestId('pr-suggestion').textContent).toContain('v2, with the until bound.')
  })

  it('a draft made from the suggestion wears its origin', () => {
    const draft = thread({
      id: 'd',
      audience: 'pr',
      origin: { threadId: 't1', messageId: 'm2', edited: true },
      messages: [{ id: 'x', author: 'reviewer', text: 'Keep the streak when late?', at }],
    })
    const { container } = render(onPr(<ThreadList threads={[draft]} actions={actions()} />))
    // In the byline, beside "draft" — not a third badge on the head.
    expect(container.querySelector('.cmt-origin')!.textContent).toBe(' · from your agent, edited')
    expect(container.querySelectorAll('.thread-head .thread-badge')).toHaveLength(1)
  })

  it("a receipt shows the agent's version on request, and a dismissal can be undone", () => {
    const acts = actions({ restorePrComment: vi.fn(async () => ({})) })
    const dismissed = suggested()
    dismissed.messages[1]!.prComment!.outcome = { kind: 'dismissed', at }
    render(onPr(<ThreadList threads={[dismissed]} actions={acts} />))
    const receipt = screen.getByTestId('pr-suggestion-receipt')
    expect(receipt.textContent).not.toContain('Late completions reset the streak here.')
    fireEvent.click(within(receipt).getByRole('button', { name: /show the suggested comment/ }))
    expect(receipt.textContent).toContain('Late completions reset the streak here.')
    fireEvent.click(within(receipt).getByRole('button', { name: /hide the suggested comment/ }))
    expect(receipt.textContent).not.toContain('Late completions reset the streak here.')
    fireEvent.click(within(receipt).getByRole('button', { name: /^Undo$/ }))
    expect(acts.restorePrComment).toHaveBeenCalledWith('t1', 'm2')
    cleanup()

    // Added: no Undo — the draft is the way back (discarding it restores the suggestion).
    const added = suggested()
    added.messages[1]!.prComment!.outcome = { kind: 'added', draftThreadId: 'd', edited: false, at }
    render(onPr(<ThreadList threads={[added]} actions={acts} />))
    expect(screen.queryByRole('button', { name: /^Undo$/ })).toBeNull()
    expect(screen.getByRole('button', { name: /show the suggested comment/ })).toBeTruthy()
  })

  it('the rail row says the thread suggests a comment', () => {
    const items = threadItems([suggested()])
    render(onPr(<ThreadRail items={items} pr />))
    expect(document.querySelector('.crow-pill-pr')!.textContent).toContain('suggests')
  })
})

describe('replying on a posted public thread', () => {
  it('is a GitHub reply, never a hand-over to the agent, even with an agent attached', () => {
    const posted = thread({
      audience: 'pr',
      state: 'sent',
      github: { threadId: 'x', kind: 'inline', resolved: false, outdated: false },
    })
    render(onPr(<ThreadList threads={[posted]} actions={actions()} agentConnected />))
    fireEvent.click(screen.getByRole('button', { name: /Reply on GitHub/ }))
    fireEvent.change(screen.getByPlaceholderText(/reply on GitHub/), {
      target: { value: 'agreed' },
    })
    expect(screen.queryByRole('button', { name: /Reply & send/ })).toBeNull()
    const reply = screen.getByRole('button', { name: /^Reply/ })
    expect(reply.getAttribute('title')).toMatch(/posts when you submit/)
  })
})

describe('the header on a pull request', () => {
  function changesetOn(info: PrInfo): Changeset {
    return {
      version: 1,
      spec: { kind: 'branch', base: 'origin/main' },
      repo: { path: '/x', name: 'widgets', branch: 'diffo/pr-482', worktree: 'pr-482' },
      files: [],
      stats: { files: 3, additions: 40, deletions: 2 },
      pr: info,
    }
  }

  it('the title owns the row; author, branches, CI and reviews wait in the card', () => {
    render(
      <Header
        changeset={changesetOn(pr)}
        review={{ openComments: 2, publicDrafts: 1, onFinishReview: () => {} }}
      />,
    )
    const title = screen.getByRole('button', { name: /#482.*Retry flaky uploads/ })
    expect(screen.queryByText('mira-k')).toBeNull()
    expect(screen.queryByText('CI passing')).toBeNull()
    expect(screen.queryByText('fix/upload-retry')).toBeNull()
    expect(screen.queryByText('diffo/pr-482')).toBeNull()
    expect(screen.getByRole('button', { name: /Submit review \(1\)/ })).toBeTruthy()
    fireEvent.click(title)
    // A popover, not a dialog: it takes no focus and traps none.
    const card = screen.getByRole('region', { name: 'pull request details' })
    expect(within(card).getByText('mira-k')).toBeTruthy()
    expect(within(card).getByText('fix/upload-retry')).toBeTruthy()
    expect(within(card).getByText('main')).toBeTruthy()
    expect(within(card).getByText(/CI passing · pushed/)).toBeTruthy()
    expect(within(card).queryByText('Add jitter to retry delay')).toBeNull()
    fireEvent.click(within(card).getByRole('button', { name: '1 commit' }))
    const commit = within(card).getByRole('link', { name: /Add jitter to retry delay/ })
    expect(commit.getAttribute('href')).toBe(`${pr.url}/commits/${'c'.repeat(40)}`)
    expect(within(commit).getByText('ccccccc')).toBeTruthy()
    expect(within(card).getByText('no reviews yet')).toBeTruthy()
    expect(within(card).getByText('acme/widgets #482')).toBeTruthy()
    expect(
      within(card)
        .getByRole('link', { name: /Open on GitHub/ })
        .getAttribute('href'),
    ).toBe(pr.url)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('region', { name: 'pull request details' })).toBeNull()
  })

  it('CI the token may not read says so in the card, instead of claiming no checks', () => {
    render(<Header changeset={changesetOn(fixturePr({ checks: { state: 'unknown' } }))} />)
    fireEvent.click(screen.getByRole('button', { name: /#482/ }))
    const card = screen.getByRole('region', { name: 'pull request details' })
    expect(within(card).getByText(/checks not visible to your token · pushed/)).toBeTruthy()
  })

  it('shows one status chip, the most decision-relevant state first', () => {
    const chip = (info: PrInfo) => {
      const { container, unmount } = render(<Header changeset={changesetOn(info)} />)
      const text = container.querySelector('.pr-chips .chip')?.textContent ?? null
      unmount()
      return text
    }
    expect(chip(pr)).toBeNull()
    expect(chip(fixturePr({ checks: { state: 'unknown' } }))).toBeNull()
    expect(chip(fixturePr({ checks: { state: 'pending' } }))).toBe('CI running')
    expect(chip(fixturePr({ draft: true, checks: { state: 'pending' } }))).toBe('draft')
    expect(chip(fixturePr({ draft: true, checks: { state: 'failure' } }))).toBe('CI failing')
    expect(chip(fixturePr({ changesRequested: 1, checks: { state: 'failure' } }))).toBe(
      'changes requested',
    )
    expect(
      chip(fixturePr({ state: 'merged', changesRequested: 1, checks: { state: 'failure' } })),
    ).toBe('merged')
    expect(chip(fixturePr({ state: 'closed' }))).toBe('closed')
  })
})

describe('turns and sides on a pull request', () => {
  it('a public draft is a note, a posted one is on GitHub, resolved is settled', () => {
    expect(threadTurn(thread({ audience: 'pr' }))).toBe('note')
    expect(
      threadTurn(
        thread({
          audience: 'pr',
          state: 'sent',
          github: { threadId: 'x', kind: 'inline', resolved: false, outdated: false },
        }),
      ),
    ).toBe('posted')
    expect(threadTurn(thread({ audience: 'pr', state: 'resolved' }))).toBe('resolved')
  })

  it('groups the rail by side, hottest first inside each', () => {
    const gh = (id: string, over: Partial<ReviewThread>) =>
      thread({
        id,
        audience: 'pr',
        state: 'sent',
        github: { threadId: id, kind: 'inline', resolved: false, outdated: false },
        ...over,
      })
    const items = threadItems([
      gh('posted-old', { updatedAt: '2026-09-20T00:00:00Z' }),
      thread({ id: 'draft', audience: 'pr' }),
      thread({ id: 'waiting', state: 'sent' }),
      thread({
        id: 'yours',
        state: 'sent',
        messages: [
          { id: 'm1', author: 'reviewer', text: 'q', at: '2026-09-24T10:00:00Z' },
          { id: 'm2', author: 'agent', text: 'a', at: '2026-09-24T10:01:00Z' },
        ],
      }),
      gh('posted-new', { updatedAt: '2026-09-25T00:00:00Z' }),
    ])
    const sides = bySide(items)
    expect(sides.github.map((i) => i.thread.id)).toEqual(['draft', 'posted-new', 'posted-old'])
    expect(sides.agent.map((i) => i.thread.id)).toEqual(['yours', 'waiting'])
  })
})

describe('the rail on a pull request', () => {
  const gh = (id: string, login: string, over: Partial<ReviewThread> = {}) =>
    thread({
      id,
      audience: 'pr',
      state: 'sent',
      github: { threadId: id, kind: 'inline', resolved: false, outdated: false },
      messages: [
        {
          id: `${id}-m`,
          author: 'github',
          text: `${id} says`,
          at: '2026-09-20T12:00:00Z',
          github: { id: `${id}-c`, user: { login, avatarUrl: '' } },
        },
      ],
      ...over,
    })
  const heads = () =>
    [...document.querySelectorAll('.side-head')].map((h) => h.textContent!.replace(/\s+/g, ' '))
  const rowsIn = (side: string) =>
    [...document.querySelectorAll(`.side-${side} .crow`)].map((r) => r.getAttribute('data-thread'))

  it('two groups with a badge each: drafts for GitHub, your turn for Private', () => {
    const items = threadItems([
      thread({
        id: 'draft',
        audience: 'pr',
        messages: [{ id: 'd', author: 'reviewer', text: 'nit', at: 'x' }],
      }),
      gh('posted', 'reviewer-x'),
      thread({
        id: 'yours',
        state: 'sent',
        messages: [
          { id: 'm1', author: 'reviewer', text: 'q', at: '2026-09-24T10:00:00Z' },
          { id: 'm2', author: 'agent', text: 'a', at: '2026-09-24T10:01:00Z' },
        ],
      }),
    ])
    render(onPr(<ThreadRail items={items} pr />))
    expect(heads()).toEqual(['GitHub 2 1 draft', 'Private 1 1 your turn'])
    expect(document.querySelector('.side-badge-hot')!.textContent).toBe('1 your turn')
    expect(rowsIn('github')).toEqual(['draft', 'posted'])
    expect(rowsIn('agent')).toEqual(['yours'])
    // A draft wears the pill; a posted thread names its GitHub voice.
    expect(document.querySelector('[data-thread="draft"] .crow-pill')!.textContent).toBe('Draft')
    expect(document.querySelector('[data-thread="posted"] .crow-state')!.textContent).toBe(
      'reviewer-x',
    )
    // No filter row and no turn sections on a PR.
    expect(screen.queryByRole('radiogroup')).toBeNull()
    expect(document.querySelector('.sec-head')).toBeNull()
  })

  it('an empty side still shows, saying so', () => {
    render(<ThreadRail items={threadItems([gh('posted', 'jonas')])} pr />)
    expect(heads()).toEqual(['GitHub 1', 'Private 0'])
    expect(screen.getByText('Nothing asked of the agent yet')).toBeTruthy()
  })

  it('shows only the GitHub threads you are part of; others and resolved fold', () => {
    const mention = gh('ping', 'mira-k', {
      messages: [
        {
          id: 'ping-m',
          author: 'github',
          text: 'cc @reviewer-x, thoughts?',
          at: '2026-09-21T00:00:00Z',
          github: { id: 'ping-c', user: { login: 'mira-k', avatarUrl: '' } },
        },
      ],
    })
    const spoke = gh('spoke', 'reviewer-x')
    const replied = gh('replied', 'mira-k', {
      messages: [
        ...gh('replied', 'mira-k').messages,
        { id: 'r', author: 'reviewer', text: 'agreed', at: '2026-09-22T00:00:00Z' },
      ],
    })
    const bots = ['bot1', 'bot2', 'bot3'].map((id) => gh(id, 'devex-bot'))
    const items = threadItems([
      ...bots,
      mention,
      spoke,
      replied,
      gh('done', 'jonas', { state: 'resolved' }),
      thread({ id: 'draft', audience: 'pr' }),
    ])
    render(onPr(<ThreadRail items={items} pr />))
    expect(rowsIn('github')).toEqual(['draft', 'ping', 'spoke', 'replied'])
    fireEvent.click(screen.getByRole('button', { name: '3 from others' }))
    expect(rowsIn('github')).toHaveLength(7)
    expect(rowsIn('github').slice(4)).toEqual(['bot1', 'bot2', 'bot3'])
    fireEvent.click(screen.getByRole('button', { name: 'Only mine' }))
    expect(rowsIn('github')).toHaveLength(4)
    fireEvent.click(screen.getByRole('button', { name: '1 resolved' }))
    expect(document.querySelector('[data-thread="done"] .crow-state')!.textContent).toBe(
      'jonas · resolved',
    )
    // Fresh mount with a folded thread open: it is on screen without a click.
    cleanup()
    render(onPr(<ThreadRail items={items} pr selectedThreadId="bot2" />))
    expect(rowsIn('github')).toContain('bot2')
  })

  it('a click on the fold wins over the selection, until a new selection lands inside it', () => {
    const bots = ['bot1', 'bot2', 'bot3'].map((id) => gh(id, 'devex-bot'))
    const items = threadItems([
      ...bots,
      gh('spoke', 'reviewer-x'),
      gh('done', 'jonas', { state: 'resolved' }),
    ])
    const { rerender } = render(onPr(<ThreadRail items={items} pr selectedThreadId="bot2" />))
    expect(rowsIn('github')).toContain('bot2')
    // "Only mine" folds the others away even though the selected thread is one of them.
    fireEvent.click(screen.getByRole('button', { name: 'Only mine' }))
    expect(rowsIn('github')).toEqual(['spoke'])
    expect(screen.getByRole('button', { name: '3 from others' })).toBeTruthy()
    // Picking another folded thread reopens the fold: the pick has to be on screen.
    rerender(onPr(<ThreadRail items={items} pr selectedThreadId="bot3" />))
    expect(rowsIn('github')).toContain('bot3')
    // The same for resolved: open by selection, shut by a click, reopened by a new pick.
    rerender(onPr(<ThreadRail items={items} pr selectedThreadId="done" />))
    expect(rowsIn('github')).toContain('done')
    fireEvent.click(screen.getByRole('button', { name: '1 resolved' }))
    expect(rowsIn('github')).not.toContain('done')
    rerender(onPr(<ThreadRail items={items} pr selectedThreadId="bot1" />))
    expect(rowsIn('github')).not.toContain('done')
    rerender(onPr(<ThreadRail items={items} pr selectedThreadId="done" />))
    expect(rowsIn('github')).toContain('done')
  })

  it("a draft's mark discards it, the way the card does — never a resolve that drops it silently", () => {
    const onResolve = vi.fn(async () => {})
    const onDelete = vi.fn(async () => {})
    const items = threadItems([thread({ id: 'draft', audience: 'pr' })])
    render(onPr(<ThreadRail items={items} pr onResolve={onResolve} onDelete={onDelete} />))
    expect(screen.queryByRole('button', { name: 'Resolve thread' })).toBeNull()
    // One trash on the row, not two: the mark is the discard.
    expect(screen.queryByRole('button', { name: 'Delete thread' })).toBeNull()
    const discard = screen.getByRole('button', { name: 'Discard draft' })
    expect(discard.getAttribute('data-tip')).toBe('Discard draft: drops it; nothing was posted')
    fireEvent.click(discard)
    expect(onDelete).toHaveBeenCalledWith('draft')
    expect(onResolve).not.toHaveBeenCalled()
    // Without a discard on offer, the mark is inert rather than a resolve.
    cleanup()
    render(onPr(<ThreadRail items={items} pr onResolve={onResolve} />))
    expect(
      (screen.getByRole('button', { name: 'Discard draft' }) as HTMLButtonElement).disabled,
    ).toBe(true)
  })

  it('a queued resolve or reopen says so in the row, apart from one already on GitHub', () => {
    const items = threadItems([
      gh('queued', 'jonas', { state: 'resolved', queued: { resolve: true } }),
      gh('done', 'jonas', {
        state: 'resolved',
        github: { threadId: 'done', kind: 'inline', resolved: true, outdated: false },
      }),
      gh('back', 'reviewer-x', { queued: { unresolve: true } }),
    ])
    render(onPr(<ThreadRail items={items} pr />))
    fireEvent.click(screen.getByRole('button', { name: '2 resolved' }))
    const state = (id: string) =>
      document.querySelector(`[data-thread="${id}"] .crow-state`)!.textContent
    expect(state('queued')).toBe('resolves when you submit')
    expect(state('done')).toBe('jonas · resolved')
    expect(state('back')).toBe('reopens when you submit')
  })

  it('folding a side is the filter', () => {
    render(<ThreadRail items={threadItems([gh('posted', 'jonas'), thread({ id: 'priv' })])} pr />)
    fireEvent.click(screen.getByRole('button', { name: /GitHub 1/ }))
    expect(rowsIn('github')).toEqual([])
    expect(rowsIn('agent')).toEqual(['priv'])
  })
})

describe('the pane on a pull request', () => {
  const at = '2026-09-24T10:00:00Z'
  const said = (id: string, login: string, text: string, over: Partial<ReviewThread> = {}) =>
    thread({
      id,
      anchor: { kind: 'changeset' },
      audience: 'pr',
      github: { threadId: id, kind: 'comment', resolved: false, outdated: false },
      messages: [
        {
          id: `${id}-m`,
          author: 'github',
          text,
          at,
          github: { id: `${id}-c`, user: { login, avatarUrl: '' } },
        },
      ],
      ...over,
    })
  const description = said('description', 'author-a', 'What this PR does', {
    github: { threadId: 'description', kind: 'description', resolved: false, outdated: false },
  })
  const mine = said('c1', 'reviewer-x', 'I asked about the cap')
  const mention = said('c2', 'someone', 'ping @reviewer-x, thoughts?')
  const bot1 = said('b1', 'ci-bot', 'CI passed')
  const bot2 = said('b2', 'bugbot', 'Found 2 issues')
  const comments = (over: Record<string, unknown> = {}) => ({
    partition: {
      byHunk: new Map(),
      byFile: new Map(),
      byLayer: new Map(),
      changeset: [description, bot1, mine, bot2, mention],
    },
    actions: actions(),
    ...over,
  })

  it('leads with the description and what is yours; the rest waits behind one line', () => {
    render(onPr(<ReadingPane files={[]} overview comments={comments()} />))
    expect(screen.getByText('What this PR does')).toBeTruthy()
    expect(screen.getByText('I asked about the cap')).toBeTruthy()
    expect(screen.getByText(/thoughts\?/)).toBeTruthy()
    expect(screen.queryByText('CI passed')).toBeNull()
    expect(screen.queryByText('Found 2 issues')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '2 more from others' }))
    expect(screen.getByText('CI passed')).toBeTruthy()
    expect(screen.getByText('Found 2 issues')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Only mine' }))
    expect(screen.queryByText('CI passed')).toBeNull()
  })

  it('a reveal aimed at a folded thread unfolds it', () => {
    const { rerender } = render(onPr(<ReadingPane files={[]} overview comments={comments()} />))
    expect(screen.queryByText('Found 2 issues')).toBeNull()
    rerender(
      onPr(
        <ReadingPane
          files={[]}
          overview
          comments={comments({ revealNotesTick: 1, revealThreadId: 'b2' })}
        />,
      ),
    )
    expect(screen.getByText('Found 2 issues')).toBeTruthy()
  })

  it('off a pull request nothing folds', () => {
    render(<ReadingPane files={[]} overview comments={comments()} />)
    expect(screen.getByText('CI passed')).toBeTruthy()
    expect(screen.queryByText(/more from others/)).toBeNull()
  })
})
