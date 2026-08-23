// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Anchor, ReviewMessage, ReviewThread } from '../shared/review.js'
import { BANNER_LINGER_MS, useAgentNotifications } from './useAgentNotifications.js'

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

function mount(threads: ReviewThread[]) {
  const onOpenThread = vi.fn()
  const rendered = renderHook(
    ({ t }: { t: ReviewThread[] }) => useAgentNotifications({ threads: t, onOpenThread }),
    { initialProps: { t: threads } },
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
