# Read it commit by commit

The Files tab shows the change as it stands: every commit folded into one diff.
That is the right view for "what does this do now", and the wrong one for a
branch that was built in deliberate steps. **Commits** reads it the way it was
written: one commit at a time, oldest first, each against its own parent.

## The tab

**Commits** sits beside Files, Threads and Layers. Each row is a commit: its
subject, short sha, author, when, and how many files and lines it touched.
Edits not yet committed follow the commits as a last row, **Uncommitted
changes**, because a branch review includes the working tree too.

Picking a row narrows the reading pane to that commit's own diff, under a card
with its message. The pane bar says where you are, `commit 2 / 5 · 3 files · 1
left`, and pages to the commits on either side.

| Key | |
| --- | --- |
| `]` / `[` | Next / previous commit |
| `n` | Next unread file in this commit |
| `J` / `K` | Next / previous file in this commit |

The tab opens on the first commit with something unread.

## Marks are shared with Files

A commit's box ticks every file in *its* diff, and a commit reads as done once
all of them are. Marks are kept per hunk, and a hunk is identified by its
content, so a hunk no later commit touched is the same mark in both views.
Read commit 1 here and its untouched files are ticked on the Files tab; tick a
file there and the commit that made it, unchanged since, shows it read.

A hunk a later commit rewrote is two different hunks: reading the early version
does not mark the final one. That is the point: the final version is code you
have not seen yet.

## Comments

Comment on a line in a commit the way you would anywhere. The thread keeps the
code you commented on, so the agent reads exactly what you saw. On the Files
tab it sits on the same line when that line survived, and on its file when a
later commit moved it on.

## What it leaves out

- **Merge commits.** Their diff against the first parent is the base branch
  coming in, not the change. The Files tab still shows the result.
- **Working-tree reviews.** With nothing committed there are no commits to
  step through, and the tab says so. Open the review against a branch
  (`diffo main`) to read it commit by commit.
- **Image previews and expanding context** in a commit read the current files,
  not that commit's version.
