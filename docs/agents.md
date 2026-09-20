# The agent protocol

Diffo never spawns an agent, calls a model, or holds an API key. The agent that
wrote the code attaches to the review itself, by running one command, and
everything it is asked to do arrives in the JSON that command prints.

This page explains that mechanism for a person: what "attached" means, what the
agent receives, and what it is obliged to do with it. It is the page to read when
you want to know why feedback went where it went.

The instructions the agent itself follows are generated, not written here. They
live in the [Agent Skill](https://github.com/DiffoHQ/diffo/blob/main/skills/diffo/SKILL.md)
and in the prompt the server builds for every payload, both produced from the same
source strings, so the two cannot drift apart. For command syntax, see the
[CLI reference](/reference/cli#agent-commands).

## What "attached" means

An agent is attached when it is holding an open `diffo poll`. That is the whole
relationship: no registration, no handshake, no process of Diffo's running on the
agent's behalf. Three things follow from it.

- **Feedback lands where the context is.** The poll runs inside the session that
  wrote the code, so a comment arrives in the conversation that already knows why
  the code looks like that.
- **An agent that is not polling is not reachable.** Sends queue instead, and the
  review says so (presence reads **waiting**). Nothing is lost; the next poll
  collects it.
- **Diffo does not care which agent it is.** Any process that can run a shell
  command can drive the loop, registered or not.

## The loop, from the agent's side

| Step | What the agent runs | Why it matters |
| --- | --- | --- |
| 1. Open | `diffo --no-open` | Starts the review and prints the URL. `--no-open` because an agent should never throw a browser window at someone; it hands over the URL instead — immediately, before anything else |
| 2. Guide | `diffo comment -m "…"` | One orientation comment, only when the changeset needs it, written while the reviewer is opening the page. See [the guide comment](#the-guide-comment) |
| 2b. Layers | `diffo layers --suggest "…"` | Optional: a flag that this read benefits from an ordered outline. The outline itself is posted only when the reviewer asks. See [layers](#layers) |
| 3. Attach | `diffo poll --title "…"` | Blocks until the reviewer acts, then prints one payload. The title becomes the reviewer's browser tab name — see [the tab title](#the-tab-title) |
| 4. Act | (edits, and `diffo reply`) | Work the threads the payload named, and answer each one |
| 5. Re-attach | `diffo poll` | Also a statement: see [re-polling closes the batch](#re-polling-closes-the-batch) |
| 6. Detach | `diffo end` | When the review is over |

Step 1 returns immediately, leaving a background server, so it is a short command
and not something the agent waits on. Only the poll blocks.

## The tab title

Every Diffo tab is titled "Diffo", which is fine until the reviewer has three
of them open. The poll that attaches carries `--title "<the change, in 2-3
words>"`, and that becomes the tab's whole name — `tab titles`, not
`tab titles · Diffo`.

Two or three words is not a style preference. A tab in a crowded strip shows
around twenty characters and cuts the rest, so the app's own name would spend
half the budget repeating what the favicon already says, and the word that
tells this review apart has to come first rather than last.

It is the agent's to send because the agent is the only party that knows what
the changeset is at the moment it starts listening. The rules:

- The newest title wins. A changeset that grows into something else renames its
  own tab on the next poll that carries one.
- A poll without `--title` leaves the name alone, so re-polling through a long
  review never has to repeat itself.
- Until some poll sends one, the tab reads "Diffo" exactly as it always did.
- A review served from a source checkout reads `dev · <title>`, so a dev review
  is never mistaken for a shipped one at a glance.
- Anything over 40 characters is cut with an ellipsis — a backstop against an
  essay, not a target.
- The title is part of the review state: it survives a reload and a server
  restart, and it is dropped when the reviewer clears the review — that round
  is over, and the poll woken by the clear names the next one.

## What a poll payload carries

One JSON object, discriminated by `status`:

| `status` | Meaning |
| --- | --- |
| `feedback` | Work is waiting. The only status that carries any |
| `timeout` | The 30-minute cap on this poll closed. Nothing is lost; poll again |
| `superseded` | Another session took the review. Do not re-poll |
| `ended` | The agent side detached with `diffo end`. Do not re-poll |

A `feedback` payload:

```jsonc
{
  "status": "feedback",
  "kind": "threads",           // "threads" = individual sends · "finish" = the reviewer is done reading
  "threadIds": ["4f1c9a2e-…"], // reply to each of these
  "prompt": "…",               // the authoritative instruction (see below)
  "next_step": "…"             // what to do once they are all handled
}
```

`prompt` is prose, built server-side, and it is what the agent actually acts on.
It carries the thread text, a snapshot of the hunk each thread is anchored to as
it was **when the comment was written**, the intent contract below, and the reply
protocol. Because it is assembled per payload, an agent with no skill installed
and no memory of this page still receives complete instructions.

A `kind: "finish"` payload is the reviewer pressing **Finish review**: the whole
batch at once, with coverage attached (`38/42 hunks read, 2 files skipped`). Any
closing note leads that batch as its own thread on the whole changeset, with an id
to reply to. It re-ships every thread that was sent, including ones already
answered, and the prompt tells the agent not to answer those twice.

## Change or Question: the intent contract

Every thread carries the reviewer's intent, and the contract is two lines, shipped
verbatim in the prompt:

> `question` threads want an answer, not an edit. Reply in the thread; change no
> code for them unless the reviewer asks.

> `issue` threads want a code change. Address each one, or push back in the thread
> with your reasoning.

This is the load-bearing distinction in the whole tool. A reviewer asking "why a
Map here?" wants a sentence, and an agent that answers with a refactor has made
the diff worse and moved the code under a reader mid-review. Disagreeing with a
change request is allowed, in the thread, with reasons. Ignoring it is not.

The prompt adds two rules with the same intent: change only what the threads ask
about, and re-read the current file before editing, because the snapshot in the
prompt was frozen when the comment was written.

## Re-polling closes the batch

The single behaviour most worth understanding, because it is not obvious from the
command.

**A new poll is read as "I have finished the previous lot."** Asking for more work
is a statement about the old work. So when a poll arrives, every thread from the
previous batch that never got a reply stops saying *waiting on the agent* and
starts saying *no answer*, and the review shows it that way to the reviewer.

The consequence for an agent is: handle the payload, then poll. Not poll, then
start working. And a thread the agent decided not to act on still needs a reply
saying so, because a reason is an answer and silence is not.

A batch also closes when the agent runs `diffo end`, or when its connection dies.
Whatever was still owed is recorded as unanswered, so the review stops waiting on
a thread the agent has moved past.

## The guide comment

Right after handing over the URL, an agent is asked to judge whether a cold reader
needs orientation, and if so to post exactly one comment on the whole changeset.
The URL goes first because writing a guide is the slowest step of an open, and a
reviewer waiting for a link should not wait on a diagram: the guide lands live at
the top of the review, and a banner points at it if they have already scrolled
into a file. The
doctrine is stated once in the source and interpolated into every surface that
teaches it, so all of them say the same thing:

| | |
| --- | --- |
| **When** | Multi-file, structural, or subtle. Skipped when the diff explains itself |
| **What** | One sentence on what the change does, plus a small ```` ```mermaid ```` diagram if a picture explains the shape better than words |
| **The line it must not cross** | Orient reading, never pre-review: no verdicts, nothing is "fine" |
| **When it goes stale** | The agent replies to its own guide thread with a short update, rather than posting a second guide |

That last constraint is the point of the whole step. A guide that says the change
is correct has pre-reviewed the code for the person whose independent judgment is
the reason Diffo exists. If a takeover happens, the new agent inherits the existing
guide and updates it in place, so the reviewer never ends up with two.

## Layers

A diff arrives in alphabetical order, which is almost never the order it should
be read in. **Layers** are the agent's reading plan: the change as ordered steps,
each a coherent unit a person would explain in one breath, with the files that
belong to it. They come from the agent only, because the session that wrote the
code still remembers the order it would explain it in; Diffo never guesses a
plan from paths, and with no layers the review is exactly the flat file list.

Two commands, one doctrine:

| | |
| --- | --- |
| **Suggest** | `diffo layers --suggest "<why, in one line>"`, at open, next to the guide. It flags that this read benefits from layers, without writing them. The review shows the offer to the reviewer; the reason is quoted next to it |
| **Post** | `diffo layers --json '<Layer[]>'`, or the same JSON piped to `diffo layers --stdin`. Posted only when the reviewer asks, because writing an outline is the heavy step and most changesets never need one |
| **When to suggest** | When the change has an order worth explaining. A wide diff with one idea does not need layers; four files can hide three steps. Agent judgment, no file-count threshold |
| **Order** | The order you would explain it, not the order you wrote it: the file that explains the rest first, mechanical consequences last. For a feature, follow the request from entry point to effect; for a refactor, contract first, then consumers |
| **Mechanical** | `"kind": "mechanical"` marks a layer that changes no behaviour (a rename, call sites following a signature); its files render folded. If unsure, don't tag |
| **Summaries** | One or two sentences per layer, markdown with a ```` ```mermaid ```` fence if it helps. The guide's line holds verbatim: orient reading, never pre-review |

A layer:

```jsonc
{
  "title": "Weekday resolution",
  "summary": "A bare weekday resolves to the *next* occurrence. Read `weekday.ts` first.",
  "kind": "mechanical",            // optional — only when nothing changes behaviour
  "files": [
    "src/weekday.ts",
    { "path": "src/dates.ts", "note": "delegates to resolveWeekday; the old arithmetic goes" }
  ]
}
```

Files are whole files, by path relative to the repo root. A `path:from-to` form
is accepted and reserved; in this version it means the whole file. Unknown paths
are accepted too, since the file may land later, and simply show nothing until
it does.

The rules that make a post safe to repeat:

- **A post replaces the whole list.** The agent never diffs its own outline. Ids
  are minted by the server and kept for every title that survives a re-post, so
  the reviewer's active layer stays under them.
- **Resolution happens at render.** Layers are re-resolved against the live
  changeset on every refresh. A file the agent touches after posting lands in a
  derived trailing layer, *Since your review*, which is never stored; the agent
  absorbs it by re-posting. A renamed file lands there too, under its new name.
- **Marks stay on hunks.** Progress per layer is the same coverage Finish review
  reports, so a re-post cannot lose a read mark.
- A suggestion is cleared by the post that answers it, and refused once layers
  exist. Both go when the reviewer clears the review.

If the agent suggests layers, the suggestion belongs in its handoff message
too, where the reviewer's eyes already are: *say "layers" and I'll outline it
before you start*. Saying it in the terminal is the zero-UI path.

## Presence: what the reviewer can see

The review always shows whether a Send is reaching anybody. The states are derived
from the connection and the queue, never asserted by the agent:

| State | Reason | What it means |
| --- | --- | --- |
| **waiting** | `no-agent` | Nothing attached. Sends queue for the next poll |
| | `ended` | An agent detached deliberately |
| | `disconnected` | A poll died without detaching |
| **listening** | `polling` | A poll is open. A Send arrives now |
| **working** | `delivered` | Feedback handed over, no reply yet |
| | `replied` | A reply just landed; a brief grace window before the next state |
| | `stalled` | Delivered over **5 minutes** ago with nothing back |

Two deliberate choices here. `stalled` stays *inside* **working** rather than
becoming its own state, because a slow agent and a dead agent look identical from
outside; the reviewer gets the elapsed time and decides. And there is a **90-second**
grace after each reply, so an agent working through a batch does not flicker between
states on every `diffo reply`.

If nothing is attached at all, every thread carries a **Copy prompt** button: the
same prompt the poll would have delivered, ready to paste into any agent.

## One session owns a review

Each `diffo poll` identifies its session by walking up the process tree for a
recognisable coding-agent process (`claude`, `cursor`, `codex`, `copilot`, and
friends), skipping shell processes on the way, and sends that pid as
`x-diffo-session-pid`.

The **newest poll wins**. When a second session polls a repo another session already
holds:

- the new poll gets an `x-diffo-took-over-from: <pid>` response header, and is told
  to mention the takeover, since the reviewer's feedback now arrives there;
- the displaced poll returns `status: "superseded"` and is told to stand down rather
  than re-poll, because two agents trading a review back and forth helps nobody.

Nothing queued is lost in a handover: undelivered feedback lives in the review, not
in the poll, so it is re-derived and re-queued for whoever is listening.

Reviews are scoped per **branch** as well. A checkout under a running server swaps
both the review and the delivery queue to that branch's work, so feedback queued on
one branch cannot surface against another branch's hunks.

## Why nothing gets lost

The guarantee is **at-least-once**, and it holds because feedback lives in the
review rather than in any process:

- A payload is not marked delivered until the write to the poll succeeds. Hono
  swallows stream write errors, so a "successful" write is not proof of receipt; an
  unconfirmed payload is delivered again on the next poll.
- The delivery queue is not persisted. On startup it is rebuilt from the threads
  themselves, which means a restart cannot drop feedback nobody collected.
- Killing the poll, the agent, or the server changes nothing about what the reviewer
  sent. The next poll, from any session, picks it up.

The cost of at-least-once is the occasional duplicate, which is why `finish`
re-ships answered threads and the prompt tells the agent to leave them alone.

## Where the agent's instructions live

None of the text an agent reads is maintained by hand:

| Surface | Generated from |
| --- | --- |
| [`skills/diffo/SKILL.md`](https://github.com/DiffoHQ/diffo/blob/main/skills/diffo/SKILL.md) | [`src/skill.ts`](https://github.com/DiffoHQ/diffo/blob/main/src/skill.ts), via `pnpm build:skill`. A test fails if the committed file drifts, which is why it is never hand-edited |
| Every poll payload's `prompt` | [`src/server/prompt.ts`](https://github.com/DiffoHQ/diffo/blob/main/src/server/prompt.ts), the same module the skill imports its command strings from |
| `diffo help agent` | The same strings again, for an agent whose context was compacted mid-review |

## See also

- [CLI reference](/reference/cli#agent-commands): the syntax and output of every
  agent command
- [How it works](/guide/how-it-works): where the poll sits in the system
- [Architecture](/architecture): the delivery queue and the review state machine
