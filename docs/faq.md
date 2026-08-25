# FAQ

### Does any of my code leave my machine?

No. Diffo makes zero network calls. One process on your machine, bound to loopback, state
in a single SQLite file at `~/.diffo/diffo.db`. No account, no telemetry, no model API: it
holds no keys because it calls no models.

### Is this an AI code reviewer?

No, and deliberately not. Diffo doesn't grade your diff or leave generated nitpicks. It's
a reading tool for the human, on the bet that your judgement is the scarce resource and
the machine's is not.

### Why not just use a pull request?

You still can, and probably should. A pull request is how you hand finished work to
someone else, with the queue, the notification, and the record that implies. Diffo is what
happens before that: the loop where you and the agent that wrote the code turn a first
draft into something worth handing over. Nothing needs to be committed, pushed, or opened
first, and the PR is still there to open when you're done.

### Can I review a pull request with it?

Not yet, but it's planned — the [Status section](https://github.com/DiffoHQ/diffo#status)
tracks what works today. For now the changeset is your working tree (the default) or
everything since a fork point (`--base main`).

### Why Node 24?

The server keeps its state in the runtime's built-in `node:sqlite`, which lands in 24. That
buys you no native module to compile, no `better-sqlite3` install step, and no database to
run. It's the reason `npx -y @diffohq/diffo` can be the entire setup.

### Does it work with agents other than Claude Code?

Yes. The interface is a CLI and a generated Agent Skill, not an integration with any one
vendor. `diffo setup` knows about Claude Code, Cursor, VS Code and Copilot CLI, and writes a shared
copy into the `~/.agents/skills` directory that Codex, Gemini CLI, Amp, Goose and OpenCode
read. Any agent that can run a shell command can drive the loop: `diffo poll`,
`diffo reply`, `diffo comment`, `diffo end`. That's the whole protocol.

### I closed my terminal. Is the review gone?

No. `diffo` leaves a background server by default, precisely so the review outlives the
terminal (or the agent session) that opened it. It self-stops after 30 minutes with
nothing using it. Want it tied to your terminal instead? `--foreground`.

### I sent a comment but no agent was attached. Did I lose it?

No. It queues, and the presence indicator says **waiting** so you know at the time. The
next `diffo poll`, from any session, picks it up. The same holds if a poll dies
mid-delivery: feedback lives in the review, not in the poll, and delivery is at-least-once.

### Can two agent sessions attach at once?

One session owns a review at a time, and the **newest poll wins**. The new one is told it
took over (and told to mention that to you); the displaced one is told to stand down.
Nothing queued is lost in the handover. Details in [agents.md](agents.md#one-session-owns-a-review).

### I switched branches while it was running. What happened to my comments?

They stayed with their branch. Reviews are scoped per repo *and* branch, so a checkout
under a running server swaps to that branch's review rather than dropping yesterday's
comments onto today's hunks. Switch back and they're where you left them.

### Can I run it on several repos at once?

Yes: one server per repo, each on its own port, all coordinating through the same SQLite
file. Run `diffo` in a second repo and you get a second review. Running it twice in the
*same* repo just points you at the existing one.

### Why did my "viewed" mark disappear?

Because that code changed after you read it. Read marks are keyed to a content-addressed
hunk id, so editing a hunk mints a new id, the mark comes off, and the hunk says
*changed since you read it*. That's the feature: you can't accidentally sign off on code
you never saw.

### Does it need a clean working tree, or a commit?

Neither. Uncommitted work is the default case, and untracked files are included: new agent
output shows up as an addition rather than not at all.

### How do I get rid of it?

`rm -rf ~/.diffo` removes all state. If you linked a clone, `pnpm unlink --global`. Any
running server stops itself once it's idle, or `curl -X POST localhost:<port>/api/shutdown`
if you're impatient.

### Something's wrong. Where are the logs?

A background server logs to `~/.diffo/logs/<repo>-<hash>.log`, or wherever
`DIFFO_SERVER_LOG` points. Or run `diffo --foreground` and watch it directly.

### Can I fork it and ship my own?

Yes, Apache-2.0. Ship it under your own name, though: the [trademark
policy](https://github.com/DiffoHQ/diffo/blob/main/TRADEMARK.md) covers the Diffo name and logo, not the code.
