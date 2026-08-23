import { describe, expect, it } from 'vitest'
import type { Anchor, ReviewMessage, ReviewThread } from '../shared/review.js'
import { agentMessageKeys, badgeTitle, collectNotices } from './notifications.js'

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

describe('agentMessageKeys', () => {
  it('lists agent messages only, keyed by thread and message', () => {
    const reply = msg('agent', 'because')
    const t = thread({ messages: [msg('reviewer', 'why?'), reply] })
    expect(agentMessageKeys([t])).toEqual([`${t.id}:${reply.id}`])
  })

  it('an all-reviewer review seeds empty', () => {
    expect(agentMessageKeys([thread(), thread()])).toEqual([])
  })
})

describe('collectNotices', () => {
  it('a fresh agent reply becomes an answer notice with anchor and first line', () => {
    const t = thread({
      messages: [msg('reviewer', 'why?'), msg('agent', "It's guarded.\nSecond line.")],
    })
    const notices = collectNotices([t], new Set())
    expect(notices).toHaveLength(1)
    expect(notices[0]).toMatchObject({
      kind: 'answer',
      threadId: t.id,
      anchor: 'src/a.ts:12',
      preview: "It's guarded.",
    })
  })

  it('a seen message never notifies again', () => {
    const t = thread({ messages: [msg('reviewer'), msg('agent', 'done')] })
    const seen = new Set(agentMessageKeys([t]))
    expect(collectNotices([t], seen)).toEqual([])
  })

  it('an untouched agent-started thread is a thread notice', () => {
    const t = thread({ state: 'open', messages: [msg('agent', 'consider a guard here')] })
    expect(collectNotices([t], new Set())[0]!.kind).toBe('thread')
  })

  it('an agent thread the reviewer replied into notifies as an answer', () => {
    const t = thread({
      messages: [msg('agent', 'consider'), msg('reviewer', 'go on'), msg('agent', 'like this')],
    })
    expect(collectNotices([t], new Set())[0]!.kind).toBe('answer')
  })

  it('two agent messages in one thread are one notice, for the latest', () => {
    const first = msg('agent', 'part one')
    const second = msg('agent', 'part two')
    const t = thread({ messages: [msg('reviewer'), first, second] })
    const notices = collectNotices([t], new Set())
    expect(notices).toHaveLength(1)
    expect(notices[0]!.key).toBe(`${t.id}:${second.id}`)
    expect(notices[0]!.preview).toBe('part two')
  })

  it('a reviewer reply after the answer still surfaces the answer', () => {
    const answer = msg('agent', 'the answer')
    const t = thread({ messages: [msg('reviewer'), answer, msg('reviewer', 'thanks, and…?')] })
    expect(collectNotices([t], new Set())[0]!.key).toBe(`${t.id}:${answer.id}`)
  })

  it('file and changeset anchors label accordingly', () => {
    const onFile = thread({
      anchor: { kind: 'file', path: 'src/b.ts' },
      messages: [msg('reviewer'), msg('agent', 'a')],
    })
    const onAll = thread({
      anchor: { kind: 'changeset' },
      messages: [msg('reviewer'), msg('agent', 'b')],
    })
    const [f, c] = collectNotices([onFile, onAll], new Set())
    expect(f!.anchor).toBe('src/b.ts')
    expect(c!.anchor).toBeNull()
  })
})

describe('badgeTitle', () => {
  it('prefixes a count and restores clean at zero', () => {
    expect(badgeTitle(3, 'Diffo')).toBe('(3) Diffo')
    expect(badgeTitle(0, 'Diffo')).toBe('Diffo')
  })
})

// Dummy edit — reviewer testing the live-update loop; safe to delete.
