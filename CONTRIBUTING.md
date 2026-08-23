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
you're hacking use *this checkout's* CLI instead of the published `npx -y diffo`.
Without it the dev servers still run, but the skill they install and the commands
they print point at the released package rather than your changes.

Then start the full dev environment — server (port 4949) and client
(port 5173) together:

```bash
pnpm dev
```

(`pnpm dev:server` / `pnpm dev:client` still run each half on its own.)

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
