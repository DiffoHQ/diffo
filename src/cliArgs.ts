import { parseArgs } from 'node:util'
import { GUIDE, POLL_STANCE } from './server/prompt.js'
import type { ChangesetSpec } from './shared/types.js'

export const HELP_TEXT = `diffo — review a changeset the way you'd read a book

Usage: diffo [options]          open (or resume) the review for this repo
       diffo <command> [...]    manage the server, or talk to the review
       diffo help [command]     show help for a command

For the reviewer:
  status             Show this repo's review server, if one is running
                     (--json for a machine-readable answer)
  stop               Stop this repo's review server
  setup              Register diffo with the coding agents on this machine
                     (Claude Code, Cursor, VS Code, Copilot, and the shared
                     ~/.agents skills dir read by Codex, Gemini, Amp, Goose, …)

For the agent (the AI that wrote the change):
  poll               Wait for the reviewer's feedback (blocking long-poll;
                     prints one JSON payload; safe to re-run any time)
  reply <threadId>   Post a reply to a review thread
                     (--message "<text>", or pipe the text on stdin)
  comment [<file>]   Start a comment thread as the agent — on a line (--line),
                     a file, or (with no file) the whole changeset; the
                     reviewer replies to take it up, or resolves it
  end                Detach from the review politely
  help agent         The agent's whole protocol on one page

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
  diffo --base main            review everything since forking from main
  diffo status                 is a server running here, and where?
  diffo reply t-3 -m "fixed"   answer a review thread (agent side)

Feedback lives in the review, not in any process: diffo, poll, status, stop,
and setup are all safe to re-run after an interruption.`

const VERB_HELP: Record<string, string> = {
  agent: `diffo help agent — the agent's whole protocol on one page

You are the agent that wrote the change; a human reads it live in their
browser. Diffo carries their feedback to you and your replies back inline.
Poll payloads carry their own instructions — this page is the map that
survives when context does not.

The loop:

1. Open: run \`diffo --no-open\` from inside the repo. It returns straight
   away, leaving a background server watching the working tree. Never open a
   browser at the reviewer — end your message with the printed URL instead,
   and keep ending every message with it while you stay attached.
2. Guide (only when the changeset needs it — ${GUIDE.when}): before sharing
   the URL, post ONE comment on the whole changeset (\`diffo comment -m "…"\`,
   no file): ${GUIDE.what}.
   ${GUIDE.stance}. If the changeset later shifts under the guide,
   ${GUIDE.update}.
3. Listen: run \`diffo poll\` — it blocks until the reviewer acts, then prints
   one JSON payload naming the threads to act on. Run it attended:
   ${POLL_STANCE}.
   Killed or timed out? Re-run it; feedback is held in the review, not the
   poll.
4. Act: \`[issue]\` threads want a code change; \`[question]\` threads want an
   answer in the reply and no edit. Your edits reach the reviewer live.
5. Reply: \`diffo reply <threadId> --message "<text>"\` (pipe long replies on
   stdin) — concise, addressed to the reviewer. Markdown renders; a
   \`\`\`mermaid fence draws a diagram.
6. Comment (sparingly): \`diffo comment [<file>] [--line <n>] -m "<text>"\`
   starts a thread in your voice — a concern, or context that helps the read.
7. Poll again only when the whole batch is handled — a new poll tells the
   reviewer you are done with the previous one.
8. Detach: run \`diffo end\` when the review is over or the user moves on.

Rules:
- Change only what the threads ask about — the reviewer is mid-read, and an
  unrelated edit moves the diff under them.
- One attached agent at a time: the newest poll carries the review; don't
  re-poll to take it back from another session — tell the user instead.
- Resolving a thread is the reviewer's call, never yours.`,
  poll: `diffo poll — wait for the reviewer's feedback

Usage: diffo poll

Blocks (streaming whitespace heartbeats) until the reviewer acts, then prints
one JSON payload naming the review threads to act on, and exits. Run it
attended — a tracked background task or the foreground, never detached: a
payload that reaches a process nobody is listening to never reaches you.
Safe to re-run any time: feedback is held in the review itself, so
nothing is lost when a poll is killed or times out — the next poll gets it.

Output: one JSON object, e.g.
  {"status":"feedback","threadIds":["t-3"],"prompt":"…what to do…"}

Example:
  diffo poll`,
  reply: `diffo reply — post a reply to a review thread

Usage: diffo reply <threadId> --message "<text>"
       … | diffo reply <threadId>            (long replies: pipe on stdin)

Thread ids arrive in poll payloads. Each run posts one message, so don't
re-run a reply that succeeded.
Messages render GitHub-flavored markdown; a \`\`\`mermaid fence renders as a
diagram in the review.

Output: {"ok":true,"threadId":"t-3","state":"…","next_step":"…"}

Example:
  diffo reply t-3 --message "fixed — the guard now covers the empty case"`,
  comment: `diffo comment — start a comment thread as the agent

Usage: diffo comment [<file>] [--line <n>] --message "<text>"
       … | diffo comment [<file>] [--line <n>]  (long comments: pipe on stdin)

Anchors to a line (--line), a file, or — with no file — the whole changeset.
A potential issue, or context that helps the reviewer read: either way it is
one thread, labeled as yours, and it never counts as the reviewer's feedback
until they reply into it — then it is theirs to send — or they resolve it.
Spend these sparingly — an agent that annotates everything gets skimmed.
Messages render GitHub-flavored markdown; a \`\`\`mermaid fence renders as a
diagram in the review.

Output: {"ok":true,"threadId":"t-1","next_step":"…"}

Example:
  diffo comment src/auth.ts --line 42 --message "this branch is unreachable"`,
  end: `diffo end — detach from the review politely

Usage: diffo end

Ends YOUR attachment only: if another session is the attached agent it does
nothing, and says so. Safe to re-run.

Output: {"ok":true,"next_step":"…"}

Example:
  diffo end`,
  status: `diffo status — show this repo's review server, if one is running

Usage: diffo status [--json]

Prints the changeset summary, the server (port, pid, version), and the review
URL. Exits 0 when a server is running, 1 when none is. Safe to re-run.

--json prints one JSON object instead, e.g.
  {"running":true,"port":4949,"pid":123,"version":"0.0.1","url":"http://localhost:4949"}
  {"running":false}

Example:
  diffo status --json`,
  stop: `diffo stop — stop this repo's review server

Usage: diffo stop

Asks the server to shut down cleanly (falling back to a signal if it lingers)
and clears its registration. Safe to re-run: stopping nothing is a success,
and the review itself survives — the next \`diffo\` picks it back up.

Example:
  diffo stop`,
  setup: `diffo setup — register diffo with the coding agents on this machine

Usage: diffo setup

Detects Claude Code, Cursor, VS Code, and Copilot CLI, and registers diffo
with each so they know when and how to open a review. Also installs into
~/.agents/skills — the cross-tool skills directory read by Codex, Gemini CLI,
Amp, Goose, OpenCode, and others. Safe to re-run: already-registered clients
are left as they are, and opening a review keeps installed skills fresh
automatically after upgrades.

Example:
  diffo setup`,
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
      port: number | undefined
      open: boolean
      foreground: boolean
    }
  | { kind: 'poll' }
  | { kind: 'reply'; threadId: string; message: string | null }
  | { kind: 'comment'; file: string | null; line: number | null; message: string | null }
  | { kind: 'end' }
  | { kind: 'setup' }
  | { kind: 'status'; json: boolean }
  | { kind: 'stop' }
  | { kind: 'error'; message: string }

const VERBS = new Set(['poll', 'reply', 'comment', 'end', 'setup', 'status', 'stop'])

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
  for (const verb of [...VERBS, 'help']) {
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
    message: `unknown command '${input}'${suggestion ? ` — did you mean '${suggestion}'?` : ''}`,
  }
}

function parseHelp(rest: string[]): CliCommand {
  const topic = rest[0]
  if (rest.length > 1) return { kind: 'error', message: 'help takes at most one command' }
  if (topic === undefined || topic === 'help') return { kind: 'help' }
  if (topic !== 'agent' && !VERBS.has(topic)) return unknownCommand(topic)
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

export function parseCliArgs(argv: string[]): CliCommand {
  if (argv[0] !== undefined && !argv[0].startsWith('-')) {
    if (argv[0] === 'help') return parseHelp(argv.slice(1))
    if (VERBS.has(argv[0])) return parseVerb(argv[0], argv.slice(1))
    return unknownCommand(argv[0])
  }

  const parsed = tryParse(() =>
    parseArgs({
      args: argv,
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

  const spec: ChangesetSpec = values.base
    ? { kind: 'branch', base: values.base }
    : { kind: 'working-tree' }
  return {
    kind: 'run',
    spec,
    port,
    open: !values['no-open'],
    foreground: values.foreground === true,
  }
}

function parseVerb(verb: string, rest: string[]): CliCommand {
  const parsed = tryParse(() =>
    parseArgs({
      args: rest,
      allowPositionals: true,
      options: {
        message: { type: 'string', short: 'm' },
        line: { type: 'string' },
        json: { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
      },
    }),
  )
  if (!parsed.ok) return { kind: 'error', message: parsed.message }
  const { values, positionals } = parsed.value

  // A help request is never an error, whatever else is on the line.
  if (values.help) return { kind: 'help', topic: verb }

  if (values.json && verb !== 'status') {
    return { kind: 'error', message: `'${verb}' takes no --json` }
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
    return { kind: 'reply', threadId, message: values.message ?? null }
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
  return { kind: 'comment', file, line, message: values.message ?? null }
}
