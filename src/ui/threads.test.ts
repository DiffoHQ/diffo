import { describe, expect, it } from 'vitest'
import type { Anchor, ReviewMessage, ReviewThread } from '../shared/review.js'
import {
  byFile,
  byTurn,
  holdsAttention,
  isUnsent,
  threadItems,
  threadOutcome,
  threadTurn,
  unsettledCount,
  yourTurnCount,
} from './threads.js'

function msg(author: 'reviewer' | 'agent', text = 'x', over: Partial<ReviewMessage> = {}) {
  return { id: `m-${Math.random()}`, author, text, at: '2026-08-08T00:00:00Z', ...over }
}

function thread(over: Partial<ReviewThread> = {}): ReviewThread {
  return {
    id: 't-1',
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

describe('isUnsent', () => {
  it('counts an unsent note and a held reply alike', () => {
    expect(isUnsent(thread({ state: 'open' }))).toBe(true)
    expect(isUnsent(thread({ state: 'sent', withheld: true }))).toBe(true)
    expect(isUnsent(thread({ state: 'addressed', withheld: true }))).toBe(true)
  })

  it('a handed-over thread owes nothing', () => {
    expect(isUnsent(thread({ state: 'sent' }))).toBe(false)
    expect(isUnsent(thread({ state: 'addressed' }))).toBe(false)
    expect(isUnsent(thread({ state: 'resolved' }))).toBe(false)
  })

  it('survives an agent reply landing after the held one', () => {
    const t = thread({
      state: 'addressed',
      withheld: true,
      messages: [msg('reviewer'), msg('reviewer', 'held'), msg('agent', 'answering the first')],
    })
    expect(threadTurn(t)).toBe('yours')
    expect(isUnsent(t)).toBe(true)
  })
})

describe('threadTurn — a reply you kept', () => {
  it('a withheld reply is Not sent, never "waiting on the agent"', () => {
    const held = thread({
      state: 'sent',
      withheld: true,
      messages: [msg('reviewer', 'q'), msg('agent', 'a'), msg('reviewer', 'kept back')],
    })
    expect(threadTurn(held)).toBe('note')
  })

  it('the same thread without the flag still waits on the agent', () => {
    const sent = thread({
      state: 'sent',
      messages: [msg('reviewer', 'q'), msg('agent', 'a'), msg('reviewer', 'sent it')],
    })
    expect(threadTurn(sent)).toBe('agent')
  })

  it('resolving outranks it — a settled thread is settled', () => {
    expect(threadTurn(thread({ state: 'resolved', withheld: true }))).toBe('resolved')
  })

  it('an answer you have not read outranks a reply you have not sent', () => {
    const both = thread({
      state: 'sent',
      withheld: true,
      messages: [msg('reviewer', 'q'), msg('reviewer', 'kept back'), msg('agent', 'answer')],
    })
    expect(threadTurn(both)).toBe('yours')
  })
})

describe('threadTurn', () => {
  it('the agent spoke last on a sent thread → your turn', () => {
    expect(threadTurn(thread({ messages: [msg('reviewer'), msg('agent')] }))).toBe('yours')
    expect(
      threadTurn(thread({ state: 'addressed', messages: [msg('reviewer'), msg('agent')] })),
    ).toBe('yours')
  })

  it('you spoke last on a sent thread → waiting on the agent', () => {
    expect(threadTurn(thread())).toBe('agent')
    expect(threadTurn(thread({ messages: [msg('reviewer'), msg('agent'), msg('reviewer')] }))).toBe(
      'agent',
    )
  })

  it('once the agent concluded the batch, waiting stops being honest', () => {
    expect(threadTurn(thread({ unanswered: true }))).toBe('unanswered')
  })

  it('a silent code edit is still an answer — that one comes back to you', () => {
    expect(threadTurn(thread({ state: 'addressed', unanswered: true }))).toBe('yours')
  })

  it('a resolved thread is settled, whatever the agent did or did not do', () => {
    expect(threadTurn(thread({ state: 'resolved', unanswered: true }))).toBe('resolved')
  })

  it('never sent → a note, which waits on nobody', () => {
    expect(threadTurn(thread({ state: 'open' }))).toBe('note')
  })

  it('resolved outranks whoever spoke last — settled is settled', () => {
    expect(
      threadTurn(thread({ state: 'resolved', messages: [msg('reviewer'), msg('agent')] })),
    ).toBe('resolved')
  })

  it('is derived, so nothing about *reading* can change it', () => {
    const t = thread({ messages: [msg('reviewer'), msg('agent')] })
    expect(threadTurn(t)).toBe('yours')
    expect(threadTurn({ ...t, codeChanged: true })).toBe('yours')
    expect(threadTurn(structuredClone(t))).toBe('yours')
  })
})

describe('threads', () => {
  it('carries what a row needs to be recognised without opening the diff', () => {
    const [item] = threadItems([
      thread({
        messages: [
          msg('reviewer', 'Why does median use sort()?\nsecond line'),
          msg('agent', 'Good catch — added a comparator.\nmore detail', { durationMs: 6800 }),
        ],
      }),
    ])
    expect(item!.question).toBe('Why does median use sort()?')
    expect(item!.answer).toBe('Good catch — added a comparator.')
    expect(item!.anchor).toBe('src/a.ts:12')
    expect(item!.path).toBe('src/a.ts')
    expect(item!.durationMs).toBe(6800)
    expect(item!.turn).toBe('yours')
  })

  it('describes file and changeset anchors honestly', () => {
    const [file] = threadItems([thread({ anchor: { kind: 'file', path: 'src/b.ts' } })])
    expect(file!.anchor).toBe('src/b.ts')
    expect(file!.path).toBe('src/b.ts')

    const [note] = threadItems([thread({ anchor: { kind: 'changeset' } })])
    expect(note!.anchor).toBeNull()
    expect(note!.path).toBeNull()
  })

  it('has no answer until the agent has actually spoken', () => {
    const [item] = threadItems([thread()])
    expect(item!.answer).toBeNull()
    expect(item!.durationMs).toBeUndefined()
  })

  it('carries the queue place for a send waiting in line', () => {
    const queued = new Map([['t-1', 2]])
    const [item] = threadItems([thread()], new Set(), queued)
    expect(item!.queued).toBe(2)
    expect(item!.working).toBeUndefined()
  })

  it('working outranks queued — a re-queued follow-up reads as "on it"', () => {
    const [item] = threadItems([thread()], new Set(['t-1']), new Map([['t-1', 1]]))
    expect(item!.working).toBe(true)
    expect(item!.queued).toBeUndefined()
  })
})

describe('byTurn', () => {
  const items = threadItems([
    thread({ id: 'a', state: 'open', updatedAt: '2026-08-08T00:00:01Z' }),
    thread({
      id: 'b',
      messages: [msg('reviewer'), msg('agent')],
      updatedAt: '2026-08-08T00:00:02Z',
    }),
    thread({
      id: 'c',
      messages: [msg('reviewer'), msg('agent')],
      updatedAt: '2026-08-08T00:00:09Z',
    }),
    thread({ id: 'd', updatedAt: '2026-08-08T00:00:03Z' }),
    thread({ id: 'e', state: 'resolved', updatedAt: '2026-08-08T00:00:04Z' }),
  ])

  it('groups in section order and puts the newest first inside each', () => {
    const groups = byTurn(items)
    expect([...groups.keys()]).toEqual(['yours', 'agent', 'note', 'resolved'])
    expect(groups.get('yours')!.map((i) => i.thread.id)).toEqual(['c', 'b'])
  })

  it('omits empty sections — an empty group is noise', () => {
    const groups = byTurn(threadItems([thread({ state: 'open' })]))
    expect([...groups.keys()]).toEqual(['note'])
  })

  it('every thread lands in exactly one section', () => {
    const groups = byTurn(items)
    const placed = [...groups.values()]
      .flat()
      .map((i) => i.thread.id)
      .sort()
    expect(placed).toEqual(['a', 'b', 'c', 'd', 'e'])
  })

  it('counts what wants you', () => {
    expect(yourTurnCount(items)).toBe(2)
  })
})

describe('byFile / holdsAttention', () => {
  const items = threadItems([
    thread({ id: 'a', anchor: { kind: 'file', path: 'src/a.ts' }, state: 'resolved' }),
    thread({ id: 'b', anchor: { kind: 'file', path: 'src/a.ts' }, state: 'open' }),
    thread({ id: 'c', anchor: { kind: 'changeset' } }),
  ])

  it('groups by file and leaves changeset notes out', () => {
    const map = byFile(items)
    expect(map.get('src/a.ts')!.map((i) => i.thread.id)).toEqual(['a', 'b'])
    expect([...map.keys()]).toEqual(['src/a.ts'])
  })

  it('a resolved thread or a note does not hold a file open', () => {
    expect(holdsAttention(byFile(items).get('src/a.ts'))).toBe(false)
    expect(holdsAttention(undefined)).toBe(false)
  })

  it('an answered or awaiting thread does hold it open', () => {
    const answered = threadItems([
      thread({ anchor: { kind: 'file', path: 'x' }, messages: [msg('reviewer'), msg('agent')] }),
    ])
    expect(holdsAttention(answered)).toBe(true)
    const waiting = threadItems([thread({ anchor: { kind: 'file', path: 'x' } })])
    expect(holdsAttention(waiting)).toBe(true)
  })
})

describe('threadOutcome', () => {
  it('reply plus a rewritten hunk is a fix', () => {
    expect(
      threadOutcome(thread({ state: 'addressed', messages: [msg('reviewer'), msg('agent')] })),
    ).toBe('fixed')
  })

  it('a reply with the code untouched answered a question', () => {
    expect(threadOutcome(thread({ messages: [msg('reviewer'), msg('agent')] }))).toBe('answered')
  })

  it('a rewritten hunk with no reply is a silent change, not an answer', () => {
    expect(threadOutcome(thread({ state: 'addressed' }))).toBe('changed')
  })

  it('nothing back, batch concluded → no answer; nothing back, still out → waiting', () => {
    expect(threadOutcome(thread({ unanswered: true }))).toBe('no-answer')
    expect(threadOutcome(thread())).toBe('waiting')
  })

  it('notes and settled threads have no outcome to report', () => {
    expect(threadOutcome(thread({ state: 'open' }))).toBeNull()
    expect(threadOutcome(thread({ state: 'resolved' }))).toBeNull()
  })

  it('rides along on the thread rows', () => {
    const [item] = threadItems([thread({ unanswered: true })])
    expect(item!.outcome).toBe('no-answer')
    expect(item!.turn).toBe('unanswered')
  })
})

describe('yourTurnCount', () => {
  it('counts the dead ends too — they need a decision as much as an answer does', () => {
    const items = threadItems([
      thread({ id: 'a', messages: [msg('reviewer'), msg('agent')] }),
      thread({ id: 'b', unanswered: true }),
      thread({ id: 'c' }),
      thread({ id: 'd', state: 'open' }),
    ])
    expect(yourTurnCount(items)).toBe(2)
  })
})

describe('unsettledCount', () => {
  it('counts every conversation still going, and no settled one', () => {
    const items = threadItems([
      thread({ id: 'a', messages: [msg('reviewer'), msg('agent')] }),
      thread({ id: 'b', unanswered: true }),
      thread({ id: 'c' }),
      thread({ id: 'd', state: 'open' }),
      thread({ id: 'e', state: 'resolved' }),
      thread({ id: 'f', state: 'resolved' }),
    ])
    expect(unsettledCount(items)).toBe(4)
  })
})

describe('agent-voice threads', () => {
  const agentThread = (over: Partial<ReviewThread> = {}) =>
    thread({
      state: 'open',
      messages: [msg('agent', 'start with review.ts — the rest is plumbing')],
      ...over,
    })

  it('a fresh agent thread is From the agent, never an unsent draft of yours', () => {
    expect(threadTurn(agentThread())).toBe('proposed')
    expect(isUnsent(agentThread())).toBe(false)
    expect(yourTurnCount(threadItems([agentThread()]))).toBe(0)
  })

  it('a reviewer reply makes it count — Not sent, with Send to hand it over', () => {
    const engaged = agentThread({
      messages: [msg('agent', 'note'), msg('reviewer', 'expand on that?')],
    })
    expect(threadTurn(engaged)).toBe('note')
    expect(isUnsent(engaged)).toBe(true)
  })

  it('once the reviewer replies in, it walks the normal conversation turns', () => {
    const replied = agentThread({
      state: 'sent',
      messages: [msg('agent', 'note'), msg('reviewer', 'expand on that?')],
    })
    expect(threadTurn(replied)).toBe('agent')

    const answered = agentThread({
      state: 'sent',
      messages: [msg('agent', 'note'), msg('reviewer', 'expand?'), msg('agent', 'sure —')],
    })
    expect(threadTurn(answered)).toBe('yours')

    expect(threadTurn(agentThread({ state: 'resolved' }))).toBe('resolved')
  })
})
