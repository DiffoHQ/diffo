# Contributing to Diffo

Thanks for helping out. Diffo is a TypeScript CLI (`diffo`) with a
React + Vite UI and a Hono server. It requires **Node >= 24** (the server uses
the built-in `node:sqlite`).

By participating you agree to the [Code of Conduct](CODE_OF_CONDUCT.md);
security issues go through the [security policy](SECURITY.md), not the issue
tracker.

## Contributor License Agreement

First-time contributors are asked to sign the [CLA](CLA.md) — a bot comments
on your first pull request and signing is a single reply. You keep the
copyright to your work; the CLA just gives the maintainer the right to
relicense it, which keeps the project's future licensing options open.

## Setup

```bash
pnpm install
cp .env.example .env
```

The `.env` step matters: `ENV=development` is what makes a review opened while
you're hacking use *this checkout's* CLI instead of the published `npx -y @diffohq/diffo`.
Without it the dev servers still run, but the skill they install and the commands
they print point at the released package rather than your changes.

Then start the full dev environment — server (port 4949) and client
(port 5173) together:

```bash
pnpm dev
```

(`pnpm dev:server` / `pnpm dev:client` still run each half on its own.)

## Two skills: `/diffo` and `/diffo-dev`

`ENV=development` changes what the *server* prints. It does not change the skill
your agent has — that is a separate install, and there are two of them, on
purpose, so you can exercise the released CLI and your checkout without swapping
files between runs:

| | `/diffo` | `/diffo-dev` |
| --- | --- | --- |
| Installed by | `npx skills add …`, `diffo setup`, or `pnpm build:skill --global` | `pnpm dev:skill --global` |
| Lives at | `~/.claude/skills/diffo/` | `~/.claude/skills/diffo-dev/` |
| Runs | `npx -y @diffohq/diffo` | `tsx src/cli.ts` from your checkout |
| Chosen by | you, or the agent on its own | **you only** |

They are different skill names, so they occupy different slots and neither
install touches the other. `diffo setup` never sees `diffo-dev`, and regenerating
one leaves the other alone.

The asymmetry in that last row is the part that matters. Only `/diffo-dev`
carries `disable-model-invocation: true`, and its description tells the model to
never pick it. So an ordinary "open a code review" keeps reaching the shipped
skill exactly as it does for a user, and reviewing with unreleased code stays a
deliberate act. If both were model-invocable, which CLI ran would be a coin flip.

```bash
pnpm dev:skill --global     # install/refresh /diffo-dev
pnpm build:skill --global   # install/refresh /diffo from this checkout's build
```

Both take effect in the next agent session — skills are read at session start.

### Telling the two reviews apart

A review served from a checkout says so, in the browser tab and next to the
wordmark:

| | Tab title | Header |
| --- | --- | --- |
| `ENV=development` | `diffo-dev` | amber **dev** badge |
| released | `Diffo` | nothing |

The server rewrites `index.html` on the way out, so the marker is there at first
paint — there is no moment where a checkout review looks released. Nothing else
on the page distinguishes them: same UI, same repo, same diff.

### Two things to know about the dev skill

It runs your working tree **uncompiled**, so an edit is live for whoever is
reading the review — including a broken one; land the edit before you reopen.
And the checkout path is baked in absolutely, so re-run `pnpm dev:skill --global`
after moving or renaming the directory.

### Testing the real install path

`pnpm build:skill --global` writes the skill file and nothing else. To exercise
what a user actually hits — every agent on the machine, the plugin form for
Cursor, VS Code, and Copilot CLI included:

```bash
pnpm build && node dist/cli.mjs setup
```

`pnpm dev:skill` without `--global` writes `diffo-dev` project-scoped under
`.claude/skills/` (gitignored) instead, if you would rather it existed only
inside this repo.

## Before you open a PR

One command runs every required gate:

```bash
pnpm check
```

That's `typecheck` (tsc --noEmit), `test` (unit + real-git integration +
built-binary E2E smoke), `build` (vite build + tsdown), `lint` (Biome), and
`docs:build` (VitePress) — all five must pass, and CI runs the same five on your
PR. `docs:build` is a real gate, not a formality: the docs embed clips and
diagrams as asset imports, so a missing or misnamed file fails the build.

Lint is Biome, and `pnpm format` (Biome with `--write`) fixes almost everything
it flags — run that before reaching for the config.

## The one hard rule: never hand-edit the shipped skill

`skills/diffo/SKILL.md` is **generated**, not authored. It's built from
[`src/skill.ts`](src/skill.ts) by:

```bash
pnpm build:skill
```

Edit `src/skill.ts` and regenerate — never touch `skills/diffo/SKILL.md`
directly. A hand edit will be silently overwritten on the next build.
