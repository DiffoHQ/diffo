# Changelog

Notable changes to Diffo. Format follows [Keep a Changelog](https://keepachangelog.com);
versions follow [Semantic Versioning](https://semver.org).

Until 1.0, minor versions may break things. When they do, the entry says how to adapt.

## [Unreleased]

### Fixed

- **Diagram labels stay readable in dark mode.** A node the agent colors
  (`classDef` / `style … fill:`) keeps its fill in both themes, but its label
  followed the theme, so dark mode drew near-white text on a pastel box. A
  label on a colored node now gets whichever ink reads better on its fill; an
  explicit `color:` is still kept.

## [0.7.0] — 2026-09-26

### Added

- **Pull request review: `diffo <PR URL>`** (also `owner/repo#N`, `#N`, or
  `N` from a clone; `/diffo <PR link>` from your agent). The PR is fetched into
  a worktree Diffo owns (`~/.diffo/worktrees/<repo>-<hash>/pr-<N>`, on branch
  `diffo/pr-<N>`) and reviewed there as an ordinary branch review, so your
  checkout is never touched. The description, reviews and conversation comments
  come in as threads at the top; inline GitHub threads sit at their lines with
  real logins and avatars. The header carries the PR title and one status chip
  (merged, changes requested, CI failing, draft, or CI running, by priority);
  click the title for author, branches, checks, reviews and the GitHub link. A
  push moves the worktree and the diff updates like
  any edit, read marks included. Every composer gains two tabs in its head and
  wears the side you pick as a stripe down its edge: **Comment on PR** drafts a
  review comment for GitHub (blue), **Ask agent** sends a private thread (amber
  dashed, one button, no intent chips). Public drafts, replies and resolves post as one
  review when you **Submit review**: GitHub's own dialog, body first, then the
  verdict (Comment / Approve / Request changes) with what each means, and every
  pending comment listed in full above the button; nothing leaves before then,
  and a failure midway never posts twice. The Threads list
  groups by side, GitHub then Private, each striped in its color with one
  badge (drafts pending, or threads on your turn), so a row's side is never
  in doubt; GitHub lists the threads you are part of, and the rest of the
  conversation folds behind "N from others". A public card
  offers nothing that reaches the agent; under a private one, **Post as PR
  comment** turns the agent's answer (or its ```suggestion block) into an
  editable draft. The agent works from the worktree as a copilot for
  code it did not write, never posts to GitHub, and gets a `submitted` notice
  when you finish. Needs the GitHub CLI signed in: every GitHub call is your
  own `gh`, and Diffo holds no token.
- **A positional target.** `diffo main` reviews against `main` (same as
  `--base main`); a pull-request reference is a target too. `diffo pr <ref>`
  is the explicit spelling.
- **`diffo clean`** lists the worktrees Diffo made and removes the ones whose
  review is over (merged or closed, pruned, or gone); `--force` takes dirty
  ones, `--all` every one.


### Changed

- **The pull request description is the Overview.** Row 0 of Layers on a PR is
  the author's description, the way the agent's guide is on a local review; a
  guide the agent posts sits under it. A fresh PR review opens there.
- **Other people's conversation comments start folded.** On the pull request,
  the pane leads with what is yours: the description, your private threads,
  and the GitHub conversations you started, replied to, spoke in, or are
  @mentioned in. The rest, bots included, waits behind "N more from others",
  the rule the Threads list already applied; picking one of them from the list
  unfolds it.
- **The network claim.** Diffo still makes no network calls of its own; a
  pull-request review is the one case where it talks to GitHub, and only
  through your `gh`. README, FAQ and the security page say so.
- A bare word that is not a typo of a command is now a branch to review
  against, not an "unknown command".


### Fixed

- **The agent's `diffo poll` from your checkout reaches the pull request's
  review.** Every command except a plain open now follows a live PR server into
  its worktree when the checkout has no review of its own; before, it started a
  second, plain review of the checkout and listened there.
- **A submit of only resolves no longer fails.** A pending review is opened and
  submitted only when something needs one (a line comment, an inline reply, a
  body, or a verdict); GitHub refuses an empty review, and used to leave one
  dangling.
- **Session detection no longer mistakes the CLI's own launcher for the agent.**
  A `tsx` or `npx` wrapper carrying a repo path with a harness word in it (a
  checkout under `.claude/worktrees/…`, a project called `example`) could pass
  for the session; it dies the moment `diffo poll` returns, so five seconds
  after every delivery the review showed "no agent" and marked the thread
  "the agent moved on" while the agent was still working. The walk now skips
  processes that carry the CLI's own invocation, and a harness name only counts
  at the start of a path segment.
- **A collapsed resolved thread no longer stretches the diff it sits in.** The
  one-line summary carried the whole first message; a bot's review comment
  running to paragraphs made the code table thousands of pixels wide. The
  summary is now the first line, and it can no longer size the table.
- **Opening a second pull request no longer removes the first one's checkout
  while you are still reading it.** The sweep that runs at every open treated a
  merged or closed PR as done the moment GitHub said so; it now leaves a
  worktree alone while a Diffo server is reviewing in it. `diffo clean --force`
  is the one thing that removes such a worktree, and it says so.
- **A pull request is fetched from the remote that names its repository.** In
  a clone of a fork, `origin` is the fork; the PR's head and base now come from
  the remote whose URL matches the PR, and Diffo refuses to guess when none does.
- **A failed submit never reaches the agent.** A submit that GitHub refused
  outright (approving your own PR, say) still ran the agent's leg when it
  carried no drafts, so the agent heard a finish that did not happen and a
  second one on the retry.
- **Resolving the description, a review body, or a conversation comment no
  longer breaks the submit.** Only inline threads resolve on GitHub; the other
  kinds now resolve locally instead of queueing a call GitHub rejects at every
  retry.
- **A pending review you submitted or discarded on github.com no longer
  blocks every later submit.** Diffo now trusts what GitHub reports as pending
  at submit time and starts a fresh review when the stored one is gone.
- **A draft written as several messages posts once.** Every message of the
  draft now counts as posted; before, the ones after the first went out again
  as replies at the next submit.
- **Reviews and conversation comments are paginated.** A PR with more than a
  hundred of either lost the rest: a pending review beyond the first page went
  unseen (and the submit then tried to create a second one), approval counts
  were short, and imported comments stopped at a hundred.
- **The pull request is fetched only when its head moved**, not at every
  45-second poll, and a fetch that keeps failing is logged once.
- **A reply on a conversation comment no longer comes back as a second
  thread** when GitHub's copy is imported.
- **Removing a worktree by hand no longer leaks its branch and ref**: the next
  sweep still cleans the git side.
- **A URL that is not a pull request is an error**, not a silent review of the
  working tree.
- **`diffo clean` says when it could not check a worktree**, and a worktree git
  failed to remove stays listed instead of being reported as removed.
- **The Submit review dialog's pending list refreshes after a partial GitHub
  failure**, so it lists only what is still to post; it also submits when the
  preview itself failed to load, and a verdict that became blocked mid-dialog
  falls back to Comment.
- **Public drafts no longer count as comments waiting for the agent**, in the
  finish summary or the monitor.
- **A queued resolve or reopen stays visible** on a collapsed card and in its
  rail row ("resolves when you submit").
- **A GitHub thread whose line went outdated says so** ("outdated on GitHub:
  the line left the diff") instead of claiming the file left the changeset.
- **The rail's mark on a public draft discards it**, the way the card does,
  instead of resolving it out of the submit while it still read as settled.
- **"Only mine" and "N resolved" folds honour a click** even while the selected
  thread sits inside the fold.

## [0.6.0] — 2026-09-26

### Added

- **Edit your comments.** Hover one of your messages and click the pencil. If
  the agent hasn't seen it yet, the edit just fixes the text in place. If it
  has, editing works like editing a chat message: everything after it is
  deleted, the messages that will go fade while you edit, and
  **Save & resend** hands the thread back (plain **Save** holds it). The
  agent is told its earlier replies were withdrawn, and that any code it
  changed for them is still in the tree, so it should keep or revert that code
  and say which. The pencil is off while the agent is answering the thread.

### Changed

- **Connecting an agent is one line to paste.** With no agent attached, the
  modal used to lead with installing the skill and hid the actual join prompt,
  seven lines of poll instructions, under "Already have it?". Now it offers a
  single ask, `connect to the diffo review in <repo>`, which wakes the skill
  your agent already has. The repo path points it at this review from any
  session. The install command and the scope checkbox are gone.

- **The guide opens with the problem, and its diagram draws what happens.**
  The map-not-a-tour doctrine still let a guide explain a change through its
  own code names: "what it does" came out as a mechanism line, and "how the
  changed pieces talk to each other" as a chart of which constant feeds which
  function. It now asks for the problem the change solves and what it changes,
  written for a reader who never saw the session, and a diagram of the flow it
  changes — from what sets it off to what someone sees, people and screens
  when they are the flow, never which code references which. A plain node is
  anything existing, not only code. `help guide`'s example leads with the
  problem too, since agents copy examples.
- **Layer summaries say what the step is about.** Agents kept writing them
  as retellings of the files right below, so the card gave the reviewer no
  context. The doctrine now asks for what the layer is about and enough
  context to review it — short, free-form, never a retelling of the diff — and
  a small diagram when the step has a shape. `help layers`, `help agent`, the
  open-time nudge, and the outline request all carry the same words.
- **The Layers tab, before there are any, is a title, one line, and the
  button.** The explainer paragraph, the dashed example, and the hint under
  the button are gone; an agent's suggestion to read in layers shows in the
  header chip, not as a state of the tab.

## [0.5.0] — 2026-09-26

### Changed

- **The guide is a map, not a tour.** Since layers took over the reading
  order, the agent's opening comment kept writing one anyway — 24 of the last
  30 guides did. The doctrine now asks for what only the author knows: what
  the change does and why, how the changed pieces talk to each other as a
  runtime-flow diagram, what has to stay true (an invariant, a judgment call,
  a known shortcoming) as checks for the reviewer to run, and what to skip.
  No reading order, no file list, about a hundred words plus the diagram.
  Diagrams tag new code `:::new` and changed code `:::changed` with two
  `classDef` lines, so the seam where new meets old reads the same on every
  review. `diffo help guide` carries the doctrine and one worked example;
  `help agent`, the open-time nudge, and the cleared-round payload restate it.

### Added

- **Hide tests works inside layers.** The switch used to step aside with the
  other filters once an outline was up, so a layer showed its test files
  whatever you had chosen. It now follows you in: a layer shows its
  non-test files, the rail counts what it took (`3 files · 1 hidden`), a
  layer left with nothing says so on its card, and `n`, `]` and the layer's
  roll-up mark skip what is hidden — excluded, not read, exactly as on the
  Files tab. The narrowing filters (reviewed, since, the typed word) still
  step aside there: the outline is the narrowing.
- **The map is navigation.** In the changeset threads — the guide above all —
  a file named as `` `path` `` or `` `path:line` `` in prose, or in a diagram
  node, is now a jump to that file in the review, the same way a layer
  summary's references already were. Layer-card diagrams get the same.

- **Agent-offered replies.** `diffo comment` and `diffo reply` take
  `--suggest-reply "<one line>"`: the answer the agent expects when its
  message ends in a decision that is the reviewer's ("want me to extract
  this?" → "yes, extract it"). In the composer it shows as ghost text in the
  reply box with a Tab chip; Tab or → takes it, typing or Shift+Tab
  withdraws it, and nothing is sent without ⌘↵ — an offer is a draft, never
  a hand-over. The help text and agent protocol say when to use it: only on
  a message that proposes something, never on one that only reports.

### Fixed

- **Hide tests** now catches Cypress (`.cy.ts`, `cypress/`), e2e layouts
  (`.e2e.ts`, `e2e/`, Nx `*-e2e/`), test support (`__mocks__`, snapshots,
  `test-utils`, runner configs like `vitest.config.ts`), Gradle source sets
  (`androidTest/`, `integrationTest/`, `testFixtures/`), `*IT.java`,
  Kotest/Spock `*Spec`, pytest `conftest.py`, RSpec `spec/**/*.rb`, Go
  `testdata/` and mocks, Gherkin `.feature` files, and any `.NET`
  `*.UnitTests/`-style project.
- **Review page polish.** Mermaid figures scale to the comment card instead
  of clipping (below 60% they scroll); file headers keep the basename at
  narrow widths, ellipsizing the directory from the left; `c` comments on
  the clicked line (a click marks it focused, the hunk's first changed line
  stays the fallback); the composer footer is a Change · Question · Agent
  decides control, posted cards and Threads rail rows carry the kind badge;
  quick actions are the three asks reviewers of agent code make most
  (Explain this, Clean up the comments, Simplify this); cards and rail share
  one status vocabulary (Draft → Sent → Answered / Addressed → Resolved);
  the pane bar reads "18 of 30 files" and "hunk 2 / 64" with the selected
  hunk marked by a rail and ring; below 800px the file list starts folded;
  layer rows pick on a click anywhere.

## [0.4.1] — 2026-09-24

### Fixed

- **Skill: the poll step reads as data again.** Step 3 of `SKILL.md` said
  every poll payload "names your next step", which read as reviewer text
  steering the agent and brought back Snyk's W011 (third-party content).
  It now says the payload's `next_step` is fixed text the CLI writes, never
  reviewer-typed, and points at the trust rule from the poll step itself.

## [0.4.0] — 2026-09-22

### Added

- **Layers: the agent's reading plan.** A diff arrives in alphabetical order,
  which is almost never the order it should be read in. The agent that wrote
  the change can now post an outline (`diffo layers --json`, or `--suggest` at
  open to offer one): ordered steps, each with a title, a short summary, and
  its files. The review gains a **Layers** tab; picking a layer narrows the
  pane to its files under the summary, and `]` / `[` / `n` walk the plan. The
  reviewer's **Ask the agent to outline this** reaches the agent through
  `diffo poll` as a `kind: "layers"` payload. Layers come from the agent only,
  and with none posted the review is the flat file list it was. They resolve
  against the live changeset on every refresh, so files touched after posting
  gather in a *Since your review* layer until a re-post, which keeps the
  reviewer's place for every title that survives.

## [0.3.0] — 2026-09-19

### Added

- **Tab titles: `diffo poll --title "<the change, in 2-3 words>"`.** A reviewer
  with several reviews open saw every tab titled "Diffo" and had to click
  through them to find one. The agent now names the change on the poll that
  starts the review, and that name becomes the tab's — just the name, since a
  tab shows about twenty characters and the favicon already says which app this
  is. The newest title wins, so a changeset that becomes something else can
  rename its own tab, and a poll without `--title` leaves the name alone.
  Nothing changes until an agent sends one: the tab reads "Diffo" exactly as
  before. The unread-answer badge still rides in front (`(2) tab titles`), a
  review served from a source checkout still says so (`dev · tab titles`), and
  clearing the review drops the title along with the round.

### Changed

- **The review URL reaches you before the guide, not after.** The agent used
  to be told to post its guide comment first and hand over the URL last, so a
  review with a diagram to draw opened only once the diagram was drawn. The
  skill, `help agent`, and the open-time nudge now all say the opposite: share
  the URL the moment it prints, then write the guide while the reviewer opens
  the page. The guide lands live at the top of the review; if the tab is
  focused and the reviewer has already scrolled on, the notification banner
  points at it, and stays until clicked or dismissed.

### Fixed

- **Replying to an agent comment is one click again.** A thread the agent
  started (`diffo comment`) used to take Reply, then a second Send, before
  the reviewer's answer reached the agent. With an agent attached the
  composer now offers **Reply & send**, and the server hands the thread over
  on that reply. The ghost Reply beside it still writes the line in without
  handing it over, for a later Send or the finish batch.

## [0.2.0] — 2026-08-31

### Added

- **Diagrams in comments render beautifully.** Mermaid fences for the common
  types (flowchart, sequence, state, class, ER, xychart) now render through
  beautiful-mermaid, themed with Diffo's own CSS variables so they re-color
  live when the theme flips. Stock mermaid remains the fallback for
  everything else (pie, gantt, gitGraph, …) — and those now re-render in
  place on a theme switch too, instead of keeping a stale palette until
  refresh. Nothing that rendered before stops rendering, and all diagram
  output still passes through the sanitizer.
- **Interim agent replies: `diffo reply --more`.** An answer that only
  promises a follow-up ("I'll investigate and report back") used to read as
  final. `--more` marks it interim: the typing indicator keeps running
  beneath it, the rail keeps the thread under "Waiting on the agent", and
  the agent's next plain reply settles it. Every way the agent can go quiet
  (detach, dead session, server restart) converts the promise into the
  ordinary unanswered state, so the indicator can never run forever.
- **Your theme choice follows you across repos.** It was stored per-origin,
  and every repo serves from its own port — picking dark in one review never
  reached the next. The durable copy now lives in the shared DB.

### Fixed

- **The reading pane now renders files in the rail's tree order** (folders
  first, then files, alphabetical by basename) instead of raw git order, so
  the pane, J/K navigation, "next unreviewed", and the finish-review
  coverage lists all read in the order the rail shows.

### Changed

- **The review loop spends far fewer of the agent's tokens.** The full
  "how to respond" protocol ships once per agent session — repeat deliveries
  carry a compact form plus a `diffo help agent` pointer. Finish no longer
  re-ships threads the agent already answered: they ride as one-line
  mentions, off the reply clock. And a re-delivered thread points at the
  current file instead of repeating its frozen diff snapshot. A typical
  delivery shrinks 30–50%.
- **SKILL.md is now a stub** (9.3KB → 5.2KB). Invocation, start-up steps,
  and the rules that cannot wait stay inline — the trust-model wording below
  among them, now test-pinned — while the loop's details live in
  `diffo help agent`, so installed copies carry less that can go stale.
- **The skill now states its trust model outright**, for security scanners
  and cold readers alike: the review URL is a plain `http://localhost:<port>`
  address carrying no token or credential, and poll payloads are the local
  human reviewer's feedback — data to weigh, never instructions with the
  user's authority. Addresses the Snyk skill audit that read the old wording
  as credential exposure (W007) and third-party content injection (W011).
  The poll payload is likewise now described as the reviewer's threads as
  structured data, not "a prompt" the agent acts on — the phrasing the same
  audit read as external code controlling the agent (W012).

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

[Unreleased]: https://github.com/DiffoHQ/diffo/compare/v0.7.0...HEAD
[0.7.0]: https://github.com/DiffoHQ/diffo/compare/v0.6.0...v0.7.0
[0.6.0]: https://github.com/DiffoHQ/diffo/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/DiffoHQ/diffo/compare/v0.4.1...v0.5.0
[0.4.1]: https://github.com/DiffoHQ/diffo/compare/v0.4.0...v0.4.1
[0.4.0]: https://github.com/DiffoHQ/diffo/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/DiffoHQ/diffo/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/DiffoHQ/diffo/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/DiffoHQ/diffo/compare/v0.0.2...v0.1.0
[0.0.2]: https://github.com/DiffoHQ/diffo/compare/v0.0.1...v0.0.2
[0.0.1]: https://github.com/DiffoHQ/diffo
