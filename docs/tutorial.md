# Your first review

In about five minutes you'll open a review of code an agent just wrote, read it, ask for
changes, and watch the fixes land while you're still reading. That loop is the point: you
aren't signing off on finished code, you're shaping it live with the agent that wrote it.

::: info Before you start
- **Your agent needs the Diffo skill.** It's what teaches it to open reviews and answer
  your comments. [Getting started](guide/getting-started.md) installs it in one command.
- **Node >= 24** and **git**.
- **A repo with uncommitted work in it.** Any edit will do.
:::

## 1 · Ask your agent to open a review

In the session that wrote the code, type `/diffo` or say "open a diffo review".

<video class="clip" src="./assets/t0-slash.mp4" muted loop playsinline width="1560" height="806" poster="./assets/t0-slash-poster.jpg" preload="none"
  aria-label="Typing /diffo in Claude Code: the skill loads, diffo opens a review, the header shows the agent listening, and the reviewer starts reading."></video>

The agent opens the review and hands you the URL. It's attached and listening from the
first second (see the **listening** badge in the header), so your comments land in the
session with all the context, and its answers land back in your threads immediately.

If the change is multi-file or structural, it also leaves a guide: one comment on the whole
changeset saying what the change does, with a diagram when the shape is easier to see than
to read. It orients your reading and stops there, with no verdicts, so you start with a map
instead of a wall of diff.

## 2 · Review the code

Read the diff, start threads on any line, file, or changeset. Every one of them is a
live conversation with the agent that opened the review.

<video class="clip clip-light" src="./assets/t2-read.mp4" muted loop playsinline width="1440" height="1102" poster="./assets/t2-read-poster.jpg" preload="none"
  aria-label="Pressing j moves through hunks, v marks a file reviewed, n jumps to the next unread file, and the counter above the diff drops toward zero."></video>
<video class="clip clip-dark" src="./assets/t2-read-dark.mp4" muted loop playsinline width="1440" height="1102" poster="./assets/t2-read-dark-poster.jpg" preload="none"
  aria-label="Pressing j moves through hunks, v marks a file reviewed, n jumps to the next unread file, and the counter above the diff drops toward zero."></video>

The bar above the diff counts down as you mark files reviewed: `12 left`, then
`all reviewed`.

To comment, press `c` on a hunk, or hover any line and click the button in the gutter.
For several lines at once, drag down the line numbers and release — the composer opens
on the range, and the ▲/▼ on its chip (or a shift-click) adjust the edge one line at a
time without losing what you've typed.

<video class="clip clip-light" src="./assets/t3-comment.mp4" muted loop playsinline width="1440" height="1102" poster="./assets/t3-comment-poster.jpg" preload="none"
  aria-label="A comment composer opens on a line of the diff, the Question chip is selected, and a real question is typed before Add comment."></video>
<video class="clip clip-dark" src="./assets/t3-comment-dark.mp4" muted loop playsinline width="1440" height="1102" poster="./assets/t3-comment-dark-poster.jpg" preload="none"
  aria-label="A comment composer opens on a line of the diff, the Question chip is selected, and a real question is typed before Add comment."></video>

Every comment is either a **Change** or a **Question**. A Change asks for an edit. A
Question gets an answer and nothing else: the agent is told not to touch the code, so
"why a Map here?" never turns into an unrequested refactor.

Then pick where it goes:

- **Add comment** (`⌘↵`) keeps it on the review while you continue reading.
- **Send to agent** delivers it right away.

Send comments one at a time or batch the review and send it at the end, same as GitHub.

## 3 · Finish the review

Whatever you send arrives in the agent's session anchored to the code it points at, and
its reply comes back into the same thread.

<video class="clip clip-light" src="./assets/t5-loop.mp4" muted loop playsinline width="1560" height="806" poster="./assets/t5-loop-poster.jpg" preload="none"
  aria-label="The reviewer sends a question; the Claude Code session receives it, works it, and replies, and the answer appears inside the thread."></video>
<video class="clip clip-dark" src="./assets/t5-loop-dark.mp4" muted loop playsinline width="1560" height="806" poster="./assets/t5-loop-dark-poster.jpg" preload="none"
  aria-label="The reviewer sends a question; the Claude Code session receives it, works it, and replies, and the answer appears inside the thread."></video>

When you're done reading, hit **Finish review** in the header.

A preview shows exactly what will be sent: every thread, plus your coverage
(`38/42 hunks read, 2 files skipped`). Add a closing note if you want — it goes out as a
thread on the whole changeset, leading the batch, and the agent replies to it there.

After you send:

- The header flips to **working**, and the threads you sent show as in flight.
- The agent receives your comments, each anchored to the code it's about.
- Questions get an inline reply in their thread. Changes get the edit, and the diff
  updates as each one lands.
- When the batch is done, the header returns to **listening**, ready for your next round.

No pull request, no push, no waiting for CI, and no context lost between the person who
read the code and the agent that wrote it.

## Repeat until the code is ready

<video class="clip clip-light" src="./assets/t10-fix.mp4" muted loop playsinline width="1560" height="806" poster="./assets/t10-fix-poster.jpg" preload="none"
  aria-label="The reviewer marks a comment as a Change; the agent edits the file and replies, and the diff re-renders with the change in it."></video>
<video class="clip clip-dark" src="./assets/t10-fix-dark.mp4" muted loop playsinline width="1560" height="806" poster="./assets/t10-fix-dark-poster.jpg" preload="none"
  aria-label="The reviewer marks a comment as a Change; the agent edits the file and replies, and the diff re-renders with the change in it."></video>

The agent's fixes land in the same review: the diff re-renders as it works, so you're
reading the fix itself, not a promise of one.

This is the whole idea. Review isn't a gate the code passes at the end; it's how the
code gets finished. The agent stays in the flow with you, round after round: read what
changed, comment again, send again. When every thread is resolved and the diff reads
clean, the code is ready.

## Your review is durable

Comments live in Diffo's local server, not in the agent's session. Close the terminal,
kill the agent, or restart the machine: the review and everything you sent are still
there, and the next agent to attach picks up whatever wasn't answered yet. Threads are
scoped per repo and branch, so switching branches never mixes reviews.

## Where to go next

- [The agent protocol](agents.md): how an agent attaches, what a poll payload
  carries, and how presence works.
- [Architecture](architecture.md): the diff pipeline, the delivery queue, and the SQLite
  state.
- [FAQ](faq.md): the short answers.
