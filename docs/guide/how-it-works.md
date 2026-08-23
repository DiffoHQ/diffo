# How it works

<!-- Root-absolute, because `docs/public/` is served from the site root. Reaching these
     as `../public/…` also builds, but Vite then emits a second, hashed copy of each SVG
     alongside the one public/ already publishes. -->
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="/how-it-works-dark.svg">
  <img alt="Diffo's architecture, animated: your agent writes the code and opens the review; a local Diffo server watches the changeset and serves the review to your browser; your comments and Finish review return to the agent through diffo poll, and its answers and fixes land back in the review live." src="/how-it-works-light.svg" width="100%">
</picture>

One npm package, one process per repo, no services. The CLI, the server, and the
review UI all ship together and all run on your machine: no accounts, no cloud, no
telemetry, and no model API. Diffo holds no keys because it calls no models.

## One process, four parts

All in [the repo](https://github.com/DiffoHQ/diffo):

| Part | What it is |
| --- | --- |
| **[The CLI](https://github.com/DiffoHQ/diffo/blob/main/src/cli.ts)** | One `diffo` binary for both sides: you open reviews with it, the agent drives `poll` / `reply` / `comment` through it |
| **[The server](https://github.com/DiffoHQ/diffo/tree/main/src/server)** | A local server per repo. Reads git directly, keeps threads in SQLite, streams live updates to the browser, and holds the agent's long poll |
| **[The UI](https://github.com/DiffoHQ/diffo/tree/main/src/ui)** | The review you read in the browser. React, served as static files by the same process |
| **[The skill](https://github.com/DiffoHQ/diffo/blob/main/src/skill.ts)** | Compiled to [skills/diffo/SKILL.md](https://github.com/DiffoHQ/diffo/blob/main/skills/diffo/SKILL.md) and installed by [`diffo setup`](/reference/cli#diffo-setup); teaches any coding agent when to open a review and how to behave inside one |

One more directory isn't a part so much as a contract: `src/shared` holds the wire
model both sides import, so the diff the server builds and the diff the browser
renders are the same type, not two hopeful guesses about each other.

## What happens when you run `diffo`

1. **It finds the repo.** The git root of your working directory is the identity of
   everything below: the review, the server claim, the port.
2. **It looks for a server already watching that repo,** registered in
   `~/.diffo/diffo.db`, and health-checks it. Three outcomes: **reuse** it (same
   build, same repo), **replace** it (a different build: retire it politely, then
   take over), or start **fresh**. Only one server per repo ever wins, because the
   claim is an atomic insert into SQLite rather than a check-then-write.
3. **It builds the changeset.** Git plumbing produces a unified patch; the parser
   turns it into files and hunks, each hunk carrying a content-addressed id:
   `hash(path + changed lines + occurrence)`, never line numbers.
4. **It serves the review on loopback** and prints the URL, then returns
   immediately, leaving the server running in the background.

The port is the one this repo used last, so the browser tab you left open keeps
working; failing that, the first free one.

## The changeset is the unit of review

Not a pull request. Whatever the agent actually produced:

- **the working tree vs `HEAD`**: the default, and the case that matters most,
  because it's where agent output lives before anyone has decided it's good
- **a branch or commit range**: `--base main` reviews everything since the fork
  point
- **pull requests**: on the roadmap, not here yet

Untracked files are included, so brand-new agent output shows up as an addition
rather than not at all. Staged and unstaged changes are both in, and which is which
is part of the changeset's identity. That distinction is invisible in
`git diff HEAD`, but it changes what the review means.

## Staying live while the agent works

The server keeps one recursive filesystem watch over the repo: one descriptor
however big the repo is, rather than a per-directory walk that runs out of them on a
monorepo. Writes to the working tree and to git's own state files (`HEAD`, `index`,
`packed-refs`) both count, so commits, staging, and branch switches all register.

Events are debounced into one recompute per burst. The recompute hashes the raw
diff, and only a hash that moved bumps the changeset `version`. What goes down the
stream to your browser is that version number, **not** the diff, and the browser
refetches. Cheap to send, impossible to get out of order.

Three things fall out of hunk ids being content-addressed rather than positional:

- A hunk you marked read keeps its mark through a refresh that didn't touch it.
- A hunk that *was* edited mints a new id, loses its mark, and says *changed since
  you read it*.
- Threads stay anchored to the code they were about, not to a line number that
  moved.

Two more things the server tracks while you read: a **checkout** under a running
server swaps to that branch's review, so today's hunks never meet yesterday's
comments; and when your changeset is **committed**, the review notices that the diff
emptied because `HEAD` moved past it, and offers you a fresh start. A stash empties
the diff without moving `HEAD`, so it isn't mistaken for landing.

## Two channels out, both local

| Channel | Carries |
| --- | --- |
| **REST + SSE → your browser** | The changeset and the review over `GET`, plus one event stream for `changeset` / `review` / `presence` |
| **Long poll → the agent** | `diffo poll` holds a connection open, whitespace heartbeats every 15s, capped at 30 minutes per poll |

The agent channel is the interesting one, because it has to survive processes dying.
Feedback is held in the review, not in the poll: a payload isn't marked delivered
until the write succeeds, so a poll killed mid-delivery re-delivers rather than
losing your comment. The newest poll owns the review; a displaced session is told to
stand down, and nothing queued is lost in the handover.

Diffo spawns no agents of its own. The one you're already talking to attaches
through that poll, which is why your feedback lands in the session that holds the
context.

## What's stored, and where

| Where | What |
| --- | --- |
| `~/.diffo/diffo.db`, SQLite (WAL), mode `0600` | Review threads, keyed by repo path + branch + base, pruned after 60 days untouched · which server holds which repo · each repo's preferred port |
| Your browser's `localStorage` | Which hunks you've read, keyed by worktree path and changeset spec |
| Nowhere | Your code. Diffo reads git on demand and stores no copy of your files |

The agent delivery queue is deliberately *not* persisted. On startup it's rebuilt
from the threads themselves (handed over, not already answered, reviewer spoke
last), so a restart can't drop feedback nobody collected.

## Loopback isn't enough on its own

The server binds loopback, but a page on `evil.com` whose DNS is rebound to
`127.0.0.1` still reaches it. So one middleware runs before everything: the `Host`
must be loopback, and any `Origin` present must be loopback too. A missing `Host`
isn't a free pass, because HTTP/1.1 requires one: its absence means a hand-rolled
request. Static file serving separately refuses any path that escapes the client
directory, and agent replies (Markdown, from a process outside the app) go through
DOMPurify before they reach the DOM.

## The server lifecycle

The server runs in the background by default and keeps watching after the command
exits, so a review survives the terminal (or the agent session) that opened it.

It stops itself after 30 minutes in which nothing used it, where "used" counts an
open browser tab and a listening agent poll as activity, not just requests. A
delivered-but-unanswered batch deliberately does *not* hold it alive: that feedback
is durable and gets re-delivered to the next poll.

`diffo --foreground` keeps the server in your terminal instead, and never
self-stops. `diffo status` says whether one is running and where; `diffo stop` ends
it.

## Deeper

- [Architecture](/architecture): the diff pipeline, hunk identity, the delivery
  queue, and the review state machine
- [The agent protocol](/agents): the poll payloads, the intent contract, and presence
- [CLI reference](/reference/cli): every command, flag, and environment variable
