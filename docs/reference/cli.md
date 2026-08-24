# CLI reference

One `diffo` binary serves both sides of the review: you open reviews with it,
and the agent that wrote the code drives the feedback loop through it. The
[Agent Skill](https://github.com/DiffoHQ/diffo/blob/main/skills/diffo/SKILL.md)
teaches your agent everything on this page.

```bash
diffo [options]           # open (or resume) the review for this repo
diffo <command> [...]     # manage the server, or talk to the review
diffo help [command]      # help for one command
```

Nothing needs installing: `npx -y @diffohq/diffo` resolves a fresh CLI on every run. The
examples below write `diffo` for brevity.

Every command runs from inside a git repository and is safe to re-run. Feedback
lives in the review, not in any process, so an interrupted command loses
nothing.

## Commands at a glance

| Command | Side | What it does |
| --- | --- | --- |
| `diffo` | reviewer | Open (or resume) the review for this repo |
| [`diffo status`](#diffo-status) | reviewer | Is a server watching this repo, and where |
| [`diffo stop`](#diffo-stop) | reviewer | Stop this repo's server |
| [`diffo setup`](#diffo-setup) | reviewer | Register Diffo with the coding agents on this machine |
| [`diffo poll`](#diffo-poll) | agent | Wait for the reviewer's feedback |
| [`diffo reply`](#diffo-reply-threadid) | agent | Reply to a thread |
| [`diffo comment`](#diffo-comment-file) | agent | Start a thread in the agent's own voice |
| [`diffo end`](#diffo-end) | agent | Detach from the review |
| [`diffo help`](#help-and-version) | both | Help for the CLI, or for one command |

## Opening a review

```bash
diffo                     # the working tree vs HEAD
diffo --base main         # everything since forking from main
diffo --no-open -p 4949   # a fixed port, no browser
```

| Option | What it does |
| --- | --- |
| `--base <branch>` | Review everything since forking from `<branch>` (`merge-base`). Default: the working tree vs `HEAD` |
| `-p`, `--port <port>` | Port to serve on. Default: the port this repo last used, else the first free one |
| `--no-open` | Don't open the browser. What an agent should always pass |
| `--foreground` | Keep the server in this terminal (Ctrl-C stops it) instead of leaving a background one behind |

The command prints the changeset summary and the review URL, then returns
immediately, leaving a **background server** that keeps watching after the
terminal (or the agent session) that opened it is gone. Run it twice in the same
repo and the second run points you at the existing review rather than starting a
second one.

A background server self-stops after **30 minutes** in which no browser tab and
no agent poll used it. See [`DIFFO_IDLE_TIMEOUT_MS`](#environment-variables) to
change or disable that. `--foreground` never self-stops.

Untracked files are included, so brand-new agent output shows up as an addition
rather than not at all.

## Reviewer commands

### `diffo status`

```bash
diffo status
diffo status --json
```

Prints the changeset summary, the server behind it (port, pid, version), and the
review URL. `--json` prints one object instead, either the server behind the
review:

```json
{ "running": true, "port": 4949, "pid": 51234, "version": "0.0.1", "url": "http://localhost:4949" }
```

or, when nothing is watching this repo:

```json
{ "running": false }
```

Exits **0** when a server is watching this repo and **1** when none is, so it
works as a shell condition.

### `diffo stop`

Asks this repo's server to shut down cleanly, falls back to a signal if it
lingers, and clears its registration. Stopping nothing is still a success.

The review itself survives: threads live in SQLite, and the next `diffo` picks
them back up.

### `diffo setup`

Registers Diffo with the coding agents on this machine, and installs the Agent
Skill that teaches them when to open a review and how to behave inside one. It
never touches an agent that isn't installed, never overwrites anything that
isn't Diffo's, and is safe to re-run.

One row per client, each with a status:

| Status | Meaning |
| --- | --- |
| `registered` | Wired up. Restart or reload that client so it discovers Diffo |
| `manual` | One step needs your hands; the row says which. Re-run `diffo setup` afterwards |
| `absent` | That client isn't installed here |
| `failed` | Something went wrong; the row says what |

Exits **1** if any row failed, otherwise **0**.

Which clients, and how each is wired, is in
[Getting started](/guide/getting-started#one-setup-every-agent), along with the
manual equivalent of every row if you'd rather do it by hand.

You don't need to re-run `setup` after an upgrade: opening a review refreshes
the skill copies it installed.

## Agent commands

These are the whole agent protocol. Any agent that can run a shell command can
drive the loop; [the agent protocol](/agents) is the full reference behind it.

All four talk to this repo's server, starting one if none is running.

### `diffo poll`

```bash
diffo poll
```

Blocks until the reviewer acts, then prints **one JSON payload** naming the
threads to act on, and exits 0. Whitespace heartbeats every **15 seconds** keep
the connection alive; a single poll is capped at **30 minutes**.

```json
{ "status": "feedback", "kind": "threads", "threadIds": ["t-3"], "prompt": "…", "next_step": "…" }
```

`status` is one of `feedback` (the only one that carries work), `timeout`,
`superseded` (another session took the review), or `ended`.

Run it attended, in the foreground or as a tracked background task, never
detached: a payload delivered to a process nobody is reading never reaches the
agent. Safe to re-run any time; delivery is at-least-once, so a poll that dies
mid-write re-delivers instead of dropping feedback.

### `diffo reply <threadId>`

```bash
diffo reply t-3 --message "Fixed: the guard now covers the empty case."
echo "$long_reply" | diffo reply t-3
```

Posts one message into a thread, rendered as GitHub-flavored Markdown in the
reviewer's UI (a ```` ```mermaid ```` fence draws a diagram). Thread ids come
from poll payloads.

| Option | What it does |
| --- | --- |
| `-m`, `--message <text>` | The reply. Omit it to read the message from stdin |

Prints `{ "ok": true, "threadId": "t-3", "state": "…", "next_step": "…" }`. An
unknown thread id fails with exit 1. Each run posts a message, so don't re-run a
reply that succeeded.

### `diffo comment [<file>]`

```bash
diffo comment src/server/db.ts --line 88 --message "This lock ordering looks wrong to me."
diffo comment --message "Worth a second pair of eyes on the whole migration."
```

Opens a thread **as the agent**, anchored to a line, a file, or, with no file, to
the whole changeset. For something the agent noticed in its own work, or context
that helps the read.

| Option | What it does |
| --- | --- |
| `-m`, `--message <text>` | The comment. Omit it to read the text from stdin |
| `--line <n>` | Anchor to a line. Needs a file argument |

Prints `{ "ok": true, "threadId": "t-1", "next_step": "…" }`.

An agent-started thread is inert until a human replies into it: it doesn't count
toward the reviewer's outstanding feedback and isn't flushed by Finish review.

### `diffo end`

Detaches the calling session politely. If another session is the attached agent,
nothing is touched and the output says so:
`{ "ok": false, "reason": "not-owner", "ownerPid": 51234 }`. Safe to re-run.

## Help and version

| Command | What it does |
| --- | --- |
| `diffo --help`, `-h` | The full usage page |
| `diffo help <command>` | Help for one command, including its output shape |
| `diffo help agent` | The agent's whole protocol on one page |
| `diffo --version`, `-v` | Print the version |

`-h` works after a command too: `diffo comment -h` is the same as
`diffo help comment`.

An unrecognised command is an error with a suggestion (`diffo repyl` offers
`reply`), not a silent no-op.

## Environment variables

| Variable | Effect |
| --- | --- |
| `DIFFO_DB` | Path to the state file. Default `~/.diffo/diffo.db` |
| `DIFFO_IDLE_TIMEOUT_MS` | Idle budget before a background server self-stops. `0` or `off` disables it. Default: 30 minutes for a background server, off in the foreground |
| `DIFFO_SERVER_LOG` | Where a background server writes its log. Default `~/.diffo/logs/<repo>-<hash>.log` |
| `DIFFO_DAEMON` | Internal. Set by the CLI on the server it spawns; don't set it yourself |

## Exit codes

| Code | When |
| --- | --- |
| `0` | Success |
| `1` | Any failure: not a git repo, a bad flag, no server for `status`, an unknown thread id for `reply`, a failed row in `setup` |

Errors go to stderr as `diffo: <what went wrong>`. Machine-readable output
(`--json`, and every agent command) goes to stdout on its own, so it stays
pipeable into `jq`.

## See also

- [The agent protocol](/agents): the poll payloads, the intent contract, presence,
  and who owns a review
- [Keyboard shortcuts](/reference/keyboard-shortcuts): the review UI itself
- [Getting started](/guide/getting-started): install, and one setup per agent
