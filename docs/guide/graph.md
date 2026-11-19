# Read it as a graph

A diff shows the lines that changed. It does not show how the changed code
connects. The **graph view** shows the change as cards and arrows: a card is a
function that the change touches, with its diff lines, and an arrow is a call
from one card to another.

The **List / Graph** switch in the pane bar turns it on. The graph has the same
hunks as the list. Comments, the Viewed marks and the file filters are shared
between the two views.

## What the graph shows

Diffo parses the head text and the base text of each changed file in the page,
with [tree-sitter](https://tree-sitter.github.io). It has grammars for C++ and
for TypeScript and JavaScript. A file in a different language is one card with
the lines of its hunks, so the graph always holds the whole change.

| In the graph | What it is |
| --- | --- |
| A card with a name | A function that a hunk changes, with its changed lines |
| A card with no name | Changed lines outside a function, or a file with no parser |
| A red card | A function that the change removes |
| A solid arrow | A call whose text names its target: `this.x()`, a full name, a function of the same scope |
| A **Callback** arrow | A callback that is followed from the place that binds it to the code that runs it |
| A box | The folder, then the class, of the cards in it |

The cards are in three columns: **Logic**, **Support** (headers, build files,
configuration) and **Tests**.

There are no types. A call on an object whose class the text does not tell
makes no arrow, so a missing arrow does not mean that there is no call. An
arrow that the graph does show is a fact of the text.

## Moving around

From far, a box shows its name in place of its cards. A click on a box fits it
to the view and opens it one level. The breadcrumb above the graph shows where
the view is, and the outline in the file rail lists the boxes and the cards.

| Key | |
| --- | --- |
| `↓` / `↑` | Next / previous card, through the whole change in one order |
| `→` / `←` | Show the calls out of the selected card, or the calls into it |
| `1` … `9` | Follow the arrow with that number |
| `↵` | On a selected card: mark its changed lines as viewed, or take the mark away. With no card selected: go into the box in focus |
| `esc` | Go up one level |

Drag moves the view, and the wheel zooms. **Overlay** turns the names from far
on and off, and **Comments** shows the threads on each card.

## With layers

In the [Layers](/guide/layers) tab, the graph is the agent's outline: each layer
is a column, and a card is in the column of the layer that holds its lines. The
card of the active layer is above the graph, with its summary and **Comment on
this layer**.

The agent can give a layer more than files. Each of these is optional:

| Field | In the graph |
| --- | --- |
| `color` | The color of the column, or of a box |
| `boxes` | Named boxes around the code at some places, to four levels |
| `arrows` | An arrow between two places, with a label: a flow that is not a call |
| `order` | The order of reading. `↓` and `↑` follow it |
| `notes` | A card with no code: an actor, a decision, a concept |
| `context` | A card for code that the change does not touch |

The graph does not draw the mermaid diagram of a summary. An agent that puts a
diagram in a summary gives the same content as notes, context cards and arrows,
so the two views tell one story. `diffo help layers` has the full shape.

## For the agent: `diffo graph`

`diffo graph` prints the cards and the arrows as JSON, with a list named `open`
of what the text cannot tell: the places where the code gives a callback or an
object to code that is not in the change. See the [CLI reference](/reference/cli#diffo-graph).

## Rules of a repository

The graph has layers of its own. Each one adds to the one below it:

- **Basic**: what the diff tells. True for each change.
- **Language**: what the text of a language tells. True for each repository in
  that language.
- **Repo**: the rules of one repository: where the code of a file runs, the
  calls that the text does not show (across a process, through an event), the
  names of its callback library, its style.

Diffo ships the first two. The Repo layer is an interface with no rules in it
yet: a `GraphRepo` in `src/ui/graph/repo/`, named in the list of
`repo/rules.ts`. When a change is of a repository that has rules, the graph
shows a **Repo** switch. `src/ui/graph/README.md` has the details.
