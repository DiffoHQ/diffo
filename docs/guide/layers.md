# Read it in layers

A diff arrives in alphabetical order, which is almost never the order it should
be read in. **Layers** are the agent's reading plan: the change as ordered steps,
each with a title, a short summary, and the files that belong to it. You read one
layer at a time, in the order the agent would explain it.

![Layers in Diffo: the header chip suggests layers and the reviewer accepts; the request crosses to the agent, which splits the 13-file change into four ordered layers and posts them with diffo layers; the layers land in the rail, the first layer's card draws its diagram, its files are read and ticked, and \] steps to the second and third layers.](../assets/readme-layers.svg){.clip .clip-light}
![Layers in Diffo: the header chip suggests layers and the reviewer accepts; the request crosses to the agent, which splits the 13-file change into four ordered layers and posts them with diffo layers; the layers land in the rail, the first layer's card draws its diagram, its files are read and ticked, and \] steps to the second and third layers.](../assets/readme-layers-dark.svg){.clip .clip-dark}

Layers come from the agent only. The session that wrote the change still
remembers the order it would explain it in; Diffo never guesses a plan from
paths, and with no layers the review is exactly the flat file list.

## Asking for them

Three ways in, all the same ask:

- **The header chip.** When the agent thinks the change reads better in order,
  it says so at open, and the header shows *agent · suggests layers* with the
  agent's reason beside it. One click.
- **The Layers tab.** Its **Ask the agent for layers** button works whether the
  agent suggested it or not. **Layer by**, above it, picks what the layers
  are for; it opens on your
  default preset, and its menu ends with **Manage presets**. When the agent's suggestion
  names a preset and you have no default of your own, the picker opens on
  that one, with *Suggested by the agent* and its reason under it; with a
  default of your own, the picker stays on yours and the suggestion is a line
  you can take, *The agent suggests Importance*; the menu marks that preset
  *suggested* either way. The suggestion is remembered for the review: remove
  the layers later and the tab opens on it again, or on the preset the agent
  picked when you let it choose. **Add instructions**, under the button, opens a
  small dialog for what you want this time on top of the preset, and
  **One-time instructions** in the menu opens the same dialog to say what
  you want in your own words instead.
- **In the terminal.** Say "layers" to the agent. It offers exactly this in its
  handoff message when it suggests them.

The ask reaches the agent through its poll. The tab reads *Layering…* and the
presence chip *layering the change* until the layers land, a moment later.

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
rename or call sites following a signature, and keeps its files folded. A
layer tagged *background* is how the change is done rather than what you
decide on: implementation the other layers already describe, tests, build
wiring. Once there are background layers, the tab groups them under two
quiet labels that fold: **Key changes** and **Other changes**, each with how
many layers it holds and its lines added and removed. Other changes starts
folded; open it to check something, and a layer in it reads like any other.
Which groups are open is remembered. **Since your review**, what moved after
the layers were posted, is a third group at the end, with **Add to layers**
on its label. A hair of progress under the head fills as you mark the key
changes.

The pane reads a layer's files in the order the agent put them in. The foot
of the layer's card, **Read the files in**, offers the two orders: the agent's,
or **folder order**, the way the Files tab lists them. `J` / `K` and `n`
follow the pick; the rail shows the layer's files as a folder tree either way.
One pick covers every layer, and it is remembered across reviews.

The book in the head of the list opens the **Overview**: the agent's guide
to the change, and on a pull request its description. `[` from the first
layer goes there too. See
[Reviewing a pull request](/guide/pr-review).

## A file in two steps

Some files hold more than one step: the contract at the top, the call sites
further down. The agent can give each step only the part that belongs to it,
and the review says so wherever you look.

In the pane, the file's header carries a chip, **3 of 7 hunks**, and the
hunks that read in another step fold into one row where they sit:

> ▸ 2 hunks in step 3 · Consumers

Open the row to see them in place, dimmed, or click the step's name to go
read them there. **Whole file** on the header opens everything: every hunk,
with all the lines between. **Viewed** on that header marks the step's
hunks, not the whole file, so reading step 1's half never ticks step 3's.

In the rail, the layer's count says *2 files · 1 split*, and the file's row
reads *3 of 7 hunks*; its mark is that part's. On the Files tab the file
says *steps 1 · 3* after its name, and its mark is the whole file's, mixed
while one part is read and the other is not.

How much of each file you see is yours to pick. Beside the reading order on
the card, **Show this layer changed** offers *lines | hunks | files*,
narrowest first, one for each way the agent can split a file. *Hunks* is
what's above: the step's hunks, plain. *Files* shows every hunk of each file,
other steps' hunks too, dimmed and tagged with their step, in place of the
folded rows. *Lines*, the default, is the step's hunks with the lines the
agent highlighted lit and the rest dimmed (next section). It changes only
what you see — **Viewed** still marks this step's part. A pick that would
show the same as *hunks* in a step is greyed, and its tooltip says why. One
pick for the whole review, remembered across reviews.

Nothing can hide in the split. Every changed line belongs to exactly one
step. A line no step claims lands in *Since your review*, lit, like a file no
step lists, and the agent hears about it the moment it posts: the ack names
the lines left out, and the next step is a re-post with them placed. A
post where two layers claim the same line is refused.

## Highlighted lines

The agent points at the lines each step is about. Under **Show this layer
changed · lines**, the default, those lines keep the diff's full colour and
the rest of the hunk steps back, grey — every line still there, so a hunk
several steps share reads differently in each. A hunk the step highlights
nothing in is not part of it: it folds under the name of the step that does
highlight it, like a split file's other hunks. A file the step lists without
a highlight is the step's throughout, and lights in full. *Hunks* and *files*
show the same hunks plain; in a step the agent highlighted nothing in,
*lines* is greyed. A changed line no step claims is still read, lit, under
*Since your review*.

**Viewed** under a step that highlights a file marks its highlighted lines,
not its hunks: reading one step's lines of a shared hunk leaves the other
step's unread. A hunk counts as read once all its changed lines are, by
whichever steps.

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

## What the layers are for

The same change can be layered more than one way. The head of the Layers tab
names the **preset** the layers follow, *Layered by* **Importance**. Click it
and it opens to why: one line on what the layers show, whether you picked the
preset or the agent suggested or picked it, and your note for this change if
you gave one. The **more** menu beside it acts on the layers: **Layer
again**, **Manage presets**, and **Remove layers**. To change the preset, use
**Layer again**, there or in the line under the list (*Layers not quite
right?*); leaving the pick to the agent is in that dialog, under **Layer by**.

Layering again is the agent's heavy step, so nothing in the tab starts it on
its own. **Layer again** opens a small dialog on what the layers follow now;
its **Layer again** button is what asks, and its **Manage presets** link goes
to the presets. The dialog has one
more field, **For this change only**: a note for the agent on top of the
preset, such as *start with the migration, keep the tests in background*.
Where the note and the preset disagree, the note wins. It is kept with these
layers, shown when you open the head as *Your note*, and filled in again the next
time you layer again; it is never saved with your presets. **One-time
instructions** is the same box with no preset: the agent layers the change by
what you write, once, and the head reads *Layered by* **your instructions**.

A preset tells the agent how to split a change into layers: what to read
closely, in what order, and what goes to background. Two are built in, named
for what the change is layered by, and what you mean to do with the change
tells them apart: read all of it, or sign it off.

| Preset | What you get | Use it when |
| --- | --- | --- |
| **Concept** | One idea per layer, in the order the change was built. Each layer is a change you could approve on its own, the way it would have been one small pull request: the code with its call sites and tests, needing only the layers before it. A layer that changes existing behaviour says so, and anything beyond the request is a layer of its own | You will read the whole change: ordinary size, or bigger and made of parts that stand alone |
| **Importance** | The lines that matter most; the rest in background. A budget: at most five layers and about 150 changed lines, the most important first (the data, then the contracts, then the few places that decide), every file given as short line ranges and never whole, each layer titled as the question you answer | You will sign the change off rather than read it: it is too big to read whole, you directed it and trust it, or it is a second look |

Importance promises a size, and says in its last layer what the budget cut.
For a different size, say so in a note for this change (*up to 400 lines*),
or keep a preset of your own.

Anything narrower, a domain or a concern (*only the database changes*, *what
could break first*), is **One-time instructions** when it is about this
change, and a preset of your own when you will want it again: ask the agent
for it in the dialog and it writes one.

**Let the agent choose**, the default, leaves the pick to the agent: it reads
the change, chooses by each preset's *use it when*, and **Why this preset**
says it picked and why. While the agent is layering again, the head says so.
**Remove layers** asks first and then takes the layers away; your read marks
and threads stay, and you can ask for layers again.

**Manage presets** opens the **Layers presets** dialog, the same one the gear
menu's **Layers presets** opens. The presets are cards down the left; clicking one
shows it, and the default wears a badge. A preset opens on its name, its one
line, and a card with what it says; tags beside the name say what it is (*Built in*,
*Default*, *Disabled*), and the **more** menu at the end of the row holds what
can be done to it: **Make default** sets what new layers follow,
**Disable** takes it out of the choices, yours and the agent's, and
**Delete** asks, in a dialog, before it removes one of yours and its
conversation. Built-ins can't be edited; **Make a copy to edit** makes one
your own, every field prefilled. With a review open, the bar at the foot of
the dialog layers it by the one in view, **Layer by Concept**, and names the
preset the review's layers follow when they follow one.

The card reads top to bottom: **Use it when**, then **What the agent is
told**, which opens on its first lines with **Show all** for the rest. On one
of yours, **Manual edit** turns the card into a form of the four fields, with
**Save** and **Cancel**. Attached under it, the way a comment sits under the
lines it is about, is the conversation with the agent: a thread like
any in a review, where you say what to change (*put every new environment variable in the review layers,
before the routes*): the message rides to the agent through its next poll,
the agent answers in the conversation and edits the fields, and each edit
shows as a line, *Changed instructions · undo*; once taken, it reads
*undone*. The agent is sent the preset's
fields as they stand with every message, so it always works from what the
dialog shows. It is one conversation per preset, kept with it across reviews;
**New conversation** clears the messages and leaves the preset as it is. Asked about a built-in, the
agent makes a changed copy under your own presets and names it in its answer
there; **Make a copy to edit** does the same by hand.

Layers stay when you delete the preset they follow: the head reads
*Layered by a deleted preset*, and **Layer again** opens on the agent's choice.

**New preset** opens on the conversation, with the same **Manual edit**
beside its name: type the fields, or tell the agent
what you want to review and what to skip (*only the public API and anything
that writes to disk; tests and UI go to background*) and it fills them in.
Your first message makes the preset: it sits under *yours* from then on,
called **New preset** and marked *empty*, so moving to another card or
closing the dialog loses nothing, and the conversation carries on there. An
empty preset is not offered in **Layer by** and the agent never picks it;
once it has instructions it is a preset like any other. Opening **New
preset** and leaving without writing anything makes nothing.
Presets and their conversations follow you, not the repo: they live beside
the theme and the voice, on this machine, for every review.

## The plan stays honest

Layers are resolved against the live changeset on every refresh. A file the
agent touches after posting, one no layer names, or the hunks of a split file
that no step claims any more, gather in a trailing **Since your review**
layer, so nothing hides outside the plan. **Add to layers**, on the
*Since your review* label, is the light way to absorb them: the agent puts
them in the layers you have, and nothing else changes — same layers, same
preset, same note, no dialog. **Layer again**, in the head's menu, is the full
one: a new split of the change. Either way a re-post keeps your place for
every title that survives.

Read marks live on hunks and their lines, not on layers, so a re-post can
never lose one.

## Commenting on a layer

A question about the step itself, not a line in it: why these files belong
together, whether the order is right, a summary that says too much. The layer's
card has **Comment on this layer** in its corner, and the thread lives under
the card, with the agent on the other end like any other thread. The agent is
handed the layer as it was when you wrote the comment, title, summary
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

Two commands: `diffo layers --suggest "<why>" [--preset <id>]` at open, and
`diffo layers --json '<Layer[]>'` to post, only when you ask.
[Layers in the agent protocol](/agents#layers) has the doctrine, and the
[CLI reference](/reference/cli#diffo-layers) has the shape of a layer.
