// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ReviewThread } from '../../shared/review.js'
import type { FileChange, Hunk } from '../../shared/types.js'
import { partitionThreads } from '../reviewPlacement.js'
import { ReadingPane } from './ReadingPane.js'
import { CommentBox, type ReviewActions, ThreadCard } from './Threads.js'

vi.mock('../highlight.js', () => ({
  tokenizeLines: async () => null,
  langForPath: () => null,
}))

afterEach(cleanup)

function actions(over: Partial<ReviewActions> = {}): ReviewActions {
  return {
    create: vi.fn(async () => thread()),
    reply: vi.fn(async () => {}),
    send: vi.fn(async () => ({ delivered: false, copied: true, prompt: 'THE PROMPT' })),
    resolve: vi.fn(async () => {}),
    reopen: vi.fn(async () => {}),
    remove: vi.fn(async () => {}),
    ...over,
  }
}

function openReply(placeholder = 'reply…') {
  fireEvent.click(document.querySelector('.thread-reply-stub')!)
  return screen.getByPlaceholderText(placeholder) as HTMLTextAreaElement
}

function thread(over: Partial<ReviewThread> = {}): ReviewThread {
  return {
    id: 't-1',
    anchor: { kind: 'hunk', hunkId: 'hunk-1', path: 'src/b.ts', side: 'new', line: 2 },
    state: 'open',
    codeContext: '+const added = 2',
    codeChanged: false,
    messages: [
      { id: 'm1', author: 'reviewer', text: 'why this?', at: '2026-08-03T00:00:00Z' },
      { id: 'm2', author: 'agent', text: 'because Y', at: '2026-08-03T00:01:00Z' },
    ],
    createdAt: '2026-08-03T00:00:00Z',
    updatedAt: '2026-08-03T00:01:00Z',
    ...over,
  }
}

const FILE: FileChange = {
  path: 'src/b.ts',
  oldPath: null,
  status: 'modified',
  kind: 'text',
  staged: false,
  hunks: [
    {
      id: 'hunk-1',
      path: 'src/b.ts',
      oldStart: 1,
      newStart: 1,
      lines: [
        { kind: 'context', oldNo: 1, newNo: 1, text: 'const keep = true' },
        { kind: 'del', oldNo: 2, newNo: null, text: 'const removed = 1' },
        { kind: 'add', oldNo: null, newNo: 2, text: 'const added = 2' },
      ],
    } satisfies Hunk,
  ],
}

function pane(threads: ReviewThread[], acts = actions()) {
  return render(
    <ReadingPane
      files={[FILE]}
      comments={{ partition: partitionThreads([FILE], threads), actions: acts }}
    />,
  )
}

describe('ThreadCard', () => {
  it('a delivered thread says where the feedback is, and never claims to be typing', () => {
    const { unmount } = render(<ThreadCard thread={thread()} actions={actions()} working />)
    expect(screen.getByText(/with the agent/)).toBeTruthy()
    expect(document.querySelector('.thread-message-pending .pending-dots')).toBeTruthy()
    expect(document.querySelector('.pending-dots-live')).toBeNull()
    unmount()
    render(<ThreadCard thread={thread()} actions={actions()} />)
    expect(screen.queryByText(/with the agent/)).toBeNull()
    expect(document.querySelector('.thread-message-pending')).toBeNull()
  })

  it('the typing indicator sits after what the agent has — raced comments stay below it', () => {
    render(
      <ThreadCard
        thread={thread({
          state: 'sent',
          deliveredThrough: '2026-08-03T00:02:00Z',
          messages: [
            { id: 'm1', author: 'reviewer', text: 'why this?', at: '2026-08-03T00:00:00Z' },
            { id: 'm2', author: 'agent', text: 'because Y', at: '2026-08-03T00:01:00Z' },
            { id: 'm3', author: 'reviewer', text: 'raced in', at: '2026-08-03T00:03:00Z' },
          ],
        })}
        actions={actions()}
        working
      />,
    )
    const rows = [
      ...document.querySelectorAll(
        '.thread-messages > .cmt, .thread-messages .thread-message-pending',
      ),
    ]
    const texts = rows.map((r) => r.textContent ?? '')
    const pendingIdx = rows.findIndex((r) => r.classList.contains('thread-message-pending'))
    const racedIdx = texts.findIndex((t) => t.includes('raced in'))
    expect(pendingIdx).toBeGreaterThan(-1)
    expect(racedIdx).toBeGreaterThan(-1)
    expect(pendingIdx).toBeLessThan(racedIdx)
  })

  it('without a hand-over marker the indicator keeps its old place at the end', () => {
    render(
      <ThreadCard
        thread={thread({
          state: 'sent',
          messages: [
            { id: 'm1', author: 'reviewer', text: 'why this?', at: '2026-08-03T00:00:00Z' },
            { id: 'm2', author: 'reviewer', text: 'second', at: '2026-08-03T00:03:00Z' },
          ],
        })}
        actions={actions()}
        working
      />,
    )
    const rows = [...document.querySelectorAll('.thread-messages > *')]
    expect(rows.at(-1)!.classList.contains('thread-message-pending')).toBe(true)
  })

  it('a queued thread names its place in line', () => {
    const { unmount } = render(
      <ThreadCard thread={thread({ state: 'sent' })} actions={actions()} queuePosition={2} />,
    )
    expect(screen.getByText('queued — #2 in line')).toBeTruthy()
    unmount()
    render(<ThreadCard thread={thread({ state: 'sent' })} actions={actions()} queuePosition={1} />)
    expect(screen.getByText('queued — next in line')).toBeTruthy()
  })

  it('held outranks queued — a re-queued follow-up is still over there', () => {
    render(
      <ThreadCard
        thread={thread({ state: 'sent' })}
        actions={actions()}
        working
        queuePosition={1}
      />,
    )
    expect(screen.getByText(/with the agent/)).toBeTruthy()
    expect(screen.queryByText(/queued/)).toBeNull()
  })

  it('a thread the agent walked away from says so, and stops waiting', () => {
    render(<ThreadCard thread={thread({ state: 'sent', unanswered: true })} actions={actions()} />)
    expect(screen.getByText(/no answer — the agent moved on/)).toBeTruthy()
    expect(screen.getByText(/Send it again, or resolve it/)).toBeTruthy()
    expect(document.querySelector('.pending-dots')).toBeNull()
  })

  it('re-sending an unanswered thread puts it back in line, not in the dead end', () => {
    render(
      <ThreadCard
        thread={thread({ state: 'sent', unanswered: true })}
        actions={actions()}
        queuePosition={1}
      />,
    )
    expect(screen.getByText('queued — next in line')).toBeTruthy()
    expect(screen.queryByText(/no answer/)).toBeNull()
  })

  it('renders the thread with state chip and reply box', () => {
    render(<ThreadCard thread={thread()} actions={actions()} />)
    expect(screen.getByText('why this?')).toBeTruthy()
    expect(screen.getByText('because Y')).toBeTruthy()
    expect(screen.getByText('Open')).toBeTruthy()
    expect(openReply()).toBeTruthy()
    expect(screen.getByText('You')).toBeTruthy()
    expect(screen.queryByText('reviewer')).toBeNull()
    expect(screen.getByText('Agent')).toBeTruthy()
  })

  it('the reply box stays collapsed until asked for', () => {
    render(<ThreadCard thread={thread()} actions={actions()} />)
    expect(screen.queryByPlaceholderText('reply…')).toBeNull()
    expect(document.querySelector('.thread-reply-stub')).toBeTruthy()
    openReply()
    expect(screen.getByPlaceholderText('reply…')).toBeTruthy()
  })

  it('deletes a thread from the inline trash button — no menu to open first', () => {
    const acts = actions()
    render(<ThreadCard thread={thread()} actions={acts} />)
    fireEvent.click(screen.getByLabelText('delete this thread'))
    expect(acts.remove).toHaveBeenCalledWith('t-1')
  })

  it('offers no Delete when the action is unavailable', () => {
    render(<ThreadCard thread={thread()} actions={actions({ remove: undefined })} />)
    expect(screen.queryByLabelText('delete this thread')).toBeNull()
  })

  it('a sent thread without an agent reply says it is waiting, with a re-copy button', () => {
    const acts = actions()
    render(
      <ThreadCard
        thread={thread({
          state: 'sent',
          messages: [{ id: 'm1', author: 'reviewer', text: 'why?', at: '' }],
        })}
        actions={acts}
      />,
    )
    expect(screen.getByText(/waiting on your agent/)).toBeTruthy()
    fireEvent.click(screen.getByText('Copy prompt'))
    expect(acts.send).toHaveBeenCalledWith('t-1')
  })

  it('the waiting hint disappears once the agent replies', () => {
    render(<ThreadCard thread={thread({ state: 'sent' })} actions={actions()} />)
    expect(screen.queryByText(/waiting on your agent/)).toBeNull()
  })

  it('a held reply says so, and offers the Send that releases it', () => {
    const acts = actions()
    const held = thread({
      state: 'sent',
      withheld: true,
      messages: [
        { id: 'm1', author: 'reviewer', text: 'why this?', at: '2026-08-03T00:00:00Z' },
        { id: 'm2', author: 'agent', text: 'because Y', at: '2026-08-03T00:01:00Z' },
        { id: 'm3', author: 'reviewer', text: 'second thought', at: '2026-08-03T00:02:00Z' },
      ],
    })
    render(<ThreadCard thread={held} actions={acts} />)
    expect(screen.getByText('Not sent')).toBeTruthy()
    expect(screen.queryByText('Sent')).toBeNull()
    expect(screen.getByText(/your reply is held here/)).toBeTruthy()
    fireEvent.click(screen.getByText('Send'))
    expect(acts.send).toHaveBeenCalledWith('t-1')
  })

  it('a held reply is not "waiting on your agent"', () => {
    render(<ThreadCard thread={thread({ state: 'sent', withheld: true })} actions={actions()} />)
    expect(screen.queryByText(/waiting on your agent/)).toBeNull()
  })

  it('send marks copied; resolve and reopen call through', async () => {
    const acts = actions()
    const { rerender } = render(<ThreadCard thread={thread()} actions={acts} />)
    fireEvent.click(screen.getByText('Send'))
    expect(acts.send).toHaveBeenCalledWith('t-1')
    expect(await screen.findByText(/prompt copied/)).toBeTruthy()

    fireEvent.click(screen.getByText('Resolve'))
    expect(acts.resolve).toHaveBeenCalledWith('t-1')
    expect(screen.queryAllByText('Resolve')).toHaveLength(1)

    rerender(<ThreadCard thread={thread({ state: 'resolved' })} actions={acts} />)
    fireEvent.click(screen.getByTitle('expand this resolved thread'))
    fireEvent.click(screen.getByText('Reopen'))
    expect(acts.reopen).toHaveBeenCalledWith('t-1')
  })

  it('a folded resolved thread carries Reopen on the row you can still see', () => {
    const acts = actions()
    render(<ThreadCard thread={thread({ state: 'resolved' })} actions={acts} />)
    // Collapsed to its summary line: the foot that normally holds Reopen is gone.
    expect(document.querySelector('.thread-foot')).toBeNull()
    fireEvent.click(screen.getByText('Reopen'))
    expect(acts.reopen).toHaveBeenCalledWith('t-1')

    // And the same when it is the chevron doing the folding, not the resolved state.
    fireEvent.click(screen.getByTitle('expand this resolved thread'))
    fireEvent.click(screen.getByLabelText('collapse this thread'))
    expect(document.querySelector('.thread-head')!.textContent).toContain('Reopen')
  })

  it('never claims a copy that did not happen — and hands over the prompt', async () => {
    const acts = actions({
      send: vi.fn(async () => ({ delivered: false, copied: false, prompt: 'THE PROMPT' })),
    })
    render(<ThreadCard thread={thread()} actions={acts} />)
    fireEvent.click(screen.getByText('Send'))
    expect(await screen.findByText(/couldn't reach the clipboard/)).toBeTruthy()
    expect(screen.getByText('THE PROMPT')).toBeTruthy()
    expect(screen.queryByText(/prompt copied/)).toBeNull()
  })

  it('a delivered send shows neither the copied badge nor the fallback', async () => {
    const acts = actions({ send: vi.fn(async () => ({ delivered: true })) })
    render(<ThreadCard thread={thread()} actions={acts} />)
    fireEvent.click(screen.getByText('Send'))
    await waitFor(() => expect(acts.send).toHaveBeenCalled())
    expect(screen.queryByText(/prompt copied/)).toBeNull()
    expect(screen.queryByText(/couldn't reach the clipboard/)).toBeNull()
  })

  it('a closing note is badged as one, and waits on the agent like any thread', () => {
    render(
      <ThreadCard
        thread={thread({
          anchor: { kind: 'changeset' },
          state: 'sent',
          closingNote: true,
          codeContext: null,
          messages: [
            { id: 'm1', author: 'reviewer', text: 'solid overall', at: '2026-08-03T00:00:00Z' },
          ],
        })}
        actions={actions()}
      />,
    )
    expect(screen.getByText('closing note')).toBeTruthy()
    expect(screen.getByText('solid overall')).toBeTruthy()
    // Sent, so it is the agent's move — no Send button left on it.
    expect(screen.queryByText('Send')).toBeNull()
  })

  it('a resolved thread collapses to one line, and expands on click', () => {
    render(
      <ThreadCard thread={thread({ state: 'resolved', codeChanged: true })} actions={actions()} />,
    )
    expect(document.querySelector('.thread-collapsed')).toBeTruthy()
    expect(screen.getByText('Resolved')).toBeTruthy()
    expect(screen.getByText('why this?')).toBeTruthy()
    expect(screen.queryByText('because Y')).toBeNull()
    expect(screen.queryByText('Send')).toBeNull()

    fireEvent.click(screen.getByTitle('expand this resolved thread'))
    expect(screen.getByText('because Y')).toBeTruthy()
    expect(screen.getByText('code changed since this comment')).toBeTruthy()
    expect(screen.queryByPlaceholderText('reply…')).toBeNull()
    expect(document.querySelector('.thread-reply-stub')).toBeNull()
  })

  it('reply sends the text and clears the box once it has landed', async () => {
    const acts = actions()
    render(<ThreadCard thread={thread()} actions={acts} />)
    const box = openReply()
    fireEvent.change(box, { target: { value: 'more detail please' } })
    fireEvent.click(screen.getByText('Reply'))
    expect(acts.reply).toHaveBeenCalledWith('t-1', 'more detail please', true)
    await waitFor(() => expect(box.value).toBe(''))
  })

  it('the composer sits in the foot — writing adds Reply beside Resolve and Send', () => {
    render(<ThreadCard thread={thread()} actions={actions()} />)
    const box = openReply()
    expect(box.closest('.thread-foot')).toBeTruthy()
    expect(screen.queryByText('Reply')).toBeNull()
    fireEvent.change(box, { target: { value: 'and rename it' } })
    const foot = document.querySelector('.thread-foot')!
    expect(foot.contains(screen.getByText('Reply'))).toBe(true)
    expect(foot.contains(screen.getByText('Resolve'))).toBe(true)
    expect(foot.contains(screen.getByText('Send'))).toBe(true)
    expect(screen.queryByText('Reply & send')).toBeNull()
  })

  it('folds the frozen snapshot behind a named toggle — thread first, code on demand', () => {
    const long = Array.from({ length: 9 }, (_, i) => `line ${i + 1}`).join('\n')
    render(<ThreadCard thread={thread({ codeContext: long })} actions={actions()} showContext />)
    expect(document.querySelector('.thread-context')).toBeNull()
    expect(screen.getByText('9 lines')).toBeTruthy()
    fireEvent.click(screen.getByText('the commented change'))
    const pre = document.querySelector('.thread-context')!
    expect(pre.textContent).toContain('line 1')
    expect(pre.textContent).toContain('line 9')
    fireEvent.click(screen.getByText('the commented change'))
    expect(document.querySelector('.thread-context')).toBeNull()
  })

  it('tints the snapshot lines like the diff they quote', () => {
    render(
      <ThreadCard
        thread={thread({ codeContext: ' context\n+added\n-removed' })}
        actions={actions()}
        showContext
      />,
    )
    fireEvent.click(screen.getByText('the commented change'))
    expect(document.querySelector('.ctx-add')!.textContent).toBe('+added')
    expect(document.querySelector('.ctx-del')!.textContent).toBe('-removed')
    const context = [...document.querySelectorAll('.ctx-line')].find(
      (l) => l.textContent === ' context',
    )!
    expect(context.className).toBe('ctx-line')
  })

  it('typing a reply leaves rendered message DOM alone — a diagram must not re-render per keystroke', () => {
    render(<ThreadCard thread={thread({ state: 'sent' })} actions={actions()} agentConnected />)
    const body = document.querySelector('.thread-message-agent .cmt-body')!
    // Stand-in for the mermaid pass upgrading a fence: an external DOM mutation
    // that React knows nothing about. It must survive keystrokes in the composer.
    const figure = document.createElement('div')
    figure.className = 'mermaid-figure'
    body.appendChild(figure)

    const box = openReply()
    for (const value of ['w', 'wh', 'why', 'why?']) {
      fireEvent.change(box, { target: { value } })
    }
    expect(document.contains(figure)).toBe(true)
  })

  it('an agent reply shows how long the run took', () => {
    render(
      <ThreadCard
        thread={thread({
          messages: [
            { id: 'm1', author: 'reviewer', text: 'why?', at: '' },
            { id: 'm2', author: 'agent', text: 'because', at: '', durationMs: 65_000 },
          ],
        })}
        actions={actions()}
      />,
    )
    expect(screen.getByText('answered in 1m 05s')).toBeTruthy()
  })
})

describe('ThreadCard with an attached agent', () => {
  const sent = () =>
    thread({ state: 'sent', messages: [{ id: 'm1', author: 'reviewer', text: 'why?', at: '' }] })

  it('a sent thread shows no manual paste hint — the poll carries it', () => {
    render(<ThreadCard thread={sent()} actions={actions()} agentConnected />)
    expect(screen.queryByText(/waiting on your agent/)).toBeNull()
    expect(screen.queryByText(/paste the copied prompt/)).toBeNull()
    expect(screen.queryByText('Copy prompt')).toBeNull()
  })

  it('Reply & send hands the follow-up over in the one click', () => {
    const acts = actions()
    render(<ThreadCard thread={thread({ state: 'sent' })} actions={acts} agentConnected />)
    const box = openReply()
    fireEvent.change(box, { target: { value: 'and one more thing' } })
    fireEvent.click(screen.getByText('Reply & send'))
    expect(acts.reply).toHaveBeenCalledWith('t-1', 'and one more thing', true)
    expect(acts.send).not.toHaveBeenCalled()
  })

  it('the ghost Reply beside it still holds the follow-up back', () => {
    const acts = actions()
    render(<ThreadCard thread={thread({ state: 'sent' })} actions={acts} agentConnected />)
    const box = openReply()
    fireEvent.change(box, { target: { value: 'thinking out loud' } })
    fireEvent.click(screen.getByText('Reply'))
    expect(acts.reply).toHaveBeenCalledWith('t-1', 'thinking out loud', false)
    expect(acts.send).not.toHaveBeenCalled()
  })

  it('⌘↵ runs the primary — the reply goes straight to the agent', () => {
    const acts = actions()
    render(<ThreadCard thread={thread({ state: 'sent' })} actions={acts} agentConnected />)
    const box = openReply()
    fireEvent.change(box, { target: { value: 'sent along' } })
    fireEvent.keyDown(box, { key: 'Enter', metaKey: true })
    expect(acts.reply).toHaveBeenCalledWith('t-1', 'sent along', true)
  })

  it('an open thread writes the reply straight in — there is nothing to withhold from', () => {
    const acts = actions()
    render(<ThreadCard thread={thread({ state: 'open' })} actions={acts} agentConnected />)
    const box = openReply()
    fireEvent.change(box, { target: { value: 'note to self' } })
    fireEvent.click(screen.getByText('Reply'))
    expect(acts.reply).toHaveBeenCalledWith('t-1', 'note to self', true)
  })

  it('Send says where the thread goes when an agent is attached', () => {
    render(<ThreadCard thread={thread()} actions={actions()} agentConnected />)
    expect(screen.getByTitle('send this thread to your agent')).toBeTruthy()
  })
})

describe('CommentBox', () => {
  const box = () => screen.getByPlaceholderText('say…')
  const openFormatting = () => fireEvent.click(screen.getByLabelText('Formatting and preview'))

  it('submits trimmed-nonempty text, cancels on escape', () => {
    const onSubmit = vi.fn()
    const onCancel = vi.fn()
    render(
      <CommentBox
        title="Comment on x.ts"
        placeholder="say…"
        onSubmit={onSubmit}
        onCancel={onCancel}
      />,
    )
    const button = screen.getByText('Add comment') as HTMLButtonElement
    expect(button.disabled).toBe(true)
    fireEvent.change(box(), { target: { value: 'a comment' } })
    fireEvent.click(button)
    expect(onSubmit).toHaveBeenCalledWith('a comment', false, undefined)
    fireEvent.keyDown(box(), { key: 'Escape' })
    expect(onCancel).toHaveBeenCalled()
  })

  it('closes from the header X and from the footer Close', () => {
    const onCancel = vi.fn()
    render(<CommentBox title="t" placeholder="say…" onSubmit={vi.fn()} onCancel={onCancel} />)
    fireEvent.click(screen.getByLabelText('Close'))
    fireEvent.click(screen.getByText('Close'))
    expect(onCancel).toHaveBeenCalledTimes(2)
  })

  it('opens with no toolbar and no tabs — Aa buys them back', () => {
    const { container } = render(
      <CommentBox title="t" placeholder="say…" onSubmit={vi.fn()} onCancel={vi.fn()} />,
    )
    expect(container.querySelector('.cbox-mdbar')).toBeNull()
    expect(container.querySelector('.cbox-tabs')).toBeNull()
    openFormatting()
    expect(container.querySelector('.cbox-mdbar')).toBeTruthy()
    expect(screen.getByText('Preview')).toBeTruthy()
    fireEvent.click(screen.getByText('Preview'))
    openFormatting()
    expect(container.querySelector('.cbox-mdbar')).toBeNull()
    expect(box()).toBeTruthy()
  })

  it('the openers leave once you have started — they exist to start you', () => {
    render(<CommentBox title="t" placeholder="say…" onSubmit={vi.fn()} onCancel={vi.fn()} />)
    expect(screen.getByText('Is it tested?')).toBeTruthy()
    fireEvent.change(box(), { target: { value: 'this hunk' } })
    expect(screen.queryByText('Is it tested?')).toBeNull()
  })

  it('switches to Preview, which renders the real textarea content', () => {
    render(<CommentBox title="t" placeholder="say…" onSubmit={vi.fn()} onCancel={vi.fn()} />)
    fireEvent.change(box(), { target: { value: 'use `formatAgentDuration` **here**' } })
    openFormatting()
    fireEvent.click(screen.getByText('Preview'))
    const preview = document.querySelector('.cbox-preview')!
    expect(preview.querySelector('code')!.textContent).toBe('formatAgentDuration')
    expect(preview.querySelector('strong')!.textContent).toBe('here')
    expect(screen.queryByPlaceholderText('say…')).toBeNull()
  })

  it('says so rather than showing an empty preview', () => {
    render(<CommentBox title="t" placeholder="say…" onSubmit={vi.fn()} onCancel={vi.fn()} />)
    openFormatting()
    fireEvent.click(screen.getByText('Preview'))
    expect(screen.getByText('Nothing to preview yet.')).toBeTruthy()
  })

  it('an opener fills the box instead of sending blind', () => {
    const onSend = vi.fn()
    render(
      <CommentBox
        title="t"
        placeholder="say…"
        onSubmit={vi.fn()}
        onSend={onSend}
        onCancel={vi.fn()}
      />,
    )
    fireEvent.click(screen.getByText('What could break?'))
    expect((box() as HTMLTextAreaElement).value).toBe('What could break?')
    expect(onSend).not.toHaveBeenCalled()
  })

  it('widening the scope is reported to the caller, which owns the anchor', () => {
    const onSend = vi.fn()
    render(
      <CommentBox
        title="t"
        placeholder="say…"
        scope={{ label: 'useViewed.ts:8', canWiden: true }}
        onSubmit={vi.fn()}
        onSend={onSend}
        onCancel={vi.fn()}
      />,
    )
    expect(screen.getByText('useViewed.ts:8')).toBeTruthy()
    fireEvent.change(box(), { target: { value: 'why?' } })
    fireEvent.click(screen.getByText('+ whole changeset'))
    expect(screen.getByText('the whole changeset')).toBeTruthy()
    fireEvent.click(screen.getByText('Send to agent'))
    expect(onSend).toHaveBeenCalledWith('why?', true, undefined)
  })

  it('offers no widening on a changeset note — it already sees everything', () => {
    render(
      <CommentBox
        title="t"
        placeholder="say…"
        scope={{ label: 'the whole changeset', canWiden: false }}
        onSubmit={vi.fn()}
        onCancel={vi.fn()}
      />,
    )
    expect(screen.queryByText('+ whole changeset')).toBeNull()
  })

  it('the markdown toolbar wraps the selection', () => {
    render(<CommentBox title="t" placeholder="say…" onSubmit={vi.fn()} onCancel={vi.fn()} />)
    openFormatting()
    const area = box() as HTMLTextAreaElement
    fireEvent.change(area, { target: { value: 'make it bold' } })
    area.setSelectionRange(8, 12)
    fireEvent.click(screen.getByLabelText('Bold'))
    expect((box() as HTMLTextAreaElement).value).toBe('make it **bold**')
  })

  it('a list prefixes whole lines, not the middle of a word', () => {
    render(<CommentBox title="t" placeholder="say…" onSubmit={vi.fn()} onCancel={vi.fn()} />)
    openFormatting()
    const area = box() as HTMLTextAreaElement
    fireEvent.change(area, { target: { value: 'one\ntwo' } })
    area.setSelectionRange(1, 5)
    fireEvent.click(screen.getByLabelText('Bulleted list'))
    expect((box() as HTMLTextAreaElement).value).toBe('- one\n- two')
  })

  it('⌘↵ takes the primary action — adding the comment, even with an agent to ask', () => {
    const onSend = vi.fn()
    const onSubmit = vi.fn()
    render(
      <CommentBox
        title="t"
        placeholder="say…"
        onSubmit={onSubmit}
        onSend={onSend}
        onCancel={vi.fn()}
      />,
    )
    fireEvent.change(box(), { target: { value: 'go' } })
    fireEvent.keyDown(box(), { key: 'Enter', metaKey: true })
    expect(onSubmit).toHaveBeenCalledWith('go', false, undefined)
    expect(onSend).not.toHaveBeenCalled()
  })

  it('intent starts unset; a chip forces it, and clicking it again lets go', () => {
    const onSubmit = vi.fn()
    render(<CommentBox title="t" placeholder="say…" onSubmit={onSubmit} onCancel={vi.fn()} />)
    expect(screen.getByText('Change')).toBeTruthy()
    expect(screen.queryByText('Nit')).toBeNull()
    expect(document.querySelector('.cbox-intent-chip[aria-checked="true"]')).toBeNull()
    fireEvent.click(screen.getByText('Question'))
    fireEvent.change(box(), { target: { value: 'why a set?' } })
    fireEvent.click(screen.getByText('Add comment'))
    expect(onSubmit).toHaveBeenCalledWith('why a set?', false, 'question')

    fireEvent.click(screen.getByText('Question'))
    fireEvent.change(box(), { target: { value: 'and this one, you decide' } })
    fireEvent.click(screen.getByText('Add comment'))
    expect(onSubmit).toHaveBeenCalledWith('and this one, you decide', false, undefined)
  })

  it('an opener is a question — the chip follows it', () => {
    const onSubmit = vi.fn()
    render(<CommentBox title="t" placeholder="say…" onSubmit={onSubmit} onCancel={vi.fn()} />)
    fireEvent.click(screen.getByText('Is it tested?'))
    fireEvent.click(screen.getByText('Add comment'))
    expect(onSubmit).toHaveBeenCalledWith('Is it tested?', false, 'question')
  })

  it('Add comment is the primary button; Send to agent is the second choice', () => {
    render(
      <CommentBox
        title="t"
        placeholder="say…"
        onSubmit={vi.fn()}
        onSend={vi.fn()}
        onCancel={vi.fn()}
      />,
    )
    expect(screen.getByText('Add comment').className).toContain('btn-primary')
    expect(screen.getByText('Send to agent').className).not.toContain('btn-primary')
  })
})

describe('markdown bodies', () => {
  it('renders a comment as markdown instead of showing its syntax', () => {
    render(
      <ThreadCard
        thread={thread({
          messages: [
            { id: 'm1', author: 'agent', text: 'Fixed in `Threads.tsx`:\n\n- one\n- two', at: '' },
          ],
        })}
        actions={actions()}
      />,
    )
    const body = document.querySelector('.cmt-body')!
    expect(body.querySelector('code')!.textContent).toBe('Threads.tsx')
    expect(body.querySelectorAll('li')).toHaveLength(2)
    expect(body.textContent).not.toContain('`')
  })

  it('strips anything that could run, and defangs surviving links', () => {
    render(
      <ThreadCard
        thread={thread({
          messages: [
            {
              id: 'm1',
              author: 'agent',
              text: '<img src=x onerror="alert(1)"> [docs](https://example.com)',
              at: '',
            },
          ],
        })}
        actions={actions()}
      />,
    )
    const body = document.querySelector('.cmt-body')!
    expect(body.querySelector('img')).toBeNull()
    expect(body.innerHTML).not.toContain('onerror')
    const link = body.querySelector('a')!
    expect(link.getAttribute('rel')).toBe('noopener noreferrer')
    expect(link.getAttribute('target')).toBe('_blank')
  })
})

describe('inline placement in the reading pane', () => {
  it('renders a hunk thread in a thread row right after its anchored line', () => {
    const { container } = pane([thread()])
    const rows = [...container.querySelectorAll('.hunk tbody tr')]
    const anchoredIdx = rows.findIndex((r) => r.textContent?.includes('const added = 2'))
    expect(rows[anchoredIdx + 1]!.className).toContain('thread-row')
    expect(rows[anchoredIdx + 1]!.textContent).toContain('why this?')
  })

  it('an edited hunk keeps its thread on the line, badged as changed', () => {
    // The agent rewrote the hunk, so its content-addressed id rotated out from under
    // the anchor. Line 2 is still there: that is where the comment belongs.
    const orphan = thread({
      id: 't-orphan',
      anchor: { kind: 'hunk', hunkId: 'rotated-away', path: 'src/b.ts', side: 'new', line: 2 },
      codeChanged: true,
    })
    const { container } = pane([orphan])
    expect(container.querySelector('.file-threads')).toBeNull()
    const rows = [...container.querySelectorAll('.hunk tbody tr')]
    const anchoredIdx = rows.findIndex((r) => r.textContent?.includes('const added = 2'))
    expect(rows[anchoredIdx + 1]!.className).toContain('thread-row')
    expect(rows[anchoredIdx + 1]!.textContent).toContain('code changed since this comment')
  })

  it('renders file-level threads (and truly homeless orphans) above the hunks with context', () => {
    const orphan = thread({
      id: 't-orphan',
      // Line 40 is in no hunk of this diff — nothing left to sit next to.
      anchor: { kind: 'hunk', hunkId: 'rotated-away', path: 'src/b.ts', side: 'new', line: 40 },
      codeChanged: true,
    })
    const { container } = pane([orphan])
    const fileThreads = container.querySelector('.file-threads')!
    expect(fileThreads.textContent).toContain('why this?')
    fireEvent.click(fileThreads.querySelector('.thread-context-toggle')!)
    expect(fileThreads.querySelector('.thread-context')!.textContent).toContain('+const added = 2')
    expect(container.querySelector('.file-comment-btn .ghb-badge')!.textContent).toBe('1')
  })

  it('changeset notes start open under their count, and fold on click', () => {
    const note = thread({ id: 't-note', anchor: { kind: 'changeset' }, codeContext: null })
    const { container } = pane([note])
    const section = container.querySelector('.changeset-strip')!
    expect(section.textContent).toContain('On the changeset')
    expect(section.querySelector('.strip-n')!.textContent).toBe('1')
    expect(section.textContent).toContain('why this?')

    fireEvent.click(section.querySelector('.strip-head')!)
    expect(section.textContent).not.toContain('why this?')
  })

  it('counts the notes in the strip head', () => {
    const notes = [
      thread({ id: 'n1', anchor: { kind: 'changeset' }, codeContext: null }),
      thread({ id: 'n2', anchor: { kind: 'changeset' }, codeContext: null }),
    ]
    const { container } = pane(notes)
    expect(container.querySelector('.changeset-strip .strip-n')!.textContent).toBe('2')
  })

  it('the strip offers a new-note button that opens the changeset composer', () => {
    const note = thread({ id: 't-note', anchor: { kind: 'changeset' }, codeContext: null })
    const onOpen = vi.fn()
    const { container } = render(
      <ReadingPane
        files={[FILE]}
        comments={{
          partition: partitionThreads([FILE], [note]),
          actions: actions(),
          onOpenChangesetComposer: onOpen,
        }}
      />,
    )
    expect(container.querySelector('.strip-add')).toBeTruthy()
    fireEvent.click(screen.getByText('+ Note on the changeset'))
    expect(onOpen).toHaveBeenCalled()
  })

  it('the notes section is forced open while the changeset composer is up', () => {
    const note = thread({ id: 't-note', anchor: { kind: 'changeset' }, codeContext: null })
    const { container } = render(
      <ReadingPane
        files={[FILE]}
        comments={{
          partition: partitionThreads([FILE], [note]),
          actions: actions(),
          changesetComposerOpen: true,
        }}
      />,
    )
    const section = container.querySelector('.changeset-strip')!
    // Folding the strip cannot hide a composer someone is typing into.
    fireEvent.click(section.querySelector('.strip-head')!)
    expect(section.textContent).toContain('why this?')
    expect(section.querySelector('.thread-composer')).toBeTruthy()
  })

  it('clicking a line comment button opens the composer for that line', () => {
    const acts = actions()
    const { container } = pane([], acts)
    const addRow = [...container.querySelectorAll('.hunk tbody tr')].find((r) =>
      r.textContent?.includes('const added = 2'),
    )!
    fireEvent.click(addRow.querySelector('.line-comment-btn')!)
    const box = container.querySelector('.thread-composer textarea')!
    fireEvent.change(box, { target: { value: 'rename this' } })
    fireEvent.click(screen.getByText('Add comment'))
    expect(acts.create).toHaveBeenCalledWith(
      { kind: 'hunk', hunkId: 'hunk-1', path: 'src/b.ts', side: 'new', line: 2 },
      'rename this',
      undefined,
    )
  })
})

describe('threads the changeset left behind', () => {
  const gone = thread({
    id: 't-gone',
    anchor: { kind: 'hunk', hunkId: 'dead-hunk', path: 'src/deleted.ts', side: 'new', line: 52 },
    state: 'addressed',
  })

  it('a thread whose file left the diff still has a card to read the answer in', () => {
    const { container } = render(
      <ReadingPane
        files={[FILE]}
        comments={{ partition: partitionThreads([FILE], []), past: [gone], actions: actions() }}
      />,
    )
    const section = container.querySelector('.past-threads')!
    expect(section.textContent).toContain('1 thread whose code left the changeset')
    // Folded until asked for: a leftover must not push the diff down the pane.
    expect(section.querySelector('[data-thread-id="t-gone"]')).toBeNull()

    fireEvent.click(section.querySelector('.file-header')!)
    const card = section.querySelector('[data-thread-id="t-gone"]')!
    expect(card.textContent).toContain('because Y')
    expect(card.querySelector('.thread-where')!.textContent).toBe('src/deleted.ts:52')
    expect(card.querySelector('.thread-where-gone')).toBeTruthy()
    expect(card.textContent).toContain('the commented change')
  })

  it('the rail can open one — the reveal tick unfolds the section', () => {
    const comments = {
      partition: partitionThreads([FILE], []),
      past: [gone],
      actions: actions(),
    }
    const { container, rerender } = render(<ReadingPane files={[FILE]} comments={comments} />)
    expect(container.querySelector('[data-thread-id="t-gone"]')).toBeNull()
    rerender(<ReadingPane files={[FILE]} comments={{ ...comments, revealPastTick: 1 }} />)
    expect(container.querySelector('[data-thread-id="t-gone"]')).toBeTruthy()
  })

  it('no section at all when the changeset has left nothing behind', () => {
    const { container } = pane([])
    expect(container.querySelector('.past-threads')).toBeNull()
  })
})

describe('a held reply on a departed thread', () => {
  const held = thread({
    id: 't-gone',
    anchor: { kind: 'hunk', hunkId: 'dead-hunk', path: 'src/deleted.ts', side: 'new', line: 52 },
    state: 'addressed',
    withheld: true,
  })

  it('points at Send, never at a finish batch that is scoped to the changeset', () => {
    render(<ThreadCard thread={held} actions={actions()} gone />)
    expect(screen.getByText(/Send hands it over; Finish review will not/)).toBeTruthy()
    expect(screen.getByRole('button', { name: /Send/ })).toBeTruthy()
  })

  it('a thread still in the diff keeps the promise the batch can keep', () => {
    render(<ThreadCard thread={held} actions={actions()} />)
    expect(screen.getByText(/Finish review takes it with the batch/)).toBeTruthy()
  })
})
