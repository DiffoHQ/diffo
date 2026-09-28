# Read it in layers

A diff arrives in alphabetical order, which is almost never the order it should
be read in. **Layers** are the agent's reading plan: the change as ordered steps,
each with a title, a short summary, and the files that belong to it. You read one
layer at a time, in the order the agent would explain it.

<video class="clip clip-light" src="../assets/layers.mp4" muted loop playsinline width="1440" height="1102" poster="../assets/layers-poster.jpg" preload="none"
  aria-label="A 23-file change, every file folded. The header chip reads agent · suggests layers; the reviewer clicks it, eight layers land, and picking the first shows its summary card. ] steps to layers 2 and 3, where the reviewer asks on a line and the agent answers in the thread."></video>
<video class="clip clip-dark" src="../assets/layers-dark.mp4" muted loop playsinline width="1440" height="1102" poster="../assets/layers-dark-poster.jpg" preload="none"
  aria-label="A 23-file change, every file folded. The header chip reads agent · suggests layers; the reviewer clicks it, eight layers land, and picking the first shows its summary card. ] steps to layers 2 and 3, where the reviewer asks on a line and the agent answers in the thread."></video>

Layers come from the agent only. The session that wrote the change still
remembers the order it would explain it in; Diffo never guesses a plan from
paths, and with no layers the review is exactly the flat file list.

## Asking for them

Three ways in, all the same ask:

- **The header chip.** When the agent thinks the change reads better in order,
  it says so at open, and the header shows *agent · suggests layers* with the
  agent's reason beside it. One click.
- **The Layers tab.** Its **Ask the agent to outline** button works whether the
  agent suggested it or not.
- **In the terminal.** Say "layers" to the agent. It offers exactly this in its
  handoff message when it suggests them.

The ask reaches the agent through its poll. The tab reads *Outlining…* and the
presence chip *outlining layers* until the outline lands, a moment later.

## Reading one at a time

Picking a layer narrows the reading pane to its files, under a card with the
layer's summary. The card renders markdown, and a
[mermaid](https://mermaid.js.org) diagram when the step has a shape, the same
way a thread does; a file the summary names is a click away.

| Key | |
| --- | --- |
| `]` / `[` | Next / previous layer |
| `n` | Next unread file, rolling from one layer's last unread file into the next |
| `J` / `K` | Next / previous file, staying inside the active layer |

Each layer carries its own progress, read off the same hunk marks
**Finish review** reports. A layer tagged *mechanical* changes no behaviour, a
rename or call sites following a signature, and keeps its files folded.

On a pull request, row 0 of the list is the **Overview**: the pull request's
description, in the place a guide takes on a local review. See
[Reviewing a pull request](/guide/pr-review).

## The plan stays honest

Layers are resolved against the live changeset on every refresh. A file the
agent touches after posting, or one no layer names, gathers in a trailing
**Since your review** layer, so nothing hides outside the plan. One line at the
foot of the tab asks the agent to re-outline, and a re-post keeps your place for
every title that survives.

Read marks live on hunks, not on layers, so a re-post can never lose one.

## What a layer may say

A summary follows the guide's rule: it orients your reading and never pre-reviews
it. It says what the step is about and gives the context its files cannot show on
their own; no verdicts, nothing declared "fine". The order is the order you would
explain the change in, the file that explains the rest first and mechanical
consequences last, not the order it was written in.

## The agent's side

Two commands: `diffo layers --suggest "<why>"` at open, and
`diffo layers --json '<Layer[]>'` to post, only when you ask.
[Layers in the agent protocol](/agents#layers) has the doctrine, and the
[CLI reference](/reference/cli#diffo-layers) has the shape of a layer.
