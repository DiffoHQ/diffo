# Diffo — agent notes

**Diffo** is local, live code review for the AI age: a copilot for the
*human* reviewer. AI writes the code; Diffo is where a person actually reads
it, comments, and loops feedback straight back to the agent that wrote it.
Vision and user guide: [README.md](README.md).

Scope note: the unit of review is a **changeset**, not a pull request —
uncommitted agent output, a branch, a commit range, or a PR. Don't let
naming drift back to PR-only.

## Working on it

- `pnpm check` runs every required gate: `typecheck` · `test` · `build` ·
  `lint` · `docs:build`. CI runs the same five on every PR; `pnpm format` fixes
  most lint.
- `skills/diffo/SKILL.md` is **generated** — edit `src/skill.ts` and run
  `pnpm build:skill`; never hand-edit the output. A hand edit is silently
  overwritten on the next build. That regenerates the repo file only: the skill
  your own session is running is a separate installed copy, and CONTRIBUTING.md
  covers switching it between this checkout and the shipped CLI.
- Keep team/org-shaped features behind clean module seams: their own
  directories, with core never importing from them.
