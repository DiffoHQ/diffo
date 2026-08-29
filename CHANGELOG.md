# Changelog

Notable changes to Diffo. Format follows [Keep a Changelog](https://keepachangelog.com);
versions follow [Semantic Versioning](https://semver.org).

Until 1.0, minor versions may break things. When they do, the entry says how to adapt.

## [Unreleased]

Nothing yet.

## [0.1.0] — 2026-08-29

### Added

- **Comment on multiple lines.** Drag down the line-number gutter (or
  shift-click) to select a range and comment on it. The scope chip's steppers
  walk the free edge one line at a time, a sent range comment marks its lines
  with a glyph and a spine, and the range travels to the agent as
  `path:12-20 (new side)`. Existing single-line comments need no migration.
- **Styled tooltips on every icon-only control**, replacing the native
  `title` tooltips that were slow enough to read as absent — shown on
  keyboard focus too, and live-updating labels like *Copy path* → *Copied*
  mid-hover.
- **Agent activity in the header presence chip** — it narrates what the
  agent is doing, not just whether it's alive.
- **A security model page** in the docs: the operational properties (no
  egress, loopback-only with rebinding/CSRF guards, read-only git, data at
  rest, provenance, no install scripts) stated in a form a security reviewer
  can check against the source.

### Changed

- **Finish review now speaks in your words, not a verdict.** The
  Comment / Request changes / Approve radios are gone; finish sends the
  outgoing comments plus the optional closing note, which *is* the verdict.
  One signal is derived instead of declared: an empty finish over a
  fully-read changeset is a green light to proceed. Nothing to adapt — a
  client or stored review still carrying a verdict is silently ignored.
- **Comment threads freeze their anchored lines**, so a thread keeps
  pointing at the code it was written about even after the code moves.

### Fixed

- The CLI knows its own version again. Since the rename to `@diffohq/diffo`,
  every published build reported `0.0.0` (`diffo --version`, the server
  handshake), so a newer CLI would reuse a running server from an older build
  instead of replacing it.
- **Hide tests** now recognizes test files in any stack — PascalCase
  `Test`/`Tests` suffixes, `.Tests` project directories, `test_` prefixes,
  `_test`/`_spec` suffixes and `test`/`Tests` directories — not just the
  JavaScript `.test.`/`.spec.`/`__tests__` conventions. Ambiguous cases
  resolve toward showing the file.
- Split view no longer collapses into four equal columns on some diffs.
- The typed file filter narrows the reading pane, not just the file rail,
  and a chip in the pane bar names the active filter.
- A commit made while no server was watching is now caught: the review
  offers a fresh start instead of leaving the previous round's threads under
  the new changeset, and the reset tells the polling agent it happened.
- Finish no longer brands answered threads as unanswered.

## [0.0.2] — 2026-08-26

### Changed

- Releases are now published to npm from GitHub Actions with
  [provenance](https://docs.npmjs.com/generating-provenance-statements): every
  tarball carries a signed attestation binding it to the exact commit and
  workflow run that built it, verifiable on the npm package page. Nothing
  changes for users — same package, now with a checkable paper trail.

## [0.0.1] — 2026-08-25

The first release, published to npm as `@diffohq/diffo`. Everything below is what
shipped in it, written as a starting point rather than a history.

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
  read, 2 files skipped*) and an optional closing note. The note travels as a thread on the
  whole changeset — it leads the agent's batch, and the agent replies to it like any other
  thread.
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

- **Published as `@diffohq/diffo`**, not `diffo` — the bare name on npm belongs to an
  unrelated package. The binary it installs is still `diffo`.
- **Pull requests are not a changeset source yet.** Working tree and `--base` only.
- **Guided reading** — splitting a large change into an ordered sequence of small,
  reviewable sections — is designed but not built.

[Unreleased]: https://github.com/DiffoHQ/diffo/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/DiffoHQ/diffo/compare/v0.0.2...v0.1.0
[0.0.2]: https://github.com/DiffoHQ/diffo/compare/v0.0.1...v0.0.2
[0.0.1]: https://github.com/DiffoHQ/diffo
