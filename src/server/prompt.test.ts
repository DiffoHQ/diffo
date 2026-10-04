import { describe, expect, it } from 'vitest'
import { fixturePr } from '../forge/fixture.js'
import { type Anchor, describeAnchor, type ReviewThread } from '../shared/review.js'
import type { Changeset } from '../shared/types.js'
import { DEV_SKILL_NAME, SKILL_NAME } from '../skill.js'
import {
  ACK_NEXT_STEP,
  buildClearedPrompt,
  buildCoalescedPrompt,
  buildConnectAsk,
  buildFinishPrompt,
  buildLayersRequestPrompt,
  buildSubmittedPrompt,
  buildThreadPrompt,
  CLI,
  CLI_COMMANDS,
  captureAnchor,
  GUIDE,
  GUIDE_CLASSDEFS,
  guideInherit,
  guideNudge,
  LAYERS,
  layersNudge,
  nextStepFor,
  voiceLines,
} from './prompt.js'

const repo = { path: '/tmp/demo', name: 'demo', branch: 'main', worktree: null }
const ctx = { repo }

function changeset(over: Partial<Changeset> = {}): Changeset {
  return {
    version: 1,
    spec: { kind: 'working-tree' },
    repo,
    files: [
      {
        path: 'src/a.ts',
        oldPath: null,
        status: 'modified',
        kind: 'text',
        staged: false,
        hunks: [],
      },
      {
        path: 'src/new.ts',
        oldPath: null,
        status: 'added',
        kind: 'text',
        staged: false,
        hunks: [],
      },
      {
        path: 'src/b.ts',
        oldPath: 'src/old.ts',
        status: 'renamed',
        kind: 'text',
        staged: false,
        hunks: [],
      },
    ],
    stats: { files: 3, additions: 40, deletions: 12 },
    ...over,
  }
}

function thread(over: Partial<ReviewThread> = {}): ReviewThread {
  return {
    id: 't-1',
    anchor: { kind: 'hunk', hunkId: 'h1', path: 'src/a.ts', side: 'new', line: 12 },
    state: 'sent',
    codeContext: '+const x = 1',
    codeChanged: false,
    messages: [
      { id: 'm1', author: 'reviewer', text: 'rename x to count', at: '2026-08-03T00:00:00Z' },
    ],
    createdAt: '2026-08-03T00:00:00Z',
    updatedAt: '2026-08-03T00:00:00Z',
    ...over,
  }
}

describe('buildThreadPrompt', () => {
  it('carries anchor, thread id, code context, messages, and the CLI protocol', () => {
    const prompt = buildThreadPrompt(thread(), { repo })
    expect(prompt).toContain('src/a.ts:12 (new side)')
    expect(prompt).toContain('id: t-1')
    expect(prompt).toContain('+const x = 1')
    expect(prompt).toContain('- reviewer: rename x to count')
    expect(prompt).toContain('npx -y @diffohq/diffo reply <threadId> --message')
    expect(prompt).toContain('npx -y @diffohq/diffo comment [<file>]')
    expect(prompt).toContain('npx -y @diffohq/diffo poll')
    expect(prompt).not.toContain('reply_to_thread')
    expect(prompt).not.toContain('curl')
    expect(prompt).not.toContain('review.json')
  })

  it('omits the diff block when there is no code context', () => {
    const prompt = buildThreadPrompt(
      thread({ anchor: { kind: 'file', path: 'src/a.ts' }, codeContext: null }),
      ctx,
    )
    expect(prompt).not.toContain('```diff')
    expect(prompt).toContain('src/a.ts')
  })
})

describe('prompt context (A1)', () => {
  it('thread prompts carry the one-line spec — not the file list', () => {
    const prompt = buildThreadPrompt(thread(), { repo, changeset: changeset() })
    expect(prompt).toContain(
      'The changeset under review: the working tree against HEAD — 3 files, +40 −12.',
    )
    expect(prompt).not.toContain('- M src/a.ts')
    expect(prompt).not.toContain('- A src/new.ts')
  })

  it('branch specs name the base', () => {
    const prompt = buildThreadPrompt(thread(), {
      repo,
      changeset: changeset({ spec: { kind: 'branch', base: 'main' } }),
    })
    expect(prompt).toContain('against merge-base(`main`, HEAD)')
  })

  it('the finish prompt caps the file list honestly', () => {
    const files = Array.from({ length: 45 }, (_, i) => ({
      path: `src/f${i}.ts`,
      oldPath: null,
      status: 'modified' as const,
      kind: 'text' as const,
      staged: false,
      hunks: [],
    }))
    const prompt = buildFinishPrompt(
      [thread()],
      { repo, changeset: changeset({ files, stats: { files: 45, additions: 1, deletions: 0 } }) },
      { viewedHunks: 1, totalHunks: 1, skippedFiles: [] },
    )
    expect(prompt).toContain('- … and 5 more')
    expect(prompt).not.toContain('src/f44.ts')
  })

  it('sibling threads appear as one-liners, marked context-only', () => {
    const sibling = thread({
      id: 't-2',
      anchor: { kind: 'file', path: 'src/other.ts' },
      messages: [{ id: 'm', author: 'reviewer', text: 'drop this helper\nlong detail', at: '' }],
    })
    const prompt = buildThreadPrompt(thread(), { repo, siblings: [sibling] })
    expect(prompt).toContain('## Other review threads (context only — do not act on them here)')
    expect(prompt).toContain('- src/other.ts — "drop this helper"')
    expect(prompt).not.toContain('long detail')
  })

  it('no siblings → no sibling section', () => {
    expect(buildThreadPrompt(thread(), ctx)).not.toContain('Other review threads')
  })

  it('the coalesced prompt renders siblings too — same section, same exclusions', () => {
    const sibling = thread({
      id: 't-9',
      anchor: { kind: 'file', path: 'src/other.ts' },
      messages: [{ id: 'm', author: 'reviewer', text: 'drop this helper', at: '' }],
    })
    const prompt = buildCoalescedPrompt([thread(), thread({ id: 't-2' })], {
      repo,
      siblings: [sibling],
    })
    expect(prompt).toContain('## Other review threads (context only — do not act on them here)')
    expect(prompt).toContain('- src/other.ts — "drop this helper"')
  })

  it('the closing note leads: quoted verbatim before coverage when no thread carries it', () => {
    // No thread carries the note — a finish recorded before closing notes were
    // threads, or one over a changeset with nothing left to anchor to.
    const prompt = buildFinishPrompt(
      [],
      { repo, changeset: null },
      {
        viewedHunks: 1,
        totalHunks: 1,
        skippedFiles: [],
        note: 'all good\nmerge it please',
      },
    )
    expect(prompt).toContain('> all good')
    expect(prompt).toContain('> merge it please')
    expect(prompt.indexOf('> all good')).toBeLessThan(prompt.indexOf('Coverage:'))
  })

  it('the closing-note thread leads the batch, quoted once, with a reply id', () => {
    const note = thread({
      id: 't-note',
      anchor: { kind: 'changeset' },
      closingNote: true,
      codeContext: null,
      messages: [
        { id: 'm-note', author: 'reviewer', text: 'solid overall', at: '2026-08-03T00:00:00Z' },
      ],
    })
    const prompt = buildFinishPrompt(
      [thread(), note],
      { repo, changeset: null },
      {
        viewedHunks: 1,
        totalHunks: 1,
        skippedFiles: [],
        note: 'solid overall',
      },
    )
    expect(prompt).toContain('Thread 1 [their closing note on the whole review]')
    expect(prompt).toContain('id: t-note')
    // Pointed at from the top rather than quoted twice.
    expect(prompt).toContain('Their closing note is Thread 1 below')
    expect(prompt.match(/solid overall/g)).toHaveLength(1)
    expect(prompt).toContain('The closing note speaks for the whole review')
    expect(prompt.indexOf('id: t-note')).toBeLessThan(prompt.indexOf('id: t-1'))
  })

  it('an empty finish over a fully-read changeset is a green light — and only that one', () => {
    const clean = buildFinishPrompt(
      [],
      { repo, changeset: null },
      { viewedHunks: 2, totalHunks: 2, skippedFiles: [] },
    )
    expect(clean).toContain('green light')

    // Anything unread, outgoing, or said in a note means the silence isn't approval.
    const partial = buildFinishPrompt(
      [],
      { repo, changeset: null },
      { viewedHunks: 1, totalHunks: 2, skippedFiles: ['a.ts'] },
    )
    expect(partial).not.toContain('green light')
    expect(partial).toContain('No open review threads')

    const withThreads = buildFinishPrompt(
      [thread()],
      { repo, changeset: null },
      { viewedHunks: 2, totalHunks: 2, skippedFiles: [] },
    )
    expect(withThreads).not.toContain('green light')

    const noted = buildFinishPrompt(
      [],
      { repo, changeset: null },
      { viewedHunks: 2, totalHunks: 2, skippedFiles: [], note: 'hold on, thinking' },
    )
    expect(noted).not.toContain('green light')
  })

  it('the finish prompt carries the full frame — coverage needs the file list', () => {
    const prompt = buildFinishPrompt(
      [thread()],
      { repo, changeset: changeset() },
      {
        viewedHunks: 1,
        totalHunks: 1,
        skippedFiles: [],
      },
    )
    expect(prompt).toContain('## The changeset under review')
    expect(prompt).toContain('- M src/a.ts')
    expect(prompt).toContain('- R src/old.ts → src/b.ts')
  })
})

describe('reply protocol rules', () => {
  it('every prompt carries scope, staleness, resolution, and reply-shape rules', () => {
    for (const prompt of [
      buildThreadPrompt(thread(), ctx),
      buildCoalescedPrompt([thread(), thread({ id: 't-2' })], ctx),
      buildFinishPrompt([thread()], ctx, { viewedHunks: 1, totalHunks: 1, skippedFiles: [] }),
    ]) {
      expect(prompt).toMatch(/change only what these threads ask about/i)
      expect(prompt).toMatch(/re-read the current file/i)
      expect(prompt).toMatch(/the reviewer's call/i)
      expect(prompt).toMatch(/what changed and where/i)
      expect(prompt).toMatch(/don't paste the\s+diff/i)
      expect(prompt).toMatch(/verify it the cheapest honest way/i)
    }
  })

  it('the undirected v1 instruction stays retired', () => {
    expect(buildThreadPrompt(thread(), ctx)).not.toMatch(/apply the fix, or answer the question/i)
  })

  it('a batch tells the agent to read everything before editing; one thread does not', () => {
    const readFirst = /read every thread before you start editing/i
    expect(buildCoalescedPrompt([thread(), thread({ id: 't-2' })], ctx)).toMatch(readFirst)
    expect(
      buildFinishPrompt([thread(), thread({ id: 't-2' })], ctx, {
        viewedHunks: 1,
        totalHunks: 1,
        skippedFiles: [],
      }),
    ).toMatch(readFirst)
    expect(buildThreadPrompt(thread(), ctx)).not.toMatch(readFirst)
  })

  it('a thread the agent answered last collapses to one line — history and snapshot stay behind', () => {
    const answered = thread({
      id: 't-a',
      messages: [
        { id: 'm1', author: 'reviewer', text: 'why?', at: '' },
        { id: 'm2', author: 'agent', text: 'because.', at: '' },
      ],
    })
    const prompt = buildFinishPrompt([answered, thread({ id: 't-2' })], ctx, {
      viewedHunks: 1,
      totalHunks: 1,
      skippedFiles: [],
    })
    expect(prompt).toContain(
      '1 thread you already answered, with nothing new since — no reply owed, not repeated here:',
    )
    expect(prompt).toContain('- t-a — src/a.ts:12 (new side)')
    // No full block: no id line, no re-shipped history.
    expect(prompt).not.toContain('id: t-a')
    expect(prompt).not.toContain('because.')
    // The fresh thread still travels whole.
    expect(prompt).toContain('id: t-2')
  })

  it('a --more reply does not count as answered — Finish still ships the thread whole', () => {
    const promised = thread({
      id: 't-p',
      awaitingFollowUp: true,
      messages: [
        { id: 'm1', author: 'reviewer', text: 'why?', at: '' },
        { id: 'm2', author: 'agent', text: 'digging in — back soon', at: '' },
      ],
    })
    const prompt = buildFinishPrompt([promised], ctx, {
      viewedHunks: 1,
      totalHunks: 1,
      skippedFiles: [],
    })
    expect(prompt).toContain('id: t-p')
    expect(prompt).not.toContain('you already answered')
  })

  it('a closing note the agent already replied to still leads the batch in full', () => {
    const note = thread({
      id: 't-note',
      anchor: { kind: 'changeset' },
      closingNote: true,
      codeContext: null,
      messages: [
        { id: 'm1', author: 'reviewer', text: 'solid overall', at: '' },
        { id: 'm2', author: 'agent', text: 'thanks — noted.', at: '' },
      ],
    })
    const prompt = buildFinishPrompt([note], ctx, {
      viewedHunks: 1,
      totalHunks: 1,
      skippedFiles: [],
      note: 'solid overall',
    })
    expect(prompt).toContain('id: t-note')
    expect(prompt).not.toContain('you already answered')
  })

  it('skipped files earn the comment-thread nudge; full coverage stays silent', () => {
    const coverage = (skippedFiles: string[]) => ({ viewedHunks: 1, totalHunks: 2, skippedFiles })
    const nudged = buildFinishPrompt([thread()], ctx, coverage(['src/risky.ts']))
    expect(nudged).toContain('Not marked read: src/risky.ts.')
    expect(nudged).toMatch(/say so in a comment thread/i)
    expect(nudged).toMatch(/replies to take it up, or resolves it/i)
    expect(buildFinishPrompt([thread()], ctx, coverage([]))).not.toMatch(/not marked read/i)
  })

  it('the three coverage buckets are named for what they are, never one accusation', () => {
    const prompt = buildFinishPrompt([thread()], ctx, {
      viewedHunks: 2,
      totalHunks: 6,
      viewedFiles: 1,
      totalFiles: 4,
      skippedFiles: ['src/skipped.ts'],
      changedFiles: ['src/moved.ts'],
      commentedUnread: ['src/discussed.ts'],
    })
    expect(prompt).not.toMatch(/never opened/i)
    expect(prompt).toContain(
      'Changed after the reviewer read them (their read marks were revoked): src/moved.ts.',
    )
    expect(prompt).toContain('Commented on but not marked read: src/discussed.ts.')
    expect(prompt).toContain('Not marked read: src/skipped.ts.')
    expect(prompt).toMatch(/left the not-marked-read files unread/i)
  })

  it('a thread the agent went quiet on is named, counted, and put first', () => {
    const prompt = buildFinishPrompt(
      [thread({ id: 't-1', unanswered: true }), thread({ id: 't-2' })],
      ctx,
      { viewedHunks: 1, totalHunks: 1, skippedFiles: [] },
    )
    expect(prompt).toContain('1 of the threads below you were already given once')
    expect(prompt).toContain('YOU NEVER ANSWERED THIS')
    expect(prompt).toMatch(/reason you are not acting/i)
  })

  it('a clean batch carries no accusation', () => {
    const prompt = buildFinishPrompt([thread()], ctx, {
      viewedHunks: 1,
      totalHunks: 1,
      skippedFiles: [],
    })
    expect(prompt).not.toMatch(/already given once/i)
    expect(prompt).not.toMatch(/NEVER ANSWERED/)
  })

  it('the empty finish is not a dead end — a green light, and it says to keep listening', () => {
    const prompt = buildFinishPrompt([thread({ state: 'resolved' })], ctx, {
      viewedHunks: 1,
      totalHunks: 1,
      skippedFiles: [],
    })
    expect(prompt).toContain('green light')
    expect(prompt).toMatch(/keep listening/i)
    expect(prompt).toContain('poll')
  })

  it('caps the frozen snapshot honestly, naming the file to read instead', () => {
    const long = Array.from({ length: 40 }, (_, i) => `+line ${i}`).join('\n')
    const prompt = buildThreadPrompt(thread({ codeContext: long }), ctx)
    expect(prompt).toContain('+line 24')
    expect(prompt).not.toContain('+line 25')
    expect(prompt).toContain('(… and 15 more snapshot lines — read the current `src/a.ts` instead)')
  })

  it('a short snapshot travels whole — no cap note', () => {
    const prompt = buildThreadPrompt(thread(), ctx)
    expect(prompt).toContain('+const x = 1')
    expect(prompt).not.toContain('more snapshot lines')
  })

  it('a previously delivered thread does not re-ship its snapshot', () => {
    const prompt = buildThreadPrompt(thread({ deliveredThrough: '2026-08-03T01:00:00Z' }), ctx)
    expect(prompt).not.toContain('+const x = 1')
    expect(prompt).toContain(
      '(diff snapshot delivered to you earlier — read the current `src/a.ts` instead)',
    )
  })
})

describe('the compact protocol (repeat deliveries to the same session)', () => {
  it('keeps the contract essentials plus the pointer that reprints the rest', () => {
    const prompt = buildThreadPrompt(thread({ intent: 'fix' }), { repo, protocol: 'compact' })
    expect(prompt).toContain('help agent')
    expect(prompt).toContain(CLI_COMMANDS.reply)
    expect(prompt).toContain(CLI_COMMANDS.poll)
    expect(prompt).toMatch(/change only what these threads ask about/i)
    expect(prompt).toMatch(/`issue` threads want a code change/)
    expect(prompt).toMatch(/the reviewer's call/i)
  })

  it('is a fraction of the full protocol, and drops the full-only teaching', () => {
    const full = buildThreadPrompt(thread(), { repo })
    const compact = buildThreadPrompt(thread(), { repo, protocol: 'compact' })
    expect(compact.length).toBeLessThan(full.length / 2)
    // Comment-thread teaching and the mermaid guidance live in the full form only.
    expect(compact).not.toContain(CLI_COMMANDS.comment)
    expect(compact).not.toContain('mermaid')
  })

  it('the coalesced and finish prompts honor it too', () => {
    const coalesced = buildCoalescedPrompt([thread(), thread({ id: 't-2' })], {
      repo,
      protocol: 'compact',
    })
    expect(coalesced).toContain('Same protocol as your earlier deliveries')
    const finish = buildFinishPrompt(
      [thread()],
      { repo, protocol: 'compact' },
      {
        viewedHunks: 1,
        totalHunks: 1,
        skippedFiles: [],
      },
    )
    expect(finish).toContain('Same protocol as your earlier deliveries')
  })
})

describe('reviewer intent', () => {
  it('labels ride in the thread heading, Conventional Comments vocabulary', () => {
    const prompt = buildCoalescedPrompt(
      [thread({ id: 'q1', intent: 'question' }), thread({ id: 'f1', intent: 'fix' })],
      ctx,
    )
    expect(prompt).toContain('### Thread 1 [question]')
    expect(prompt).toContain('### Thread 2 [issue]')
    expect(prompt).not.toContain('nitpick')
  })

  it('contract lines appear once per prompt, only for the labels present', () => {
    const prompt = buildCoalescedPrompt(
      [thread({ id: 'q1', intent: 'question' }), thread({ id: 'q2', intent: 'question' })],
      ctx,
    )
    expect(prompt).toMatch(/`question` threads want an answer, not an edit/)
    expect(prompt.match(/want an answer, not an edit/g)).toHaveLength(1)
    expect(prompt).not.toContain('`issue` threads')
    expect(prompt).not.toContain('Unlabeled threads')
  })

  it('legacy threads without intent get the judgment fallback, no label', () => {
    const prompt = buildThreadPrompt(thread(), ctx)
    expect(prompt).toContain('### Thread 1 — src/a.ts:12 (new side)')
    expect(prompt).toContain('Unlabeled threads: judge from the text')
  })
})

describe('a thread on a layer', () => {
  const onLayer = thread({
    anchor: { kind: 'layer', layerId: 'L1', title: 'Contract' },
    codeContext: null,
    anchoredLayer: {
      title: 'Contract',
      summary: 'The parser returns null.\nCallers follow.',
      files: ['src/a.ts', 'src/b.ts'],
    },
    messages: [
      {
        id: 'm1',
        author: 'reviewer',
        text: 'why is b.ts in this step?',
        at: '2026-08-03T00:00:00Z',
      },
    ],
  })

  it('heads with the layer and quotes the step instead of a diff', () => {
    const prompt = buildThreadPrompt(onLayer, ctx)
    expect(prompt).toContain('### Thread 1 — layer "Contract"')
    expect(prompt).toContain('as it was outlined when the comment was written')
    expect(prompt).toContain('- title: Contract')
    expect(prompt).toContain('- summary:\n  The parser returns null.\n  Callers follow.')
    expect(prompt).toContain('- files: `src/a.ts`, `src/b.ts`')
    expect(prompt).not.toContain('```diff')
    expect(prompt).not.toContain('line numbers are stale')
  })
})

describe('captureAnchor (what a new thread freezes)', () => {
  const hunk = {
    id: 'h1',
    path: 'src/a.ts',
    oldStart: 10,
    newStart: 10,
    lines: [
      { kind: 'context' as const, oldNo: 10, newNo: 10, text: 'function total() {' },
      { kind: 'del' as const, oldNo: 11, newNo: null, text: '  return sum' },
      { kind: 'add' as const, oldNo: null, newNo: 11, text: '  const t = round(sum)' },
      { kind: 'add' as const, oldNo: null, newNo: 12, text: '  return t' },
      { kind: 'context' as const, oldNo: 12, newNo: 13, text: '}' },
    ],
  }
  const withHunk = changeset({
    files: [
      {
        path: 'src/a.ts',
        oldPath: null,
        status: 'modified',
        kind: 'text',
        staged: false,
        hunks: [hunk],
      },
    ],
  })
  const anchor = (over: Partial<Extract<Anchor, { kind: 'hunk' }>> = {}): Anchor => ({
    kind: 'hunk',
    hunkId: 'h1',
    path: 'src/a.ts',
    side: 'new',
    line: 11,
    ...over,
  })

  it('freezes the whole hunk plus where the anchored line sits in it', () => {
    const capture = captureAnchor(withHunk, anchor())
    expect(capture?.codeContext).toBe(
      ' function total() {\n-  return sum\n+  const t = round(sum)\n+  return t\n }',
    )
    expect(capture?.anchored).toEqual({ start: 2, end: 2, text: '+  const t = round(sum)' })
  })

  it('a range covers every row between its lines', () => {
    const capture = captureAnchor(withHunk, anchor({ endLine: 12 }))
    expect(capture?.anchored).toEqual({
      start: 2,
      end: 3,
      text: '+  const t = round(sum)\n+  return t',
    })
  })

  it('old-side anchors resolve against the old numbering — deleted lines included', () => {
    const capture = captureAnchor(withHunk, anchor({ side: 'old' }))
    expect(capture?.anchored).toEqual({ start: 1, end: 1, text: '-  return sum' })
  })

  it('a line the hunk does not carry still freezes the snapshot, just unmarked', () => {
    const capture = captureAnchor(withHunk, anchor({ line: 99 }))
    expect(capture?.codeContext).toContain('round(sum)')
    expect(capture?.anchored).toBeUndefined()
  })

  it('non-hunk anchors and vanished hunks capture nothing', () => {
    expect(captureAnchor(withHunk, { kind: 'file', path: 'src/a.ts' })).toBeNull()
    expect(captureAnchor(withHunk, anchor({ hunkId: 'gone' }))).toBeNull()
  })

  it('a layer anchor freezes the step as outlined — no diff snapshot', () => {
    const layers = {
      items: [
        {
          id: 'L1',
          title: 'Contract',
          summary: 'The parser returns null.',
          files: ['src/a.ts:1-9', { path: 'src/b.ts', note: 'callers' }],
        },
      ],
      postedAt: '',
    }
    expect(
      captureAnchor(withHunk, { kind: 'layer', layerId: 'L1', title: 'Contract' }, layers),
    ).toEqual({
      codeContext: null,
      anchoredLayer: {
        title: 'Contract',
        summary: 'The parser returns null.',
        files: ['src/a.ts', 'src/b.ts'],
      },
    })
    expect(
      captureAnchor(withHunk, { kind: 'layer', layerId: 'L9', title: 'Gone' }, layers),
    ).toBeNull()
  })

  it('caps the frozen text of a huge range, keeping its head', () => {
    const lines = Array.from({ length: 30 }, (_, i) => ({
      kind: 'add' as const,
      oldNo: null,
      newNo: i + 1,
      text: `line ${i + 1}`,
    }))
    const big = changeset({
      files: [
        {
          path: 'src/a.ts',
          oldPath: null,
          status: 'modified',
          kind: 'text',
          staged: false,
          hunks: [{ id: 'h1', path: 'src/a.ts', oldStart: 1, newStart: 1, lines }],
        },
      ],
    })
    const capture = captureAnchor(big, anchor({ line: 1, endLine: 30 }))
    expect(capture?.anchored?.start).toBe(0)
    expect(capture?.anchored?.end).toBe(29)
    expect(capture?.anchored?.text.split('\n')).toHaveLength(10)
  })
})

describe('anchored threads in the prompt (the agent must find the commented code)', () => {
  const anchored = { start: 0, end: 0, text: '+const x = 1' }

  it('quotes the anchored line in the heading — the identifier that survives code movement', () => {
    const prompt = buildThreadPrompt(thread({ anchored }), ctx)
    expect(prompt).toContain('### Thread 1 — src/a.ts:12 (new side) — "const x = 1"')
  })

  it('a range heading quotes its first line as a start marker', () => {
    const prompt = buildThreadPrompt(
      thread({
        anchor: {
          kind: 'hunk',
          hunkId: 'h1',
          path: 'src/a.ts',
          side: 'new',
          line: 12,
          endLine: 14,
        },
        anchored,
      }),
      ctx,
    )
    expect(prompt).toContain('src/a.ts:12-14 (new side) — starts at: "const x = 1"')
  })

  it('a range opening on a blank line quotes its first line with content', () => {
    const prompt = buildThreadPrompt(
      thread({
        anchor: {
          kind: 'hunk',
          hunkId: 'h1',
          path: 'src/a.ts',
          side: 'new',
          line: 12,
          endLine: 14,
        },
        anchored: { start: 0, end: 2, text: '+\n+  \n+const y = 2' },
      }),
      ctx,
    )
    expect(prompt).toContain('src/a.ts:12-14 (new side) — starts at: "const y = 2"')
  })

  it('an all-blank anchored range keeps the plain heading', () => {
    const prompt = buildThreadPrompt(thread({ anchored: { start: 0, end: 0, text: '+  ' } }), ctx)
    expect(prompt).toContain('### Thread 1 — src/a.ts:12 (new side)\n')
  })

  it('marks the commented lines inside the snapshot', () => {
    const prompt = buildThreadPrompt(
      thread({
        codeContext: ' before\n+const x = 1\n after',
        anchored: { start: 1, end: 1, text: '+const x = 1' },
      }),
      ctx,
    )
    expect(prompt).toContain('The commented change (`>` marks the commented lines):')
    expect(prompt).toContain('\n>+const x = 1\n')
    expect(prompt).toContain('\n before\n')
  })

  it('windows a long snapshot around the commented line, not the hunk head', () => {
    const long = Array.from({ length: 40 }, (_, i) => `+line ${i}`).join('\n')
    const prompt = buildThreadPrompt(
      thread({ codeContext: long, anchored: { start: 30, end: 30, text: '+line 30' } }),
      ctx,
    )
    expect(prompt).toContain('>+line 30')
    expect(prompt).not.toContain('+line 10\n')
    expect(prompt).toContain(
      '(windowed to the commented lines — 15 more snapshot lines around them; read the current `src/a.ts` for the full change)',
    )
  })

  it('warns when the code moved under the comment', () => {
    const prompt = buildThreadPrompt(thread({ anchored, codeChanged: true }), ctx)
    expect(prompt).toContain('its line numbers are stale')
  })

  it('a fresh new-side thread carries no warning', () => {
    const prompt = buildThreadPrompt(thread({ anchored }), ctx)
    expect(prompt).not.toContain('line numbers are stale')
    expect(prompt).not.toContain('removed code')
  })

  it('old-side anchors say the code is the old version, not the current file', () => {
    const prompt = buildThreadPrompt(
      thread({
        anchor: { kind: 'hunk', hunkId: 'h1', path: 'src/a.ts', side: 'old', line: 12 },
        codeContext: '-const x = 1',
        anchored: { start: 0, end: 0, text: '-const x = 1' },
      }),
      ctx,
    )
    expect(prompt).toContain('This comments on removed code')
  })

  it('a follow-up after resolve still shows the commented lines — the snapshot is gone', () => {
    const prompt = buildThreadPrompt(thread({ codeContext: null, anchored }), ctx)
    expect(prompt).toContain('The commented lines, as they were when the comment was written:')
    expect(prompt).toContain('+const x = 1')
  })

  it('threads from before anchoring existed render exactly as they used to', () => {
    const prompt = buildThreadPrompt(thread(), ctx)
    expect(prompt).toContain('The commented change:')
    expect(prompt).not.toContain('marks the commented lines')
    expect(prompt).not.toContain(' — "')
  })
})

describe('the poll envelope (next_step per payload kind)', () => {
  it('branches by kind — the empty finish is never told to act on threads', () => {
    expect(nextStepFor('threads', 2)).toMatch(/act on each thread/i)
    expect(nextStepFor('finish', 3)).toMatch(/work the whole batch/i)
    const empty = nextStepFor('finish', 0)
    expect(empty).toMatch(/nothing to act on/i)
    expect(empty).toMatch(/keep listening/i)
    expect(empty).not.toMatch(/act on each thread/i)
  })

  it('a layers payload points at the post, then back to the poll', () => {
    const step = nextStepFor('layers', 0)
    expect(step).toContain(CLI_COMMANDS.layers)
    expect(step).toContain(CLI_COMMANDS.layersStdin)
    expect(step).toMatch(/keep listening/i)
    expect(step).not.toMatch(/act on each thread/i)
  })

  it('a cleared payload points at the guide, then back to the poll', () => {
    const step = nextStepFor('cleared', 0)
    expect(step).toMatch(/guide/i)
    expect(step).toMatch(/keep listening/i)
    expect(step).not.toMatch(/act on each thread/i)
  })

  it('every ack teaches the next step; end pairs the prohibition with its alternative', () => {
    expect(ACK_NEXT_STEP.reply).toContain('poll')
    expect(ACK_NEXT_STEP.comment).toMatch(/replies to take it up, or resolves it/i)
    expect(ACK_NEXT_STEP.end).toMatch(/do not reopen or re-poll/i)
    expect(ACK_NEXT_STEP.end).toMatch(/directly in the conversation/i)
  })
})

describe('buildConnectAsk (what the reviewer pastes to bring an agent in)', () => {
  it('names this review by its repo, so any session lands on it', () => {
    expect(buildConnectAsk(false, '/Users/me/code/app', '/Users/me')).toBe(
      'connect to the diffo review in ~/code/app',
    )
    expect(buildConnectAsk(false, '/srv/app', '/Users/me')).toBe(
      'connect to the diffo review in /srv/app',
    )
  })

  it('only folds a real home prefix into ~', () => {
    expect(buildConnectAsk(false, '/Users/me', '/Users/me')).toBe(
      'connect to the diffo review in ~',
    )
    expect(buildConnectAsk(false, '/Users/meg/app', '/Users/me')).toContain('/Users/meg/app')
  })

  it('wakes the skill by name — the dev one only answers its slash command', () => {
    expect(buildConnectAsk(false, '/r', '/h')).toContain(SKILL_NAME)
    expect(buildConnectAsk(true, '/r', '/h')).toBe(`/${DEV_SKILL_NAME} connect to the review in /r`)
  })

  it('teaches no loop — that is what the skill is for', () => {
    expect(buildConnectAsk(false, '/r', '/h')).not.toContain('poll')
  })
})

describe('the open-time guide nudge', () => {
  it('asks for a guide when the review has none', () => {
    const nudge = guideNudge(false)!
    expect(nudge).toContain('guide')
    expect(nudge).toContain('```mermaid')
    // The URL goes out first; the guide is written while the reviewer opens
    // the page — never the other way round, which is what made opens slow.
    expect(nudge.indexOf('share the URL')).toBeLessThan(nudge.indexOf('post a guide'))
    expect(nudge).toMatch(/right now/)
    expect(nudge).not.toMatch(/before sharing the URL/i)
    // The judgment stays the agent's, and pre-reviewing stays banned.
    expect(nudge).toContain('skip when the diff explains itself')
    expect(nudge).toContain('never pre-review')
    // A map, not a tour: layers own the order, and the guide fits one screen.
    expect(nudge).toContain(GUIDE.order)
    expect(nudge).toContain(GUIDE.budget)
    expect(nudge).toContain('no reading order')
    expect(nudge).toContain('help guide')
  })

  it('the doctrine names what only the author knows, and never a section list', () => {
    expect(GUIDE.what).toMatch(/invariant/)
    expect(GUIDE.what).toMatch(/judgment call/)
    expect(GUIDE.what).toMatch(/skip/)
    // Problem first, for a reader outside the session; the diagram draws what
    // happens, never a reference graph of code names.
    expect(GUIDE.what).toMatch(/the problem it solves/)
    expect(GUIDE.what).toMatch(/never saw your session/)
    expect(GUIDE.what).toMatch(/which code references which/)
    // Ingredients, not a form: nothing in it is a heading to fill.
    expect(GUIDE.budget).toMatch(/only the parts this change needs/)
    // The legend is two tags and two classDef lines, strokes only — the fill
    // stays the renderer's so the diagram keeps following the theme.
    expect(GUIDE_CLASSDEFS).toHaveLength(2)
    for (const line of GUIDE_CLASSDEFS) {
      expect(line).toMatch(/^classDef (new|changed) stroke:#[0-9a-f]{6},stroke-width:2px$/)
      expect(line).not.toContain('fill')
    }
  })

  it('goes quiet once the review carries one', () => {
    expect(guideNudge(true)).toBeNull()
  })

  it('names the real command, so an agent without the skill can follow it', () => {
    expect(guideNudge(false)).toContain(CLI_COMMANDS.guide)
    // The guide anchors to the changeset, so the command must not offer a file.
    expect(guideNudge(false)).not.toContain('[<file>]')
  })
})

describe('the layers payload (reviewer pressed Outline)', () => {
  it('asks for the outline, carries the whole doctrine, and owes nothing else', () => {
    const prompt = buildLayersRequestPrompt({ repo, changeset: changeset() }, null)
    expect(prompt).toContain('asked for layers')
    expect(prompt).toContain('reads "Outlining…"')
    expect(prompt).not.toContain('refresh')
    // An agent with no skill still gets every rule the CLI help carries.
    expect(prompt).toContain(LAYERS.summary)
    expect(prompt).toContain(LAYERS.diagram)
    for (const line of GUIDE_CLASSDEFS) expect(prompt).toContain(line)
    expect(prompt).toContain(LAYERS.order)
    expect(prompt).toContain(LAYERS.mechanical)
    expect(prompt).toContain(LAYERS.stance)
    expect(prompt).toContain(LAYERS.decisions)
    expect(prompt).toContain(LAYERS.shape)
    expect(prompt).toContain(CLI_COMMANDS.layers)
    expect(prompt).toContain(CLI_COMMANDS.layersStdin)
    expect(prompt).toContain('no reply, no comment')
    expect(prompt).toContain('The changeset under review')
    expect(prompt).toContain(CLI_COMMANDS.poll)
  })

  it('a refresh names the outline they have and asks for the whole list again', () => {
    const prompt = buildLayersRequestPrompt({ repo, changeset: null }, [
      { title: 'Contract' },
      { title: 'Callers' },
    ])
    expect(prompt).toContain('refresh the layers')
    expect(prompt).toContain('"Contract", "Callers"')
    expect(prompt).toContain('Since your review')
    expect(prompt).toContain(LAYERS.replace)
    expect(prompt).not.toContain('The changeset under review')
    // An empty outline is not a refresh.
    expect(buildLayersRequestPrompt({ repo, changeset: null }, [])).toContain('asked for layers')
  })
})

describe('the cleared payload (reviewer started the review over)', () => {
  it('says what happened, owes nothing, and restates the guide doctrine', () => {
    const prompt = buildClearedPrompt({ repo, changeset: changeset() })
    expect(prompt).toContain('cleared the review')
    expect(prompt).toContain('no feedback to act on')
    // The same doctrine as the open-time nudge: agent judgment, no pre-review.
    expect(prompt).toContain('skip when the diff explains itself')
    expect(prompt).toContain('never pre-review')
    expect(prompt).toContain(GUIDE.order)
    expect(prompt).toContain(CLI_COMMANDS.guide)
    expect(prompt).not.toContain('[<file>]')
    // It frames the fresh round the reviewer is now looking at.
    expect(prompt).toContain('The changeset under review')
  })

  it('stands alone without a changeset, and always routes back to the poll', () => {
    const prompt = buildClearedPrompt({ repo, changeset: null })
    expect(prompt).toContain('cleared the review')
    expect(prompt).toContain(CLI_COMMANDS.poll)
    expect(prompt).not.toContain('The changeset under review')
  })
})

describe('the takeover guide-inherit notice', () => {
  it('points the new agent at the existing guide with a runnable reply command', () => {
    const notice = guideInherit('t-guide')
    expect(notice).toContain('t-guide')
    // Update in place, never a second guide — and the command is the real CLI,
    // so an agent without the skill can follow it verbatim.
    expect(notice).toContain(`${CLI} reply t-guide`)
    expect(notice).toMatch(/rather than posting a second guide/)
  })
})

describe('layers doctrine', () => {
  it('the nudge appears only while the review has neither layers nor a suggestion', () => {
    const nudge = layersNudge({})!
    expect(nudge).toContain(CLI_COMMANDS.layersSuggest)
    expect(nudge).toContain(CLI_COMMANDS.layers)
    expect(nudge).toContain(LAYERS.suggest)
    // Asked for layers in chat, the agent has only this line: it carries the
    // summary and diagram rules the Outline request does.
    expect(nudge).toContain(LAYERS.summary)
    expect(nudge).toContain(LAYERS.diagram)
    expect(nudge).toContain(LAYERS.order)
    expect(nudge).toContain(LAYERS.stance)
    expect(layersNudge({ layers: { items: [], postedAt: '' } })).toBeNull()
    expect(layersNudge({ layersSuggested: {} })).toBeNull()
  })

  it('summaries inherit the guide’s stance verbatim', () => {
    expect(LAYERS.stance).toBe(GUIDE.stance)
  })

  it('the mechanical rule names the bar and the default when unsure', () => {
    expect(LAYERS.mechanical).toMatch(/no behaviour/)
    expect(LAYERS.mechanical).toMatch(/if unsure, don't tag/)
  })

  it('every layers ack names the next poll', () => {
    for (const key of ['layers', 'layersSuggested', 'layersAlready'] as const) {
      expect(ACK_NEXT_STEP[key]).toContain(CLI_COMMANDS.poll)
    }
    expect(ACK_NEXT_STEP.layersSuggested).toContain(CLI_COMMANDS.layers)
  })
})

describe('suggested PR comments — the doctrine, the voice, the notice', () => {
  const onPr = (over: Partial<Changeset> = {}) => changeset({ pr: fixturePr(), ...over })
  const at = '2026-10-02T00:00:00Z'

  it('a pull request teaches the agent to read a finding as a comment in the making; a local review never does', () => {
    const prPrompt = buildThreadPrompt(thread(), { repo, changeset: onPr() })
    expect(prPrompt).toContain('## Drafting a review comment for the author')
    expect(prPrompt).toContain('--pr-comment')
    expect(prPrompt).toMatch(/lean toward attaching/)
    expect(prPrompt).toMatch(/one or two\nshort sentences, the point first/)
    expect(prPrompt).toMatch(/Nothing you attach reaches GitHub/)
    const local = buildThreadPrompt(thread(), { repo, changeset: changeset() })
    expect(local).not.toContain('--pr-comment')
    expect(local).not.toContain('Drafting a review comment')
  })

  it('the compact protocol keeps the rule in one paragraph, PR only', () => {
    const compact = buildThreadPrompt(thread(), { repo, changeset: onPr(), protocol: 'compact' })
    expect(compact).toContain('--pr-comment')
    expect(compact).not.toContain('## Drafting a review comment')
    const local = buildThreadPrompt(thread(), { repo, changeset: changeset(), protocol: 'compact' })
    expect(local).not.toContain('--pr-comment')
  })

  it("the reviewer's voice: their public comments, newest first, and the suggestions they edited", () => {
    const draft = thread({
      id: 'draft',
      audience: 'pr',
      state: 'open',
      origin: { threadId: 'ask', messageId: 'a', edited: true },
      createdAt: '2026-10-02T00:02:00Z',
      messages: [{ id: 'd', author: 'reviewer', text: 'Late ones reset the streak. Keep it?', at }],
    })
    const older = thread({
      id: 'older',
      audience: 'pr',
      createdAt: '2026-10-02T00:01:00Z',
      messages: [
        { id: 'o', author: 'reviewer', text: 'nit: `--repeating` reads as a boolean', at },
      ],
    })
    const theirs = thread({
      id: 'gh',
      audience: 'pr',
      github: { threadId: 'gh', kind: 'inline', resolved: false, outdated: false },
      messages: [
        {
          id: 'g',
          author: 'github',
          text: 'LGTM',
          at,
          github: { id: 'g', user: { login: 'mayab', avatarUrl: '' } },
        },
      ],
    })
    const ask = thread({
      id: 'ask',
      messages: [
        { id: 'q', author: 'reviewer', text: 'resets the streak?', at },
        {
          id: 'a',
          author: 'agent',
          text: 'yes',
          at,
          prComment: {
            text: 'Finishing a day late resets the streak to 0 here. Keep `todo.streak`?',
            outcome: { kind: 'added', draftThreadId: 'draft', edited: true, at },
          },
        },
      ],
    })
    const asIs = thread({
      id: 'asis',
      messages: [
        {
          id: 'b',
          author: 'agent',
          text: 'bug',
          at,
          prComment: {
            text: 'Loops forever on 0.',
            outcome: { kind: 'added', draftThreadId: 'nope', edited: false, at },
          },
        },
      ],
    })
    const block = voiceLines([ask, theirs, older, draft, asIs])!
    const lines = block.split('\n')
    expect(lines[0]).toBe("## The reviewer's voice")
    // Newest of theirs first; GitHub's own words are not the reviewer's voice.
    expect(
      lines.indexOf(`- ${describeLine(draft)} — "Late ones reset the streak. Keep it?"`),
    ).toBeLessThan(
      lines.indexOf(`- ${describeLine(older)} — "nit: \`--repeating\` reads as a boolean"`),
    )
    expect(block).not.toContain('LGTM')
    // Only an edited, added suggestion makes a pair; one taken as-is teaches nothing.
    expect(block).toContain(
      'yours: "Finishing a day late resets the streak to 0 here. Keep `todo.streak`?"',
    )
    expect(block).toContain('theirs: "Late ones reset the streak. Keep it?"')
    expect(block).not.toContain('Loops forever')

    expect(voiceLines([ask])).toBeNull()
    // It rides PR prompts only, and only when passed.
    expect(buildThreadPrompt(thread(), { repo, changeset: onPr(), voice: [ask, draft] })).toContain(
      "## The reviewer's voice",
    )
    expect(
      buildThreadPrompt(thread(), { repo, changeset: changeset(), voice: [ask, draft] }),
    ).not.toContain("## The reviewer's voice")
  })

  it('the submit notice says what became of the suggestions, in one aggregate line', () => {
    const base = { event: 'COMMENT', comments: 2, body: '' }
    expect(buildSubmittedPrompt({ repo, changeset: onPr() }, base)).not.toMatch(/you suggested/)
    const withSome = buildSubmittedPrompt(
      { repo, changeset: onPr() },
      { ...base, suggestions: { total: 4, posted: 2, edited: 1, dismissed: 1, undecided: 1 } },
    )
    expect(withSome).toContain(
      'Of the 4 review comments you suggested: 2 posted (1 edited first), 1 dismissed, 1 left undecided (they stay private and never post).',
    )
  })
})

function describeLine(t: ReviewThread): string {
  return describeAnchor(t.anchor)
}
