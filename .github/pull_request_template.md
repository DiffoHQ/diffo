<!--
Thanks for contributing. Keep this short — a good PR description says what changed and
why, and lets the diff say how. Delete any section that doesn't apply.
-->

## What this changes

<!-- One or two sentences. If there's an issue, "Fixes #123". -->

## Why

<!-- The problem this solves, or the behaviour that was wrong. If it's a bug fix, what
     did it look like when it was broken? -->

## How you tested it

<!-- Which of these you did — real answers, not ticks for the sake of it. -->

- [ ] `pnpm typecheck`
- [ ] `pnpm test`
- [ ] `pnpm build`
- [ ] Ran it against a real repo (`diffo` in something with uncommitted work)
- [ ] Added a line to CHANGELOG.md under `## [Unreleased]` — for anything a user
      would notice (features, fixes, behaviour changes). Skip for CI, docs, and
      internal-only refactors.

<!-- New behaviour needs a test. If you didn't add one, say why here — sometimes the
     honest answer is "I couldn't work out how", and that's a fine thing to ask about. -->

## Anything a reviewer should know

<!-- A decision you weren't sure about, a trade-off you made, a thing you'd like a second
     opinion on. This is the most useful section in most PRs. -->

---

<!--
Two repo-specific things that will fail CI or a review if missed:

  · skills/diffo/SKILL.md is GENERATED. Edit src/skill.ts and run `pnpm build:skill`.
    A test fails if the committed file drifts.

  · Comments should say what the code can't. If a comment restates the line below it,
    cut it; if it records why a non-obvious thing is that way, keep it.

First PR? A bot will ask you to sign the CLA — one reply. See CONTRIBUTING.md.
-->
