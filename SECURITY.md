# Security Policy

## Reporting a vulnerability

Please **do not open a public issue for security problems**. Instead, use
GitHub's private vulnerability reporting: go to the repository's **Security**
tab and click **Report a vulnerability**
([direct link](https://github.com/DiffoHQ/diffo/security/advisories/new)).

You'll get an acknowledgment within a few days. Please include a reproduction
or a clear description of the attack path — Diffo is small enough that a good
report usually turns into a fix quickly.

## Supported versions

Diffo is pre-1.0: only the **latest release** receives security fixes.

## Trust model

Knowing what Diffo assumes makes it easier to judge what's a vulnerability:

- **The server is loopback-only.** It binds `127.0.0.1` and authenticates no
  one. Requests are guarded against DNS rebinding and cross-site abuse
  (loopback-only `Host`, `Origin` checks, and a custom-header requirement on
  side-effectful polling), because *web pages you visit* are inside the threat
  model.
- **One human, one machine.** Diffo assumes the machine's local processes and
  users are trusted. There is no token or password between local clients and
  the server, and any local process can read or write the review. The review
  database (`~/.diffo`) is created readable by the owning user only.
- **The reviewed repo is hostile.** Diffo exists to review code you have *not*
  vetted — often agent-written. Repo content must never execute in the review
  UI's origin: files are served inert (plain text or sandboxed), and markdown,
  Mermaid, and diff rendering are sanitized. Escapes from this property are
  exactly the reports we most want.
- **Reviewer feedback becomes an agent prompt.** Text typed into a review is
  delivered verbatim to the coding agent. Diffo does not try to protect an
  agent from its own reviewer.

### In scope

- Reaching or driving the server from outside the machine or from a web page
  (rebinding, CSRF, cross-site side effects, response leaks).
- Reviewed-repo content executing scripts, escaping sanitization, or reading
  files outside the repo (path traversal).
- Injection of any kind: command, SQL, or markup that survives sanitization.

### Out of scope

- Attacks requiring a hostile *local* user or process on the same machine
  (accepted single-user model — hardening PRs still welcome).
- Denial of service against your own localhost server (e.g. `/api/shutdown`
  is deliberately unauthenticated).
- Social engineering of the reviewer, or malicious feedback sent to an agent
  by the machine's own user.
