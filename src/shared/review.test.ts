import { describe, expect, it } from 'vitest'
import {
  anchorSpan,
  describeAnchor,
  isHumanMessage,
  liveSuggestion,
  MAX_TITLE_LEN,
  normalizeTitle,
  openedByReviewerAgent,
  PR_COMMENT_MAX,
  parsePrComment,
  parseReviewerChat,
  parseReviewerName,
  REVIEWER_LIMITS,
  type ReviewMessage,
  type ReviewThread,
  roundsOf,
  threadsInChangeset,
  undeliveredThreadIds,
  unpostedReplies,
  untouchedAgentVoice,
  untouchedByHuman,
} from './review.js'
import type { DiffLine, FileChange, Hunk } from './types.js'

const add = (newNo: number): DiffLine => ({ kind: 'add', oldNo: null, newNo, text: 'added' })

const hunk = (id: string, path: string, lines: DiffLine[]): Hunk => ({
  id,
  path,
  oldStart: 1,
  newStart: 1,
  lines,
})

const file = (path: string, hunks: Hunk[]): FileChange => ({
  path,
  oldPath: null,
  status: 'modified',
  kind: 'text',
  staged: false,
  hunks,
})

const thread = (id: string, anchor: ReviewThread['anchor']): ReviewThread => ({
  id,
  anchor,
  state: 'open',
  codeContext: null,
  codeChanged: false,
  messages: [],
  createdAt: '',
  updatedAt: '',
})

describe('threadsInChangeset', () => {
  const files = [file('a.ts', [hunk('h1', 'a.ts', [add(1)])])]

  it('keeps a thread whose hunk is live, or whose file at least still is', () => {
    const { active, past } = threadsInChangeset(files, [
      thread('live', { kind: 'hunk', hunkId: 'h1', path: 'a.ts', side: 'new', line: 1 }),
      thread('edited', { kind: 'hunk', hunkId: 'dead', path: 'a.ts', side: 'new', line: 1 }),
      thread('on-file', { kind: 'file', path: 'a.ts' }),
      thread('note', { kind: 'changeset' }),
    ])
    expect(active.map((t) => t.id)).toEqual(['live', 'edited', 'on-file', 'note'])
    expect(past).toEqual([])
  })

  it('a layer thread lives exactly as long as its layer is in the outline', () => {
    const layers = { items: [{ id: 'L1', title: 'Contract', files: ['a.ts'] }], postedAt: '' }
    const { active, past } = threadsInChangeset(
      files,
      [
        thread('on-layer', { kind: 'layer', layerId: 'L1', title: 'Contract' }),
        thread('on-dropped', { kind: 'layer', layerId: 'L9', title: 'Callers' }),
      ],
      layers,
    )
    expect(active.map((t) => t.id)).toEqual(['on-layer'])
    expect(past.map((t) => t.id)).toEqual(['on-dropped'])
    // No outline at all: every layer thread is a leftover.
    expect(
      threadsInChangeset(files, [thread('x', { kind: 'layer', layerId: 'L1', title: 'Contract' })])
        .past,
    ).toHaveLength(1)
  })

  it('drops threads whose file has left the changeset entirely', () => {
    const { active, past } = threadsInChangeset(files, [
      thread('gone-hunk', { kind: 'hunk', hunkId: 'dead', path: 'z.ts', side: 'new', line: 1 }),
      thread('gone-file', { kind: 'file', path: 'z.ts' }),
    ])
    expect(active).toEqual([])
    expect(past.map((t) => t.id)).toEqual(['gone-hunk', 'gone-file'])
  })

  it('a renamed file keeps the threads opened under its old name', () => {
    const renamed: FileChange = {
      ...file('b.ts', [hunk('h2', 'b.ts', [add(1)])]),
      oldPath: 'a.ts',
      status: 'renamed',
    }
    const { active, past } = threadsInChangeset(
      [renamed],
      [
        thread('old-hunk', { kind: 'hunk', hunkId: 'h1', path: 'a.ts', side: 'new', line: 1 }),
        thread('old-file', { kind: 'file', path: 'a.ts' }),
        thread('new-file', { kind: 'file', path: 'b.ts' }),
      ],
    )
    expect(active.map((t) => t.id)).toEqual(['old-hunk', 'old-file', 'new-file'])
    expect(past).toEqual([])
  })

  it('an empty changeset owns nothing — including its own notes', () => {
    const { active, past } = threadsInChangeset(
      [],
      [
        thread('note', { kind: 'changeset' }),
        thread('h', { kind: 'hunk', hunkId: 'h1', path: 'a.ts', side: 'new', line: 1 }),
      ],
    )
    expect(active).toEqual([])
    expect(past.map((t) => t.id)).toEqual(['note', 'h'])
  })
})

describe('undeliveredThreadIds — what a restart still owes the agent', () => {
  const sent = (id: string, over: Partial<ReviewThread> = {}): ReviewThread => ({
    ...thread(id, { kind: 'changeset' }),
    state: 'sent',
    sentAt: `2026-08-15T00:00:0${id}Z`,
    messages: [{ id: `m-${id}`, author: 'reviewer', text: 'q', at: '2026-08-15T00:00:00Z' }],
    ...over,
  })

  it('re-queues a sent thread the reviewer spoke last on', () => {
    expect(undeliveredThreadIds([sent('1')])).toEqual(['1'])
  })

  it('never re-queues a withheld reply — withholding has to survive a restart', () => {
    expect(undeliveredThreadIds([sent('1', { withheld: true })])).toEqual([])
  })

  it('still re-queues the others alongside it, in send order', () => {
    const ids = undeliveredThreadIds([sent('3'), sent('1', { withheld: true }), sent('2')])
    expect(ids).toEqual(['2', '3'])
  })
})

describe('anchorSpan / describeAnchor — the one label the agent ever sees', () => {
  const single = { kind: 'hunk', hunkId: 'h', path: 'a.ts', side: 'new', line: 12 } as const

  it('a single line stays a bare number; a range reads start-end', () => {
    expect(anchorSpan(single)).toBe('12')
    expect(anchorSpan({ ...single, endLine: 20 })).toBe('12-20')
  })

  it('describeAnchor carries the range through to the prompt', () => {
    expect(describeAnchor(single)).toBe('a.ts:12 (new side)')
    expect(describeAnchor({ ...single, endLine: 20 })).toBe('a.ts:12-20 (new side)')
    expect(describeAnchor({ kind: 'file', path: 'a.ts' })).toBe('a.ts')
    expect(describeAnchor({ kind: 'changeset' })).toBe('the whole changeset')
    expect(describeAnchor({ kind: 'layer', layerId: 'L1', title: 'Contract' })).toBe(
      'layer "Contract"',
    )
  })
})

describe("normalizeTitle — an agent's words, made fit to be a tab name", () => {
  it('collapses to one trimmed line and strips control characters', () => {
    expect(normalizeTitle('tab titles from the agent')).toBe('tab titles from the agent')
    expect(normalizeTitle('  tab titles\n  from the agent\t')).toBe('tab titles from the agent')
    expect(normalizeTitle('tab\u0007titles')).toBe('tab titles')
  })

  it('caps a long one with an ellipsis rather than filling the tab strip', () => {
    const long = normalizeTitle('word '.repeat(50))!
    expect(long).toHaveLength(MAX_TITLE_LEN)
    expect(long.endsWith('…')).toBe(true)
  })

  it('anything that is not a usable title is null — the caller keeps the name it has', () => {
    expect(normalizeTitle('')).toBeNull()
    expect(normalizeTitle('   \n  ')).toBeNull()
    expect(normalizeTitle(undefined)).toBeNull()
    expect(normalizeTitle(7)).toBeNull()
  })
})

describe('liveSuggestion — the one suggested PR comment the reviewer can still act on', () => {
  const at = '2026-10-02T00:00:00Z'
  const agent = (id: string, prComment?: ReviewThread['messages'][number]['prComment']) => ({
    id,
    author: 'agent' as const,
    text: 'answer',
    at,
    ...(prComment ? { prComment } : {}),
  })
  const priv = (messages: ReviewThread['messages'], over: Partial<ReviewThread> = {}) => ({
    ...thread('t', { kind: 'changeset' }),
    messages,
    ...over,
  })

  it('is the latest undecided suggestion, and nothing on a thread without one', () => {
    expect(liveSuggestion(priv([agent('a')]))).toBeNull()
    const one = priv([agent('a', { text: 'Keep the streak?' })])
    expect(liveSuggestion(one)?.id).toBe('a')
  })

  it('a redraft replaces the earlier suggestion; a plain later reply does not', () => {
    const redrafted = priv([agent('a', { text: 'v1' }), agent('b', { text: 'v2' })])
    expect(liveSuggestion(redrafted)?.id).toBe('b')
    const answered = priv([agent('a', { text: 'v1' }), agent('b')])
    expect(liveSuggestion(answered)?.id).toBe('a')
  })

  it('a decided suggestion is history, even when it is the latest', () => {
    const added = priv([
      agent('a', {
        text: 'v1',
        outcome: { kind: 'added', draftThreadId: 'd', edited: false, at },
      }),
    ])
    expect(liveSuggestion(added)).toBeNull()
    const dismissedThenEarlier = priv([
      agent('a', { text: 'v1' }),
      agent('b', { text: 'v2', outcome: { kind: 'dismissed', at } }),
    ])
    expect(liveSuggestion(dismissedThenEarlier)).toBeNull()
  })

  it('never on a public thread or a resolved one', () => {
    const m = [agent('a', { text: 'v1' })]
    expect(liveSuggestion(priv(m, { audience: 'pr' }))).toBeNull()
    expect(liveSuggestion(priv(m, { state: 'resolved' }))).toBeNull()
  })

  it('parsePrComment trims, keeps newlines, caps, and drops junk', () => {
    expect(parsePrComment('  a\n\n```suggestion\nb\n```  ')).toBe('a\n\n```suggestion\nb\n```')
    expect(parsePrComment('   ')).toBeUndefined()
    expect(parsePrComment(42)).toBeUndefined()
    expect(parsePrComment('x'.repeat(PR_COMMENT_MAX + 5))).toHaveLength(PR_COMMENT_MAX)
  })
})

describe('reviewer agents', () => {
  let n = 0
  const said = (author: ReviewMessage['author'], by?: string): ReviewMessage => ({
    id: `m${n++}`,
    author,
    text: 'x',
    at: '2026-11-22T00:00:00Z',
    ...(by ? { by } : {}),
  })
  const human = () => said('reviewer')
  const codex = () => said('reviewer', 'codex')
  const author = () => said('agent')
  const of = (messages: ReviewMessage[], over: Partial<ReviewThread> = {}): ReviewThread => ({
    ...thread('t', { kind: 'changeset' }),
    state: 'sent',
    messages,
    ...over,
  })

  it('a name is short, lowercase, and not a word the review already uses', () => {
    expect(parseReviewerName('codex')).toEqual({ ok: true, name: 'codex' })
    expect(parseReviewerName('  Claude-2 ')).toEqual({ ok: true, name: 'claude-2' })
    expect(parseReviewerName('a'.repeat(24)).ok).toBe(true)
    for (const bad of ['', 'a'.repeat(25), 'two words', 'snake_case', 'é', 42, undefined]) {
      expect(parseReviewerName(bad).ok, String(bad)).toBe(false)
    }
    for (const taken of ['you', 'reviewer', 'agent', 'author', 'github', 'Agent']) {
      expect(parseReviewerName(taken), taken).toMatchObject({ ok: false })
    }
  })

  it('tells the human from a reviewer agent, and who opened a thread', () => {
    expect(isHumanMessage(human())).toBe(true)
    expect(isHumanMessage(codex())).toBe(false)
    expect(isHumanMessage(author())).toBe(false)
    expect(openedByReviewerAgent(of([codex(), author()]))).toBe('codex')
    expect(openedByReviewerAgent(of([human(), author()]))).toBeNull()
    expect(openedByReviewerAgent(of([author(), human()]))).toBeNull()
    expect(openedByReviewerAgent(of([]))).toBeNull()
  })

  it('a round is a reviewer-agent message the author agent answered', () => {
    expect(roundsOf(of([codex()]))).toBe(0)
    expect(roundsOf(of([codex(), author()]))).toBe(1)
    // An interim reply and its follow-up answer one message: one round.
    expect(roundsOf(of([codex(), author(), author()]))).toBe(1)
    expect(roundsOf(of([codex(), author(), codex()]))).toBe(1)
    expect(roundsOf(of([codex(), author(), codex(), author(), codex(), author()]))).toBe(3)
    // The human's word starts the count over, and their own exchange is no round.
    expect(roundsOf(of([codex(), author(), codex(), author(), human()]))).toBe(0)
    expect(roundsOf(of([codex(), author(), human(), author(), codex(), author()]))).toBe(1)
    expect(roundsOf(of([human(), author(), human(), author()]))).toBe(0)
    expect(REVIEWER_LIMITS).toEqual({ rounds: 3 })
  })

  it("a reviewer agent's word goes to the author agent like the human's; a stopped thread to nobody", () => {
    expect(undeliveredThreadIds([of([codex()])])).toEqual(['t'])
    expect(undeliveredThreadIds([of([codex(), author(), codex()])])).toEqual(['t'])
    expect(undeliveredThreadIds([of([codex(), author()])])).toEqual([])
    expect(undeliveredThreadIds([of([codex()], { needsYou: 'rounds' })])).toEqual([])
  })

  it('only the human makes an agent thread theirs, and only the human owes GitHub a reply', () => {
    expect(untouchedAgentVoice(of([author()]))).toBe(true)
    expect(untouchedAgentVoice(of([author(), codex()]))).toBe(true)
    expect(untouchedAgentVoice(of([author(), human()]))).toBe(false)
    // Coverage asks the wider question: has the human written here at all?
    expect(untouchedByHuman(of([codex(), author()]))).toBe(true)
    expect(untouchedByHuman(of([author()]))).toBe(true)
    expect(untouchedByHuman(of([codex(), author(), human()]))).toBe(false)
    expect(untouchedByHuman(of([human(), author()]))).toBe(false)
    const posted = of([human(), codex()], {
      audience: 'pr',
      github: { threadId: 'T', kind: 'inline', resolved: false, outdated: false },
    })
    expect(unpostedReplies(posted)).toHaveLength(1)
  })
})

describe('parseReviewerChat', () => {
  it('reads the two sides, and drops a message from anyone else', () => {
    expect(
      parseReviewerChat([
        { at: 'a', from: 'you', text: 'x' },
        { at: 'b', from: 'agent', text: 'y' },
        { at: 'c', from: 'someone', text: 'dropped' },
      ]),
    ).toEqual([
      { at: 'a', from: 'you', text: 'x' },
      { at: 'b', from: 'agent', text: 'y' },
    ])
  })
})
