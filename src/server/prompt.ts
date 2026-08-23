import { fileURLToPath } from 'node:url'
import {
  type Coverage,
  describeAnchor,
  type ReviewThread,
  startedByAgent,
  THREAD_INTENTS,
  type ThreadIntent,
} from '../shared/review.js'
import type { Changeset, FileChange } from '../shared/types.js'

export function snapshotHunk(changeset: Changeset, hunkId: string): string | null {
  for (const file of changeset.files) {
    const hunk = file.hunks.find((h) => h.id === hunkId)
    if (!hunk) continue
    const marker = { add: '+', del: '-', context: ' ' } as const
    return hunk.lines.map((l) => marker[l.kind] + l.text).join('\n')
  }
  return null
}

export const NPX = 'npx -y diffo'

/** This checkout's root — `src/server/prompt.ts` → up two. */
export const CHECKOUT_ROOT = fileURLToPath(new URL('../..', import.meta.url)).replace(/\/$/, '')

export const IS_DEV = process.env.ENV === 'development'

/** Running the CLI straight from a checkout. Absolute on both halves — the agent
 * runs it from inside the repo under review, hence the tsx *binary* rather than
 * `node --import tsx`, which resolves its loader against the cwd. The
 * `ENV=development` prefix travels with the invocation so the server a dev skill
 * starts speaks the same dev CLI back. */
export function devCliFor(checkoutRoot: string): string {
  return `ENV=development ${checkoutRoot}/node_modules/.bin/tsx ${checkoutRoot}/src/cli.ts`
}

export const CLI = IS_DEV ? devCliFor(CHECKOUT_ROOT) : NPX

export function buildCliCommands(cli: string) {
  return {
    open: cli,
    poll: `${cli} poll`,
    reply: `${cli} reply <threadId> --message "<your reply>"`,
    comment: `${cli} comment [<file>] [--line <line>] --message "<comment>"`,
    // The guide is `comment` with no file — spelled out separately so the
    // instruction to anchor it to the whole changeset doesn't have to be given
    // alongside a usage string offering a file.
    guide: `${cli} comment --message "<what the change does>"`,
    end: `${cli} end`,
    setup: `${cli} setup`,
  } as const
}

export const CLI_COMMANDS = buildCliCommands(CLI)

/** Drift-tested against package.json's `repository` in prompt.test.ts. */
export const SKILL_REPO = 'DiffoHQ/diffo'

export function buildInstallSkill(isDev: boolean, checkoutRoot: string, global = true): string {
  if (isDev) return `cd ${checkoutRoot} && pnpm dev:skill${global ? ' --global' : ''}`
  return `npx skills add ${SKILL_REPO} --skill diffo${global ? ' -g' : ''}`
}

export const INSTALL_SKILL = {
  global: buildInstallSkill(IS_DEV, CHECKOUT_ROOT, true),
  project: buildInstallSkill(IS_DEV, CHECKOUT_ROOT, false),
} as const

/**
 * Payloads must stand alone: agents join without the skill (the invite modal's
 * paste, a fresh session, a compacted context), so every instruction to poll
 * restates how to hold the poll — attended, never detached. Mirrors the skill.
 */
export const POLL_STANCE =
  'a tracked background task if your harness has one, the foreground if not — never a detached process'

export const JOIN_PROMPT =
  `join the diffo review: run \`${CLI_COMMANDS.poll}\` (${POLL_STANCE}) ` +
  'and follow the JSON payload it prints — each payload carries its own instructions'

export function nextStepFor(kind: 'threads' | 'finish', actionable: number): string {
  if (kind === 'finish' && actionable === 0) {
    return `Nothing to act on — run \`${CLI_COMMANDS.poll}\` again to keep listening (${POLL_STANCE}); the reviewer may follow up.`
  }
  const lead = kind === 'finish' ? 'The reviewer is done reading — work the whole batch. ' : ''
  return `${lead}Act on each thread, reply with \`${CLI_COMMANDS.reply}\`, then run \`${CLI_COMMANDS.poll}\` again to keep listening.`
}

export const ACK_NEXT_STEP = {
  reply: `When every thread is handled, run \`${CLI_COMMANDS.poll}\` again to keep listening (${POLL_STANCE}).`,
  comment: `It's in the review as your comment, labeled as yours — the reviewer replies to take it up, or resolves it. Continue with the review threads, then run \`${CLI_COMMANDS.poll}\`.`,
  end: 'Detached. Do not reopen or re-poll this review unless the user asks — deliver anything remaining directly in the conversation.',
} as const

/**
 * The guide doctrine — the one agent comment that orients a cold reader.
 * Stated once and interpolated into every surface that teaches it (the skill,
 * `help agent`, the open-time nudge below), the same way POLL_STANCE keeps the
 * poll rules aligned: the surfaces phrase it at different lengths, but these
 * invariants cannot drift apart.
 */
export const GUIDE = {
  /** When one is warranted — and that silence is a valid outcome. */
  when: 'multi-file, structural, or subtle — skip when the diff explains itself',
  /** What it contains. */
  what: 'one sentence on what the change does, plus a small ```mermaid diagram if a picture explains the shape better than words',
  /** The line it must not cross. */
  stance: 'Orient reading, never pre-review: no verdicts, nothing is "fine"',
  /** Staleness: the guide is a thread, so updates land under it. */
  update: 'reply to your own guide thread with a short update',
} as const

/**
 * Printed by `diffo` (open) to a piped stdout when the review has no guide yet.
 * The skill teaches the same step, but this line is what an agent WITHOUT the
 * skill sees — payloads and command output must stand alone (see POLL_STANCE).
 */
export function guideNudge(hasGuide: boolean): string | null {
  if (hasGuide) return null
  return (
    'orient the reviewer before sharing the URL, if this changeset needs it ' +
    `(${GUIDE.when}): post a guide — one comment on the whole changeset: ` +
    `${GUIDE.what}: \`${CLI_COMMANDS.guide}\` ` +
    `(no file, so it anchors to the changeset). ${GUIDE.stance}.`
  )
}

/**
 * Printed to stderr when a poll takes the review over and the review already
 * carries a guide: the new agent inherits it as orientation and updates it in
 * place — a second guide would give the reviewer two.
 */
export function guideInherit(threadId: string): string {
  return (
    `diffo: this review already carries the previous agent's guide (thread ${threadId}).\n` +
    `Read it, and if your changes reshape the changeset update it by replying to it\n` +
    `(\`${CLI} reply ${threadId} -m "…"\`) rather than posting a second guide.\n`
  )
}

const INTENT_LABEL: Record<ThreadIntent, string> = {
  question: 'question',
  fix: 'issue',
}

const INTENT_CONTRACT: Record<ThreadIntent, string> = {
  question:
    '- `question` threads want an answer, not an edit. Reply in the thread; change no code for them unless the reviewer asks.',
  fix: '- `issue` threads want a code change. Address each one, or push back in the thread with your reasoning.',
}

const UNLABELED_CONTRACT =
  '- Unlabeled threads: judge from the text — a question wants an answer, not an edit.'

export function intentContract(threads: readonly ReviewThread[]): string[] {
  const present = new Set(threads.map((t) => t.intent))
  const lines = THREAD_INTENTS.filter((i) => present.has(i)).map((i) => INTENT_CONTRACT[i])
  if (present.has(undefined)) lines.push(UNLABELED_CONTRACT)
  return lines
}

export function replyProtocol(threads: readonly ReviewThread[]): string {
  const batchNote =
    threads.length > 1
      ? '\nRead every thread before you start editing — threads can touch the same\ncode, and an edit for one can move what another is anchored to.\n'
      : ''
  // Finish re-ships every sent thread, answered ones included; without this line
  // the agent re-answers each and the reviewer gets duplicate replies.
  const answeredNote = threads.some((t) => t.messages.at(-1)?.author === 'agent')
    ? [
        "   - Some threads end with your own earlier reply — if nothing new was asked since, don't reply to them again.",
      ]
    : []
  return `## How to respond

Diffo is running locally; talk to it through its CLI.
${batchNote}
For each thread above:

1. Act on it.
${[...intentContract(threads).map((line) => `   ${line}`), ...answeredNote].join('\n')}
2. Reply to the thread (concise, addressed to the reviewer, no preamble):

   ${CLI_COMMANDS.reply}

   (a long reply can be piped instead: pipe it to \`${CLI} reply <threadId>\`)

   A fix reply says what changed and where (\`file:line\`) — don't paste the
   diff; the reviewer's browser shows your edits live. Before saying something
   is fixed, verify it the cheapest honest way (run the relevant test, re-read
   the change) and mention what you checked.
   Reply as soon as a thread is handled; don't save replies for the end.
   Replies and comment threads render GitHub-flavored markdown, and a
   \`\`\`mermaid fence renders as a diagram — use one when a flow, sequence,
   or state picture explains the change better than prose. Keep it small
   (roughly ten nodes); it renders inside a narrow thread card.
3. If you notice something worth a comment of its own — a potential issue,
   or context that helps the reviewer read — start a thread:

   ${CLI_COMMANDS.comment}

   Anchor it to a line (--line), a file, or the whole changeset (no file).
   It appears in the review in your voice and never counts as the reviewer's
   feedback: they reply to take it up, or resolve it. Spend these sparingly —
   an agent that annotates everything gets skimmed.
4. When every thread is handled, run \`${CLI_COMMANDS.poll}\` again to wait
   for the reviewer's next feedback — ${POLL_STANCE}.

Rules:

- Change only what these threads ask about — the reviewer is mid-read, and an
  unrelated edit moves the diff under them. If a correct fix has to touch other
  code, say so in the thread (or in a comment thread of yours) before doing it.
- Each "commented change" above was frozen when the comment was written —
  re-read the current file before editing; the code may have moved since.
- Your code edits are detected automatically and the reviewer's diff updates
  live. Resolving a thread is the reviewer's call, never yours.`
}

export interface PromptContext {
  repo: Changeset['repo']
  changeset?: Changeset | null
  siblings?: ReviewThread[]
}

const FRAME_FILE_CAP = 40

function fileLine(file: FileChange): string {
  const letter = { added: 'A', modified: 'M', deleted: 'D', renamed: 'R' }[file.status]
  return file.status === 'renamed' && file.oldPath
    ? `- R ${file.oldPath} → ${file.path}`
    : `- ${letter} ${file.path}`
}

export function specLine(changeset: Changeset): string {
  const spec =
    changeset.spec.kind === 'working-tree'
      ? 'the working tree against HEAD'
      : `the working tree against merge-base(\`${changeset.spec.base}\`, HEAD)`
  const { files, additions, deletions } = changeset.stats
  return `The changeset under review: ${spec} — ${files} file${files === 1 ? '' : 's'}, +${additions} −${deletions}.`
}

export function changesetFrame(changeset: Changeset): string {
  const listed = changeset.files.slice(0, FRAME_FILE_CAP).map(fileLine)
  if (changeset.files.length > FRAME_FILE_CAP) {
    listed.push(`- … and ${changeset.files.length - FRAME_FILE_CAP} more`)
  }
  return ['## The changeset under review', '', specLine(changeset), '', ...listed].join('\n')
}

const SIBLING_CAP = 10

export function siblingLines(siblings: ReviewThread[]): string | null {
  if (siblings.length === 0) return null
  const lines = siblings.slice(0, SIBLING_CAP).map((t) => {
    const first = t.messages[0]?.text.split('\n')[0]?.slice(0, 100) ?? ''
    return `- ${describeAnchor(t.anchor)} — "${first}"`
  })
  if (siblings.length > SIBLING_CAP) {
    lines.push(`- … and ${siblings.length - SIBLING_CAP} more`)
  }
  return ['## Other review threads (context only — do not act on them here)', '', ...lines].join(
    '\n',
  )
}

const SNAPSHOT_LINE_CAP = 25

function threadBlock(thread: ReviewThread, index: number): string {
  // A thread the agent itself started reads differently: the reviewer is
  // responding to something the agent said, not filing new feedback.
  const label = startedByAgent(thread)
    ? ' [your comment — the reviewer replied]'
    : thread.intent
      ? ` [${INTENT_LABEL[thread.intent]}]`
      : ''
  const again = thread.unanswered ? ' — YOU NEVER ANSWERED THIS' : ''
  const parts = [
    `### Thread ${index + 1}${label} — ${describeAnchor(thread.anchor)}${again}`,
    `id: ${thread.id}`,
  ]
  if (thread.codeContext) {
    const lines = thread.codeContext.split('\n')
    parts.push('The commented change:', '```diff', ...lines.slice(0, SNAPSHOT_LINE_CAP), '```')
    if (lines.length > SNAPSHOT_LINE_CAP) {
      const where = thread.anchor.kind === 'changeset' ? 'the file' : `\`${thread.anchor.path}\``
      parts.push(
        `(… and ${lines.length - SNAPSHOT_LINE_CAP} more snapshot lines — read the current ${where} instead)`,
      )
    }
  }
  parts.push(
    'Messages:',
    ...thread.messages.map((m) => `- ${m.author}: ${m.text.replace(/\n/g, '\n  ')}`),
  )
  return parts.join('\n')
}

export function buildThreadPrompt(thread: ReviewThread, ctx: PromptContext): string {
  const siblings = siblingLines(ctx.siblings ?? [])
  return [
    `A reviewer is reading your changes in \`${ctx.repo.name}\` (branch \`${ctx.repo.branch}\`) and sent you this review thread.`,
    '',
    ...(ctx.changeset ? [specLine(ctx.changeset), ''] : []),
    threadBlock(thread, 0),
    '',
    ...(siblings ? [siblings, ''] : []),
    replyProtocol([thread]),
    '',
  ].join('\n')
}

export function buildCoalescedPrompt(threads: ReviewThread[], ctx: PromptContext): string {
  const siblings = siblingLines(ctx.siblings ?? [])
  return [
    `The reviewer sent new messages on ${threads.length} review threads in \`${ctx.repo.name}\` (branch \`${ctx.repo.branch}\`).`,
    '',
    ...(ctx.changeset ? [specLine(ctx.changeset), ''] : []),
    ...threads.map((t, i) => `${threadBlock(t, i)}\n`),
    ...(siblings ? [siblings, ''] : []),
    replyProtocol(threads),
    '',
  ].join('\n')
}

export function buildFinishPrompt(
  threads: ReviewThread[],
  ctx: PromptContext,
  coverage: Coverage,
): string {
  const repo = ctx.repo
  const actionable = threads.filter((t) => t.state === 'sent')
  const changed = coverage.changedFiles ?? []
  const commented = coverage.commentedUnread ?? []
  const filtered = coverage.filteredOut ?? []
  const skipped = [
    changed.length > 0
      ? ` Changed after the reviewer read them (their read marks were revoked): ${changed.join(', ')}.`
      : '',
    commented.length > 0 ? ` Commented on but not marked read: ${commented.join(', ')}.` : '',
    filtered.length > 0
      ? ` Deliberately out of scope — hidden by a filter and never read: ${filtered.join(', ')}.`
      : '',
    coverage.skippedFiles.length > 0
      ? ` Not marked read: ${coverage.skippedFiles.join(', ')}.`
      : '',
  ].join('')
  const files =
    coverage.totalFiles !== undefined && coverage.totalFiles > 0
      ? `${coverage.viewedFiles ?? 0}/${coverage.totalFiles} files read, `
      : ''
  const verdictLine =
    coverage.verdict === 'approve'
      ? 'Verdict: **approved** — the reviewer is happy for this changeset to proceed.'
      : coverage.verdict === 'request-changes'
        ? 'Verdict: **changes requested** — do not treat this review as done until the threads below are addressed.'
        : null
  const noteLines =
    coverage.note !== undefined
      ? ['Their closing note:', ...coverage.note.split('\n').map((l) => `> ${l}`)]
      : []
  const owed = actionable.filter((t) => t.unanswered)
  const owedLines =
    owed.length > 0
      ? [
          `${owed.length} of the threads below you were already given once, and never`,
          'replied to. They are marked. Answer those first — a reply, or a',
          'reason you are not acting; going quiet again is the one thing that',
          'leaves the reviewer with nothing to do.',
          '',
        ]
      : []
  const parts = [
    `A reviewer finished reading your changes in \`${repo.name}\` (branch \`${repo.branch}\`).`,
    '',
    ...(verdictLine ? [verdictLine, ''] : []),
    ...(noteLines.length > 0 ? [...noteLines, ''] : []),
    ...(ctx.changeset ? [changesetFrame(ctx.changeset), ''] : []),
    `Coverage: ${files}${coverage.viewedHunks}/${coverage.totalHunks} hunks read.${skipped}`,
    '',
    ...owedLines,
  ]
  if (coverage.skippedFiles.length > 0) {
    parts.push(
      'The reviewer left the not-marked-read files unread. If any of them hide',
      'a risky or subtle change you made, say so in a comment thread',
      `(\`${CLI_COMMANDS.comment}\`) — the reviewer replies to take it up, or resolves it.`,
      '',
    )
  }
  if (actionable.length === 0) {
    parts.push(
      'No open review threads — nothing to act on. Run',
      `\`${CLI_COMMANDS.poll}\` again to keep listening (${POLL_STANCE});`,
      'the reviewer may follow up.',
      '',
    )
  } else {
    parts.push(
      `${actionable.length} review thread${actionable.length === 1 ? '' : 's'} to act on:`,
      '',
      ...actionable.map((t, i) => `${threadBlock(t, i)}\n`),
      replyProtocol(actionable),
      '',
    )
  }
  return parts.join('\n')
}
