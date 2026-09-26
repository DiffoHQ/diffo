# The review loop

A Diffo review is a conversation with the agent that wrote the code.

## The agent orients you first

On a change that's multi-file, structural, or just subtle, the agent leaves a
single guide comment anchored to the whole changeset: a map of the change. What
it does and why, in a sentence; how the changed pieces talk to each other, as a
small [mermaid](https://mermaid.js.org) diagram of the runtime flow when the
shape is easier to see than to read; what has to stay true, as checks for you to
run — the invariant the change must keep, a judgment call the agent made, a
shortcoming it knows about; and what you can skip. It renders in the thread, so
the picture is where you're already looking, and it fits one screen.

In the diagram, new code and changed code carry their own outline color, and a
plain node is existing code the change now leans on — so the seam where new
meets old is visible at a glance, in the same visual language on every review.
The map is also navigation: a file the guide names, in prose or in a diagram
node, is a click away.

What the guide is not is a reading order. That is what [layers](#read-it-in-layers)
are for, and the agent offers them instead when the change reads better in
order.

The agent hands you the URL first and writes the guide while you open the page,
so the link never waits on the diagram. The guide sits at the top of the review
when it lands; if you've already scrolled into a file, a banner under the header
points at it.

The guide has one hard rule: it orients your reading and never pre-reviews it.
No verdicts, and nothing is declared "fine". That judgement is the part you
came for, so the agent doesn't get to make it. When the diff explains itself,
there is no guide at all, and silence is the correct outcome.

If the change moves on while you're reading, the update lands as a reply under
the same guide thread rather than as a second guide.

## Read it in layers

A diff arrives in alphabetical order, which is almost never the order it
should be read in. **Layers** are the agent's reading plan: the change as
ordered steps, each with a title, a short summary, and the files that belong
to it. You read one layer at a time, in the order the agent would explain it.

Layers come from the agent only; Diffo never guesses a plan from paths. With
no layers, the review is exactly the flat file list.

The rail's **Layers** tab offers **Ask the agent to outline this**. When the
agent thinks the change reads better in order it says so at open, and the
header chip (*agent · suggests layers*) is the same ask in one click. Picking a
layer narrows the reading pane to its files under a card with the summary,
which renders markdown and mermaid like a thread does; `]` / `[` step between
layers, and `n` rolls from one layer's last unread file into the next. A layer
tagged *mechanical* keeps its files folded.

Layers are resolved against the live changeset on every refresh. A file the
agent touches after posting, or one no layer names, gathers in a trailing
**Since your review** layer, and one line at the foot of the tab asks the agent
to re-outline; a re-post keeps your place for every title that survives.
Progress per layer is read off the same hunk marks Finish review reports.

A layer summary follows the guide's rule: it orients your reading and never
pre-reviews it.

## You read

Syntax-highlighted unified/split diffs, keyboard-first navigation, context
expansion, images side by side, file-level viewed tracking with a progress
bar. Reading, not scrolling. (See the
[keyboard shortcuts](/reference/keyboard-shortcuts).)

## The review stays live

The agent keeps writing; new files appear, stats tick, fresh hunks pulse. If
something you already marked viewed changes, the mark comes off and the hunk
says *changed since you read it*.

## You comment: on a line, a range of lines, a file, or the whole changeset

Every comment is a thread, marked **Change** (edit the code) or **Question**
(answer it, touch nothing).

For more than one line, drag down the line numbers and release — the composer
opens on the range. The line you started on is the range's **anchor**; the
▲/▼ on the composer's chip walk the other edge one line at a time, up past the
anchor or down through it and out the other side, and every press has an exact
inverse — no selection is ever lost to a stray click. Shift-click puts that
edge on any line directly. Your draft is held outside the composer, so
reshaping the range mid-sentence never eats what you typed.

A sent range comment stays legible in the diff: a small glyph on its first
line, a thin spine down to its card, and the whole range lights up when you
hover the card. The agent receives the range too —
`src/db.ts:214-231 (new side)`, not just one line.

- **Send to agent** delivers it now.
- **Add comment** queues it.
- **Finish review** hands the whole batch back with honest coverage stats
  attached ("38/42 hunks viewed, 2 files skipped").

## The agent fixes and answers in place

A **Change** gets the edit: the agent's code changes are detected
automatically, the diff updates live under your cursor, and the thread flips
to *addressed*. A **Question** gets its answer as an inline reply in the
thread.

The UI always shows the agent's presence (*waiting* / *listening* /
*working*), so you know whether a Send reaches a live agent or waits in the
queue. If nothing is attached, every thread carries a **Copy prompt** you
can paste into any agent, registered or not.

## No background agents, ever

Diffo spawns nothing. The agent you're already talking to stays attached
through `diffo poll`. Your feedback returns into the session that authored
the code, where all the context is.

There is no coverage gate and no verdict to sign: the comments and the
coverage *are* what the agent receives.
