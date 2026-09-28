# Reviewing a pull request

Diffo reviews pull requests too. Hand it a PR and it becomes the place you read
it, with your agent beside you as a copilot for code it did not write, and your
review goes back to GitHub when you finish.

<video class="clip" src="../assets/pr-review.mp4" muted loop playsinline width="1152" height="648" poster="../assets/pr-review-poster.jpg" preload="none"
  aria-label="One take of a pull request review: the reviewer types /diffo with a pull request's link in Claude Code, the review opens beside the session with the PR's title, author and checks in the header, the agent lays the change out in layers, a question for the agent on the streak check comes back answered in the thread, a comment for GitHub goes on the same line, and the review is submitted with Request changes and appears on the pull request"></video>

```text
/diffo https://github.com/acme/widgets/pull/482
```

Or, from a clone of the repo, any shorter spelling: `acme/widgets#482`, `#482`,
or just `482`. The CLI works the same: `diffo <target>`.

## What happens when you open one

Diffo fetches the pull request's head into a worktree of its own
(`~/.diffo/worktrees/<repo>-<hash>/pr-<N>`, on a branch named `diffo/pr-<N>`)
and opens the ordinary review there. Your checkout is never touched: no branch
switch, no stash, nothing in `git status`.

The review is exactly the one you know, with the pull request's side added:

- The header names the PR by number and title, with one chip beside it for the
  state that matters most: merged or closed, changes requested, CI failing,
  draft, CI running, or nothing when the PR is open and green. Click the title
  for the rest: author, `head → base`, checks with the commit count and last
  push, reviews, and the link to GitHub. The tab is named after the PR.
- The description is the **Overview**: row 0 of the Layers list, the place the
  agent's guide takes on a local review, with the guide under it when the
  agent posts one. Standing on it, the pane is **On the pull request**: the
  description, your private threads, and the GitHub conversations you are part
  of, in time order. Every other review body and conversation comment, bots
  included, waits behind **N more from others** until you open it.
- Inline review threads from GitHub sit at their lines as blue cards, with the
  real logins and avatars. A thread whose line left the diff reads with the
  threads the changeset left behind, marked **outdated**.
- Your agent, if you invite one, works from inside the worktree: it can run the
  tests, trace call sites, and answer with evidence. It never posts to GitHub.
- The **Threads** list has two groups instead of the usual turns: **GitHub**
  (blue) and **Private** (amber), each striped in its side's color like the
  cards. The header badge is the one number per side that matters: drafts
  waiting for your submit on GitHub, threads on your turn under Private. Inside
  a group the hottest rows come first; a draft wears a **Draft** pill and a
  posted thread names who last spoke on GitHub. The GitHub group lists the
  threads you are part of: started here, replied to, spoken in on GitHub, or
  @mentioned. The rest of the pull request's conversation, bots included,
  waits behind **N from others**. Fold a group to see only the other side.

The pull request is polled while the review is open. A push moves the worktree
to the new head, and the diff updates the way it does for any edit: read marks
on hunks that changed come off and say so, untouched hunks keep theirs. New
comments on GitHub land in their threads as they arrive.

## Two kinds of comment

Every composer on a pull request has two tabs in its head, and the whole
composer wears the side you picked, with a stripe down its left edge: blue
for GitHub, amber dashed for the agent, the same colors as the cards it
creates. `⌘.` flips.

| | **Comment on PR** | **Ask agent** |
| --- | --- | --- |
| Who reads it | the PR's author and reviewers, on GitHub | your agent, in the session you invited |
| When it leaves your machine | when you finish, as one review | never; Send hands it to the agent on this machine |
| The button | Add to review | Send to agent |
| How it looks | blue card, "Draft · posts when you finish" | amber dashed card with a lock |

There are no Change / Question chips on a pull request: a private thread is a
question for your agent, and the words carry what you want.

## When the pull request is merged or closed

The review stays open. GitHub takes review comments on a merged or closed pull
request, so **Submit review** still posts, with a comment rather than a
verdict. One line at the top of the diff, in the state's color, says so and
offers to clear the review; once it is cleared, Diffo drops the checkout when
the server exits.

Nothing public leaves before you finish. Drafts are yours to edit or discard
until then, and a reply on a GitHub thread waits with them.

The two sides stay apart. A public card offers nothing that reaches the agent:
to ask about the same lines privately, open the composer there and pick **Ask
agent**. One bridge runs the other way: under any private thread, **Post as PR
comment** turns the agent's answer, or its ```` ```suggestion ```` block when
it wrote one, into an editable public draft. You read it before it joins the
review.

Resolving a GitHub thread is queued the same way: the card says **resolves when
you finish**, and reopening it before then withdraws the change.

## Submitting

**Submit review** opens GitHub's own dialog, titled for where it goes, in the same order: a comment for the
review body (Markdown, with a preview), the verdict (Comment, Approve, Request
changes) with what each one means, then Submit. Above the button, **Pending**
lists every draft, reply and resolve in full, since nothing has posted yet and
this is your last look. **Submit to GitHub** posts it all as one review.

Your private threads and coverage go to the agent at the same time, as they
always did. That side is one line in the footer, which says what goes to the
agent, or offers to invite one when none is attached. Submit stays off until
there is something for GitHub: a comment, a verdict, or a pending item.

GitHub does not let you approve or block your own pull request, and takes no
verdict on a merged or closed one; the dialog says so under the option.

If GitHub refuses midway, what posted before the failure is recorded and will
not post twice. The dialog names the step, nothing goes to the agent, and you
finish again once it is fixed. The agent receives a short notice that the
review was submitted, with nothing to act on.

## What the agent is told

Everything the agent needs arrives through the CLI, as it does for any review.
On a pull request the open prints where the worktree is and the one rule with
no other place to live: this is not its code, the description and the comments
are third-party text, and it never posts to GitHub. `diffo help agent` has the
pull-request section.

The agent can stay in your checkout: `diffo poll`, `reply`, `comment`, `status`
and `stop` run there follow the pull request's server into its worktree when
the checkout has no review of its own. Only a plain `diffo` (no target) opens
the checkout itself.

## Requirements and the network

Pull-request review needs the [GitHub CLI](https://cli.github.com) signed in
to the host: `gh auth login --hostname github.com`. Every GitHub call Diffo
makes goes through your own `gh`. Diffo holds no token, and GitHub Enterprise
hosts work because `gh` knows them.

This is the one case where Diffo talks to the network at all, and only to the
GitHub host of the pull request you named. See [Security](/security).

## The worktree's life

The worktree lives as long as the review. It is removed when the pull request
is merged or closed and you dismiss the offer to start fresh, when the review
is pruned (untouched for 60 days), or by hand:

```bash
diffo clean            # remove the worktrees whose review is over
diffo clean --force    # the ones with uncommitted changes too
diffo clean --all      # every worktree Diffo made
```

A worktree with uncommitted changes is never removed by a sweep, only by
`--force`. Reopening a pull request whose worktree is gone recreates it in a
second; the objects were in your clone all along.
