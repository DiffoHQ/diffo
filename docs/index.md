---
layout: home

hero:
  name: Diffo
  text: The human way to review agent-written code.
  tagline: "A live review on your machine: the change in layers, in the order it should be read, and the agent on the other end of every comment. For what it just wrote, or for a pull request."
  # The hero image is theme/LivingMark.vue, through the `home-hero-image` slot.
  actions:
    - theme: brand
      text: Get started
      link: /guide/getting-started
    - theme: alt
      text: Your first review
      link: /tutorial
    - theme: alt
      text: ★ Star on GitHub
      link: https://github.com/DiffoHQ/diffo

features:
  - icon: '<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16"/><path d="M16 16h5v5"/></svg>'
    title: Talk to the agent on the line
    details: Ask on any line and the agent answers in the thread. Ask for a change and the fix lands in the diff while you read.
    link: /guide/the-loop
    linkText: How the loop works
  - icon: '<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="m12 3 9 5-9 5-9-5 9-5z"/><path d="m3 13 9 5 9-5"/><path d="m3 18 9 5 9-5"/></svg>'
    title: Read it in layers
    details: The agent splits the change into ordered layers, each with a summary and its files. One layer at a time, in the order it should be read; on a change too big to read, only the lines that matter.
    link: /guide/layers
    linkText: Layers
  - icon: '<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><circle cx="18" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><path d="M13 6h3a2 2 0 0 1 2 2v7"/><path d="M6 9v12"/></svg>'
    title: Review pull requests
    details: Hand it a link. The PR opens in a worktree of its own, your agent reads beside you, and your review goes back to GitHub when you finish.
    link: /guide/pr-review
    linkText: Reviewing a pull request
  - icon: '<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="12" rx="2"/><path d="M12 16v4"/><path d="M8 20h8"/></svg>'
    title: Entirely on your machine
    details: No config, no accounts, no cloud. Anonymous usage data, off with one command. A small local server per repo, state in SQLite under ~/.diffo. A pull request's calls to GitHub go through your own gh.
    link: /faq#does-any-of-my-code-leave-my-machine
    linkText: What leaves the box
---

## One round trip

<HeroDiff />

Diffo doesn't grade your diff or leave generated nitpicks. It isn't an AI reviewer.
It's a reading tool for the human, wired to the one process that still holds the full
context of the change: the agent that just wrote it.

## Start in one command

<InstallTerminal />

Then, in any agent session, one command:

| Run | And the agent reviews |
| --- | --- |
| `/diffo` | what it just wrote, before anything is committed |
| `/diffo main` | everything since you branched off `main` |
| `/diffo <PR link>` | a GitHub pull request, checked out in a worktree of its own |

The agent opens the review and hands you the URL. Nothing to commit, nothing to push, no
CI to wait for. Installed from one agent and want them all? `diffo setup`
[registers every agent on the machine](./guide/getting-started#one-setup-every-agent).

## Review the paths that matter

![A 20,418-line pull request in Diffo, layered by Importance: organizations, roles and SSO across 214 files, opened alphabetical. The reviewer picks Importance under Layer by and asks the agent, which keeps 152 lines in five key layers, the deciding sections of each: the schema migration, the SSO sign-in, the roles and permission checks, the API routes that break, and the API keys it removed. UI, call sites, tests, fixtures and docs go to Other changes, folded.](./assets/readme-importance.svg){.clip .clip-light .home-clip}
![A 20,418-line pull request in Diffo, layered by Importance: organizations, roles and SSO across 214 files, opened alphabetical. The reviewer picks Importance under Layer by and asks the agent, which keeps 152 lines in five key layers, the deciding sections of each: the schema migration, the SSO sign-in, the roles and permission checks, the API routes that break, and the API keys it removed. UI, call sites, tests, fixtures and docs go to Other changes, folded.](./assets/readme-importance-dark.svg){.clip .clip-dark .home-clip}

**An agent writes 20,000 lines in an afternoon. Nobody reads 20,000 lines.** Layer it by
**Importance** and review only the paths that decide something: your data, sign-in,
permissions, the API. The rest waits, folded. [How](./guide/layers#what-the-layers-are-for)

## The loop

<LoopScene />

## Read it in layers

![Layers in Diffo: the header chip suggests layers and the reviewer accepts; the request crosses to the agent, which splits the 13-file change into four ordered layers and posts them with diffo layers; the layers land in the rail, the first layer's card draws its diagram, its files are read and ticked, and \] steps to the second and third layers.](./assets/readme-layers.svg){.clip .clip-light .home-clip}
![Layers in Diffo: the header chip suggests layers and the reviewer accepts; the request crosses to the agent, which splits the 13-file change into four ordered layers and posts them with diffo layers; the layers land in the rail, the first layer's card draws its diagram, its files are read and ticked, and \] steps to the second and third layers.](./assets/readme-layers-dark.svg){.clip .clip-dark .home-clip}

A diff arrives alphabetically, which is almost never the order to read it in. Ask, and
the agent posts **layers**: the change as ordered steps, each with a title, a summary,
and its files. You read one at a time; `]` steps to the next, and anything the agent
touches after posting gathers in a *Since your review* layer, so nothing hides outside
the plan. [Layers](./guide/layers) has the whole of it.

## Reviewer agents

![Reviewer agents in Diffo. Your agent picked a set of reviewer agents for the change; you open Add reviewer, the set is already ticked, and Start hands it to your agent, which starts three reviewers as sub-agents. juno, the General reviewer, comments on line 13; your agent fixes it and answers, and juno confirms and resolves the thread. remy, the AI slop reviewer, flags a TODO on line 14; your agent disagrees, and remy hands the thread to you, marked Needs your decision. iris finds nothing and is done.](./assets/readme-reviewers.svg){.clip .clip-light .home-clip}
![Reviewer agents in Diffo. Your agent picked a set of reviewer agents for the change; you open Add reviewer, the set is already ticked, and Start hands it to your agent, which starts three reviewers as sub-agents. juno, the General reviewer, comments on line 13; your agent fixes it and answers, and juno confirms and resolves the thread. remy, the AI slop reviewer, flags a TODO on line 14; your agent disagrees, and remy hands the thread to you, marked Needs your decision. iris finds nothing and is done.](./assets/readme-reviewers-dark.svg){.clip .clip-dark .home-clip}

**+ Add reviewer** brings in reviewer agents: other AI sessions that read the change and
comment on it, each narrow. Your agent picks the set that fits and starts them; they argue
it out with your agent in the threads, and only a decision comes to you.
[The CLI reference](./reference/cli#reviewer-agent-commands) has the protocol.

## Pull requests too

![A pull request in Diffo: you hand the PR link to your agent and it is checked out in a worktree of its own; a Private question on line 13 crosses to your agent, which runs the tests and answers in the thread; a PR comment waits as a draft until Submit review, and then the review crosses to GitHub, while the private thread stays on your machine.](./assets/readme-pr.svg){.clip .clip-light .home-clip}
![A pull request in Diffo: you hand the PR link to your agent and it is checked out in a worktree of its own; a Private question on line 13 crosses to your agent, which runs the tests and answers in the thread; a PR comment waits as a draft until Submit review, and then the review crosses to GitHub, while the private thread stays on your machine.](./assets/readme-pr-dark.svg){.clip .clip-dark .home-clip}

When a pull request lands on your desk, `/diffo <PR link>` opens it in a worktree of its
own, with its conversation imported and your agent beside you as a copilot for code it did
not write. Comments for the author go to GitHub as one review when you finish; questions
for your agent never leave your machine. [Reviewing a pull request](./guide/pr-review) has
the loop.

## Read next

<div class="home-next">

- [**Your first review** <span>The whole loop, once, end to end</span>](/tutorial)
- [**CLI reference** <span>Every command, flag, and exit code</span>](/reference/cli)
- [**The agent protocol** <span>How an agent attaches and answers</span>](/agents)
- [**Architecture** <span>Hunk identity, the delivery queue</span>](/architecture)
- [**Keyboard shortcuts** <span>The review UI is keyboard-first</span>](/reference/keyboard-shortcuts)
- [**FAQ** <span>The short answers</span>](/faq)

</div>
