# Changelog

Notable changes to Diffo. Format follows [Keep a Changelog](https://keepachangelog.com);
versions follow [Semantic Versioning](https://semver.org).

Until 1.0, minor versions may break things. When they do, the entry says how to adapt.

## [Unreleased]

Nothing yet.

## [0.0.1] — unreleased

The first version, not yet published to npm. Everything below is what exists on `main`
today, written as a starting point rather than a history.

### Added

- **Live changeset review.** `diffo` in a git repo opens the browser on your working tree
  versus `HEAD`, and keeps watching: new files appear, stats tick, and a hunk you had
  marked read says *changed since you read it* once the agent edits it.
- **Changesets, not just pull requests.** The default is uncommitted work; `--base
  <branch>` reviews everything since a fork point. Untracked files are included, so
  brand-new agent output shows up as an addition.
- **Content-addressed hunk identity** — a hash of path plus changed lines, deliberately
  excluding line numbers and surrounding context. Read marks survive a refresh, an edited
  hunk honestly loses its mark, and "what moved since I last finished" is a set
  subtraction.
- **Reading tools**: syntax-highlighted unified and split diffs, word-level intraline
  marks, keyboard-first navigation, context expansion around hunks, side-by-side image
  diffs, per-file read tracking, and click-to-load stubs for lockfiles, generated modules
  and diffs over 400 changed lines.
- **Comment threads** anchored to a line, a file, or the whole changeset, typed as a
  **Change** or a **Question** so the agent knows whether you want an edit or an answer.
  Markdown supported, rendered through DOMPurify.
- **The agent loop**: `diffo poll` (a foreground long poll), `diffo reply <threadId>`,
  `diffo comment` (a thread in the agent's own voice, inert until the reviewer replies),
  `diffo end`, plus `diffo status` / `diffo stop` / `diffo help agent`. Delivery is at-least-once, and what you sent lives in the
  review rather than in the poll, so it survives a killed poll or a restarted server.
- **Presence** — *waiting* / *listening* / *working*, with a 5-minute stall threshold, so
  you always know whether a Send reaches a live agent or waits in a queue.
- **Finish review**, which hands the whole batch over with coverage attached (*38/42 hunks
  read, 2 files skipped*) and an optional closing note quoted verbatim to the agent.
- **`diffo setup`**, which registers Diffo with Claude Code, Cursor, VS Code and Copilot
  CLI, writes a shared copy into the cross-tool `~/.agents/skills` directory that Codex,
  Gemini CLI, Amp, Goose and OpenCode read, and installs the generated
  [Agent Skill](skills/diffo/SKILL.md).
- **A background server per repo**, claimed through SQLite, that outlives the terminal or
  agent session that started it and stops itself after 30 minutes idle.
- **Branch-scoped reviews**: a checkout under a running server swaps both the review and
  the delivery queue to that branch's work.

### Security

- The server binds loopback and rejects non-loopback `Host` and `Origin` headers, so a web
  page whose DNS is rebound to `127.0.0.1` cannot reach your repo through it. Static file
  serving refuses any resolved path that escapes the client directory. See
  [SECURITY.md](SECURITY.md).

### Known gaps

- **Not on npm.** Until it is, Diffo runs from a clone — see the README's quick start.
- **Pull requests are not a changeset source yet.** Working tree and `--base` only.
- **Guided reading** — splitting a large change into an ordered sequence of small,
  reviewable sections — is designed but not built.

[Unreleased]: https://github.com/DiffoHQ/diffo/compare/main...HEAD
[0.0.1]: https://github.com/DiffoHQ/diffo
