# Keyboard shortcuts

The review UI is keyboard-first. Press `?` in the review for this sheet.

## Move

| Key | Action |
| --- | --- |
| `j` / `k` | Next / previous hunk |
| `J` / `K` | Next / previous file |
| `n` | Next unreviewed file |
| `/` | Filter files |

## Read

| Key | Action |
| --- | --- |
| `v` | Mark **this file** reviewed |
| `h` | Hide reviewed files |
| `u` | Unified / split |
| `o` | Collapse / expand file |
| `b` | Show / hide the file list |

## Comment

| Key | Action |
| --- | --- |
| `c` | Comment on this hunk |
| `⌘↵` | Add the comment |
| `esc` | Close / cancel |
| `?` | This sheet |

`v` marks a whole file, not the hunk under the cursor, which is worth knowing
because coverage is reported per hunk. Reading every hunk in a file and pressing `v` are
two different claims, and Finish review sends both.

`⌘↵` **adds** the comment and leaves it in your review; it does not send it to
the agent. Sending is **Send to agent** on a single thread, or **Finish review**
for the batch.

Multi-line comments are mouse grammar rather than keys: **drag** down the line
numbers to select a range, **shift-click** a line number to move the open
composer's free edge there, and the **▲/▼** on the composer's chip walk that
edge one line at a time — through the starting line and out the other side, so
a run of ▼ reads "this line as top, N lines down". Every press is reversible.
