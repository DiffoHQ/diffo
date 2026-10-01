# Usage data

Diffo reports anonymous usage data: two small events per review, plus one when
you turn it off, on by default, announced in the review page before the first
one is sent, and off with one command. This page is the plain-language list. The authoritative one is the
source: [`src/server/telemetry.ts`](https://github.com/DiffoHQ/diffo/blob/main/src/server/telemetry.ts)
is every field that can leave, and when this page and that file differ, the file
is what runs.

## Why

Diffo is a local tool with no account and no server of ours, so without this
there is no way to know whether anyone reviews with it, on what, or whether a
release broke the loop for a kind of review nobody on the team uses. The data
answers four questions: how many machines review with Diffo, how often, what
kind of review (working tree, branch, pull request), and whether reviews get
finished. It is never used to build a history of a person.

## What is sent

Three events, each one HTTPS `POST` of a few hundred bytes of JSON.

| Event | When | Fields |
| --- | --- | --- |
| `review_opened` | `diffo` opens or resumes a review | `kind` (`tree`, `branch`, `pr`) · `agent` (which coding agent ran the CLI: `claude`, `cursor`, `codex`, `copilot`, `windsurf`, `zed`, `aider`, `goose`, `cline`, `amp`, `unknown` for a terminal, `other`) |
| `review_finished` | you press Finish review | `kind` · `threads` (in the finish batch) · `comments` (your messages across them) · `layers` (true if the review had layers) · `duration` (one of `<5m`, `5-15m`, `15-30m`, `30-60m`, `1h+`) · `event` (a pull request's `APPROVE`, `COMMENT`, or `REQUEST_CHANGES`, when one was submitted) |
| `telemetry_disabled` | you turn reporting off, on a machine that has already reported | `source` (`ui` for the Settings → Privacy switch, `cli` for `diffo telemetry off`). The one and last event after your click; a machine that never reported sends nothing at all |

Every event also carries Diffo's `version`, your `platform` (`darwin`, `linux`,
`win32`), CPU `arch`, Node major version, `dev` (true only when Diffo runs from
a source checkout, so the maintainers' own use can be filtered out), and a
`distinct_id`: one random UUID
minted on this machine the first time an event is sent and kept in
`~/.diffo/telemetry-id`, so returning machines can be told from new ones. It is
not derived from hardware, user name, or anything else about you, and turning
reporting off deletes it.

## What is never sent

Code, diffs, comment text, file paths, repository or branch names, the pull
request or anything from it, the agent's replies, your user name, email, or
GitHub identity, environment variables, and your IP address or anything derived
from it. Every event asks PostHog to skip its IP-to-location lookup
(`$geoip_disable`) and to build no person profile (`$process_person_profile:
false`), and the project is set to discard client IP data on arrival, so no
city, country, or coordinates exist on the other side either. The debug switch
below prints exactly what goes; nothing goes that it does not print.

## When it starts

Nothing is sent until the review page has shown you the notice once. The review
that shows it reports nothing at all, not even its finish; reporting begins
with the next review you open. The notice stays until you press OK, or for a
dozen seconds of the page being in front of you, counted only while the tab is
visible and the pointer is off the card. It carries no switch of its own,
Homebrew-style: it says where the switch is, and the switch and the link to
this page live under Settings → Privacy in the review page.

A `CI` environment never reports.

## Turning it off

Settings → Privacy in the review page, which asks once before it turns off, or
any one of these, on any machine:

```bash
diffo telemetry off
```

```bash
export DIFFO_TELEMETRY_DISABLED=1
```

```bash
export DO_NOT_TRACK=1
```

`diffo telemetry` prints the current state and why; `diffo telemetry on` turns it
back on with a fresh id. The environment variables win over the setting, so a
fleet can turn it off for everyone with one line. An environment variable also
hides the notice, since there is nothing to announce.

Turning it off from a machine that has already reported sends one final
`telemetry_disabled` event, carrying only the shared fields and where the click
came from, so opt-outs can be counted against users. Nothing follows it, the
machine's id is deleted at the same moment, and a machine that never reported,
or one silenced by an environment variable, sends nothing.

## Seeing exactly what goes

`DIFFO_TELEMETRY_DEBUG=1` on the server process writes every payload to the
server log (`~/.diffo/logs/`, or `DIFFO_SERVER_LOG`) before it is sent:

```bash
DIFFO_TELEMETRY_DEBUG=1 diffo --foreground
```

## Where it goes

Events go to [PostHog](https://posthog.com), an open-source product analytics
service, in its EU (Frankfurt) region, over HTTPS to `eu.i.posthog.com`. The
project key in the source is a write-only key: it can add events and read
nothing. The project processes these as anonymous events without person
profiles, with IP-to-location lookup off and client IP data discarded. Events
are kept for one year.

## How it is sent

From the review server on your machine, never from the page in your browser
and never from an install script. Each send is fire-and-forget with a two-second
timeout, so a blocked host, a proxy that refuses it, or an offline machine
costs nothing and shows nothing. Node's `fetch` does not read `HTTPS_PROXY`,
so behind a mandated proxy the event simply times out.

## For a security review

- One outbound host, `eu.i.posthog.com`, `POST` only, JSON body. Allow it or
  block it; Diffo works the same either way.
- `DO_NOT_TRACK` is honoured and takes precedence over Diffo's own setting.
- No install-time hooks: the npm package has no `postinstall`.
- The sending code is one readable function in `src/server/telemetry.ts`.
- The [security model](/security) covers everything else that can leave the
  machine, which is only a pull-request review's traffic through your own `gh`.
