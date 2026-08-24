import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { ReviewThread } from '../shared/review.js'
import type { Changeset } from '../shared/types.js'
import {
  ACK_NEXT_STEP,
  buildCoalescedPrompt,
  buildFinishPrompt,
  buildInstallSkill,
  buildThreadPrompt,
  CLI,
  CLI_COMMANDS,
  guideInherit,
  guideNudge,
  INSTALL_SKILL,
  NPX,
  nextStepFor,
  SKILL_REPO,
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

  it('the finish verdict leads: approve is stated before coverage, note quoted verbatim', () => {
    const prompt = buildFinishPrompt(
      [],
      { repo, changeset: null },
      {
        viewedHunks: 1,
        totalHunks: 1,
        skippedFiles: [],
        verdict: 'approve',
        note: 'all good\nmerge it please',
      },
    )
    expect(prompt).toContain('**approved**')
    expect(prompt).toContain('> all good')
    expect(prompt).toContain('> merge it please')
    expect(prompt.indexOf('**approved**')).toBeLessThan(prompt.indexOf('Coverage:'))
  })

  it('request-changes says the review is not done; a plain comment adds no verdict line', () => {
    const changesRequested = buildFinishPrompt(
      [thread()],
      { repo, changeset: null },
      { viewedHunks: 1, totalHunks: 1, skippedFiles: [], verdict: 'request-changes' },
    )
    expect(changesRequested).toContain('**changes requested**')

    const plain = buildFinishPrompt(
      [thread()],
      { repo, changeset: null },
      { viewedHunks: 1, totalHunks: 1, skippedFiles: [], verdict: 'comment' },
    )
    expect(plain).not.toContain('Verdict:')
    const none = buildFinishPrompt(
      [thread()],
      { repo, changeset: null },
      { viewedHunks: 1, totalHunks: 1, skippedFiles: [] },
    )
    expect(none).not.toContain('Verdict:')
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

  it('a thread the agent answered last earns the no-re-reply note; fresh ones do not', () => {
    const noReReply = /if nothing new was asked since, don't reply to them again/i
    const answered = thread({
      id: 't-a',
      messages: [
        { id: 'm1', author: 'reviewer', text: 'why?', at: '' },
        { id: 'm2', author: 'agent', text: 'because.', at: '' },
      ],
    })
    expect(
      buildFinishPrompt([answered, thread({ id: 't-2' })], ctx, {
        viewedHunks: 1,
        totalHunks: 1,
        skippedFiles: [],
      }),
    ).toMatch(noReReply)
    expect(buildThreadPrompt(thread(), ctx)).not.toMatch(noReReply)
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

  it('the empty finish is not a dead end — it says to keep listening', () => {
    const prompt = buildFinishPrompt([thread({ state: 'resolved' })], ctx, {
      viewedHunks: 1,
      totalHunks: 1,
      skippedFiles: [],
    })
    expect(prompt).toContain('nothing to act on')
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

describe('the poll envelope (next_step per payload kind)', () => {
  it('branches by kind — the empty finish is never told to act on threads', () => {
    expect(nextStepFor('threads', 2)).toMatch(/act on each thread/i)
    expect(nextStepFor('finish', 3)).toMatch(/work the whole batch/i)
    const empty = nextStepFor('finish', 0)
    expect(empty).toMatch(/nothing to act on/i)
    expect(empty).toMatch(/keep listening/i)
    expect(empty).not.toMatch(/act on each thread/i)
  })

  it('every ack teaches the next step; end pairs the prohibition with its alternative', () => {
    expect(ACK_NEXT_STEP.reply).toContain('poll')
    expect(ACK_NEXT_STEP.comment).toMatch(/replies to take it up, or resolves it/i)
    expect(ACK_NEXT_STEP.end).toMatch(/do not reopen or re-poll/i)
    expect(ACK_NEXT_STEP.end).toMatch(/directly in the conversation/i)
  })
})

describe('INSTALL_SKILL (how a human installs Diffo)', () => {
  it('installs from the repo this package actually publishes from', () => {
    const pkg = JSON.parse(
      readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../../package.json'), 'utf-8'),
    ) as { repository: { url: string } }
    expect(pkg.repository.url).toContain(SKILL_REPO)
    expect(INSTALL_SKILL.global).toBe(`npx skills add ${SKILL_REPO} --skill diffo -g`)
  })

  it('names a skill that is actually shipped under skills/', () => {
    const skill = resolve(dirname(fileURLToPath(import.meta.url)), '../../skills/diffo/SKILL.md')
    expect(readFileSync(skill, 'utf-8')).toContain('name: diffo')
  })

  it('needs no npm publish — that is the point of this route', () => {
    expect(INSTALL_SKILL.global).not.toContain(NPX)
  })

  it('offers both scopes, in both modes — the reviewer picks', () => {
    expect(INSTALL_SKILL.global).toContain(' -g')
    expect(INSTALL_SKILL.project).not.toContain(' -g')
    expect(buildInstallSkill(true, '/repo', true)).toBe('cd /repo && pnpm dev:skill --global')
    expect(buildInstallSkill(true, '/repo', false)).toBe('cd /repo && pnpm dev:skill')
  })

  it('a dev run installs THIS working tree, not what is on GitHub', () => {
    const dev = buildInstallSkill(true, '/repo')
    expect(dev).toBe('cd /repo && pnpm dev:skill --global')
    expect(dev).not.toContain('npx skills add')
  })

  it('a published run is unaffected by the checkout path', () => {
    expect(buildInstallSkill(false, '/wherever')).toBe(INSTALL_SKILL.global)
  })
})

describe('the open-time guide nudge', () => {
  it('asks for a guide when the review has none', () => {
    const nudge = guideNudge(false)!
    expect(nudge).toContain('guide')
    expect(nudge).toContain('```mermaid')
    // The judgment stays the agent's, and pre-reviewing stays banned.
    expect(nudge).toContain('skip when the diff explains itself')
    expect(nudge).toContain('never pre-review')
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
