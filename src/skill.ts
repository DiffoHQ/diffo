import { buildCliCommands, GUIDE, NPX, PACKAGE_NAME } from './server/prompt.js'

// The shipped Agent Skill is GENERATED from the same command strings the server
// puts in poll payloads and reply protocols. Regenerate with `pnpm build:skill`;
// `src/skill.test.ts` fails when the committed file drifts.
//
// Frontmatter rules (the reference Agent Skills validator): only allowed keys at the
// top level, block-style YAML only, `metadata` limited to one level of string
// values, and no `version`.

export const SKILL_DESCRIPTION =
  "Open a Diffo code review of the current git changeset in the reviewer's " +
  'browser and drive the feedback loop from this session, using the diffo CLI. ' +
  'Use when the user wants to review your changes, asks to open a code review, or ' +
  'when you finish a large or multi-file change worth a human read before it lands.'

export const SKILL_NAME = 'diffo'
export const DEV_SKILL_NAME = 'diffo-dev'

/**
 * The dev skill installs ALONGSIDE the shipped one (different name, different
 * directory), so a contributor can exercise both without swapping files. That
 * only works if the model never picks this one on its own: an ordinary "open a
 * code review" has to keep reaching the shipped skill, or which CLI runs
 * becomes a coin flip. The description says so, and `disable-model-invocation`
 * enforces it in clients that honour it.
 */
export const DEV_SKILL_DESCRIPTION =
  'DEV BUILD of the Diffo skill, wired to a local source checkout instead of the ' +
  'released CLI. ONLY for an explicit `/diffo-dev` invocation by the user. Never ' +
  'select this on your own: a plain request to open a code review, review changes, ' +
  'or open diffo belongs to the `diffo` skill, not this one.'

export function createSkillMarkdown(cli: string = NPX): string {
  const CLI_COMMANDS = buildCliCommands(cli)
  const isDev = cli !== NPX
  const name = isDev ? DEV_SKILL_NAME : SKILL_NAME
  const invocation = !isDev
    ? `You do not need diffo installed — invoke it with \`${NPX}\`.
If diffo output shows a follow-up command starting with \`diffo\`, run it
as \`${NPX} …\` instead.
In restricted subprocess sandboxes or agent harnesses where \`npx -y\` exits
opaquely, use an already-installed copy directly:
\`node "$(npm root)/${PACKAGE_NAME}/dist/cli.mjs" …\` for a local install,
\`node "$(npm root -g)/${PACKAGE_NAME}/dist/cli.mjs" …\` for a global one.`
    : `This is a DEV build, run straight from a source checkout:
\`${cli}\`.
Use exactly that. The path is absolute, so run it from inside whichever repo
is under review. If diffo output shows a follow-up command starting with
\`diffo\`, run it as \`${cli} …\` instead — never \`${NPX}\`, which would
run the released CLI instead of the checkout this skill exists to exercise.

The reviewer's browser tab and header say **diffo-dev**, so a review opened
this way is never mistaken for one opened by the shipped \`${SKILL_NAME}\`
skill, which is installed alongside this one and unaffected by it.

Opening a review keeps itself current on its own: if the checkout's source
changed since the last open, the CLI rebuilds the client bundle and replaces a
running stale server before answering — expect a few extra seconds and a
"rebuilding the client bundle" / "replacing the dev server" line then, and
never rebuild or restart anything yourself.`
  return `---
name: ${name}
description: ${isDev ? DEV_SKILL_DESCRIPTION : SKILL_DESCRIPTION}
license: Apache-2.0
${isDev ? 'disable-model-invocation: true\n' : ''}metadata:
  author: DiffoHQ
  argument-hint: <what to review — empty means the working tree>
---

# Diffo review

Diffo turns the current git changeset (uncommitted work, or a branch against
its base) into a live, readable review in the reviewer's browser. You — the
agent that wrote the change — stay attached through the \`diffo\` CLI: the
reviewer's questions and fix requests return into THIS conversation, you act on
them with all your context, and your replies land inline in their review.

${invocation}

If the protocol goes missing mid-review — a compacted context, a fresh
session — \`${cli} help agent\` reprints the whole loop on one page.

## Request

$ARGUMENTS

If the request above is non-empty, the user invoked \`/${name}\` explicitly —
open the review now, following the loop below (a branch name means review
against that base: \`${cli} --base <branch>\`).
If it is empty, review the changeset this conversation just produced.

## When to use

${
  isDev
    ? `Only when the user explicitly invokes \`/${DEV_SKILL_NAME}\`, or asks in so
many words for the dev build. Nothing else — an ordinary "review my changes",
"open a code review", or "open diffo" is the shipped \`${SKILL_NAME}\` skill's
job, and answering it here would silently review with unreleased code.`
    : `- The user asks to review your changes, or to "open diffo"
- You finished a multi-file or subtle change that deserves a human read
- The user wants to ask questions about a diff while reading it`
}

## The loop

1. **Open the review**: run \`${CLI_COMMANDS.open} --no-open\` from inside the
   repo. It starts a local server and keeps watching the working tree (your
   later edits appear live). \`--no-open\` matters: an agent never opens a
   browser at the reviewer — **hand them the printed URL instead: end your
   turn's final message with it, on its own line, the last thing they read**
   (text between tool calls may never be shown, so anywhere else risks losing
   it), and keep doing that every turn while you stay attached, per the rule
   below. An unshared URL is an unopened review. The command **returns straight
   away** — it leaves a background server watching the repo, so run it in the
   foreground like any short command and do NOT hold a slot open for it. The
   review outlives this session; if the command says a server is already
   watching this repo, one is running — just continue (and still share the URL
   it printed).
2. **Guide the reviewer in — when the changeset needs it**: before handing
   over the URL, judge whether a cold reader needs orientation
   (${GUIDE.when}). If it does, post ONE comment on the whole changeset — no
   file, so it anchors there:

   \`\`\`
   ${CLI_COMMANDS.guide}
   \`\`\`

   Its content: ${GUIDE.what} (roughly ten nodes).
   Keep it short — a guide the reviewer skims is a guide that did nothing.
   ${GUIDE.stance} — the reviewer's
   independent judgment is the point. If your later edits reshape the
   changeset, ${GUIDE.update} (it is a
   thread like any other, so the update lands under it).
3. **Poll for feedback**: run \`${CLI_COMMANDS.poll}\`.
   It waits silently (heartbeats only) until the reviewer acts, then prints one
   JSON payload: a prompt carrying the review threads to act on, with thread
   ids. Leave it running — never kill it.
   - **Don't let the poll block the conversation.** The reviewer reads at
     their own pace and talks to you in chat meanwhile — a foreground poll
     leaves them talking to a wall. Run the poll as a harness-native tracked
     background task whose completion is guaranteed to resume or notify this
     same agent (e.g. the harness's tracked background-command facility), and
     keep answering in chat while it waits. Poll in the foreground ONLY when
     the harness has no completion-aware background facility.
   - Never use \`nohup\`, shell \`&\`, \`disown\`, redirected fire-and-forget
     processes, or a detached terminal without a verified callback to keep
     polling alive. The feedback survives either way — but a payload that
     reaches a process nobody is listening to never reaches YOU, and the
     reviewer is left believing you were told. Do not tell the user the review
     is being monitored unless that wake path is live.
   - If the poll is killed or times out anyway, just re-run it. Nothing the
     reviewer sent is lost: it is held in the review itself, so it outlives the
     poll, and the server too.
   - If the poll prints that it **took the review over** from another agent
     session, a second agent is working on this repo. You are attached and the
     reviewer's feedback comes to you now — nothing is blocked — but say so to
     the user in your next message, naming the other session, so they know
     where their feedback is going and can stop the other one if they meant to.
   - If the poll returns \`"status": "superseded"\`, another agent session took
     the review from you. Do not re-poll unless the user asks — you would just
     take it back and the two of you would trade it. Tell the user instead.
4. **Act on the feedback**: threads arrive labeled \`[issue]\` (change the
   code) or \`[question]\` (answer in the reply — change nothing). Then reply
   to each thread, concise and addressed to the reviewer, no preamble:

   \`\`\`
   ${CLI_COMMANDS.reply}
   \`\`\`

   (pipe a long reply on stdin instead of --message). Reply as soon as a
   thread is handled; don't save replies for the end. Code edits are detected
   automatically — the diff in the browser updates live and the thread flips
   to addressed.
   Replies and comments render GitHub-flavored markdown, and a \`\`\`mermaid
   fence renders as a diagram in the review — use one when a flow, sequence,
   or state picture explains the change better than prose. Keep it small
   (roughly ten nodes); it renders inside a thread card.
5. **Speak in your own voice, sparingly**: you can start comment threads of
   your own — a potential issue, or context that helps the reviewer read (why
   a change looks the way it does, where to start). Anchor one to a line
   (--line), a file, or the whole changeset (no file):

   \`\`\`
   ${CLI_COMMANDS.comment}
   \`\`\`

   It is labeled as yours and never counts as the reviewer's feedback until
   they reply into it — then it is theirs to send. Spend these deliberately:
   an agent that annotates everything gets skimmed.
6. **Poll again — and only once you're actually done**: after handling
   everything the last payload gave you, run \`${CLI_COMMANDS.poll}\` again to
   keep listening. When the reviewer clicks Finish review, the poll returns
   their whole batch — queued comments plus honest coverage stats — as one
   payload; apply it the same way.

   **Your next poll is read as "I've finished that lot."** Every thread from
   the previous batch that you never replied to stops saying "waiting on the
   agent" and starts saying *no answer*, because asking for more work is a
   statement that you are done with the old. So don't re-poll the instant a payload arrives and
   then start working — handle the batch first, then poll. If you have
   deliberately decided not to act on a thread, say so in the thread; a reason
   is an answer, silence is not.
7. **End politely**: when the user moves on or the review is done, run
   \`${CLI_COMMANDS.end}\` to detach. Do not reopen or re-poll a review the
   reviewer ended unless asked.

## Rules

- **End every turn with the review URL, on its own line, for as long as you
  are attached** — not only the turn that opened it. The review is a page the
  reviewer returns to across a long conversation, and a link twenty messages
  back is a link they have to go hunting for. It costs one line, and it is the
  only thing standing between them and the review. Stop once the review is
  ended.
- One attached agent at a time: the newest poll carries the review. Don't run
  two polls at once, and don't re-poll to win it back from another session —
  tell the user which agent is attached and let them decide.
- \`${CLI_COMMANDS.end}\` ends YOUR attachment only. If another session is the
  attached agent it does nothing, and says so.
- Never edit code the reviewer didn't ask about while a review is open —
  the diff moves under their reading position.
- Replies speak to the reviewer, in the thread; don't duplicate them into the
  chat unless asked.
`
}
