// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Anchor, ReviewMessage, ReviewThread } from '../shared/review.js'
import {
  type AgentNotifications,
  BANNER_LINGER_MS,
  useAgentNotifications,
} from './useAgentNotifications.js'

let seq = 0
function msg(author: 'reviewer' | 'agent', text = 'x', over: Partial<ReviewMessage> = {}) {
  return { id: `m-${++seq}`, author, text, at: '2026-08-08T00:00:00Z', ...over }
}

function thread(over: Partial<ReviewThread> = {}): ReviewThread {
  return {
    id: `t-${++seq}`,
    anchor: { kind: 'hunk', hunkId: 'h', path: 'src/a.ts', side: 'new', line: 12 } as Anchor,
    state: 'sent',
    codeContext: null,
    codeChanged: false,
    messages: [msg('reviewer', 'why this?')],
    createdAt: '2026-08-08T00:00:00Z',
    updatedAt: '2026-08-08T00:00:00Z',
    ...over,
  }
}

/** `name` is the agent's title for the change — absent until it polls. */
type Props = { t: ReviewThread[]; name?: string }

function mount(threads: ReviewThread[], title?: string) {
  const onOpenThread = vi.fn()
  const rendered = renderHook<AgentNotifications, Props>(
    ({ t, name }) => useAgentNotifications({ threads: t, title: name, onOpenThread }),
    { initialProps: { t: threads, name: title } },
  )
  return { ...rendered, onOpenThread }
}

function reply(t: ReviewThread, text: string): ReviewThread {
  return { ...t, messages: [...t.messages, msg('agent', text)] }
}

const focusTab = () =>
  act(() => {
    window.dispatchEvent(new Event('focus'))
  })

beforeEach(() => {
  vi.useFakeTimers()
  document.title = 'Diffo'
  vi.spyOn(document, 'hasFocus').mockReturnValue(false)
})

afterEach(() => {
  cleanup()
  document.querySelector('meta[name="diffo-env"]')?.remove()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('useAgentNotifications', () => {
  it('the first snapshot is history — it seeds, it never announces', () => {
    const answered = thread({ messages: [msg('reviewer'), msg('agent', 'old news')] })
    const { result } = mount([answered])
    expect(result.current.notices).toEqual([])
    expect(document.title).toBe('Diffo')
  })

  it('a fresh answer while unfocused raises the banner and the badge', () => {
    const t = thread()
    const { result, rerender } = mount([t])
    rerender({ t: [reply(t, "It's guarded.\nmore")] })
    expect(document.title).toBe('(1) Diffo')
    expect(result.current.notices).toHaveLength(1)
    expect(result.current.notices[0]).toMatchObject({
      kind: 'answer',
      threadId: t.id,
      anchor: 'src/a.ts:12',
      preview: "It's guarded.",
    })
  })

  it('answers accumulate while the reviewer is away', () => {
    const a = thread()
    const b = thread({ anchor: { kind: 'file', path: 'src/b.ts' } })
    const { result, rerender } = mount([a, b])
    const aReplied = reply(a, 'one')
    rerender({ t: [aReplied, b] })
    rerender({ t: [aReplied, reply(b, 'two')] })
    expect(document.title).toBe('(2) Diffo')
    expect(result.current.notices.map((n) => n.preview)).toEqual(['one', 'two'])
  })

  it('a focused tab gets neither banner nor badge — the page itself is enough', () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    const t = thread()
    const { result, rerender } = mount([t])
    rerender({ t: [reply(t, 'answer')] })
    expect(result.current.notices).toEqual([])
    expect(document.title).toBe('Diffo')
  })

  it('a guide reaches a focused tab — it lands while the reviewer is already reading', () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    const t = thread()
    const { result, rerender } = mount([t])
    const guide = thread({
      state: 'open',
      anchor: { kind: 'changeset' },
      messages: [msg('agent', 'Moves the poll into its own handler.')],
    })
    rerender({ t: [t, guide] })
    expect(result.current.notices).toHaveLength(1)
    expect(result.current.notices[0]).toMatchObject({ kind: 'guide', threadId: guide.id })
    // The badge is for a tab nobody is looking at; a focused one keeps its title.
    expect(document.title).toBe('Diffo')
  })

  it('the guide outlives the linger — only a click or a dismiss takes it down', () => {
    const t = thread()
    const guide = thread({
      state: 'open',
      anchor: { kind: 'changeset' },
      messages: [msg('agent', 'the map')],
    })
    const { result, rerender } = mount([t])
    rerender({ t: [reply(t, 'answer'), guide] })
    expect(result.current.notices).toHaveLength(2)
    focusTab()
    act(() => {
      vi.advanceTimersByTime(BANNER_LINGER_MS)
    })
    expect(result.current.notices.map((n) => n.kind)).toEqual(['guide'])
    act(() => result.current.open(result.current.notices[0]!))
    expect(result.current.notices).toEqual([])
  })

  it('focus clears the badge at once and the banner after the linger', () => {
    const t = thread()
    const { result, rerender } = mount([t])
    rerender({ t: [reply(t, 'answer')] })
    focusTab()
    expect(document.title).toBe('Diffo')
    expect(result.current.notices).toHaveLength(1)
    act(() => {
      vi.advanceTimersByTime(BANNER_LINGER_MS)
    })
    expect(result.current.notices).toEqual([])
  })

  it('leaving again keeps what a brief visit did not read', () => {
    const a = thread()
    const b = thread()
    const { result, rerender } = mount([a, b])
    const aReplied = reply(a, 'one')
    rerender({ t: [aReplied, b] })
    focusTab()
    // Away again before the fade — a new answer lands and cancels it.
    rerender({ t: [aReplied, reply(b, 'two')] })
    act(() => {
      vi.advanceTimersByTime(BANNER_LINGER_MS * 2)
    })
    expect(result.current.notices).toHaveLength(2)
  })

  it('opening a notice jumps to its thread and drops it', () => {
    const t = thread()
    const { result, rerender, onOpenThread } = mount([t])
    rerender({ t: [reply(t, 'answer')] })
    act(() => result.current.open(result.current.notices[0]!))
    expect(onOpenThread).toHaveBeenCalledWith(t.id)
    expect(result.current.notices).toEqual([])
  })

  it('the agent title IS the tab name, and the badge rides in front of it', () => {
    const t = thread()
    // No app name alongside it: ~20 characters is the whole budget, and the
    // favicon already says which app this is.
    const { rerender } = mount([t], 'flaky upload retries')
    expect(document.title).toBe('flaky upload retries')
    rerender({ t: [reply(t, 'answer')], name: 'flaky upload retries' })
    expect(document.title).toBe('(1) flaky upload retries')
    focusTab()
    expect(document.title).toBe('flaky upload retries')
  })

  it('a title arriving mid-review renames the tab, badge and all', () => {
    const t = thread()
    const { rerender } = mount([t])
    // No agent has polled yet — the tab keeps the name the server served.
    expect(document.title).toBe('Diffo')
    const answered = reply(t, 'answer')
    rerender({ t: [answered] })
    expect(document.title).toBe('(1) Diffo')
    rerender({ t: [answered], name: 'tab titles' })
    expect(document.title).toBe('(1) tab titles')
  })

  it('a dev review still announces itself in the tab, in six characters', () => {
    document.title = 'diffo-dev'
    document.head.insertAdjacentHTML('beforeend', '<meta name="diffo-env" content="development" />')
    mount([thread()], 'tab titles')
    expect(document.title).toBe('dev · tab titles')
  })

  it('an untitled dev review keeps the name the server served', () => {
    document.title = 'diffo-dev'
    mount([thread()])
    expect(document.title).toBe('diffo-dev')
  })

  it('clear drops everything at once', () => {
    const a = thread()
    const b = thread()
    const { result, rerender } = mount([a, b])
    const aReplied = reply(a, 'one')
    rerender({ t: [aReplied, b] })
    rerender({ t: [aReplied, reply(b, 'two')] })
    act(() => result.current.clear())
    expect(result.current.notices).toEqual([])
  })
})
