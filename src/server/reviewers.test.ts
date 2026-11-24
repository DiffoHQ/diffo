import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ReviewMessage, ReviewThread } from '../shared/review.js'
import {
  parseProgress,
  REVIEWER_LOG_MAX,
  REVIEWER_PROGRESS_MAX,
  ReviewerHub,
  reviewerInbox,
  voiceOf,
} from './reviewers.js'

let clock = 0
const said = (author: ReviewMessage['author'], text: string, by?: string): ReviewMessage => ({
  id: `m${clock}`,
  author,
  text,
  at: new Date(Date.UTC(2026, 10, 22, 10, 0, clock++)).toISOString(),
  ...(by ? { by } : {}),
})
const codex = (text = 'this leaks') => said('reviewer', text, 'codex')
const author = (text = 'fixed') => said('agent', text)
const human = (text = 'agreed') => said('reviewer', text)

const thread = (
  id: string,
  messages: ReviewMessage[],
  over: Partial<ReviewThread> = {},
): ReviewThread => ({
  id,
  anchor: { kind: 'hunk', hunkId: 'h', path: 'src/a.ts', side: 'new', line: 4 },
  state: 'sent',
  codeContext: null,
  codeChanged: false,
  messages,
  createdAt: messages[0]?.at ?? '',
  updatedAt: messages.at(-1)?.at ?? '',
  ...over,
})

describe('reviewerInbox', () => {
  it('hands over what was written after the reviewer agent last looked', () => {
    const first = codex()
    const a1 = author('added a close()')
    const t = thread('t', [first, a1])
    const inbox = reviewerInbox([t], 'codex')
    expect(inbox.threads).toEqual([
      {
        threadId: 't',
        where: 'src/a.ts:4 (new side)',
        code_changed: false,
        rounds: 1,
        rounds_left: 2,
        you_said: 'this leaks',
        messages: [{ from: 'author agent', text: 'added a close()' }],
      },
    ])
    expect(inbox.handed).toEqual([{ threadId: 't', through: a1.at }])
    // Seen through that answer: nothing new, and it is the reviewer's move.
    const seen = reviewerInbox([{ ...t, reviewerSeenAt: a1.at }], 'codex')
    expect(seen.threads).toEqual([])
    expect(seen.handed).toEqual([])
    expect(seen.yourMove).toEqual([{ threadId: 't', where: 'src/a.ts:4 (new side)' }])
    expect(seen.counts).toMatchObject({ yours: 1, waiting: 0 })
  })

  it('counts what is still owed an answer, and what the author agent passed over', () => {
    const inbox = reviewerInbox(
      [
        thread('waiting', [codex()]),
        thread('passed', [codex()], { unanswered: true }),
        thread('promised', [codex(), author('looking')], { awaitingFollowUp: true }),
        thread('closed', [codex(), author()], { state: 'resolved' }),
        // The human holds these: their words are on the way, so it waits.
        thread('held', [codex(), author(), human()], { withheld: true }),
        thread('reopened', [codex(), author()], { state: 'open' }),
      ],
      'codex',
    )
    expect(inbox.threads).toEqual([])
    expect(inbox.yourMove).toEqual([])
    expect(inbox.counts).toEqual({ waiting: 4, yours: 0, human: 0, unanswered: 1, resolved: 1 })
  })

  it('announces a stopped thread once, with the words it had not read', () => {
    const messages = [codex(), author(), codex(), author(), codex(), author('no')]
    const stopped = thread('t', messages, { needsYou: 'rounds', reviewerSeenAt: messages[3]!.at })
    const inbox = reviewerInbox([stopped], 'codex')
    expect(inbox.threads).toEqual([])
    expect(inbox.needsHuman).toEqual([
      {
        threadId: 't',
        where: 'src/a.ts:4 (new side)',
        messages: [{ from: 'author agent', text: 'no' }],
      },
    ])
    expect(inbox.handed).toEqual([{ threadId: 't', through: messages[5]!.at }])
    const told = reviewerInbox([{ ...stopped, reviewerSeenAt: messages[5]!.at }], 'codex')
    expect(told.needsHuman).toEqual([])
    expect(told.counts.human).toBe(1)
  })

  it('says whether the commented code moved, when the anchor can tell', () => {
    const at = (over: Partial<ReviewThread>) =>
      reviewerInbox([thread('t', [codex(), author()], over)], 'codex').threads[0]!.code_changed
    expect(at({})).toBe(false)
    expect(at({ state: 'addressed' })).toBe(true)
    expect(at({ codeChanged: true })).toBe(true)
    expect(at({ anchor: { kind: 'file', path: 'src/a.ts' } })).toBeNull()
    expect(at({ anchor: { kind: 'changeset' } })).toBeNull()
  })

  it('is the inbox of one name: other reviewers and the human have their own threads', () => {
    const threads = [
      thread('mine', [codex(), author()]),
      thread('theirs', [said('reviewer', 'x', 'gemini'), author()]),
      thread('humans', [human(), author()]),
      thread('authors', [author('a guide')], { state: 'open' }),
    ]
    expect(reviewerInbox(threads, 'codex').handed.map((h) => h.threadId)).toEqual(['mine'])
    expect(reviewerInbox(threads, 'codex').opened).toBe(1)
    expect(reviewerInbox(threads, 'nobody').opened).toBe(0)
  })

  it('names the human and the agents, and keeps an artifact out of the payload', () => {
    expect(voiceOf(author())).toBe('author agent')
    expect(voiceOf(human())).toBe('human reviewer')
    expect(voiceOf(codex())).toBe('reviewer agent codex')
    const drawn = author('see\n\n```artifact title="Flow"\n<svg>markup</svg>\n```')
    const [entry] = reviewerInbox([thread('t', [codex(), drawn, human('look')])], 'codex').threads
    expect(entry!.messages.map((m) => m.from)).toEqual(['author agent', 'human reviewer'])
    expect(entry!.messages[0]!.text).not.toContain('markup')
  })
})

describe('ReviewerHub', () => {
  afterEach(() => vi.useRealTimers())

  it('a reviewer agent is here for a while after a command, and listening while it polls', () => {
    vi.useFakeTimers()
    const hub = new ReviewerHub(1000)
    const changes = vi.fn()
    hub.subscribe(changes)
    expect(hub.state('codex')).toBe('away')
    hub.touch('codex', null)
    expect(hub.state('codex')).toBe('active')
    expect(changes).toHaveBeenCalledTimes(1)
    // A second command while here changes nothing worth announcing.
    hub.touch('codex', null)
    expect(changes).toHaveBeenCalledTimes(1)
    const detach = hub.attach('codex', () => {})
    expect(hub.state('codex')).toBe('listening')
    vi.advanceTimersByTime(5000)
    expect(hub.state('codex')).toBe('listening')
    detach()
    expect(hub.state('codex')).toBe('active')
    vi.advanceTimersByTime(1100)
    expect(hub.state('codex')).toBe('away')
    expect(hub.presence(['codex', 'gemini'])).toEqual([
      { name: 'codex', state: 'away' },
      { name: 'gemini', state: 'away' },
    ])
    // The walk to away is announced: nothing else would tell the page.
    expect(changes).toHaveBeenLastCalledWith()
    expect(changes.mock.calls.length).toBeGreaterThanOrEqual(4)
  })

  it('one poll per name: a newer one releases the older, whose detach is then a no-op', () => {
    const hub = new ReviewerHub()
    const released = vi.fn()
    const first = hub.attach('codex', released)
    const second = hub.attach('codex', () => {})
    expect(released).toHaveBeenCalledTimes(1)
    first()
    expect(hub.state('codex')).toBe('listening')
    second()
    expect(hub.state('codex')).toBe('active')
    // Another name is another seat.
    hub.attach('gemini', released)
    expect(released).toHaveBeenCalledTimes(1)
  })

  it('a reviewer asked of the agent is on its way until one joins in that role, or the wait runs out', () => {
    vi.useFakeTimers()
    const hub = new ReviewerHub(1000, () => true, 500)
    const changes = vi.fn()
    hub.subscribe(changes)
    hub.expect('security')
    hub.expect('tests')
    expect(hub.starting()).toEqual(['security', 'tests'])
    // A reviewer in a role nobody was waiting for changes nothing.
    hub.arrived('general')
    expect(changes).toHaveBeenCalledTimes(2)
    hub.arrived('security')
    expect(hub.starting()).toEqual(['tests'])
    vi.advanceTimersByTime(600)
    expect(hub.starting()).toEqual([])
    expect(changes).toHaveBeenCalledTimes(4)
    // Asking again restarts the wait rather than stacking a second one.
    hub.expect('tests')
    vi.advanceTimersByTime(300)
    hub.expect('tests')
    vi.advanceTimersByTime(300)
    expect(hub.starting()).toEqual(['tests'])
  })

  it('a name is held by the live session that last used it', () => {
    const alive = new Set([10, 20])
    const hub = new ReviewerHub(1000, (pid) => alive.has(pid))
    expect(hub.heldBy('codex', 10)).toBeNull()
    hub.touch('codex', 10)
    expect(hub.heldBy('codex', 10)).toBeNull()
    expect(hub.heldBy('codex', 20)).toBe(10)
    // A session Diffo cannot identify is taken at its word.
    expect(hub.heldBy('codex', null)).toBeNull()
    // A dead holder holds nothing.
    alive.delete(10)
    expect(hub.heldBy('codex', 20)).toBeNull()
  })

  it('keeps a log of what each reviewer did, and says when it grows', () => {
    const hub = new ReviewerHub(1000)
    const changes = vi.fn()
    hub.subscribe(changes)
    expect(hub.activity('codex')).toEqual([])
    hub.log('codex', 'joined', 'joined as General reviewer')
    hub.log('codex', 'commented', 'commented on a.ts', 't1')
    expect(hub.activity('codex').map((e) => [e.kind, e.text, e.threadId])).toEqual([
      ['joined', 'joined as General reviewer', undefined],
      ['commented', 'commented on a.ts', 't1'],
    ])
    expect(changes).toHaveBeenCalledTimes(2)
    // The same line again (a poll waking on its heartbeat) is the one there.
    const first = hub.activity('codex').at(-1)!.at
    hub.log('codex', 'commented', 'commented on a.ts', 't1')
    expect(hub.activity('codex')).toHaveLength(2)
    expect(hub.activity('codex').at(-1)!.at).toBe(first)
    expect(changes).toHaveBeenCalledTimes(2)
    // One reviewer's log is not another's.
    expect(hub.activity('security')).toEqual([])
  })

  it('a log keeps only its recent lines', () => {
    const hub = new ReviewerHub(1000)
    for (let n = 0; n < REVIEWER_LOG_MAX + 5; n++) hub.log('codex', 'doing', `step ${n}`)
    const log = hub.activity('codex')
    expect(log).toHaveLength(REVIEWER_LOG_MAX)
    expect(log[0]!.text).toBe('step 5')
  })
})

describe('parseProgress', () => {
  it('is one clipped line, or nothing', () => {
    expect(parseProgress('  reading\n the routes ')).toBe('reading the routes')
    expect(parseProgress('x'.repeat(400))).toHaveLength(REVIEWER_PROGRESS_MAX)
    expect(parseProgress('   ')).toBeNull()
    expect(parseProgress(7)).toBeNull()
  })
})

describe('ReviewerHub — the human’s conversation with a reviewer', () => {
  it('the same words twice are two messages, each heard by the page', () => {
    const hub = new ReviewerHub()
    let heard = 0
    hub.subscribe(() => heard++)
    hub.tell('sec', 'ok')
    hub.tell('sec', 'ok')
    expect(hub.chat('sec').map((m) => m.text)).toEqual(['ok', 'ok'])
    expect(hub.unread('sec')).toHaveLength(2)
    expect(hub.activity('sec').filter((e) => e.kind === 'told')).toHaveLength(2)
    expect(heard).toBe(2)
    hub.say('sec', 'sure')
    hub.say('sec', 'sure')
    expect(
      hub
        .chat('sec')
        .map((m) => [m.from, m.text])
        .slice(-2),
    ).toEqual([
      ['agent', 'sure'],
      ['agent', 'sure'],
    ])
  })
})
