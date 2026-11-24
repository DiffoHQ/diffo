import { describe, expect, it } from 'vitest'
import {
  nextReviewerHue,
  REVIEWER_HUES,
  type ReviewerEvent,
  type ReviewThread,
} from '../shared/review.js'
import {
  formatWorked,
  needsYouBy,
  type Reviewers,
  reviewerHue,
  reviewerRows,
  reviewerStory,
  shortWhere,
  threadCountsBy,
  workedMs,
} from './actors.js'

describe('reviewerHue', () => {
  it('is the colour the reviewer was given when it took its seat', () => {
    const hues = new Map([
      ['codex', 3],
      ['gemini', 5],
    ])
    expect(reviewerHue('codex', hues)).toBe(3)
    expect(reviewerHue('gemini', hues)).toBe(5)
  })

  it('keeps one hue for a name that has no seat any more', () => {
    const hue = reviewerHue('codex')
    expect(hue).toBeGreaterThanOrEqual(1)
    expect(hue).toBeLessThanOrEqual(REVIEWER_HUES)
    expect(reviewerHue('codex', new Map([['gemini', 1]]))).toBe(hue)
  })
})

describe('nextReviewerHue', () => {
  it('is the first colour nobody wears, so a freed one is used again', () => {
    expect(nextReviewerHue([])).toBe(1)
    expect(nextReviewerHue([1, 2])).toBe(3)
    expect(nextReviewerHue([1, 3])).toBe(2)
  })

  it('goes round again once every colour is worn', () => {
    const all = Array.from({ length: REVIEWER_HUES }, (_, i) => i + 1)
    expect(nextReviewerHue(all)).toBe(1)
    expect(nextReviewerHue([...all, 1])).toBe(2)
  })
})

describe('reviewer status', () => {
  const at = '2026-01-01T00:00:00.000Z'
  const base = (over: Partial<Reviewers> = {}): Reviewers => ({
    seats: ['a', 'b'],
    states: new Map([
      ['a', 'active'],
      ['b', 'listening'],
    ]),
    ...over,
  })

  it('reads one status per reviewer, from its state, its threads and its last step', () => {
    const rows = reviewerRows(
      base({
        seats: ['a', 'b', 'c', 'd', 'e'],
        states: new Map([
          ['a', 'active'],
          ['b', 'listening'],
          ['c', 'listening'],
          ['d', 'active'],
        ]),
        needsYou: new Map([['c', 2]]),
        activity: new Map([
          ['d', [{ at, kind: 'done', text: 'finished: nothing left to wait for' }]],
          ['e', [{ at, kind: 'doing', text: 'reading the cache' }]],
        ]),
      }),
    )
    expect(rows.map((r) => [r.name, r.status, r.line])).toEqual([
      ['a', 'working', null],
      ['b', 'waiting', null],
      ['c', 'needs', '2 threads need you'],
      ['d', 'done', 'finished'],
      ['e', 'away', 'last: reading the cache'],
    ])
  })

  it('one that finished and left stays finished, whatever it logged after', () => {
    const later = '2026-01-01T00:05:00.000Z'
    const rows = reviewerRows(
      base({
        seats: ['f', 'g'],
        states: new Map(),
        activity: new Map([
          [
            'f',
            [
              { at, kind: 'joined', text: 'joined' },
              { at, kind: 'done', text: 'finished' },
              { at: later, kind: 'doing', text: 'says it read 8 of 57 files' },
            ],
          ],
          // A finish before it joined again is not this session's.
          [
            'g',
            [
              { at, kind: 'done', text: 'finished' },
              { at: later, kind: 'joined', text: 'rejoined' },
            ],
          ],
        ]),
      }),
    )
    expect(rows.map((r) => [r.name, r.status])).toEqual([
      ['f', 'done'],
      ['g', 'away'],
    ])
  })

  it('a thread the human holds needs them, as a stopped one does', () => {
    const thread = (extra: Record<string, unknown>) =>
      ({
        id: 'x',
        state: 'sent',
        messages: [{ id: 'm', author: 'reviewer', by: 'a', text: 't', at }],
        ...extra,
      }) as unknown as Parameters<typeof needsYouBy>[0][number]
    expect(needsYouBy([thread({ needsYou: 'rounds' })]).get('a')).toBe(1)
    expect(needsYouBy([thread({ withheld: true })]).get('a')).toBe(1)
    expect(needsYouBy([thread({ state: 'open' })]).get('a')).toBe(1)
    expect(needsYouBy([thread({ state: 'resolved', needsYou: 'rounds' })]).get('a')).toBeUndefined()
    expect(needsYouBy([thread({})]).get('a')).toBeUndefined()
  })

  it('one asked for in a role it already has is a new row: the finished one stays finished', () => {
    const rows = reviewerRows(
      base({
        seats: ['a'],
        states: new Map([['a', 'active']]),
        roles: new Map([['a', 'security']]),
        starting: ['security'],
        activity: new Map([['a', [{ at, kind: 'done', text: 'finished' }]]]),
      }),
    )
    expect(rows.map((r) => [r.name, r.status, r.seated])).toEqual([
      ['a', 'done', true],
      ['security', 'starting', false],
    ])
  })

  it('one the human stopped reads as stopped, whatever waits on it', () => {
    const [row] = reviewerRows(
      base({ seats: ['a'], states: new Map([['a', 'stopped']]), needsYou: new Map([['a', 1]]) }),
    )
    expect(row).toMatchObject({ status: 'stopped', line: null })
  })

  it('its conversation with the human is not what it is doing', () => {
    const [row] = reviewerRows(
      base({
        seats: ['a'],
        activity: new Map([
          [
            'a',
            [
              { at, kind: 'doing', text: 'reading app.ts' },
              { at, kind: 'told', text: 'stop' },
              { at, kind: 'heard', text: 'read your message' },
              { at, kind: 'said', text: 'stopping now' },
            ],
          ],
        ]),
      }),
    )
    expect(row!.line).toBe('reading app.ts')
  })
})

describe('reviewer story', () => {
  const at = (minute: number) => new Date(Date.UTC(2026, 0, 1, 0, minute)).toISOString()
  const ev = (minute: number, kind: string, text: string, threadId?: string) =>
    ({ at: at(minute), kind, text, ...(threadId ? { threadId } : {}) }) as ReviewerEvent
  const thread = (id: string, extra: Record<string, unknown>) =>
    ({
      id,
      state: 'sent',
      messages: [{ id: 'm', author: 'reviewer', by: 'g', text: 't', at: at(0) }],
      ...extra,
    }) as unknown as ReviewThread
  // The general reviewer's log from a real run.
  const events = [
    ev(0, 'joined', 'rejoined as General reviewer'),
    ev(0, 'doing', 'reading the server side: reviewers, roles, routes'),
    ev(3, 'commented', 'commented on src/server/index.ts:345 (new side)', 't1'),
    ev(4, 'doing', 'reading the author-agent side: prompt and delivery'),
    ev(4, 'waiting', 'waiting for an answer'),
    ev(5, 'answered', 'got an answer to read'),
    ev(6, 'closed', 'closed its thread on src/server/index.ts:345 (new side)', 't1'),
    ev(6, 'done', 'finished: nothing left to wait for'),
  ]
  const closed = thread('t1', {
    state: 'resolved',
    messages: [
      { id: 'a', author: 'reviewer', by: 'g', text: 'x', at: at(3) },
      { id: 'b', author: 'agent', text: 'fixed', at: at(5) },
    ],
  })

  it('tells the log newest first: finished on top, one line a step, each comment with its state', () => {
    const items = reviewerStory(events, [], [closed], false)
    expect(items.map((i) => i.kind)).toEqual(['done', 'step', 'comment', 'step', 'joined'])
    expect(items[2]).toMatchObject({
      where: 'index.ts:345',
      threadId: 't1',
      status: 'closed',
      first: 'x',
    })
  })

  it('puts what you and it said where it was said', () => {
    const items = reviewerStory(
      [ev(0, 'joined', 'j'), ev(4, 'doing', 'b')],
      [
        { at: at(2), from: 'you', text: 'look here' },
        { at: at(3), from: 'agent', text: 'on it' },
      ],
      [],
      true,
    )
    expect(items.map((i) => (i.kind === 'message' ? `${i.from}:${i.text}` : i.kind))).toEqual([
      'step',
      'agent:on it',
      'you:look here',
      'joined',
    ])
    // The newest step is what it is on now, while it works.
    expect(items[0]).toMatchObject({ kind: 'step', current: true })
  })

  it('a comment says where its thread stands, in a word', () => {
    const status = (t?: ReviewThread) =>
      (
        reviewerStory(
          [ev(0, 'commented', 'commented on a.ts', t?.id ?? 'gone')],
          [],
          t ? [t] : [],
          true,
        )[0] as { status: string }
      ).status
    expect(status(thread('x', {}))).toBe('open')
    expect(status(thread('x', { needsYou: 'reviewer' }))).toBe('needs you')
    expect(status(thread('x', { withheld: true }))).toBe('needs you')
    expect(status(thread('x', { state: 'resolved' }))).toBe('closed')
    expect(status()).toBe('gone')
  })

  it('shortens a place to the file and line', () => {
    expect(shortWhere('src/server/index.ts:345 (new side)')).toBe('index.ts:345')
    expect(shortWhere('the whole changeset')).toBe('the whole changeset')
    expect(shortWhere('src/ui/App.tsx')).toBe('App.tsx')
  })
})

describe('reviewer row meta', () => {
  const at = (minute: number) => new Date(Date.UTC(2026, 0, 1, 0, minute)).toISOString()
  const ev = (minute: number, kind: string) => ({ at: at(minute), kind, text: '' }) as ReviewerEvent
  const events = [ev(0, 'joined'), ev(5, 'doing'), ev(12, 'done')]

  it('counts from its first join to now while live, or to its last line once gone', () => {
    expect(workedMs(events, true, Date.parse(at(30)))).toBe(30 * 60_000)
    expect(workedMs(events, false, Date.parse(at(30)))).toBe(12 * 60_000)
    expect(workedMs([], true, 0)).toBeNull()
    expect(workedMs(undefined, true, 0)).toBeNull()
  })

  it('reads in minutes, then hours', () => {
    expect(formatWorked(20_000)).toBe('<1m')
    expect(formatWorked(14 * 60_000)).toBe('14m')
    expect(formatWorked(65 * 60_000)).toBe('1h 05m')
  })

  it('counts only the threads it opened, open and closed', () => {
    const by = (who: string, state: string) =>
      ({
        id: `${who}-${state}`,
        state,
        messages: [{ id: 'm', author: 'reviewer', by: who, text: 't', at: at(0) }],
      }) as unknown as ReviewThread
    const threads = [
      by('kit', 'sent'),
      by('kit', 'resolved'),
      by('kit', 'resolved'),
      by('sol', 'sent'),
    ]
    expect(threadCountsBy(threads, 'kit')).toEqual({ open: 1, closed: 2 })
    expect(threadCountsBy(threads, 'gus')).toEqual({ open: 0, closed: 0 })
  })
})
