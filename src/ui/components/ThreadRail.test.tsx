// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Anchor, ReviewThread } from '../../shared/review.js'
import { threadItems } from '../threads.js'
import { LeftPanel } from './LeftPanel.js'
import { ThreadRail } from './ThreadRail.js'

afterEach(cleanup)

const msg = (author: 'reviewer' | 'agent', text: string, durationMs?: number) => ({
  id: `m-${text}`,
  author,
  text,
  at: '2026-08-08T00:00:00Z',
  ...(durationMs === undefined ? {} : { durationMs }),
})

function thread(over: Partial<ReviewThread> = {}): ReviewThread {
  return {
    id: 't-1',
    anchor: { kind: 'hunk', hunkId: 'h', path: 'src/mathx.js', side: 'new', line: 42 } as Anchor,
    state: 'sent',
    codeContext: null,
    codeChanged: false,
    messages: [msg('reviewer', 'why this?')],
    createdAt: '2026-08-08T00:00:00Z',
    updatedAt: '2026-08-08T00:00:00Z',
    ...over,
  }
}

const rows = () => [...document.querySelectorAll('.crow')]
const sections = () => [...document.querySelectorAll('.sec-head')].map((s) => s.textContent!.trim())
const sectionOfRow = (row: Element) =>
  row.parentElement!.querySelector('.sec-head')!.textContent!.trim()

describe('ThreadRail — threads the changeset left behind', () => {
  it('a departed thread stays visible, with its answer, in the section its turn earns', () => {
    render(
      <ThreadRail
        items={threadItems([thread()])}
        pastItems={threadItems([
          thread({
            id: 't-gone',
            anchor: { kind: 'file', path: '.claude/launch.json' },
            messages: [
              msg('reviewer', 'what is this file ?'),
              msg('agent', 'Not product code — ignored it in .gitignore.'),
            ],
          }),
        ])}
      />,
    )
    expect(sections().some((s) => s.includes('Left this changeset'))).toBe(false)
    const gone = document.querySelector('[data-thread="t-gone"]')!
    expect(sectionOfRow(gone)).toBe('Your turn 1')
    expect(screen.getByText('what is this file ?')).toBeTruthy()
    expect(screen.getByText(/Not product code/)).toBeTruthy()
  })

  it('the anchor says the file went — struck through, the file tree own mark', () => {
    render(<ThreadRail items={[]} pastItems={threadItems([thread({ id: 't-gone' })])} />)
    expect(document.querySelector('.crow-where-gone')!.textContent).toBe('mathx.js:42')
    cleanup()
    render(<ThreadRail items={threadItems([thread()])} />)
    expect(document.querySelector('.crow-where-gone')).toBeNull()
  })

  it('departed threads alone are still a list, not an empty state', () => {
    render(<ThreadRail items={[]} pastItems={threadItems([thread({ id: 't-gone' })])} />)
    expect(screen.queryByText(/No threads yet/)).toBeNull()
    expect(rows()).toHaveLength(1)
  })
})

describe('ThreadRail', () => {
  it('a row is recognisable without opening the diff', () => {
    render(
      <ThreadRail
        items={threadItems([
          thread({
            messages: [
              msg('reviewer', 'Why does median use sort()?'),
              msg('agent', 'Good catch — added a comparator.', 6800),
            ],
          }),
        ])}
      />,
    )
    expect(document.querySelector('.crow-q')!.textContent).toBe('Why does median use sort()?')
    expect(document.querySelector('.crow-sub')!.textContent).toBe(
      'mathx.js:42·Good catch — added a comparator.',
    )
  })

  it('the anchor is the basename — the rail is 264px and the directories repeat', () => {
    render(<ThreadRail items={threadItems([thread()])} />)
    expect(document.querySelector('.crow-where')!.textContent).toBe('mathx.js:42')
    expect(document.querySelector('.crow-pick')!.getAttribute('title')).toBe('src/mathx.js:42')
  })

  it('sections order by whose move it is, and every thread lands in exactly one', () => {
    render(
      <ThreadRail
        items={threadItems([
          thread({ id: 'a', messages: [msg('reviewer', 'q'), msg('agent', 'a')] }),
          thread({ id: 'b' }),
          thread({ id: 'c', state: 'open' }),
          thread({ id: 'd', state: 'resolved' }),
        ])}
      />,
    )
    expect(sections()).toEqual(['Your turn 1', 'Waiting on the agent 1', 'Not sent 1', 'Settled 1'])
    expect(rows()).toHaveLength(3)
    fireEvent.click(screen.getByText(/Settled/))
    expect(rows()).toHaveLength(4)
  })

  it('a thread the agent walked away from is your move, not settled history', () => {
    render(<ThreadRail items={threadItems([thread({ id: 'a', unanswered: true })])} />)
    expect(sections()).toEqual(['Your turn 1'])
    expect(screen.getByText('no answer — the agent moved on')).toBeTruthy()
  })

  it('states what is pending, not just what happened', () => {
    render(
      <ThreadRail items={threadItems([thread({ id: 'a' }), thread({ id: 'b', state: 'open' })])} />,
    )
    expect(screen.getByText('waiting on the agent')).toBeTruthy()
    expect(screen.getByText('not sent')).toBeTruthy()
  })

  it('the right slot is the time, and nothing else — never the queue place', () => {
    render(
      <ThreadRail items={threadItems([thread({ id: 'a' })], new Set(), new Map([['a', 2]]))} />,
    )
    expect(screen.getByText('queued — #2 in line')).toBeTruthy()
    expect(document.querySelector('.crow-when')!.textContent).not.toContain('line')
  })

  it('says which thread the agent is on right now', () => {
    render(<ThreadRail items={threadItems([thread({ id: 'a' })], new Set(['a']))} />)
    expect(screen.getByText('agent is on it')).toBeTruthy()
    expect(screen.queryByText('waiting on the agent')).toBeNull()
  })

  it('a changeset note says so instead of faking a path', () => {
    render(<ThreadRail items={threadItems([thread({ anchor: { kind: 'changeset' } })])} />)
    expect(screen.getByText('the whole changeset')).toBeTruthy()
  })

  it('clicking a row hands the thread back to the app to jump to', () => {
    const onOpen = vi.fn()
    render(<ThreadRail items={threadItems([thread()])} onOpen={onOpen} />)
    fireEvent.click(screen.getByText('why this?'))
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ path: 'src/mathx.js' }))
  })

  it('a row is a container, never a button — a button cannot contain a button', () => {
    render(
      <ThreadRail
        items={threadItems([thread()])}
        onOpen={vi.fn()}
        onResolve={vi.fn()}
        onDelete={vi.fn()}
      />,
    )
    const row = rows()[0]!
    expect(row.tagName).toBe('DIV')
    expect(row.querySelector('button button')).toBeNull()
  })

  it('Resolve takes the file rows slot but not their checkbox', () => {
    const onResolve = vi.fn().mockResolvedValue(undefined)
    render(<ThreadRail items={threadItems([thread({ id: 't-9' })])} onResolve={onResolve} />)
    const mark = screen.getByLabelText('Resolve thread')
    expect(mark.className).toContain('crow-mark')
    expect(mark.className).not.toContain('row-box')
    expect(mark.tagName).toBe('BUTTON')
    expect(mark.getAttribute('aria-pressed')).toBe('false')
    expect(mark.getAttribute('role')).toBeNull()
    fireEvent.click(mark)
    expect(onResolve).toHaveBeenCalledWith('t-9')
  })

  it('the tooltip names the consequence, not just the verb', () => {
    const { unmount } = render(
      <ThreadRail items={threadItems([thread({ id: 'a' })])} onResolve={vi.fn()} />,
    )
    expect(screen.getByLabelText('Resolve thread').getAttribute('data-tip')).toBe(
      'Resolve — moves to Settled',
    )
    unmount()
    render(
      <ThreadRail
        items={threadItems([thread({ id: 'b', state: 'resolved' })])}
        onReopen={vi.fn()}
      />,
    )
    fireEvent.click(screen.getByText(/Settled/))
    expect(screen.getByLabelText('Reopen thread').getAttribute('data-tip')).toBe(
      'Reopen — moves back to its turn',
    )
  })

  it('the hover actions settle a row where you read it: resolve, or delete as noise', () => {
    const onResolve = vi.fn().mockResolvedValue(undefined)
    const onDelete = vi.fn().mockResolvedValue(undefined)
    render(
      <ThreadRail
        items={threadItems([thread({ id: 't-9' })])}
        onResolve={onResolve}
        onDelete={onDelete}
      />,
    )
    fireEvent.click(screen.getByLabelText('Resolve thread'))
    expect(onResolve).toHaveBeenCalledWith('t-9')
    fireEvent.click(screen.getByLabelText('Delete thread'))
    expect(onDelete).toHaveBeenCalledWith('t-9')
  })

  it('a resolved row offers Reopen in the same slot, like the Viewed toggle', () => {
    const onResolve = vi.fn()
    const onReopen = vi.fn().mockResolvedValue(undefined)
    render(
      <ThreadRail
        items={threadItems([thread({ id: 't-9', state: 'resolved' })])}
        onResolve={onResolve}
        onReopen={onReopen}
      />,
    )
    fireEvent.click(screen.getByText(/Settled/))
    const reopen = screen.getByLabelText('Reopen thread')
    expect(reopen.getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(reopen)
    expect(onReopen).toHaveBeenCalledWith('t-9')
    expect(onResolve).not.toHaveBeenCalled()
  })

  it('"Your turn" takes a batch: resolve everything answered in one click', () => {
    const onResolve = vi.fn().mockResolvedValue(undefined)
    render(
      <ThreadRail
        items={threadItems([
          thread({ id: 'a', messages: [msg('reviewer', 'q1'), msg('agent', 'a1')] }),
          thread({ id: 'b', messages: [msg('reviewer', 'q2'), msg('agent', 'a2')] }),
          thread({ id: 'c' }),
        ])}
        onResolve={onResolve}
      />,
    )
    fireEvent.click(screen.getByLabelText('Resolve all 2'))
    expect(onResolve.mock.calls.map((c) => c[0]).sort()).toEqual(['a', 'b'])
  })

  it('"Settled" takes the safe broom: delete settled history, touch nothing live', () => {
    const onDelete = vi.fn().mockResolvedValue(undefined)
    render(
      <ThreadRail
        items={threadItems([
          thread({ id: 'a', state: 'resolved' }),
          thread({ id: 'b', state: 'resolved' }),
          thread({ id: 'c' }),
        ])}
        onDelete={onDelete}
      />,
    )
    fireEvent.click(screen.getByLabelText('Delete all 2 settled'))
    expect(onDelete.mock.calls.map((c) => c[0]).sort()).toEqual(['a', 'b'])
  })

  it('the clear-all entry sits at the foot of the list, counting the whole store', () => {
    const onClearAll = vi.fn()
    render(<ThreadRail items={threadItems([thread()])} totalThreads={9} onClearAll={onClearAll} />)
    fireEvent.click(screen.getByText(/Clear all threads \(9\)…/))
    expect(onClearAll).toHaveBeenCalledTimes(1)
  })

  it('says so when there is nothing rather than rendering an empty frame', () => {
    render(<ThreadRail items={[]} onClearAll={vi.fn()} />)
    expect(screen.getByText(/No threads yet/)).toBeTruthy()
    expect(screen.queryByText(/Clear all threads/)).toBeNull()
  })

  it('marks the row the reading pane is showing', () => {
    const items = threadItems([thread({ id: 'a' }), thread({ id: 'b' })])
    render(<ThreadRail items={items} selectedThreadId="b" />)
    const current = [...document.querySelectorAll('.crow')].filter(
      (r) => r.getAttribute('aria-current') === 'true',
    )
    expect(current).toHaveLength(1)
    expect(current[0]!.getAttribute('data-thread')).toBe('b')
  })
})

describe('LeftPanel', () => {
  const panel = (tab: 'files' | 'threads', wantsYou: number, onSetTab = vi.fn()) =>
    render(
      <LeftPanel
        tab={tab}
        onSetTab={onSetTab}
        fileCount={22}
        threadCount={6}
        wantsYou={wantsYou}
        files={<div data-testid="files" />}
        threads={<div data-testid="threads" />}
      />,
    )

  it('shows one list at a time and switches on click', () => {
    const onSetTab = vi.fn()
    panel('files', 0, onSetTab)
    expect(screen.getByTestId('files')).toBeTruthy()
    expect(screen.queryByTestId('threads')).toBeNull()
    fireEvent.click(screen.getByText(/Threads/))
    expect(onSetTab).toHaveBeenCalledWith('threads')
  })

  it('awareness survives the switch: the dot carries what wants you', () => {
    const { unmount } = panel('files', 3)
    expect(document.querySelector('.tab-dot')).toBeTruthy()
    expect(screen.getByRole('tab', { name: /Threads/ }).textContent).toContain('6')
    unmount()

    panel('files', 0)
    expect(document.querySelector('.tab-dot')).toBeNull()
    expect(screen.getByRole('tab', { name: /Threads/ }).textContent).toContain('6')
  })

  it('accounts for the settled ones the count leaves out', () => {
    render(
      <LeftPanel
        tab="threads"
        onSetTab={vi.fn()}
        fileCount={22}
        threadCount={3}
        settledCount={8}
        wantsYou={2}
        files={<div />}
        threads={<div />}
      />,
    )
    expect(screen.getByTitle('3 still going · 8 settled')).toBeTruthy()
  })
})
