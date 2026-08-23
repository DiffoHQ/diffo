---
layout: home

hero:
  name: Diffo
  text: The human way to review agent-written code.
  tagline: "A live review on your machine, wired to the agent that wrote the code, so your comments come back as fixes."
  image:
    light: /logo.svg
    dark: /logo-dark.svg
    alt: Diffo
  actions:
    - theme: brand
      text: Get started
      link: /guide/getting-started
    - theme: alt
      text: Your first review
      link: /tutorial
    - theme: alt
      text: View on GitHub
      link: https://github.com/DiffoHQ/diffo

features:
  - icon: '<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4"/><path d="M9.5 12h5"/><path d="M12 9.5v5"/><path d="M9.5 18h5"/></svg>'
    title: Review any changeset
    details: "Uncommitted agent output, a branch, a commit range: the review opens in your browser before the code ever needs a remote."
    link: /guide/how-it-works#the-changeset-is-the-unit-of-review
    linkText: Changesets, not just PRs
  - icon: '<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16"/><path d="M16 16h5v5"/></svg>'
    title: A live loop with the agent
    details: Your comments arrive in the agent's session, its replies land inline in your threads, and its fixes update the diff live while you read.
    link: /guide/the-loop
    linkText: How the loop works
  - icon: '<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="12" rx="2"/><path d="M12 16v4"/><path d="M8 20h8"/></svg>'
    title: Entirely on your machine
    details: No config, no accounts, no cloud, no telemetry. A small local server per repo, state in SQLite under ~/.diffo.
    link: /faq#does-any-of-my-code-leave-my-machine
    linkText: What leaves the box
  - icon: '<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="2.5"/><circle cx="5" cy="5" r="2"/><circle cx="19" cy="5" r="2"/><circle cx="12" cy="20" r="2"/><path d="m6.4 6.4 3.7 3.7"/><path d="m17.6 6.4-3.7 3.7"/><path d="M12 14.5V18"/></svg>'
    title: One setup, every agent
    details: diffo setup registers with Claude Code, Cursor, VS Code, Copilot, Codex, Gemini CLI, Amp, Goose, and OpenCode, whichever are installed.
    link: /guide/getting-started#one-setup-every-agent
    linkText: One setup, every agent
---

## One round trip

<video class="clip home-clip" src="./assets/demo.mp4" muted loop playsinline width="1080" height="632" poster="./assets/demo-poster.jpg" preload="none"
  aria-label="The full Diffo loop: ask Claude Code to open a code review, read the changeset in the browser, comment on a line, and watch the agent's answer land inline in the thread"></video>

Diffo doesn't grade your diff or leave generated nitpicks. It isn't an AI reviewer.
It's a reading tool for the human, wired to the one process that still holds the full
context of the change: the agent that just wrote it.

## Start in one command

```bash
npx skills add DiffoHQ/diffo --skill diffo
```

Then, in any agent session:

> **"open a code review"**

The agent opens a live review of its own work and hands you the URL. Nothing to commit,
nothing to push, no CI to wait for.

## The loop

<div class="home-steps">
  <div class="home-step">
    <div class="home-step-n">1</div>
    <h3>The agent orients you</h3>
    <p>On a multi-file or structural change it opens the review with one guide comment:
    what the change does, plus a <a href="https://mermaid.js.org">mermaid</a> diagram when
    the shape is easier to see than to read. It orients your reading and stops there, with
    no verdicts.</p>
  </div>
  <div class="home-step">
    <div class="home-step-n">2</div>
    <h3>You read</h3>
    <p>Syntax-highlighted unified or split diffs, keyboard-first navigation, per-file
    viewed tracking. The changeset stays live: fresh hunks appear as the agent works,
    and a hunk you already read says <em>changed since you read it</em>.</p>
  </div>
  <div class="home-step">
    <div class="home-step-n">3</div>
    <h3>You comment</h3>
    <p>On a line, a file, or the whole changeset. Every thread is marked
    <strong>Change</strong> (edit the code) or <strong>Question</strong> (answer it,
    touch nothing), so a question never turns into an unrequested refactor.</p>
  </div>
  <div class="home-step">
    <div class="home-step-n">4</div>
    <h3>The agent answers</h3>
    <p>Send one thread now, or hand back the whole batch with honest coverage stats.
    Answers land inline in your threads; fixes land in the diff you're reading, so
    you're reading the fix itself, not a promise of one.</p>
  </div>
</div>

## Read next

<div class="home-next">

- [**Your first review** <span>The whole loop, once, end to end</span>](/tutorial)
- [**CLI reference** <span>Every command, flag, and exit code</span>](/reference/cli)
- [**The agent protocol** <span>How an agent attaches and answers</span>](/agents)
- [**Architecture** <span>Hunk identity, the delivery queue</span>](/architecture)
- [**Keyboard shortcuts** <span>The review UI is keyboard-first</span>](/reference/keyboard-shortcuts)
- [**FAQ** <span>The short answers</span>](/faq)

</div>
