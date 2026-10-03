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
    details: The agent outlines the change as ordered steps, each with a summary and its files. One layer at a time, in the order it should be read, not alphabetically.
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

## The loop

<LoopScene />

## Read it in layers

![Layers in Diffo: the header chip suggests layers and the reviewer accepts; the request crosses to the agent, which outlines the 13-file change as four ordered steps and posts them with diffo layers; the layers land in the rail, the first layer's card draws its diagram, its files are read and ticked, and \] steps to the second and third layers.](./assets/readme-layers.svg){.clip .clip-light .home-clip}
![Layers in Diffo: the header chip suggests layers and the reviewer accepts; the request crosses to the agent, which outlines the 13-file change as four ordered steps and posts them with diffo layers; the layers land in the rail, the first layer's card draws its diagram, its files are read and ticked, and \] steps to the second and third layers.](./assets/readme-layers-dark.svg){.clip .clip-dark .home-clip}

A diff arrives alphabetically, which is almost never the order to read it in. Ask, and
the agent posts **layers**: the change as ordered steps, each with a title, a summary,
and its files. You read one at a time; `]` steps to the next, and anything the agent
touches after posting gathers in a *Since your review* layer, so nothing hides outside
the plan. [Layers](./guide/layers) has the whole of it.

## Pull requests too

<video class="clip home-clip" src="./assets/pr-review.mp4" muted loop playsinline width="1152" height="648" poster="./assets/pr-review-poster.jpg" preload="none"
  aria-label="One take of a pull request review: the reviewer types /diffo with a pull request's link in Claude Code, the review opens beside the session with the PR's title, author and checks in the header, the agent lays the change out in layers, a question for the agent on the streak check comes back answered in the thread, a comment for GitHub goes on the same line, and the review is submitted with Request changes and appears on the pull request"></video>

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
