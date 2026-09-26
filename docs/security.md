# Security model

Diffo runs on the machine where your unreviewed, often agent-written, code
lives. That makes "what does it do, exactly?" a fair question, whether you're
an individual deciding to run it or a security team deciding to allow it.
This page is the answer, written to be checked against the source. The
[trust model and disclosure policy](https://github.com/DiffoHQ/diffo/blob/main/SECURITY.md)
live in the repo; this page is the operational detail.

## The short version

| Question | Answer |
| --- | --- |
| Network egress | **None of Diffo's own.** No telemetry, no accounts, no model APIs. Reviewing a pull request talks to that PR's GitHub host, only through your own `gh` |
| Listens on | `127.0.0.1` only, one port per repo |
| Who can connect | Local processes; web pages are actively defended against |
| Writes to your repo | **Never to your working tree or branches.** A pull-request review adds refs under `refs/diffo/`, a `diffo/pr-N` branch, and a worktree of its own under `~/.diffo`; `diffo clean` removes them |
| State on disk | Under `~/.diffo`, owner-readable only: one SQLite file (`0600`), plus a log and a checkout per pull request reviewed |
| Install scripts | **None.** The npm package has no `postinstall` or other hooks |
| Runtime dependencies | 8, all mainstream |
| Releases | Built and signed on GitHub Actions with npm provenance |

## Nothing leaves your machine

Diffo is one local process. Every HTTP request in the codebase targets its own
loopback server; there is no analytics endpoint, no update check, no crash
reporter, and no model API; it holds no keys because it calls no models. The
review you see in the browser is served from `127.0.0.1`, computed live from
your git repository.

The one exception is a review you open on a pull request. Diffo then reads and
posts to that PR's GitHub host, and only through the GitHub CLI you are signed
in with: every call is a `gh` subprocess with typed arguments, Diffo never opens
a socket to GitHub itself, and it never holds a token. Opening the review runs
`gh api user` once to learn who you are signed in as, and while the review is
open Diffo polls the pull request through `gh` every 45 seconds, and runs a
`git fetch` of its head from the same host when that head has moved. Nothing
posts before you finish the review, and nothing from the pull request's text
ever selects a command.

## Loopback-only, and defended anyway

The server binds `127.0.0.1` and authenticates no one; local processes are
trusted (it's your machine reviewing your working tree). What is *not* trusted
is the web: pages you happen to have open in the same browser are inside the
threat model, so the server defends against the ways a page could reach a
localhost service:

- **DNS rebinding**: requests must carry a loopback `Host`
  (`localhost`, `127.0.0.1`, `[::1]`); a page rebound from `evil.com` fails
  this check even though the connection lands on the right socket.
- **Cross-site requests**: a non-loopback `Origin` is rejected, so a browser
  page on another origin cannot drive the API, and side-effectful endpoints
  additionally require a custom header a cross-site request can't send.

These guards have their own test file
([`security.test.ts`](https://github.com/DiffoHQ/diffo/blob/main/src/server/security.test.ts)).

## The reviewed code is treated as hostile

Diffo exists to read code nobody has vetted yet, so repo content must never
gain execution in the review UI:

- Files are rendered inert: highlighted text, never live markup.
- Markdown in comments, replies, and the agent's layer summaries goes through
  [DOMPurify](https://github.com/cure53/DOMPurify) before it touches the DOM;
  the parser is not the trust boundary, the sanitizer is. Text imported from
  GitHub on a pull request (the description, reviews, third-party comments)
  takes the same path as a local comment.
- File-serving endpoints resolve symlinks and re-check the real path, so a
  crafted repo can't read files outside its own tree.

## What's stored, and where

The diff itself is never stored; it's recomputed from git on demand. What
persists is review state: comment threads, the agent's layers (titles, summaries,
and file paths), read marks, and a registry of running servers, all in a single SQLite file at `~/.diffo/diffo.db`. The
directory is created `0700` and the file `0600`, so it's readable by the
owning user only. Two more things live beside it: a background server's log at
`~/.diffo/logs/<repo>-<hash>.log`, and, for each pull request you review, the
checkout at `~/.diffo/worktrees/<repo>-<hash>/pr-<N>`.

To remove every trace, run `diffo clean --all` first, then delete `~/.diffo`.
A pull-request checkout is a linked worktree of your clone, so deleting the
directory by hand leaves the `diffo/pr-N` branch, the `refs/diffo/pr/N` ref
and a stale worktree entry behind in the clone; `diffo clean` takes those with
it.

On your repository, Diffo never touches the working tree or the branches you
made: the git commands a local review runs (`diff`, `merge-base`, `show`,
`ls-files`, …) inspect state; nothing stages, commits, or edits. A pull-request
review writes, but only to things Diffo owns: `git fetch` stores the PR's head
under `refs/diffo/pr/N` and refreshes the base's remote-tracking ref, then
`git worktree add` creates the `diffo/pr-N` branch and the checkout under
`~/.diffo/worktrees`. Moving that checkout to the fetched head (`git reset --hard`)
happens inside the worktree, and only when it is clean. The branch, the ref
and the worktree are removed together: when the PR is merged or closed and you
dismiss the offer to start fresh, when the review is pruned after 60 days
untouched, or by `diffo clean`.

## Supply chain

Since 0.0.2, every release of `@diffohq/diffo` is built and published by a
[GitHub Actions workflow](https://github.com/DiffoHQ/diffo/blob/main/.github/workflows/publish.yml)
using npm trusted publishing; there is no npm token anywhere to steal, and
each tarball carries a signed [provenance attestation](https://docs.npmjs.com/generating-provenance-statements)
binding it to the exact public commit and workflow run that built it. To
verify what you installed:

```bash
npm audit signatures
```

Other properties a scanner (or a human) will care about:

- **No install scripts.** Installing the package runs nothing.
- **Eight runtime dependencies**, all widely used: `hono`,
  `@hono/node-server`, `shiki`, `marked`, `mermaid`, `beautiful-mermaid`,
  `dompurify`, `@tanstack/react-query`.
- **Apache-2.0**, one public repo, every release tagged.

## What about the agent skill?

The skill is a markdown instruction file; it grants no permissions and
executes nothing by itself. It tells a coding agent how to drive the same CLI
a human would (`diffo poll`, `diffo reply`, `diffo layers`, …), and those commands talk to the
same loopback server under the same guards. Whatever your agent is allowed to
do comes from your agent harness's own permission system, not from Diffo. One
deliberate property to know: text a reviewer types into a review is delivered
verbatim to the attached agent; Diffo does not stand between you and your own
agent.

## Reporting

Found a hole in any of the properties above? That's exactly what we want to
hear about; please use
[private vulnerability reporting](https://github.com/DiffoHQ/diffo/security/advisories/new)
rather than a public issue. Scope and expectations are in
[SECURITY.md](https://github.com/DiffoHQ/diffo/blob/main/SECURITY.md).
