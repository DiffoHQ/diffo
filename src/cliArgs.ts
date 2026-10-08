import { parseArgs } from 'node:util'
import {
  CLI_COMMANDS,
  GUIDE,
  GUIDE_CLASSDEFS,
  HELP_AGENT_PR,
  LAYERS,
  POLL_STANCE,
  TAB_TITLE,
} from './server/prompt.js'
import { parseSuggestReason } from './shared/layers.js'
import { normalizeTitle } from './shared/review.js'
import type { ChangesetSpec } from './shared/types.js'

export const HELP_TEXT = `diffo: review a changeset the way you'd read a book

Usage: diffo [options]          open (or resume) the review for this repo
       diffo <target> [options] review against a branch, or review a pull request
       diffo <command> [...]    manage the server, or talk to the review
       diffo help [command]     show help for a command

The target:
  <branch>           everything since forking from that branch (same as --base)
  <PR URL>           a GitHub pull request (also owner/repo#N, #N, or N)
                     (the short forms resolve against this repo's origin)

For the reviewer:
  pr <target>        Review a pull request (the same as \`diffo <target>\`,
                     and the explicit answer for a pull request of your own;
                     help pr explains the flow)
  status             Show this repo's review server, if one is running
                     (--json for a machine-readable answer)
  stop               Stop this repo's review server
  clean              Remove the worktrees diffo made for pull requests whose
                     review is over (--force takes dirty ones, and ones a
                     running server still serves; --all takes every one)
  setup              Register diffo with the coding agents on this machine
                     (Claude Code, Cursor, VS Code, Copilot, and the shared
                     ~/.agents skills dir read by Codex, Gemini, Amp, Goose, …)
  telemetry          Show whether anonymous usage data is on, or turn it
                     off / on (telemetry off · telemetry on)

For the agent (the AI that wrote the change):
  poll               Wait for the reviewer's feedback (blocking long-poll;
                     prints one JSON payload; safe to re-run any time)
                     (--title "<what the change is>" on the first poll names
                     the reviewer's browser tab)
  reply <threadId>   Post a reply to a review thread
                     (--message "<text>", or pipe the text on stdin)
  comment [<file>]   Start a comment thread as the agent: on a line (--line),
                     a file, or (with no file) the whole changeset; the
                     reviewer replies to take it up, or resolves it
  layers             Outline the changeset as steps to read in order
                     (--suggest ["why"] flags it at open; --json '<Layer[]>'
                     or --stdin posts the list, replacing the last one)
  end                Detach from the review politely
  help agent         The agent's whole protocol on one page
  help guide         The guide comment — the map of the change — with an example

Options (for opening the review):
  --base <branch>    Review everything since forking from <branch>
                     (default: working tree vs HEAD)
  -p, --port <port>  Port to serve on (default: the port this repo last used,
                     else the first free one)
  --no-open          Don't open the browser automatically
  --foreground       Run the server in this terminal instead of leaving a
                     background one behind (Ctrl-C stops it)
  -v, --version      Show version
  -h, --help         Show this help

Examples:
  diffo                        open the review for this repo in the browser
  diffo main                   review everything since forking from main
  diffo https://github.com/o/r/pull/482
                               review pull request #482 with your agent as copilot
  diffo status                 is a server running here, and where?
  diffo reply t-3 -m "fixed"   answer a review thread (agent side)

Feedback lives in the review, not in any process: diffo, poll, status, stop,
and setup are all safe to re-run after an interruption.`

const VERB_HELP: Record<string, string> = {
  agent: `diffo help agent: the agent's whole protocol on one page

You are the agent that wrote the change; a human reads it live in their
browser. Diffo carries their feedback to you and your replies back inline.
Poll payloads carry their own instructions; this page is the map that
survives when context does not.

The loop:

1. Open: run \`diffo --no-open\` from inside the repo. It returns straight
   away, leaving a background server watching the working tree. Never open a
   browser at the reviewer; share the printed URL instead, the moment it
   prints: a message line right after this command, before the guide, the
   poll, or anything else. Then end your message with it too, and keep
   ending every message with it while you stay attached.
   Attached without ever seeing the URL (a takeover, a fresh session)?
   \`diffo status\` prints it.
2. Guide: post one only when the changeset needs orientation:
   ${GUIDE.when}.
   Right after sharing the URL, while the reviewer opens the page, post ONE
   comment on the whole changeset (\`diffo comment -m "…"\`, no file). It is
   ${GUIDE.what}.
   Not in it: ${GUIDE.order}.
   How much: ${GUIDE.budget}.
   ${GUIDE.stance}.
   Legend: ${GUIDE.legend}; \`diffo help guide\` has them, and one example.
   It lands live at the top of their review; never hold the URL back for it.
   If the changeset later shifts under the guide, ${GUIDE.update}.
3. Layers: offer them when the changeset reads better in order:
   ${LAYERS.suggest}.
   Flag it at open with \`diffo layers --suggest "<why, in one line>"\` and
   say so in your handoff ("say layers and I'll outline it"). Post the
   outline only when the reviewer asks, in chat or through the poll as a
   \`"kind": "layers"\` payload: \`diffo layers --json '<Layer[]>'\`
   (or pipe it to \`diffo layers --stdin\`). Each layer is ${LAYERS.what}.
   Summary: ${LAYERS.summary}. Diagram: ${LAYERS.diagram}.
   Order: ${LAYERS.order}. ${LAYERS.mechanical}. ${LAYERS.stance}.
   ${LAYERS.replace}. \`diffo help layers\` has the shape.
4. Listen: run \`${CLI_COMMANDS.firstPoll}\`; it blocks until the reviewer
   acts, then prints one JSON payload naming the threads to act on. Run it
   attended: ${POLL_STANCE}.
   The title is ${TAB_TITLE.what}: ${TAB_TITLE.why}. Write it the way it is
   read: ${TAB_TITLE.shape} (${TAB_TITLE.examples}). Send it ${TAB_TITLE.when};
   every other poll is a plain \`diffo poll\`.
   Killed or timed out? Re-run it; feedback is held in the review, not the
   poll.
5. Act: \`[issue]\` threads want a code change; \`[question]\` threads want an
   answer in the reply and no edit. Your edits reach the reviewer live.
6. Reply: \`diffo reply <threadId> --message "<text>"\` (pipe long replies on
   stdin), concise, addressed to the reviewer. Markdown renders; a
   \`\`\`mermaid fence draws a diagram. A reply that only promises a
   follow-up ("I'll investigate and report back") goes out with \`--more\`, so
   the reviewer keeps seeing you at work, and the real answer follows as a
   plain reply before the next poll.
7. Comment (sparingly): \`diffo comment [<file>] [--line <n>] -m "<text>"\`
   starts a thread in your voice: a concern, or context that helps the read.
   When a reply or comment of yours ends in a decision that is the
   reviewer's ("want me to extract this?"), add \`--suggest-reply "<one
   line>"\`; it shows as ghost text in their reply box, taken with Tab.
   Offer the answer you expect, not a menu; skip it on messages that only
   report.
8. Poll again only when the whole batch is handled; a new poll tells the
   reviewer you are done with the previous one.
9. Detach: run \`diffo end\` when the review is over or the user moves on.

Rules:
- Change only what the threads ask about; the reviewer is mid-read, and an
  unrelated edit moves the diff under them.
- One attached agent at a time: the newest poll carries the review; don't
  re-poll to take it back from another session; tell the user instead. When
  a poll says it took the review over, or returns status "superseded", say so
  to the user: their feedback moved with it.
- Resolving a thread is the reviewer's call, never yours.

${HELP_AGENT_PR}`,
  guide: `diffo help guide: the map an agent posts on the whole changeset

Posted with \`diffo comment -m "…"\` (no file, so it anchors to the changeset)
right after sharing the URL, while the reviewer opens the page, and only
when the changeset needs orientation: ${GUIDE.when}.

It is ${GUIDE.what}.
Not in it: ${GUIDE.order}.
How much: ${GUIDE.budget}.
${GUIDE.stance}.
Legend: ${GUIDE.legend}:

  ${GUIDE_CLASSDEFS[0]}
  ${GUIDE_CLASSDEFS[1]}

A file named as \`path\` or \`path:line\`, in backticks or in a diagram
node, becomes a jump into the review, so the map is navigation too.
If the changeset later shifts under the guide, ${GUIDE.update}.

Say each part in plain words a reader meets cold, "worth checking as you
read", "safe to skip", never a label of your own like "Hold:" that they
would have to decode.

One shape that works, not THE shape: a rename needs no diagram, a one-file
change needs no checks, and headings are optional.

  A huge tool result could overflow the model's context. This caps it at the
  model boundary and adds \`read_tool_result\` so the model can page the
  rest — nothing is stored, the text is recomputed on read.

  \`\`\`mermaid
  flowchart LR
    E[tool.execute] --> W[withToolResultCap]:::new
    W -->|over budget: slice + notice| P[provider]
    M[read_tool_result]:::new --> R[resolveFullToolResult]:::new
    R --> S[SDK steps · raw output]
    T[island-chat-transport.ts · prepareStep]:::changed --> W
    ${GUIDE_CLASSDEFS[0]}
    ${GUIDE_CLASSDEFS[1]}
  \`\`\`

  Worth checking as you read: the capper and the reader must agree, byte for
  byte, on one string: \`canonicalToolText\` is the only definition both use.
  And the reader re-runs each tool's own \`toModelOutput\`, which assumes every
  converter is pure.

  Safe to skip: four \`tool-*\` display components moved only because a prop
  went dead.`,
  pr: `diffo pr: review a GitHub pull request

Usage: diffo <PR URL | owner/repo#N | #N | N> [--no-open] [--foreground] [-p <port>]
       diffo pr <the same>                        (the explicit spelling)

Fetches the pull request's head into a worktree diffo owns
(~/.diffo/worktrees/<repo>-<hash>/pr-<N>, on branch diffo/pr-<N>) and opens the
ordinary review there: your checkout is never touched. The PR's description,
reviews and comments are imported as threads; the agent you invite is a
copilot for code it did not write. Your public comments post to GitHub as one
review when you finish; nothing leaves before that.

A pull request of your own is two reviews in one name, so \`diffo <PR>\` stops
and asks which: a branch review (\`diffo --base <base>\` on the branch — local,
nothing touches GitHub, your agent fixes what you flag) or a PR review
(\`diffo pr <PR>\` — the GitHub pull request, your comments post when you submit).

Needs the GitHub CLI signed in: gh auth login --hostname <host>. Every GitHub
call goes through your own gh; diffo holds no token.

The worktree lives as long as the review: it is removed when the review is
pruned (60 days untouched), when the PR is merged or closed and you dismiss the
offer, or by diffo clean.

Examples:
  diffo https://github.com/acme/widgets/pull/482
  diffo acme/widgets#482
  diffo 482                    (in a clone of acme/widgets)`,
  clean: `diffo clean: remove the worktrees diffo made for pull requests

Usage: diffo clean [--force] [--all]

Lists every worktree diffo owns and removes the ones whose review is over: the
pull request was merged or closed, the review was pruned, or the directory is
gone. A worktree with uncommitted changes is kept and named; --force takes it
too. --all removes every diffo worktree, review or not (their reviews go with
them on the next open).

Example:
  diffo clean`,
  poll: `diffo poll: wait for the reviewer's feedback

Usage: diffo poll [--title "<what the change is>"] [--timeout <seconds>]

Blocks (streaming whitespace heartbeats) until the reviewer acts, then prints
one JSON payload naming the review threads to act on, and exits. Run it
attended: ${POLL_STANCE}. A payload that reaches a process nobody is
listening to never reaches you.
Safe to re-run any time: feedback is held in the review itself, so
nothing is lost when a poll is killed or times out; the next poll gets it.

--title is ${TAB_TITLE.what}: ${TAB_TITLE.why}. Write it the way it is read:
${TAB_TITLE.shape} (${TAB_TITLE.examples}). Send it ${TAB_TITLE.when}; the
newest title wins, and a poll without one leaves the name it finds alone.

--timeout ends the poll after that many seconds with nothing delivered, for a
harness that caps how long a command may run: it prints
{"status":"timeout",…} and you poll again. Without it the poll waits as long
as the reviewer takes.

Output: one JSON object, e.g.
  {"status":"feedback","threadIds":["t-3"],"prompt":"…what to do…"}

Examples:
  diffo poll --title "tab titles from the agent"
  diffo poll
  diffo poll --timeout 240`,
  reply: `diffo reply: post a reply to a review thread

Usage: diffo reply <threadId> --message "<text>" [--suggest-reply "<one line>"] [--pr-comment "<text>"]
       … | diffo reply <threadId>            (long replies: pipe on stdin)

Thread ids arrive in poll payloads. Each run posts one message, so don't
re-run a reply that succeeded.
--more marks the reply as interim: you are still working, and a follow-up
reply on this thread is promised. The reviewer keeps seeing the thread as
"with the agent" until your next plain reply; going quiet instead marks it
unanswered.
--suggest-reply offers the reviewer their answer: one line that appears as
ghost text in their reply box, taken with Tab, edited or ignored at will.
Use it when your message ends in a decision that is theirs to make
("want me to extract this?" → --suggest-reply "yes, extract it"); never
on a message that only reports.
--pr-comment, on a pull request only, attaches the review comment the
reviewer would leave the author: in their voice, to the author, as GitHub
will show it — one or two short sentences, the point first (Markdown; a
\`\`\`suggestion block when the fix is local to the anchored lines). When
unsure, lean toward attaching; the reviewer would rather dismiss it than
type it. It appears under your reply with Add as PR comment draft / Edit / Dismiss;
nothing posts until the reviewer submits. Your evidence goes in --message,
never in the comment. \`diffo help agent\` says when to attach one.
Messages render GitHub-flavored markdown; a \`\`\`mermaid fence renders as a
diagram in the review.

Output: {"ok":true,"threadId":"t-3","state":"…","next_step":"…"}

Example:
  diffo reply t-3 --message "fixed: the guard now covers the empty case"`,
  comment: `diffo comment: start a comment thread as the agent

Usage: diffo comment [<file>] [--line <n>] --message "<text>" [--suggest-reply "<one line>"] [--pr-comment "<text>"]
       … | diffo comment [<file>] [--line <n>]  (long comments: pipe on stdin)

Anchors to a line (--line), a file, or, with no file, the whole changeset.
A potential issue, or context that helps the reviewer read: either way it is
one thread, labeled as yours, and it never counts as the reviewer's feedback
until they reply into it (then it is theirs to send) or resolve it.
Spend these sparingly; an agent that annotates everything gets skimmed.
--suggest-reply offers the reviewer their answer: one line that appears as
ghost text in their reply box, taken with Tab, edited or ignored at will.
Use it when the comment proposes something and the call is theirs; the
reply they take hands the thread to you like any other.
--pr-comment, on a pull request only, attaches the review comment the
reviewer would leave the author about this: same rules as on \`reply\`. For a
finding you can show (a case you ran, a call site the change misses), not
for a hunch.
Messages render GitHub-flavored markdown; a \`\`\`mermaid fence renders as a
diagram in the review.

Output: {"ok":true,"threadId":"t-1","next_step":"…"}

Examples:
  diffo comment src/auth.ts --line 42 --message "this branch is unreachable"
  diffo comment src/auth.ts --line 42 -m "I can fold these two guards into one. Want that?" --suggest-reply "yes, fold them"`,
  layers: `diffo layers: outline the changeset as steps to read in order

Usage: diffo layers --suggest ["<why, in one line>"]   at open: this read benefits from layers
       diffo layers --json '<Layer[]>'                 post the outline, replacing the last one
       … | diffo layers --stdin                        the same payload, piped

Each layer is ${LAYERS.what}.
Summary: ${LAYERS.summary}.
Diagram: ${LAYERS.diagram}:

  ${GUIDE_CLASSDEFS[0]}
  ${GUIDE_CLASSDEFS[1]}

Order: ${LAYERS.order}.
${LAYERS.mechanical}.
${LAYERS.stance}.
${LAYERS.replace}. Paths are relative to the repo root; an unknown path is
accepted (the file may land later) and simply shows nothing until it does.
Files you touch after posting land in a trailing "Since your review" layer
until you re-post.

Decisions: ${LAYERS.decisions}.

Shape: ${LAYERS.shape}

Output: {"ok":true,"layers":4,"next_step":"…"}
        {"ok":true,"suggested":true,"next_step":"…"}

Examples:
  diffo layers --suggest "the parser change explains the rest"
  diffo layers --json '[{"title":"Parser contract","summary":"The contract the rest of the change leans on: bad input now comes back as null, not an exception.","files":["src/parse.ts"],"decisions":[{"text":"Bad input returns null, not a throw","detail":"Callers already branch on null for a missing value; a throw would need a try at every site.","at":"src/parse.ts:41-46"}]},{"title":"Callers adapted","kind":"mechanical","summary":"Call sites following the new return type.","files":["src/cli.ts","src/api.ts"]}]'`,
  end: `diffo end: detach from the review politely

Usage: diffo end

Ends YOUR attachment only: if another session is the attached agent it does
nothing, and says so. Safe to re-run.

Output: {"ok":true,"next_step":"…"}

Example:
  diffo end`,
  status: `diffo status: show this repo's review server, if one is running

Usage: diffo status [--json]

Prints the changeset summary, the server (port, pid, version), and the review
URL. Exits 0 when a server is running, 1 when none is. Safe to re-run.

--json prints one JSON object instead, e.g.
  {"running":true,"port":4949,"pid":123,"version":"0.0.1","url":"http://localhost:4949"}
  {"running":false}

Example:
  diffo status --json`,
  stop: `diffo stop: stop this repo's review server

Usage: diffo stop

Asks the server to shut down cleanly (falling back to a signal if it lingers)
and clears its registration. Safe to re-run: stopping nothing is a success,
and the review itself survives; the next \`diffo\` picks it back up.

Example:
  diffo stop`,
  setup: `diffo setup: register diffo with the coding agents on this machine

Usage: diffo setup

Detects Claude Code, Cursor, VS Code, and Copilot CLI, and registers diffo
with each so they know when and how to open a review. Also installs into
~/.agents/skills, the cross-tool skills directory read by Codex, Gemini CLI,
Amp, Goose, OpenCode, and others. Safe to re-run: already-registered clients
are left as they are, and opening a review keeps installed skills fresh
automatically after upgrades.

Example:
  diffo setup`,
  telemetry: `diffo telemetry: anonymous usage data — see it, turn it off, turn it on

Usage: diffo telemetry [status|on|off]

Diffo reports two small anonymous events per review, "opened" and "finished":
its version, your OS and Node major, the kind of review (working tree, branch,
or pull request), which agent opened it, counts (threads, comments, whether
layers were used, a coarse duration), and whether it runs from a source
checkout (dev: true, so the maintainers' own use is filtered out). Never code,
paths, repository or branch names, comment text, or anything about the pull
request. One random id per machine tells returning machines from new ones;
turning reporting off deletes it. Nothing is sent until the review page has
shown you the notice once, and nothing from the review that showed it.

  status   what is on, why it is off, and where the data goes (the default)
  off      stop reporting on this machine, for good (a machine that has
           reported sends one last event saying so, then nothing)
  on       start again (a fresh id, not the old history)

DIFFO_TELEMETRY_DISABLED=1 or DO_NOT_TRACK=1 turns it off for one process or
for a fleet; CI does the same. DIFFO_TELEMETRY_DEBUG=1 writes every payload to
the server log before it is sent. The full list, and where it goes:
${'https://diffohq.github.io/diffo/telemetry'}

Example:
  diffo telemetry off`,
}

export function helpFor(topic?: string): string {
  return (topic && VERB_HELP[topic]) || HELP_TEXT
}

export type CliCommand =
  | { kind: 'help'; topic?: string }
  | { kind: 'version' }
  | {
      kind: 'run'
      spec: ChangesetSpec
      /** The positional, verbatim: a branch or a pull-request reference. The
       * CLI resolves it against the repo; `spec` is what it means when it is a
       * branch, and a placeholder until then when it may be a PR. */
      target?: string
      port: number | undefined
      open: boolean
      foreground: boolean
      /** Spelled `diffo pr <target>`: the explicit PR review, which is the
       * answer when the pull request is the user's own. A bare `diffo <PR>`
       * of their own stops and asks branch review or PR review. */
      explicitPr: boolean
    }
  | { kind: 'clean'; force: boolean; all: boolean }
  | { kind: 'poll'; title: string | null; timeoutSeconds: number | null }
  | {
      kind: 'reply'
      threadId: string
      message: string | null
      more: boolean
      suggestReply: string | null
      prComment: string | null
    }
  | {
      kind: 'comment'
      file: string | null
      line: number | null
      message: string | null
      suggestReply: string | null
      prComment: string | null
    }
  | { kind: 'layers'; source: LayersSource }
  | { kind: 'end' }
  | { kind: 'setup' }
  | { kind: 'telemetry'; action: 'status' | 'on' | 'off' }
  | { kind: 'status'; json: boolean }
  | { kind: 'stop' }
  | { kind: 'error'; message: string }

/** Where a `layers` post comes from — exactly one of the three. */
export type LayersSource =
  | { kind: 'json'; text: string }
  | { kind: 'stdin' }
  | { kind: 'suggest'; reason: string | null }

const VERBS = new Set([
  'poll',
  'reply',
  'comment',
  'layers',
  'end',
  'setup',
  'telemetry',
  'status',
  'stop',
  'clean',
  'pr',
])

function editDistance(a: string, b: string): number {
  const dp = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    let diagonal = dp[0] as number
    dp[0] = i
    for (let j = 1; j <= b.length; j++) {
      const above = dp[j] as number
      dp[j] = Math.min(
        above + 1,
        (dp[j - 1] as number) + 1,
        diagonal + (a[i - 1] === b[j - 1] ? 0 : 1),
      )
      diagonal = above
    }
  }
  return dp[b.length] as number
}

/** The closest command within two edits — one typo away, not a different word. */
function nearestVerb(input: string): string | null {
  let best: string | null = null
  let bestDistance = 3
  // `pr` is two letters: every short word is two edits from it, so it never
  // counts as a typo target — `diffo x` is a branch, not a mistyped `pr`.
  for (const verb of [...VERBS, 'help'].filter((v) => v !== 'pr')) {
    const distance = editDistance(input.toLowerCase(), verb)
    if (distance < bestDistance) {
      bestDistance = distance
      best = verb
    }
  }
  return best
}

function unknownCommand(input: string): CliCommand {
  const suggestion = nearestVerb(input)
  return {
    kind: 'error',
    message: `unknown command '${input}'${suggestion ? `. Did you mean '${suggestion}'?` : ''}`,
  }
}

function parseHelp(rest: string[]): CliCommand {
  const topic = rest[0]
  if (rest.length > 1) return { kind: 'error', message: 'help takes at most one command' }
  if (topic === undefined || topic === 'help') return { kind: 'help' }
  if (topic !== 'agent' && topic !== 'guide' && !VERBS.has(topic)) return unknownCommand(topic)
  return { kind: 'help', topic }
}

/** `parseInt` would take '80.5' and '80abc' as 80; a number is all digits or nothing. */
function parseWholeNumber(raw: string): number | null {
  return /^\d+$/.test(raw) ? Number.parseInt(raw, 10) : null
}

/**
 * Mirrors the characters git itself forbids in a ref name, plus a leading dash —
 * which would be handed to git in argument position (e.g.
 * `merge-base --upload-pack=… HEAD`). Catching these here turns a cryptic git
 * failure into a plain diffo error.
 */
function isInvalidBranchName(name: string): boolean {
  for (const ch of name) {
    const code = ch.codePointAt(0) ?? 0
    if (code < 0x20 || code === 0x7f) return true
  }
  return /[\s~^:?*[\\]|\.\.|@\{|^[-.]|[/.]$|\.lock$/.test(name)
}

/** `parseArgs` throws on an unknown flag; turn that into a `CliCommand` error. */
function tryParse<T>(run: () => T): { ok: true; value: T } | { ok: false; message: string } {
  try {
    return { ok: true, value: run() }
  } catch (err) {
    return { ok: false, message: (err as Error).message.split('.')[0] ?? 'invalid arguments' }
  }
}

/** A word that can only be a pull request, whatever verbs it resembles. */
function looksLikePr(word: string): boolean {
  return /^(https?:\/\/|#?\d+$|[\w.-]+\/[\w.-]+#\d+$)/.test(word)
}

export function parseCliArgs(argv: string[]): CliCommand {
  let target: string | undefined
  let explicitPr = false
  let rest = argv
  if (argv[0] !== undefined && !argv[0].startsWith('-')) {
    if (argv[0] === 'help') return parseHelp(argv.slice(1))
    if (argv[0] === 'pr') {
      // The explicit spelling: `diffo pr <target> …` is `diffo <target> …`.
      if (argv[1] === undefined || argv[1].startsWith('-')) {
        return argv[1] === '--help' || argv[1] === '-h'
          ? { kind: 'help', topic: 'pr' }
          : { kind: 'error', message: 'pr needs a pull request: a URL, owner/repo#N, #N, or N' }
      }
      target = argv[1]
      explicitPr = true
      rest = argv.slice(2)
    } else if (VERBS.has(argv[0])) {
      return parseVerb(argv[0], argv.slice(1))
    } else {
      // A bare word is a target — a branch, or a pull request — unless it is one
      // typo away from a command, which is what a reviewer typing fast meant.
      if (!looksLikePr(argv[0]) && nearestVerb(argv[0]) !== null) return unknownCommand(argv[0])
      target = argv[0]
      rest = argv.slice(1)
    }
  }

  const parsed = tryParse(() =>
    parseArgs({
      args: rest,
      options: {
        port: { type: 'string', short: 'p' },
        base: { type: 'string' },
        'no-open': { type: 'boolean', default: false },
        foreground: { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h' },
        version: { type: 'boolean', short: 'v' },
      },
    }),
  )
  if (!parsed.ok) return { kind: 'error', message: parsed.message }
  const { values } = parsed.value

  if (values.help) return { kind: 'help' }
  if (values.version) return { kind: 'version' }

  let port: number | undefined
  if (values.port !== undefined) {
    const parsedPort = parseWholeNumber(values.port)
    if (parsedPort === null || parsedPort < 1 || parsedPort > 65535) {
      return { kind: 'error', message: `'${values.port}' is not a valid port` }
    }
    port = parsedPort
  }

  if (values.base !== undefined && values.base.trim() === '') {
    return { kind: 'error', message: '--base needs a branch name' }
  }
  if (values.base !== undefined && isInvalidBranchName(values.base)) {
    return { kind: 'error', message: `'${values.base}' is not a valid branch name` }
  }

  if (target !== undefined) {
    if (target.trim() === '') return { kind: 'error', message: 'the target is empty' }
    if (!looksLikePr(target) && isInvalidBranchName(target)) {
      return { kind: 'error', message: `'${target}' is not a valid branch name` }
    }
    if (values.base !== undefined && !looksLikePr(target)) {
      return { kind: 'error', message: 'pass the branch once, as the target or with --base' }
    }
  }

  const spec: ChangesetSpec = values.base
    ? { kind: 'branch', base: values.base }
    : target !== undefined && !looksLikePr(target)
      ? { kind: 'branch', base: target }
      : { kind: 'working-tree' }
  return {
    kind: 'run',
    spec,
    ...(target !== undefined ? { target } : {}),
    port,
    open: !values['no-open'],
    foreground: values.foreground === true,
    explicitPr,
  }
}

/**
 * `layers` parses on its own: its `--json` takes a value where `status --json`
 * is a switch, and its one positional is the suggestion's reason rather than a
 * file. Exactly one source per run — a post and a suggestion mean different
 * things to the review, and silently picking one would hide the other.
 */
function parseLayersVerb(rest: string[]): CliCommand {
  const parsed = tryParse(() =>
    parseArgs({
      args: rest,
      allowPositionals: true,
      options: {
        json: { type: 'string' },
        stdin: { type: 'boolean' },
        suggest: { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
      },
    }),
  )
  if (!parsed.ok) return { kind: 'error', message: parsed.message }
  const { values, positionals } = parsed.value
  if (values.help) return { kind: 'help', topic: 'layers' }
  const sources = [values.json !== undefined, values.stdin === true, values.suggest === true]
  if (sources.filter(Boolean).length !== 1) {
    return {
      kind: 'error',
      message: 'layers takes exactly one of --json <Layer[]>, --stdin, or --suggest ["<why>"]',
    }
  }
  if (values.suggest) {
    if (positionals.length > 1) {
      return { kind: 'error', message: '--suggest takes at most one reason; quote it' }
    }
    return {
      kind: 'layers',
      source: { kind: 'suggest', reason: parseSuggestReason(positionals[0]) ?? null },
    }
  }
  if (positionals.length > 0) {
    return {
      kind: 'error',
      message: 'pass the layers with --json or on stdin (--stdin), not as an argument',
    }
  }
  if (values.stdin) return { kind: 'layers', source: { kind: 'stdin' } }
  if (values.json!.trim() === '') {
    return {
      kind: 'error',
      message: '--json needs a JSON array of layers; see `diffo help layers`',
    }
  }
  return { kind: 'layers', source: { kind: 'json', text: values.json! } }
}

function parseCleanVerb(rest: string[]): CliCommand {
  const parsed = tryParse(() =>
    parseArgs({
      args: rest,
      options: {
        force: { type: 'boolean' },
        all: { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
      },
    }),
  )
  if (!parsed.ok) return { kind: 'error', message: parsed.message }
  if (parsed.value.values.help) return { kind: 'help', topic: 'clean' }
  return {
    kind: 'clean',
    force: parsed.value.values.force === true,
    all: parsed.value.values.all === true,
  }
}

function parseTelemetryVerb(rest: string[]): CliCommand {
  const parsed = tryParse(() =>
    parseArgs({
      args: rest,
      allowPositionals: true,
      options: { help: { type: 'boolean', short: 'h' } },
    }),
  )
  if (!parsed.ok) return { kind: 'error', message: parsed.message }
  const { values, positionals } = parsed.value
  if (values.help) return { kind: 'help', topic: 'telemetry' }
  const action = positionals[0] ?? 'status'
  if (positionals.length > 1 || (action !== 'status' && action !== 'on' && action !== 'off')) {
    return { kind: 'error', message: 'telemetry takes one of: status, on, off' }
  }
  return { kind: 'telemetry', action }
}

function parseVerb(verb: string, rest: string[]): CliCommand {
  if (verb === 'layers') return parseLayersVerb(rest)
  if (verb === 'clean') return parseCleanVerb(rest)
  if (verb === 'telemetry') return parseTelemetryVerb(rest)
  const parsed = tryParse(() =>
    parseArgs({
      args: rest,
      allowPositionals: true,
      options: {
        message: { type: 'string', short: 'm' },
        line: { type: 'string' },
        title: { type: 'string' },
        timeout: { type: 'string' },
        more: { type: 'boolean' },
        'suggest-reply': { type: 'string' },
        'pr-comment': { type: 'string' },
        json: { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
      },
    }),
  )
  if (!parsed.ok) return { kind: 'error', message: parsed.message }
  const { values, positionals } = parsed.value
  const suggestReply = values['suggest-reply']
  const prComment = values['pr-comment']

  // A help request is never an error, whatever else is on the line.
  if (values.help) return { kind: 'help', topic: verb }

  if (values.json && verb !== 'status') {
    return { kind: 'error', message: `'${verb}' takes no --json` }
  }

  if (values.more && verb !== 'reply') {
    return { kind: 'error', message: `'${verb}' takes no --more` }
  }

  if (suggestReply !== undefined) {
    if (verb !== 'reply' && verb !== 'comment') {
      return { kind: 'error', message: `'${verb}' takes no --suggest-reply` }
    }
    if (!suggestReply.trim()) {
      return { kind: 'error', message: '--suggest-reply needs the reply you are offering' }
    }
    if (suggestReply.includes('\n')) {
      return { kind: 'error', message: '--suggest-reply is one line — the reviewer completes it' }
    }
  }

  if (prComment !== undefined) {
    if (verb !== 'reply' && verb !== 'comment') {
      return { kind: 'error', message: `'${verb}' takes no --pr-comment` }
    }
    if (!prComment.trim()) {
      return { kind: 'error', message: '--pr-comment needs the review comment you are suggesting' }
    }
  }

  if (values.title !== undefined && verb !== 'poll') {
    return { kind: 'error', message: `'${verb}' takes no --title` }
  }

  if (values.timeout !== undefined && verb !== 'poll') {
    return { kind: 'error', message: `'${verb}' takes no --timeout` }
  }

  if (
    verb === 'poll' ||
    verb === 'end' ||
    verb === 'setup' ||
    verb === 'status' ||
    verb === 'stop'
  ) {
    if (positionals.length > 0) {
      return { kind: 'error', message: `'${verb}' takes no arguments` }
    }
    if (values.message !== undefined || values.line !== undefined) {
      return { kind: 'error', message: `'${verb}' takes no options` }
    }
    if (verb === 'status') return { kind: 'status', json: values.json === true }
    if (verb === 'poll') {
      // An empty --title would silently poll title-less; say so instead.
      const title = normalizeTitle(values.title)
      if (values.title !== undefined && title === null) {
        return { kind: 'error', message: '--title needs a few words naming the change' }
      }
      const timeoutSeconds = values.timeout === undefined ? null : Number(values.timeout)
      if (timeoutSeconds !== null && (!/^\d+$/.test(values.timeout ?? '') || timeoutSeconds <= 0)) {
        return { kind: 'error', message: '--timeout needs a whole number of seconds above 0' }
      }
      return { kind: 'poll', title, timeoutSeconds }
    }
    return { kind: verb }
  }

  if (verb === 'reply') {
    const threadId = positionals[0]
    if (!threadId) return { kind: 'error', message: 'reply needs a thread id' }
    if (positionals.length > 1) {
      return {
        kind: 'error',
        message: 'pass the reply with --message or on stdin, not as an argument',
      }
    }
    if (values.line !== undefined) {
      return { kind: 'error', message: 'reply takes no --line' }
    }
    return {
      kind: 'reply',
      threadId,
      message: values.message ?? null,
      more: values.more === true,
      suggestReply: suggestReply?.trim() ?? null,
      prComment: prComment?.trim() ?? null,
    }
  }

  const file = positionals[0] ?? null
  if (positionals.length > 1) {
    return {
      kind: 'error',
      message: 'pass the comment with --message or on stdin, not as an argument',
    }
  }
  let line: number | null = null
  if (values.line !== undefined) {
    line = parseWholeNumber(values.line)
    if (line === null || line < 1) {
      return { kind: 'error', message: `'${values.line}' is not a valid line number` }
    }
  }
  if (line !== null && file === null) {
    return { kind: 'error', message: 'a --line needs a file to anchor to' }
  }
  return {
    kind: 'comment',
    file,
    line,
    message: values.message ?? null,
    suggestReply: suggestReply?.trim() ?? null,
    prComment: prComment?.trim() ?? null,
  }
}
