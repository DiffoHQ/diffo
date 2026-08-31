import { fileURLToPath } from 'node:url'
import {
  type Anchor,
  type Coverage,
  describeAnchor,
  type ReviewThread,
  startedByAgent,
  THREAD_INTENTS,
  type ThreadCapture,
  type ThreadIntent,
} from '../shared/review.js'
import type { Changeset, FileChange, Hunk } from '../shared/types.js'

/** A comment can anchor to a long range; the frozen text keeps its head. */
const ANCHORED_TEXT_CAP = 10

function findHunk(changeset: Changeset, hunkId: string): Hunk | null {
  for (const file of changeset.files) {
    const hunk = file.hunks.find((h) => h.id === hunkId)
    if (hunk) return hunk
  }
  return null
}

/**
 * Freeze what a new thread anchors to: the whole hunk as a diff snapshot, plus
 * — for the anchored line range — where those rows sit in it and their text.
 * Null for non-hunk anchors and for a hunk the changeset no longer has.
 */
export function captureAnchor(changeset: Changeset, anchor: Anchor): ThreadCapture | null {
  if (anchor.kind !== 'hunk') return null
  const hunk = findHunk(changeset, anchor.hunkId)
  if (!hunk) return null
  const marker = { add: '+', del: '-', context: ' ' } as const
  const rows = hunk.lines.map((l) => marker[l.kind] + l.text)
  const codeContext = rows.join('\n')
  const last = anchor.endLine ?? anchor.line
  const covered = hunk.lines
    .map((l, row) => ({ no: anchor.side === 'old' ? l.oldNo : l.newNo, row }))
    .filter((r) => r.no !== null && r.no >= anchor.line && r.no <= last)
  if (covered.length === 0) return { codeContext }
  const start = covered[0]!.row
  const end = covered.at(-1)!.row
  const text = rows.slice(start, Math.min(end + 1, start + ANCHORED_TEXT_CAP)).join('\n')
  return { codeContext, anchored: { start, end, text } }
}

/** Scoped, because the bare `diffo` name on npm belongs to an unrelated package.
 * The bin it exposes is still `diffo`, so only the install specifier is scoped. */
export const PACKAGE_NAME = '@diffohq/diffo'

export const NPX = `npx -y ${PACKAGE_NAME}`

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

export function nextStepFor(kind: 'threads' | 'finish' | 'cleared', actionable: number): string {
  if (kind === 'cleared') {
    return `Post the guide if this changeset warrants one, then run \`${CLI_COMMANDS.poll}\` again to keep listening (${POLL_STANCE}).`
  }
  if (kind === 'finish' && actionable === 0) {
    return `Nothing to act on — run \`${CLI_COMMANDS.poll}\` again to keep listening (${POLL_STANCE}); the reviewer may follow up.`
  }
  const lead = kind === 'finish' ? 'The reviewer is done reading — work the whole batch. ' : ''
  return `${lead}Act on each thread, reply with \`${CLI_COMMANDS.reply}\`, then run \`${CLI_COMMANDS.poll}\` again to keep listening.`
}

export const ACK_NEXT_STEP = {
  reply: `When every thread is handled, run \`${CLI_COMMANDS.poll}\` again to keep listening (${POLL_STANCE}).`,
  replyMore:
    'Interim reply posted — the reviewer still sees you working on this thread. Post the follow-up as a plain reply (no --more) BEFORE your next poll: re-polling closes the batch and counts the promise as never kept.',
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

/** The agent spoke last: the thread is answered until the reviewer says more.
 * A reply that promised a follow-up (`--more`) is not an answer yet. */
export function answeredByAgent(thread: ReviewThread): boolean {
  return thread.messages.at(-1)?.author === 'agent' && thread.awaitingFollowUp !== true
}

/** The closing note is the reviewer summing up, so it earns an answer even when it
 * asks nothing — a note with no reply is the review's one dead end. */
const CLOSING_CONTRACT =
  '- The closing note speaks for the whole review: read it first, and reply to it — briefly if it only sums up, in full if it asks something.'

export function intentContract(threads: readonly ReviewThread[]): string[] {
  const present = new Set(threads.filter((t) => !t.closingNote).map((t) => t.intent))
  const lines = THREAD_INTENTS.filter((i) => present.has(i)).map((i) => INTENT_CONTRACT[i])
  if (present.has(undefined)) lines.push(UNLABELED_CONTRACT)
  if (threads.some((t) => t.closingNote)) lines.push(CLOSING_CONTRACT)
  return lines
}

/**
 * The short form, for a session that already received the full protocol this
 * attachment (tracked per session pid by the DeliveryQueue). The full text is
 * ~580 tokens and re-shipping it with every delivery was the loop's largest
 * recurring cost; the compact form keeps only the per-batch contract — intent
 * rules, the reply command, the re-poll — plus the pointer that reprints the rest.
 */
function compactProtocol(threads: readonly ReviewThread[]): string {
  return `## How to respond

Same protocol as your earlier deliveries (\`${CLI} help agent\` reprints it in full):

1. Act on each thread.
${intentContract(threads)
  .map((line) => `   ${line}`)
  .join('\n')}
2. Reply per thread as soon as it is handled — what changed and where (\`file:line\`), verify it the cheapest honest way first:

   ${CLI_COMMANDS.reply}

3. When every thread is handled, run \`${CLI_COMMANDS.poll}\` again to keep listening.

Change only what these threads ask about — the reviewer is mid-read. Re-read
the current file before editing; the code may have moved. Resolving a thread
is the reviewer's call, never yours.`
}

export type ProtocolMode = 'full' | 'compact'

export function replyProtocol(
  threads: readonly ReviewThread[],
  mode: ProtocolMode = 'full',
): string {
  if (mode === 'compact') return compactProtocol(threads)
  const batchNote =
    threads.length > 1
      ? '\nRead every thread before you start editing — threads can touch the same\ncode, and an edit for one can move what another is anchored to.\n'
      : ''
  // Finish re-ships every sent thread, answered ones included; without this line
  // the agent re-answers each and the reviewer gets duplicate replies.
  const answeredNote = threads.some((t) => answeredByAgent(t))
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
   A reply that only promises a follow-up ("I'll investigate and report
   back") is not an answer — post it with \`--more\` so the reviewer keeps
   seeing you at work on that thread, then post the real answer as a plain
   reply (no \`--more\`) before your next poll.
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
  /** 'compact' when this session already received the full protocol; defaults to full. */
  protocol?: ProtocolMode
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

/** The heading's movement-proof identifier: the first anchored line's text,
 * stripped of its diff marker. The line numbers in `describeAnchor` go stale
 * the moment the code moves; this text is what the agent can still search for. */
function anchorQuote(thread: ReviewThread): string {
  // The first line with content — a range can open on a blank line.
  const first = thread.anchored?.text
    .split('\n')
    .map((line) => line.slice(1).trim())
    .find((line) => line !== '')
    ?.slice(0, 80)
  if (!first) return ''
  const range = thread.anchor.kind === 'hunk' && thread.anchor.endLine !== undefined
  return range ? ` — starts at: "${first}"` : ` — "${first}"`
}

/** When `path:line` must not be trusted against the working tree: an old-side
 * anchor never matches it, and a rotated hunk means the code moved under the
 * numbers. At most one note — removed code can't also have "moved". */
function anchorNote(thread: ReviewThread): string[] {
  if (thread.anchor.kind !== 'hunk') return []
  if (thread.anchor.side === 'old') {
    return [
      'This comments on removed code — the anchored lines are the old version, not the current file.',
    ]
  }
  if (thread.codeChanged) {
    return [
      'The code under this comment changed after the comment was written — its line numbers are stale. Find the code by its anchored lines, not by number.',
    ]
  }
  return []
}

/** The `[from, to)` slice of the snapshot to show: the anchored rows centered
 * inside the cap. A range longer than the cap keeps its head. */
function snapshotWindow(
  total: number,
  anchored: { start: number; end: number },
): { from: number; to: number } {
  const size = Math.min(total, SNAPSHOT_LINE_CAP)
  const span = anchored.end - anchored.start + 1
  const pad = Math.floor(Math.max(0, size - span) / 2)
  const from = Math.min(Math.max(0, anchored.start - pad), total - size)
  return { from, to: from + size }
}

/** The snapshot as the agent sees it: windowed on the anchored rows, each of
 * them marked with `>`. Threads from before `anchored` existed keep the old
 * head-of-hunk window. */
function snapshotBlock(thread: ReviewThread): string[] {
  const { codeContext, anchored } = thread
  if (!codeContext) {
    // The snapshot is gone (dropped on resolve) but the anchored text survives —
    // without this block a follow-up ships nothing but a stale line number.
    if (!anchored) return []
    const shown = anchored.text.split('\n')
    const cut = anchored.end - anchored.start + 1 - shown.length
    return [
      'The commented lines, as they were when the comment was written:',
      '```diff',
      ...shown,
      '```',
      ...(cut > 0 ? [`(… and ${cut} more commented lines)`] : []),
    ]
  }
  const lines = codeContext.split('\n')
  const where = thread.anchor.kind === 'changeset' ? 'the file' : `\`${thread.anchor.path}\``
  // Already delivered once: the agent saw this snapshot, so re-shipping it only
  // spends tokens — and it was frozen at comment time, so the current file is
  // the better read anyway. The heading still quotes the anchored lines.
  if (thread.deliveredThrough) {
    return [`(diff snapshot delivered to you earlier — read the current ${where} instead)`]
  }
  if (!anchored) {
    return [
      'The commented change:',
      '```diff',
      ...lines.slice(0, SNAPSHOT_LINE_CAP),
      '```',
      ...(lines.length > SNAPSHOT_LINE_CAP
        ? [
            `(… and ${lines.length - SNAPSHOT_LINE_CAP} more snapshot lines — read the current ${where} instead)`,
          ]
        : []),
    ]
  }
  const { from, to } = snapshotWindow(lines.length, anchored)
  const shown = lines
    .slice(from, to)
    .map((line, i) => (from + i >= anchored.start && from + i <= anchored.end ? `>${line}` : line))
  const cut = lines.length - (to - from)
  return [
    'The commented change (`>` marks the commented lines):',
    '```diff',
    ...shown,
    '```',
    ...(cut > 0
      ? [
          `(windowed to the commented lines — ${cut} more snapshot lines around them; read the current ${where} for the full change)`,
        ]
      : []),
  ]
}

function threadBlock(thread: ReviewThread, index: number): string {
  // A thread the agent itself started reads differently: the reviewer is
  // responding to something the agent said, not filing new feedback.
  const label = startedByAgent(thread)
    ? ' [your comment — the reviewer replied]'
    : thread.closingNote
      ? ' [their closing note on the whole review]'
      : thread.intent
        ? ` [${INTENT_LABEL[thread.intent]}]`
        : ''
  const again = thread.unanswered ? ' — YOU NEVER ANSWERED THIS' : ''
  return [
    `### Thread ${index + 1}${label} — ${describeAnchor(thread.anchor)}${anchorQuote(thread)}${again}`,
    `id: ${thread.id}`,
    ...anchorNote(thread),
    ...snapshotBlock(thread),
    'Messages:',
    ...thread.messages.map((m) => `- ${m.author}: ${m.text.replace(/\n/g, '\n  ')}`),
  ].join('\n')
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
    replyProtocol([thread], ctx.protocol),
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
    replyProtocol(threads, ctx.protocol),
    '',
  ].join('\n')
}

/**
 * The reviewer started the review over — the previous round landed, and its
 * threads and guide were cleared. Nothing to act on; the one thing owed is
 * orientation for the fresh round, so this restates the guide doctrine the way
 * the open-time nudge does (payloads must stand alone — see POLL_STANCE).
 */
export function buildClearedPrompt(ctx: PromptContext): string {
  return [
    `The reviewer cleared the review in \`${ctx.repo.name}\` (branch \`${ctx.repo.branch}\`): the previous round landed, and its threads and guide are gone. What the reviewer sees now is a fresh round.`,
    '',
    ...(ctx.changeset ? [specLine(ctx.changeset), ''] : []),
    `There is no feedback to act on. But the fresh round has no guide — if this changeset needs one (${GUIDE.when}): post it — one comment on the whole changeset: ${GUIDE.what}: \`${CLI_COMMANDS.guide}\` (no file, so it anchors to the changeset). ${GUIDE.stance}.`,
    '',
    `Then run \`${CLI_COMMANDS.poll}\` again to keep listening (${POLL_STANCE}).`,
    '',
  ].join('\n')
}

export function buildFinishPrompt(
  threads: ReviewThread[],
  ctx: PromptContext,
  coverage: Coverage,
): string {
  const repo = ctx.repo
  const sent = threads.filter((t) => t.state === 'sent')
  // The closing note leads the batch: it is what the reviewer would say first if
  // they were in the room, and it frames every thread under it.
  const closing = sent.find((t) => t.closingNote)
  const ordered = closing ? [closing, ...sent.filter((t) => t !== closing)] : sent
  // A thread whose last word is the agent's is answered: Finish used to re-ship
  // its full block (snapshot + history) with a "don't reply again" note — the
  // loop's biggest single spike. It rides as one id line instead, owing nothing.
  const answered = ordered.filter((t) => t !== closing && answeredByAgent(t))
  const actionable = ordered.filter((t) => !answered.includes(t))
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
  // The note is a thread now, quoted once in its own block — pointed at from up
  // here rather than repeated. Quoted in full only when no thread carries it: a
  // finish recorded before closing notes were threads, or one taken over an empty
  // changeset that had nowhere to anchor it.
  const noteLines =
    coverage.note === undefined
      ? []
      : closing
        ? ['Their closing note is Thread 1 below — answer it there, like any other thread.']
        : ['Their closing note:', ...coverage.note.split('\n').map((l) => `> ${l}`)]
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
    ...(noteLines.length > 0 ? [...noteLines, ''] : []),
    ...(ctx.changeset ? [changesetFrame(ctx.changeset), ''] : []),
    `Coverage: ${files}${coverage.viewedHunks}/${coverage.totalHunks} hunks read.${skipped}`,
    '',
    ...owedLines,
  ]
  if (answered.length > 0) {
    parts.push(
      `${answered.length} thread${answered.length === 1 ? '' : 's'} you already answered, with nothing new since — no reply owed, not repeated here:`,
      ...answered.map((t) => `- ${t.id} — ${describeAnchor(t.anchor)}`),
      '',
    )
  }
  if (coverage.skippedFiles.length > 0) {
    parts.push(
      'The reviewer left the not-marked-read files unread. If any of them hide',
      'a risky or subtle change you made, say so in a comment thread',
      `(\`${CLI_COMMANDS.comment}\`) — the reviewer replies to take it up, or resolves it.`,
      '',
    )
  }
  if (actionable.length === 0) {
    // There is no verdict field: the reviewer's word is their note, and an empty
    // finish over a fully-read changeset is the one silence that speaks — approval.
    const fullRead =
      coverage.totalHunks > 0 &&
      coverage.viewedHunks >= coverage.totalHunks &&
      changed.length === 0 &&
      commented.length === 0 &&
      filtered.length === 0 &&
      coverage.skippedFiles.length === 0
    parts.push(
      fullRead && coverage.note === undefined
        ? 'They read everything and left nothing to address — take it as a green light to proceed.'
        : 'No open review threads — nothing to act on.',
      `Run \`${CLI_COMMANDS.poll}\` again to keep listening (${POLL_STANCE});`,
      'the reviewer may follow up.',
      '',
    )
  } else {
    parts.push(
      `${actionable.length} review thread${actionable.length === 1 ? '' : 's'} to act on:`,
      '',
      ...actionable.map((t, i) => `${threadBlock(t, i)}\n`),
      replyProtocol(actionable, ctx.protocol),
      '',
    )
  }
  return parts.join('\n')
}
