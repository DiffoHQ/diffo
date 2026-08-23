# Getting started

Diffo turns any git changeset into a live review in your browser, whether
that's uncommitted agent output, a branch, or a commit range. Your comments go
straight to the agent that wrote the code, and its fixes land in the diff while
you keep reading. It's entirely local: no config, no accounts, nothing leaves
your machine.

<video class="clip" src="../assets/demo.mp4" muted loop playsinline width="1080" height="632" poster="../assets/demo-poster.jpg" preload="none"
  aria-label="The full Diffo loop: ask Claude Code to open a code review, read the changeset in the browser, comment on a line, and watch the agent's answer land inline in the thread"></video>

## Requirements

- **Node >= 24**
- **git** on your PATH

## Install

There are two ways in: paste a prompt and let your agent handle it, or run the
install yourself. Both end in the same place.

### Have your agent set it up

Paste this into Claude Code, Cursor, Codex, or whichever agent you already
use:

```text
Run `npx skills add DiffoHQ/diffo --skill diffo -g` and open the diffo review
```

That installs the skill globally, so it is there in every repo, and the review
of your current changeset opens in the browser. There is nothing to configure
afterwards.

### Install the skill yourself

```bash
npx skills add DiffoHQ/diffo --skill diffo
```

That's the whole install: project-local by default, `-g` for everywhere.
There is no CLI to set up: the skill runs `diffo` through `npx`, so it comes
along on demand. Then, in any session, just say:

> **"open a code review"**

The agent opens a live review of its own work and hands you the URL. Your
comments arrive in its context, its replies land inline in your threads, and
its fixes update the diff live while you read.

And the plain diff viewer needs no install at all: `npx -y diffo` inside
any repo opens the browser on your working tree vs HEAD.

::: warning Not yet on npm
Until `diffo` is published, run from a clone:

```bash
git clone https://github.com/DiffoHQ/diffo.git && cd diffo
pnpm install && pnpm build
node dist/cli.mjs setup   # or `node dist/cli.mjs` from any repo to review it
```
:::

## One setup, every agent

Installing the skill covers the agent you installed it from. `diffo setup`
goes wider: it detects every coding agent on the machine and registers with
all of them at once, including the plugin form for Cursor, VS Code, and
Copilot CLI. It never touches an agent that isn't installed, never overwrites
anything that isn't Diffo's, and is safe to re-run any time:

| Agent | How it's wired |
| --- | --- |
| **Claude Code** | skill installed at `~/.claude/skills/diffo` |
| **Codex** · **Gemini CLI** · **Amp** · **Goose** · **OpenCode** | one shared copy in the cross-tool `~/.agents/skills` dir |
| **Cursor** | plugin linked into `~/.cursor/plugins/local` |
| **VS Code** (Copilot Chat) | plugin registered in `chat.pluginLocations` |
| **Copilot CLI** | `copilot plugin install` |

And it stays set up: `npx -y diffo` resolves a fresh CLI on every review, and
the CLI carries the installed skill forward, so there is no re-running
`setup` after upgrades.

### Prefer to wire an agent by hand?

`setup` does nothing magical: each row above is one step you can do yourself
instead:

| Agent | Manual equivalent |
| --- | --- |
| **Claude Code** | copy [skills/diffo/SKILL.md](https://github.com/DiffoHQ/diffo/blob/main/skills/diffo/SKILL.md) to `~/.claude/skills/diffo/SKILL.md` |
| **Codex** · **Gemini CLI** · **Amp** · **Goose** · **OpenCode** | the same file to `~/.agents/skills/diffo/SKILL.md` |
| **Cursor** | symlink the diffo package directory into `~/.cursor/plugins/local/diffo` |
| **VS Code** (Copilot Chat) | add the package path to `"chat.pluginLocations"` and set `"chat.plugins.enabled": true` in your user `settings.json` |
| **Copilot CLI** | `copilot plugin install <path-to-the-diffo-package>` |

Hand-wired skill copies don't self-refresh, so re-copy after upgrading.

## Next steps

- [The review loop](/guide/the-loop): what a Diffo review feels like
- [How it works](/guide/how-it-works): the architecture behind it
- [CLI reference](/reference/cli): every command and flag
