# Read it in layers

A diff arrives in alphabetical order, which is almost never the order it should
be read in. **Layers** are the agent's reading plan: the change as ordered steps,
each with a title, a short summary, and the files that belong to it. You read one
layer at a time, in the order the agent would explain it.

![Layers in Diffo: the header chip suggests layers and the reviewer accepts; the request crosses to the agent, which outlines the 13-file change as four ordered steps and posts them with diffo layers; the layers land in the rail, the first layer's card draws its diagram, its files are read and ticked, and \] steps to the second and third layers.](../assets/readme-layers.svg){.clip .clip-light}
![Layers in Diffo: the header chip suggests layers and the reviewer accepts; the request crosses to the agent, which outlines the 13-file change as four ordered steps and posts them with diffo layers; the layers land in the rail, the first layer's card draws its diagram, its files are read and ticked, and \] steps to the second and third layers.](../assets/readme-layers-dark.svg){.clip .clip-dark}

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
| `.` | Next decision in this layer |
| `n` | Next unread file, rolling from one layer's last unread file into the next |
| `J` / `K` | Next / previous file, staying inside the active layer |

Each layer carries its own progress, read off the same hunk marks
**Finish review** reports. A layer tagged *mechanical* changes no behaviour, a
rename or call sites following a signature, and keeps its files folded.

On a pull request, row 0 of the list is the **Overview**: the pull request's
description, in the place a guide takes on a local review. See
[Reviewing a pull request](/guide/pr-review).

## Decisions

Under a layer's summary the agent may list its **decisions**: what it chose,
found, or ran into while making this step, one short line each. Most layers
have none. A plumbing step has nothing to decide, and the list is absent rather
than empty.

A decision is one of three things, and the line says which without a label:

- the agent **chose** between real alternatives you might weigh differently: a cache, a data shape, a fallback
- the code **now does** something the diff does not make obvious: a 400 where there was an empty list, a sort every caller sees
- something in the repo or the environment **shaped** the change: no clock on the model, tests that could not run

Each line is a plain statement a teammate who has not seen the code gets in a
second: the effect, not the mechanism. Read the lines before the diff, or
instead of it. Click one and the card opens under it: one sentence from the
agent, then a chip for each place the decision names (a decision can span
hunks, the rule and the test that pins it) that goes there, and **Comment**.
`.` walks the layer's decisions one by one, landing on the first place of
each.

**Comment** opens the layer's own comment box with the decision quoted, so the
thread sits with the step the agent explained rather than on a line that may
move, and the agent knows which decision is meant. Like a summary, a decision
never pre-reviews: it says what was done and why, never whether it is fine.

## The plan stays honest

Layers are resolved against the live changeset on every refresh. A file the
agent touches after posting, or one no layer names, gathers in a trailing
**Since your review** layer, so nothing hides outside the plan. One line at the
foot of the tab asks the agent to re-outline, and a re-post keeps your place for
every title that survives.

Read marks live on hunks, not on layers, so a re-post can never lose one.

## Commenting on a layer

A question about the step itself, not a line in it: why these files belong
together, whether the order is right, a summary that says too much. The layer's
card has **Comment on this layer** under the summary, and the thread lives
there, with the agent on the other end like any other thread. The agent is
handed the layer as it was outlined when you wrote the comment, title, summary
and files, so a later re-post never changes what you were asking about.

A layer thread follows its layer by title across re-posts. A re-post that drops
the title retires the thread with it: it moves to the threads the changeset
left behind, intact, and a thread you had sent reads as addressed.

Only the agent's layers take a comment. *Since your review* is Diffo's, not the
agent's, and the pull request **Overview** is the description: comment on those
the way you would on the whole changeset. On a pull request a layer thread is
always private; GitHub has no layers to post it to.

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
