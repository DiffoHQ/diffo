# The review loop

A Diffo review is a conversation with the agent that wrote the code.

## The agent orients you first

On a change that's multi-file, structural, or just subtle, the agent opens the
review with a single guide comment anchored to the whole changeset: one sentence
on what the change does, plus a small
[mermaid](https://mermaid.js.org) diagram when the shape is easier to see than
to read. It renders in the thread, so the picture is where you're already
looking.

The guide has one hard rule: it orients your reading and never pre-reviews it.
No verdicts, and nothing is declared "fine". That judgement is the part you
came for, so the agent doesn't get to make it. When the diff explains itself,
there is no guide at all, and silence is the correct outcome.

If the change moves on while you're reading, the update lands as a reply under
the same guide thread rather than as a second guide.

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
