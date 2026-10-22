# Read it commit by commit

The Files tab folds every commit into one diff. The Layers tab can also read
the branch the way it was written: one commit at a time, oldest first, each
against its parent.

## Steps or commits

On a branch review, the Layers tab carries a switch: **Steps**, the agent's
outline, or **Commits**. Steps is where the tab opens; switch to Commits to
read the branch as it was written, outline or not.

Each row is a commit: subject, short sha, author, age and size. Uncommitted
edits follow as a last row. Picking a row narrows the pane to that commit's own
diff, under its message. The list opens on the first commit with something
unread.

| Key | |
| --- | --- |
| `]` / `[` | Next / previous commit |
| `n` | Next unread file, on into the next commit once this one is read |
| `J` / `K` | Next / previous file in this commit |

## Marks and comments

Marks are per hunk and shared with the Files tab: a hunk no later commit
touched is ticked in both. A hunk a later commit rewrote is a new hunk, still
unread.

A comment keeps the code it was made on. On the Files tab it sits on the same
line, renumbered if a later commit grew the file above it, or on its file if
that line is gone from the final diff.

## Not covered

- **Merge commits** are not listed; their diff is the base branch coming in.
- **Working-tree reviews** have no commits. Open the review against a branch
  (`diffo main`).
- **Image previews** show the current files, not the commit's version.
