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
| 1. Open | `diffo --no-open` | Starts the review and prints the URL. `--no-open` because an agent should never throw a browser window at someone; it hands over the URL instead, immediately, before anything else |
| 2. Guide | `diffo comment -m "…"` | One comment on the whole changeset (a map of the change, not a reading order), only when the changeset needs it, written while the reviewer is opening the page. See [the guide comment](#the-guide-comment) |
| 2b. Layers | `diffo layers --suggest "…"` | Optional: a flag that this read benefits from an ordered outline. The outline itself is posted only when the reviewer asks. See [layers](#layers) |
| 3. Attach | `diffo poll --title "…"` | Blocks until the reviewer acts, then prints one payload. The title becomes the reviewer's browser tab name; see [the tab title](#the-tab-title) |
| 4. Act | (edits, and `diffo reply`) | Work the threads the payload named, and answer each one |
| 5. Re-attach | `diffo poll` | Also a statement: see [re-polling closes the batch](#re-polling-closes-the-batch) |
| 6. Detach | `diffo end` | When the review is over |

Step 1 returns immediately, leaving a background server, so it is a short command
and not something the agent waits on. Only the poll blocks.

## The tab title

Every Diffo tab is titled "Diffo", which is fine until the reviewer has three
of them open. The poll that attaches carries `--title "<the change, in 2-3
words>"`, and that becomes the tab's whole name: `tab titles`, not
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
- Anything over 40 characters is cut with an ellipsis, a backstop against an
  essay, not a target.
- The title is part of the review state: it survives a reload and a server
  restart, and it is dropped when the reviewer clears the review; that round
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
                               // "layers" = the reviewer asked for the outline · "cleared" = they started over
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

A `kind: "layers"` payload is the reviewer pressing **Ask the agent to outline**,
or *re-outline* over an outline that has gone stale. It carries no threads and owes no
reply: the prompt restates the whole [layers](#layers) doctrine and asks for one
`diffo layers --json` post, which is what concludes it. A `kind: "cleared"`
payload is the reviewer starting the review over; it owes nothing but a fresh
guide, if the changeset warrants one.

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
| **What** | A map of the change, not a tour of it, written for a reader who never saw the session: the problem it solves and what it changes, in a sentence or two; the flow it changes, from what sets it off to what someone sees, as a small ```` ```mermaid ```` diagram when a picture beats words (functions where code carries it, people and screens when they are the flow, never a file list or which code references which); what has to stay true, as checks for the reviewer to run (an invariant the change must keep, a judgment call it made, a shortcoming it knows about); and what they can skip. Ingredients, not sections: a rename needs no diagram, a one-file change needs no checks |
| **Not in it** | A reading order or a file list. [Layers](#layers) and the Files tab own those; a change that reads better in order gets `diffo layers --suggest`, not a numbered guide |
| **How much** | About a hundred words of prose plus the diagram, one screen |
| **The legend** | In the diagram, new code is tagged `:::new` and changed code `:::changed`, with two `classDef` lines `diffo help guide` prints verbatim; a plain node is anything existing the change now leans on. A reviewer sees the seam where new meets old by color, in the same visual language on every review |
| **The line it must not cross** | Orient reading, never pre-review: no verdicts, nothing is "fine" |
| **When it goes stale** | The agent replies to its own guide thread with a short update, rather than posting a second guide |

The reason it is a map: every other tool infers a summary by reading the diff
back. The session that wrote the change still holds what no diff shows — the
invariant it had to respect, the seam it chose, the alternative it rejected, what
it left alone on purpose — and that is what a reviewer cannot get anywhere else.
Pre-review is the one thing it may not add: a guide that says the change is
correct has judged the code for the person whose independent judgment is the
reason Diffo exists. If a takeover happens, the new agent inherits the existing
guide and updates it in place, so the reviewer never ends up with two.

The map is also navigation. A file the guide names — as `` `path` `` or
`` `path:line` `` in prose, or in a diagram node — becomes a jump to that file
in the review, the same way a layer summary's references do. `diffo help guide`
carries the whole doctrine and one worked example, labelled as one shape that
works rather than the shape.

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
| **The ask** | The reviewer's click arrives through the poll as a `kind: "layers"` payload, with the doctrine restated and no threads to answer. The Layers tab reads *Outlining…* and the presence chip *outlining layers* until the post lands; a re-poll without a post lets the request lapse and gives the reviewer their button back |
| **Re-outline** | The same ask over an existing outline, from the line at the foot of the Layers tab. The payload names the layers they have and asks for the whole list again, which is how *Since your review* gets absorbed. Ids survive for titles that match, so the reviewer's place holds. There is no "remove": an outline is replaced, or cleared with the review |
| **When to suggest** | When the change has an order worth explaining. A wide diff with one idea does not need layers; four files can hide three steps. Agent judgment, no file-count threshold |
| **Order** | The order you would explain it, not the order you wrote it: the file that explains the rest first, mechanical consequences last. For a feature, follow the request from entry point to effect; for a refactor, contract first, then consumers |
| **Mechanical** | `"kind": "mechanical"` marks a layer that changes no behaviour (a rename, call sites following a signature); its files render folded. If unsure, don't tag |
| **Summaries** | What the layer is about, and enough context to review it: the part its files cannot show on their own. No template: the agent writes it however the step reads best, kept short, without retelling the diff. The guide's line holds verbatim: orient reading, never pre-review |
| **Diagrams** | When the step has a shape (a flow, a decision, a before/after), a small ```` ```mermaid ```` diagram usually beats prose. Nodes are tagged `:::new` / `:::changed` with the guide's two classDef lines |

A layer:

```jsonc
{
  "title": "Weekday resolution",
  "summary": "A bare weekday resolves to the *next* occurrence. Read `weekday.ts` first.",
  "kind": "mechanical",            // optional, only when nothing changes behaviour
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
| | `disconnected` | A poll died without detaching, and the agent never came back |
| **listening** | `polling` | A poll is open. A Send arrives now |
| **working** | `delivered` | Feedback handed over, no reply yet |
| | `replied` | A reply just landed; a grace window before the next state |
| | `repolling` | The poll ended on its own (the window closed, the process was killed) and the session is alive; its next poll is expected |
| | `stalled` | Delivered over **5 minutes** ago with nothing back |

Three deliberate choices here. `stalled` stays *inside* **working** rather than
becoming its own state, because a slow agent and a dead agent look identical from
outside; the reviewer gets the elapsed time and decides. There is a grace after each
reply, so an agent working through a batch does not flicker between states on every
`diffo reply`: with a known session pid the grace lasts while that process lives (capped
at **10 minutes**), without one it is a fixed **90 seconds**. And a poll that ends without
`diffo end` — the poll window closing, or the harness killing the process — parks the
agent in that same grace as `repolling` rather than dropping to **waiting**: the CLI tells
the session to re-run the poll, and it normally does within moments, so the reviewer
must not be asked to invite an agent that is still there. Only when the grace runs out
without a re-poll does the review read `disconnected`.

If nothing is attached at all, every thread carries a **Copy prompt** button: the
same prompt the poll would have delivered, ready to paste into any agent.

## One session owns a review

Each `diffo poll` identifies its session by walking up the process tree for a
recognisable coding-agent process (`claude`, `cursor`, `codex`, `copilot`, and
friends), skipping shell processes and the wrappers that only exist to run the
CLI (`npx`, `tsx`) on the way, and sends that pid as `x-diffo-session-pid`.

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

## Reviewing a pull request

When the target is a pull request (`diffo <PR URL>`), the agent is a copilot
for code it did not write, and the protocol bends in four places, all of them
carried by the open output and the payloads, as usual:

- **Where to work.** The open prints the worktree Diffo checked the PR out in.
  The agent runs its investigation there (tests, grep, the code) and leaves the
  worktree as it found it: an uncommitted edit would show in the reviewer's
  diff as if the pull request had it. It never commits or pushes.
- **What it is told about trust.** The PR description, its commits and every
  GitHub comment are third-party text. Payloads frame them as information to
  weigh, never as instructions.
- **What reaches it.** Only the reviewer's private threads, and none of them
  carries an intent label: a pull request's composer has no Change / Question
  chips, so the agent reads what is wanted from the words. Public review
  comments are drafted for GitHub and post when the reviewer finishes; the
  agent never sees them as feedback and never posts to GitHub. When the answer
  is a fix, it goes in a ```suggestion block in the reply, not an edit to the
  worktree; the reviewer can turn that reply into a public draft.
- **How it ends.** Finish submits the review on GitHub and hands the private
  threads to the agent as always. A poll then returns a `"kind": "submitted"`
  notice (the verdict, the comment count, the body), which is context, not work.

The guide and layers work as on any review, built from the description, the
commits and the diff; the guide is skipped when the description already orients.

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
