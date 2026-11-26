#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { detectHarness, detectSessionPid } from './agentSession.js'
import { findChrome, htmlTitle, previewArtifacts } from './artifactPreview.js'
import { helpFor, parseCliArgs } from './cliArgs.js'
import { SRC_STAMP } from './devStamp.js'
import { GhClient } from './forge/github/gh.js'
import { parseRemoteUrl, parseTarget, prUrl } from './forge/target.js'
import type { PrRef } from './forge/types.js'
import { DiffoDb } from './server/db.js'
import {
  findRepoRoot,
  getBranchName,
  getHeadSha,
  getRemoteUrl,
  listRemotes,
  MissingBaseError,
  mainRepoOf,
  suggestedBase,
} from './server/git.js'
import { type PrContext, RepoAlreadyServedError, startServer } from './server/index.js'
import {
  type PreparedWorktree,
  prepareWorktree,
  servedWorktreeFor,
  sweepWorktrees,
  worktreePathFor,
} from './server/pr/worktree.js'
import {
  ACK_NEXT_STEP,
  CHECKOUT_ROOT,
  CLI_COMMANDS,
  doctrineFor,
  guideInherit,
  guideNudge,
  layersIncompleteStep,
  layersNudge,
  ownPrAsk,
  POLL_NOW,
  POLL_NOW_FOREGROUND,
  POLL_STANCE,
  prOpenNote,
  REVIEWER_NEXT_STEP,
  REVIEWER_POLL_STANCE,
  reviewerSetNudge,
  sharedLayersNote,
  TAB_TITLE,
} from './server/prompt.js'
import {
  describeTelemetry,
  type FailedStep,
  fileMachineIdStore,
  type ReviewKind,
  reviewKindOf,
  Telemetry,
} from './server/telemetry.js'
import {
  assessRunningServer,
  defaultLogPath,
  ensureServer,
  fetchHealth,
  retireServer,
  settleExistingServer,
} from './serverLifecycle.js'
import { apiUrl, reviewUrl } from './serverUrl.js'
import { postRegisterHint, refreshInstalledSkills, runSetup } from './setup.js'
import { findSharedPack, ownPackComment, packOf, renderShareComment } from './share/pack.js'
import { shareCheck } from './share/where.js'
import { boxOf, checkArtifacts, describeArtifact } from './shared/artifacts.js'
import { parseLayersPost, type UncoveredRef } from './shared/layers.js'
import { parsePresetPatch } from './shared/presets.js'
import type { Layers, ReviewState } from './shared/review.js'
import { AGENT_PICKS_SET, isDraftRoleKey, parseRolePatch } from './shared/roles.js'
import type { ChangesetSpec as CliSpec, PrInfo } from './shared/types.js'
import { VERSION } from './version.js'

const command = parseCliArgs(process.argv.slice(2))

function fail(message: string): never {
  console.error(`diffo: ${message}`)
  process.exit(1)
}

function cliTelemetry(db: DiffoDb): Telemetry {
  return new Telemetry({
    store: {
      get: (key) => db.getUiSetting(key),
      set: (key, value) => db.setUiSetting(key, value),
    },
    ids: fileMachineIdStore(),
    log: (line) => process.stderr.write(`diffo: ${line}\n`),
    dev: SRC_STAMP !== null || process.env.ENV === 'development',
  })
}

/** What the open being attempted would review, once that is known. */
let openKind: ReviewKind | undefined =
  command.kind === 'run' && command.target === undefined
    ? reviewKindOf(command.spec, false)
    : undefined

/**
 * An open that stops before there is a review says at which step, then the
 * caller fails as before. Only the CLI a person or agent ran reports: the daemon
 * a fresh open spawns stays quiet, and its failure reaches that CLI as one. The
 * send's own timeout bounds the wait, and nothing here changes how an open fails.
 */
async function reportOpenFailure(step: FailedStep): Promise<void> {
  if (command.kind !== 'run' || process.env.DIFFO_DAEMON) return
  try {
    const db = new DiffoDb()
    try {
      const telemetry = cliTelemetry(db)
      telemetry.reviewFailed({
        step,
        agent: detectHarness() ?? 'unknown',
        ...(openKind ? { kind: openKind } : {}),
      })
      await telemetry.flush()
    } finally {
      db.close()
    }
  } catch {
    // usage data never stands between the reviewer and the real error
  }
}

const missingBaseMessage = (base: string) => `base branch '${base}' doesn't exist in this repo`
/** The daemon's last word, quoted in the CLI's failure, is how a missing base crosses over. */
const MISSING_BASE = /base branch '.*' doesn't exist in this repo/

function probePort(port: number): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const probe = createServer()
    probe.unref()
    probe.once('error', reject)
    probe.listen({ port, host: '127.0.0.1' }, () => {
      const address = probe.address()
      const bound = typeof address === 'object' && address !== null ? address.port : port
      probe.close(() => resolvePort(bound))
    })
  })
}

async function preferredPort(): Promise<number> {
  const db = new DiffoDb()
  let remembered: number | null
  try {
    remembered = db.getPreferredPort(repoPath)
  } finally {
    db.close()
  }
  if (remembered === null) return probePort(0)
  try {
    return await probePort(remembered)
  } catch {
    return probePort(0)
  }
}

function specLabel(spec: CliSpec): string {
  return spec.kind === 'working-tree' ? 'working tree vs HEAD' : `vs ${spec.base}`
}

/** The platform's URL opener. `start` is a `cmd` builtin, not an executable. */
function opener(url: string): [string, string[]] {
  if (process.platform === 'darwin') return ['open', [url]]
  // The empty string is the window title `start` would otherwise read the URL as.
  if (process.platform === 'win32') return ['cmd', ['/c', 'start', '', url]]
  return ['xdg-open', [url]]
}

function openBrowser(url: string): void {
  const [command, args] = opener(url)
  try {
    const child = spawn(command, args, { stdio: 'ignore', detached: true })
    child.once('error', () => {})
    // Never hold the event loop open waiting on a browser.
    child.unref()
  } catch {
    // spawn can also throw synchronously — same fallback, the printed URL
  }
}

if (command.kind === 'error') {
  console.error(`diffo: ${command.message}`)
  console.error(`try: diffo --help`)
  process.exit(1)
}

if (command.kind === 'help') {
  console.log(helpFor(command.topic))
  process.exit(0)
}

if (command.kind === 'version') {
  console.log(VERSION)
  process.exit(0)
}

// Needs no repo and no server: it renders a file.
if (command.kind === 'artifact-preview') {
  if (command.file === null && process.stdin.isTTY) {
    fail(
      'artifact preview needs the text: a file (the message you are about to post, or a .html page), or pipe it on stdin',
    )
  }
  let text: string
  try {
    text = command.file === null ? await readStdin() : readFileSync(command.file, 'utf-8')
  } catch (err) {
    fail(`artifact preview: can't read ${command.file}: ${(err as Error).message}`)
  }
  const chrome = findChrome()
  if (!chrome) {
    fail(
      "artifact preview needs Chrome, Chromium, Edge or Brave on this machine, and found none. Point DIFFO_CHROME at one, or post without a preview — the reviewer's browser still reports what breaks.",
    )
  }
  const asHtml =
    command.file !== null && /\.html?$/i.test(command.file)
      ? {
          title: command.title ?? htmlTitle(text, command.file),
          box: boxOf(command.size),
        }
      : undefined
  const result = await previewArtifacts(chrome, text, {
    ...(asHtml ? { asHtml } : {}),
    ...(command.out ? { dir: resolve(command.out) } : {}),
  })
  if (result.artifacts.length === 0) {
    fail(
      result.errors.length > 0
        ? `artifact preview: ${result.errors.join('; ')}`
        : 'artifact preview: no ```artifact fence in that text — pass the message you are about to post, or a .html page',
    )
  }
  const post = command.file === null ? '<the same text on stdin>' : `< ${command.file}`
  console.log(
    JSON.stringify({
      ok: result.errors.length === 0,
      ...(result.errors.length > 0 ? { errors: result.errors } : {}),
      ...(result.warnings.length > 0 ? { warnings: result.warnings } : {}),
      artifacts: result.artifacts,
      next_step: `Look at each screenshot now (read the PNGs) as the reviewer will see them: does the card make its point without opening, is it readable in light and dark, is anything clipped, overlapping, squeezed or empty? Fix what you see${result.artifacts.some((a) => a.issues.length > 0) ? ' and every listed issue' : ''} in one pass, then post it from the same file (\`diffo comment ${post}\` or \`diffo reply <threadId> ${post}\`). Preview once more only if an issue was listed or your fix moved the layout — two runs at most.`,
    }),
  )
  process.exit(result.errors.length === 0 ? 0 : 1)
}

if (command.kind === 'setup') {
  const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  const outcomes = runSetup({ packageRoot, homeDir: homedir() })
  const width = Math.max(...outcomes.map((o) => o.client.length))
  for (const outcome of outcomes) {
    const hint = outcome.status === 'registered' ? postRegisterHint[outcome.client] : undefined
    console.log(
      `${outcome.client.padEnd(width)}  ${outcome.status.padEnd(10)}  ${outcome.detail}${hint ? ` (${hint})` : ''}`,
    )
  }
  if (outcomes.some((o) => o.status === 'manual')) {
    console.log('rows marked manual need the one step described; re-run `diffo setup` after')
  }
  if (outcomes.every((o) => o.status === 'absent')) {
    console.log('\nno supported client found. Install one, then re-run `diffo setup`')
  }
  process.exit(outcomes.some((o) => o.status === 'failed') ? 1 : 0)
}

if (command.kind === 'clean') {
  const db = new DiffoDb()
  try {
    // The sweep the daemon runs in its background, on demand: rows about repos
    // and branches that are gone, so the worktree pass below reads a tidy table.
    await db.maintain()
    const entries = sweepWorktrees(db, undefined, { force: command.force, all: command.all })
    if (entries.length === 0) {
      console.log('no diffo worktrees, nothing to clean')
      process.exit(0)
    }
    const width = Math.max(...entries.map((e) => e.record.prKey.length))
    for (const { record, reason, outcome } of entries) {
      const verdict =
        outcome === null
          ? reason === 'serving'
            ? 'kept: a diffo server is still reviewing in it (--force removes it anyway)'
            : 'kept: review in progress'
          : outcome === 'removed'
            ? reason === 'serving'
              ? 'removed (--force; a diffo server was still reviewing in it)'
              : `removed (${reason})`
            : outcome === 'dirty'
              ? 'kept: uncommitted changes (--force removes it)'
              : outcome === 'unchecked'
                ? `kept: could not check for uncommitted changes, is ${record.repoPath} still there? (--force removes it)`
                : outcome === 'failed'
                  ? 'not removed: git could not remove it; the directory and its row stay'
                  : `row dropped (${reason})`
      console.log(`${record.prKey.padEnd(width)}  ${verdict}  ${record.worktreePath}`)
    }
  } finally {
    db.close()
  }
  process.exit(0)
}

const found = findRepoRoot(process.cwd())
if (!found) {
  await reportOpenFailure('not_repo')
  fail('not inside a git repository')
}
// Reassigned once when the target is a pull request: the review then runs in
// the worktree diffo made for it, and everything below — the registry, the
// server, the URL — is about that path.
let root: string = found
let repoPath = resolve(root)

// A command about a running review, sent from the user's checkout while the
// review runs in a pull-request worktree hanging off it: the agent is invited
// from the checkout and polls from there. Follow the live server into the
// worktree rather than start a second, plain review of the checkout. Opening
// (`diffo` with no target) is not redirected: that asks for the checkout.
if (command.kind !== 'run') {
  const db = new DiffoDb()
  try {
    if (db.liveServer(repoPath) === null) {
      const served = servedWorktreeFor(db, repoPath)
      if (served) {
        process.stderr.write(
          `diffo: no server for this checkout; using its pull request review (${served.record.prKey}) at ${served.record.worktreePath}\n`,
        )
        root = served.record.worktreePath
        repoPath = resolve(root)
      }
    }
  } finally {
    db.close()
  }
}

/**
 * Only the open path settles with the source stamp: opening a review is the
 * moment "run the current source" is the promise, while poll/reply/comment must
 * never restart the server under a review in progress.
 */
async function discoverServer(): Promise<{ port: number; pid: number | null } | null> {
  const db = new DiffoDb()
  try {
    return await settleExistingServer(
      db,
      repoPath,
      VERSION,
      (line) => process.stderr.write(`diffo: ${line}\n`),
      SRC_STAMP,
    )
  } catch (err) {
    await reportOpenFailure('server_start')
    fail((err as Error).message)
  } finally {
    db.close()
  }
}

function sessionHeaders(): Record<string, string> {
  // x-diffo-agent marks a real CLI caller: as a custom header it can never be
  // sent by a web page without a CORS preflight, which the server rejects —
  // the poll endpoint requires it (see the guard in server/index.ts).
  const pid = detectSessionPid()
  return {
    'x-diffo-agent': 'cli',
    ...(pid === null ? {} : { 'x-diffo-session-pid': String(pid) }),
  }
}

/**
 * A worktree Diffo made for a pull request remembers which one: a server that
 * has to be started from inside it (`diffo poll` after the daemon idled out or
 * died) reopens the pull request, never a plain review of the checkout.
 */
function ownedPullRequest(path: string): { target: string; base: string } | null {
  const db = new DiffoDb()
  try {
    const record = db.getWorktree(resolve(path))
    if (!record) return null
    const key = /^([^/]+)\/([^/]+)\/([^/#]+)#(\d+)$/.exec(record.prKey)
    if (!key) return null
    const ref = { host: key[1]!, owner: key[2]!, repo: key[3]!, number: Number(key[4]) }
    return { target: prUrl(ref), base: record.base }
  } finally {
    db.close()
  }
}

async function requireServer(
  port?: number,
  base?: string,
  srcStamp: string | null = null,
  target?: string,
): Promise<number> {
  const owned = target === undefined ? ownedPullRequest(repoPath) : null
  const prTarget = target ?? owned?.target
  try {
    return await ensureServer({
      repoPath,
      version: VERSION,
      entry: resolve(process.argv[1] ?? fileURLToPath(import.meta.url)),
      execPath: process.execPath,
      execArgv: process.execArgv,
      port,
      base: base ?? owned?.base,
      target: prTarget,
      srcStamp,
      // A pull-request daemon re-fetches and re-checks the worktree before it
      // listens; on a large repo that is well past the 8s an ordinary open needs.
      ...(prTarget !== undefined ? { spawnTimeoutMs: 90_000 } : {}),
      logPath: process.env.DIFFO_SERVER_LOG || defaultLogPath(repoPath),
      onStatus: (line) =>
        process.stderr.write(
          `diffo: ${owned && line.startsWith('no diffo server') ? `${line}. This checkout is ${owned.target}, reopening the pull request` : line}\n`,
        ),
    })
  } catch (err) {
    const message = (err as Error).message
    await reportOpenFailure(MISSING_BASE.test(message) ? 'base' : 'server_start')
    fail(message)
  }
}

/**
 * An empty working-tree review usually means the work was committed, not that
 * there is no work: point at the branch's commits when there are any. The one
 * moment the flag is needed is the one moment the default mode shows nothing.
 */
function printBaseHint(spec: CliSpec, files: number): void {
  if (spec.kind !== 'working-tree' || files !== 0) return
  const hint = suggestedBase(repoPath)
  if (!hint) return
  console.log(
    `this branch has ${hint.commits} ${hint.commits === 1 ? 'commit' : 'commits'} since ${hint.base}. Review them with \`diffo --base ${hint.base}\``,
  )
}

interface ChangesetInfo {
  spec: CliSpec
  stats: { files: number; additions: number; deletions: number }
  repo: { name: string; branch: string }
  pr?: PrInfo
}

/**
 * Tells the server a review was opened, and by which agent — the server decides
 * whether that is reported (see server/telemetry.ts). Best effort: an open never
 * waits on, or fails over, usage data.
 */
async function announceOpen(port: number): Promise<void> {
  try {
    await fetch(apiUrl(port, '/api/telemetry/opened'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent: detectHarness() ?? 'unknown' }),
      signal: AbortSignal.timeout(2000),
    })
  } catch {
    // an older server without the route, or a server mid-restart
  }
}

/**
 * An agent opened the review (piped stdout, like `printAgentNextStep`): tell
 * the server it is here before the URL prints, so the reviewer who opens the
 * page while the guide is being written sees an agent orienting itself, not
 * "no agent" and an Invite. A human's terminal open says nothing — the
 * reviewer IS the opener, and the chip must keep offering the invite.
 */
async function announceArrival(port: number): Promise<void> {
  if (process.stdout.isTTY) return
  try {
    await fetch(apiUrl(port, '/api/agent/arrive'), {
      method: 'POST',
      headers: sessionHeaders(),
      signal: AbortSignal.timeout(2000),
    })
  } catch {
    // an older server without the route, or a server mid-restart
  }
}

async function fetchChangesetInfo(port: number): Promise<ChangesetInfo | null> {
  try {
    const res = await fetch(apiUrl(port, '/api/changeset'), {
      signal: AbortSignal.timeout(2000),
    })
    return (await res.json()) as ChangesetInfo
  } catch {
    return null
  }
}

async function fetchReviewState(port: number): Promise<ReviewState | null> {
  try {
    const res = await fetch(apiUrl(port, '/api/review'), {
      signal: AbortSignal.timeout(2000),
    })
    if (!res.ok) return null
    return (await res.json()) as ReviewState
  } catch {
    return null
  }
}

/**
 * The guide: an agent comment on the whole changeset. One per review by
 * convention, so the newest wins if an agent ever posted two. Resolved ones
 * still count — the reviewer resolving a guide means they are done with it, and
 * re-asking for one would only get the review a second guide.
 *
 * A landed review's guide doesn't count at all: it describes a changeset that
 * was committed away, so the next changeset deserves a fresh one — inheriting
 * it would orient the reviewer to work that is already behind them.
 */
function findGuideThread(review: ReviewState): ReviewState['threads'][number] | undefined {
  if (review.landed) return undefined
  return review.threads
    .filter((t) => t.anchor.kind === 'changeset' && t.messages[0]?.author === 'agent')
    .at(-1)
}

/** Two lines of repo + changeset context. A courtesy: any failure prints nothing. */
async function printChangesetSummary(port: number): Promise<void> {
  const info = await fetchChangesetInfo(port)
  if (!info) return
  const { spec, stats, repo } = info
  console.log(`diffo · ${repo.name}${repo.branch ? ` (${repo.branch})` : ''}`)
  const watching = info.pr
    ? `pull request #${info.pr.number} "${info.pr.title}" by @${info.pr.author.login} (${info.pr.base.ref} ← ${info.pr.head.ref})`
    : specLabel(spec)
  console.log(
    stats.files === 0
      ? `watching ${watching} · ${info.pr ? 'no changes' : 'working tree is clean, nothing to review yet'}`
      : `watching ${watching} · ${stats.files} ${stats.files === 1 ? 'file' : 'files'} · +${stats.additions} −${stats.deletions}`,
  )
  if (!info.pr) printBaseHint(spec, stats.files)
}

/**
 * An explicit `--base` against a server watching something else deserves the
 * truth: the server keeps its spec (switching would move the diff under the
 * reviewer), so say what it IS watching and how to switch.
 */
async function warnSpecMismatch(port: number, asked: CliSpec): Promise<void> {
  if (asked.kind !== 'branch') return
  const info = await fetchChangesetInfo(port)
  if (!info) return
  const watching = info.spec
  if (watching.kind === 'branch' && watching.base === asked.base) return
  process.stderr.write(
    `diffo: this server is watching ${specLabel(watching)}, not vs ${asked.base}; ` +
      `run \`diffo stop\`, then re-run with --base to switch\n`,
  )
}

function readStdin(): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    let data = ''
    process.stdin.setEncoding('utf-8')
    process.stdin.on('data', (chunk) => (data += chunk))
    process.stdin.on('end', () => resolvePromise(data))
    process.stdin.on('error', reject)
  })
}

/**
 * Every verb except `poll` — a short request/response against a loopback server,
 * so anything past ten seconds is a wedge, not slowness. Without the deadline a
 * server that goes quiet held the verb for undici's 300s default, long past the
 * point an agent harness gives up, so a `reply` could vanish with no error.
 */
const POST_TIMEOUT_MS = 10_000

async function postJson(
  port: number,
  path: string,
  body: unknown,
): Promise<{ status: number; body: unknown }> {
  let res: Response
  try {
    res = await fetch(apiUrl(port, path), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...sessionHeaders() },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(POST_TIMEOUT_MS),
    })
  } catch {
    fail('lost connection to the diffo server; re-run the command')
  }
  return { status: res.status, body: await res.json().catch(() => null) }
}

async function getJson(port: number, path: string): Promise<{ status: number; body: unknown }> {
  let res: Response
  try {
    res = await fetch(apiUrl(port, path), {
      headers: sessionHeaders(),
      signal: AbortSignal.timeout(POST_TIMEOUT_MS),
    })
  } catch {
    fail('lost connection to the diffo server; re-run the command')
  }
  return { status: res.status, body: await res.json().catch(() => null) }
}

if (command.kind === 'status') {
  const db = new DiffoDb()
  let record: ReturnType<DiffoDb['getServer']>
  try {
    record = db.getServer(repoPath)
  } finally {
    db.close()
  }
  const health = record ? await fetchHealth(record.port) : null
  const verdict = record ? assessRunningServer(health, repoPath, VERSION, SRC_STAMP) : 'foreign'
  if (!record || verdict === 'foreign') {
    if (command.json) {
      console.log(JSON.stringify({ running: false }))
    } else {
      console.log(
        record
          ? 'no diffo server is watching this repo (its last registration is stale)'
          : 'no diffo server is watching this repo',
      )
    }
    process.exit(1)
  }
  const pid = health?.pid ?? record.pid
  const url = reviewUrl(record.port)
  if (command.json) {
    console.log(
      JSON.stringify({
        running: true,
        port: record.port,
        pid: pid || null,
        version: health?.version ?? null,
        url,
      }),
    )
    process.exit(0)
  }
  await printChangesetSummary(record.port)
  console.log(
    `server: port ${record.port}${pid ? ` · pid ${pid}` : ''} · v${health?.version ?? 'pre-handshake'}` +
      (verdict === 'replace'
        ? health?.version === VERSION
          ? ` (the checkout's source changed, the next \`diffo\` replaces it)`
          : ` (this CLI is v${VERSION}, the next \`diffo\` replaces it)`
        : ''),
  )
  console.log(`→ ${url}`)
  process.exit(0)
}

if (command.kind === 'stop') {
  const db = new DiffoDb()
  try {
    const record = db.getServer(repoPath)
    if (!record) {
      console.log('no diffo server is watching this repo, nothing to stop')
      process.exit(0)
    }
    const health = await fetchHealth(record.port)
    if (assessRunningServer(health, repoPath, VERSION) === 'foreign') {
      db.removeServer(repoPath, record.port)
      console.log('no diffo server is watching this repo; cleared a stale registration')
      process.exit(0)
    }
    if (!(await retireServer(record.port, record.pid ?? null, health?.pid ?? null))) {
      fail(
        `the server on port ${record.port}` +
          (record.pid ? ` (pid ${record.pid})` : '') +
          ` would not stop; kill it yourself, then re-run \`diffo stop\``,
      )
    }
    db.removeServer(repoPath, record.port)
    console.log(`stopped the diffo server on port ${record.port}`)
  } finally {
    db.close()
  }
  process.exit(0)
}

if (command.kind === 'telemetry') {
  const db = new DiffoDb()
  try {
    const telemetry = cliTelemetry(db)
    const farewell =
      command.action === 'status' ? false : telemetry.setEnabled(command.action === 'on', 'cli')
    console.log(describeTelemetry(telemetry.status(), command.action, farewell))
    // The one last event must leave before this process does; the send's own
    // timeout bounds the wait.
    await telemetry.flush()
  } finally {
    db.close()
  }
  process.exit(0)
}

/** Why the server refused, in its own words when it gave any. */
function refusal(body: unknown, fallback: string): string {
  return (body as { error?: string } | null)?.error ?? fallback
}

// A reviewer agent takes its seat. Unlike every other verb it starts no server:
// a reviewer joins a review someone opened, it never opens one.
if (command.kind === 'join') {
  const db = new DiffoDb()
  let record: ReturnType<DiffoDb['getServer']>
  try {
    record = db.getServer(repoPath)
  } finally {
    db.close()
  }
  const health = record ? await fetchHealth(record.port) : null
  const verdict = record ? assessRunningServer(health, repoPath, VERSION) : 'foreign'
  if (!record || verdict === 'foreign') {
    fail(
      'no review is running for this repo, so there is nothing to join. The author agent or the user opens one with `diffo`; then run `diffo join` again',
    )
  }
  if (verdict === 'replace') {
    fail(
      `the review running here is served by another diffo build (${health?.version ?? 'unknown'}, this CLI is ${VERSION}); run the same diffo the review was opened with`,
    )
  }
  const { status, body } = await postJson(record.port, '/api/reviewer/join', {
    ...(command.as !== undefined ? { as: command.as } : {}),
    ...(command.role !== undefined ? { role: command.role } : {}),
  })
  if (status !== 200) fail(`join refused: ${refusal(body, `the server answered ${status}`)}`)
  const seat = body as { as: string } & Record<string, unknown>
  console.log(
    JSON.stringify({
      ...seat,
      url: reviewUrl(record.port),
      // The name the review gave back: a fresh one from the pool unless --as.
      next_step: REVIEWER_NEXT_STEP.join(seat.as),
    }),
  )
  process.exit(0)
}

if (command.kind === 'reviewer-set') {
  const port = await requireServer()
  const { status, body } = await postJson(port, '/api/reviewer/pick', {
    set: command.set,
    ...(command.reason === null ? {} : { reason: command.reason }),
  })
  if (status !== 200) fail(`reviewer refused: ${refusal(body, `the server answered ${status}`)}`)
  const { set, roles } = body as { set: string; roles: string[] }
  console.log(
    JSON.stringify({
      ok: true,
      picked: true,
      set,
      roles,
      next_step: ACK_NEXT_STEP.reviewerSetPicked,
    }),
  )
  process.exit(0)
}

if (command.kind === 'reviewer-suggest') {
  const port = await requireServer()
  const { status, body } = await postJson(port, '/api/reviewer/suggest', {
    ...(command.role === null ? {} : { role: command.role }),
    ...(command.reason === null ? {} : { reason: command.reason }),
  })
  if (status !== 200) fail(`reviewer refused: ${refusal(body, `the server answered ${status}`)}`)
  const { suggested, role } = body as { suggested: boolean; role: string }
  console.log(
    JSON.stringify({
      ok: true,
      suggested,
      role,
      next_step: suggested ? ACK_NEXT_STEP.reviewerSuggested : ACK_NEXT_STEP.reviewerAlready,
    }),
  )
  process.exit(0)
}

// A reviewer agent's status line. Quiet on purpose: it is said many times a
// review, and there is nothing to do next but carry on.
if (command.kind === 'progress') {
  const port = await requireServer()
  const { status, body } = await postJson(port, '/api/reviewer/progress', {
    as: command.as,
    text: command.text,
  })
  if (status !== 200) fail(`progress refused: ${refusal(body, `the server answered ${status}`)}`)
  // The human's messages ride back on a progress line: print them, with the
  // next step that says what to do with them.
  const { messages, next_step } = (body ?? {}) as { messages?: unknown; next_step?: unknown }
  console.log(
    JSON.stringify(
      Array.isArray(messages)
        ? { ok: true, from: 'human reviewer', messages, next_step }
        : { ok: true },
    ),
  )
  process.exit(0)
}

// A reviewer agent reads the change through Diffo: the diff itself, plain,
// for it to read; the page counts the files it fetched.
if (command.kind === 'diff') {
  const port = await requireServer()
  const { status, body } = await postJson(port, '/api/reviewer/diff', {
    as: command.as,
    files: command.files,
  })
  if (status !== 200) fail(`diff refused: ${refusal(body, `the server answered ${status}`)}`)
  const { patch, files, missing } = body as { patch: string; files: number; missing?: string[] }
  if (patch !== '') console.log(patch)
  console.log(JSON.stringify({ files, ...(missing ? { missing, why: 'not in this change' } : {}) }))
  process.exit(0)
}

// A reviewer agent's own account, before it stops: what it did not read.
if (command.kind === 'covered') {
  const port = await requireServer()
  const { status, body } = await postJson(port, '/api/reviewer/coverage', {
    as: command.as,
    skipped: command.skipped,
  })
  if (status !== 200) fail(`covered refused: ${refusal(body, `the server answered ${status}`)}`)
  console.log(JSON.stringify(body))
  process.exit(0)
}

if (command.kind === 'chat') {
  const port = await requireServer()
  const { status, body } = await postJson(port, '/api/reviewer/chat', {
    as: command.as,
    text: command.text,
  })
  if (status !== 200) fail(`chat refused: ${refusal(body, `the server answered ${status}`)}`)
  const { next_step } = (body ?? {}) as { next_step?: unknown }
  console.log(JSON.stringify({ ok: true, next_step }))
  process.exit(0)
}

if (command.kind === 'resolve') {
  const port = await requireServer()
  const { status, body } = await postJson(
    port,
    `/api/review/threads/${encodeURIComponent(command.threadId)}/state`,
    { state: 'resolved', as: command.as },
  )
  if (status === 404) fail(`no thread with id '${command.threadId}'`)
  if (status !== 200) fail(`resolve refused: ${refusal(body, `the server answered ${status}`)}`)
  console.log(
    JSON.stringify({
      ok: true,
      threadId: command.threadId,
      state: 'resolved',
      next_step: REVIEWER_NEXT_STEP.resolve(command.as),
    }),
  )
  process.exit(0)
}

// The reviewer agent's inbox: the same long-poll shape as the author agent's,
// on a route of its own that never touches the author's session.
if (command.kind === 'poll' && command.as !== undefined) {
  const port = await requireServer()
  process.stderr.write(
    `diffo: waiting for answers on your threads. Hold this process ${REVIEWER_POLL_STANCE}.\n` +
      'If it dies, just re-run it; answers are held in the review and survive.\n',
  )
  try {
    const res = await fetch(
      apiUrl(port, `/api/reviewer/poll?as=${encodeURIComponent(command.as)}`),
      { headers: sessionHeaders() },
    )
    if (!res.ok) {
      const body = await res.json().catch(() => null)
      fail(`poll refused: ${refusal(body, `the server answered ${res.status}`)}`)
    }
    console.log((await res.text()).trim())
  } catch {
    fail(`lost connection to the diffo server; re-run \`poll --as ${command.as}\` to keep waiting`)
  }
  process.exit(0)
}

if (command.kind === 'poll') {
  const port = await requireServer()
  process.stderr.write(
    `diffo: waiting for the reviewer. Keep this process attended: ${POLL_STANCE}.\n` +
      'If it dies, just re-run it; feedback is held in the review and survives.\n',
  )
  // The response streams whitespace heartbeats until the reviewer acts, then one
  // JSON payload. text() rides the heartbeats out; trim leaves the JSON.
  try {
    // A query param, not a header: a title is the agent's prose and may be any
    // language, while a header must stay latin-1.
    const path =
      command.title === null
        ? '/api/agent/poll'
        : `/api/agent/poll?title=${encodeURIComponent(command.title)}`
    const res = await fetch(apiUrl(port, path), {
      headers: sessionHeaders(),
    })
    if (!res.ok) fail(`poll failed (${res.status})`)
    const tookOverFrom = res.headers.get('x-diffo-took-over-from')
    if (tookOverFrom) {
      process.stderr.write(
        `diffo: another agent session (pid ${tookOverFrom}) was connected to this review;\n` +
          `this poll has taken it over, and that session has been told. Mention this to the\n` +
          `user: their feedback now comes here.\n`,
      )
      // The guide belongs to the review, not to the agent that wrote it: inherit
      // it as orientation, and update it rather than posting a second one.
      const review = await fetchReviewState(port)
      const guide = review ? findGuideThread(review) : undefined
      if (guide) process.stderr.write(guideInherit(guide.id))
    }
    console.log((await res.text()).trim())
  } catch {
    fail('lost connection to the diffo server; re-run `poll` to keep listening')
  }
  process.exit(0)
}

/**
 * The artifact preflight (see shared/artifacts.ts): a fence the reviewer would
 * see broken is refused here, before it leaves the machine; what merely won't
 * work (a CDN script, a fetch) is posted and named back in the ack.
 */
function artifactPreflight(verb: string, texts: string[]): Record<string, unknown> {
  const found: string[] = []
  const warnings: string[] = []
  for (const text of texts) {
    const check = checkArtifacts(text)
    if (check.errors.length > 0) fail(`${verb} refused: ${check.errors.join('; ')}`)
    found.push(...check.artifacts.map(describeArtifact))
    warnings.push(...check.warnings)
  }
  if (found.length === 0) return {}
  return {
    artifacts: found,
    ...(warnings.length > 0 ? { artifact_warnings: warnings } : {}),
    artifact_note:
      'renders in a sandboxed frame when the reviewer opens it; if it throws or draws nothing there, your next poll says so',
  }
}

if (command.kind === 'reply') {
  if (command.message === null && process.stdin.isTTY) {
    fail('reply needs a message: pass --message "<text>" or pipe it on stdin')
  }
  const message = (command.message ?? (await readStdin())).trim()
  if (!message) fail('reply needs a message: pass --message "<text>" or pipe it on stdin')
  const art = artifactPreflight('reply', [message])
  const port = await requireServer()
  if (command.as !== undefined) {
    const { status, body } = await postJson(
      port,
      `/api/review/threads/${encodeURIComponent(command.threadId)}/messages`,
      { as: command.as, text: message, ...(command.ask ? { ask: true } : {}) },
    )
    if (status === 404) fail(`no thread with id '${command.threadId}'`)
    if (status !== 200) fail(`reply refused: ${refusal(body, `the server answered ${status}`)}`)
    const { thread, roundsLeft } = body as { thread: { id: string }; roundsLeft: number }
    console.log(
      JSON.stringify({
        ok: true,
        threadId: thread.id,
        as: command.as,
        ...(command.ask ? { asked: true } : {}),
        ...art,
        next_step: command.ask
          ? REVIEWER_NEXT_STEP.asked(command.as)
          : REVIEWER_NEXT_STEP.reply(command.as, roundsLeft),
      }),
    )
    process.exit(0)
  }
  const { status, body } = await postJson(
    port,
    `/api/review/threads/${encodeURIComponent(command.threadId)}/messages`,
    {
      author: 'agent',
      text: message,
      ...(command.more ? { more: true } : {}),
      ...(command.ask ? { ask: true } : {}),
      ...(command.suggestReply ? { suggestedReply: command.suggestReply } : {}),
      ...(command.prComment ? { prComment: command.prComment } : {}),
    },
  )
  if (status === 404) fail(`no thread with id '${command.threadId}'`)
  // 409: the thread stopped for the human (rounds cap or --ask) and waits on
  // them.
  if (status === 400 || status === 409) fail(`reply refused: ${refusal(body, 'bad request')}`)
  if (status !== 200) fail(`reply failed (${status})`)
  const thread = (body as { thread: { id: string; state: string } }).thread
  console.log(
    JSON.stringify({
      ok: true,
      threadId: thread.id,
      state: thread.state,
      ...art,
      ...(command.prComment ? { prComment: 'suggested' } : {}),
      ...(command.ask ? { asked: true } : {}),
      next_step: command.ask
        ? ACK_NEXT_STEP.replyAsked
        : command.more
          ? ACK_NEXT_STEP.replyMore
          : command.prComment
            ? ACK_NEXT_STEP.replyPrComment
            : ACK_NEXT_STEP.reply,
    }),
  )
  process.exit(0)
}

if (command.kind === 'comment') {
  if (command.message === null && process.stdin.isTTY) {
    fail('comment needs a message: pass --message "<text>" or pipe it on stdin')
  }
  const message = (command.message ?? (await readStdin())).trim()
  if (!message) fail('comment needs a message: pass --message "<text>" or pipe it on stdin')
  const art = artifactPreflight('comment', [message])
  const port = await requireServer()
  if (command.as !== undefined) {
    const { status, body } = await postJson(port, '/api/review/threads', {
      as: command.as,
      file: command.file,
      line: command.line,
      text: message,
    })
    if (status !== 200) fail(`comment refused: ${refusal(body, `the server answered ${status}`)}`)
    const { thread, anchored } = body as {
      thread: { id: string }
      anchored: 'hunk' | 'file' | 'changeset'
    }
    // Where it landed, when that is not where it was aimed: a line outside the
    // diff falls back to its file, a file outside the changeset to the change.
    const aimed = command.line !== null ? 'hunk' : command.file !== null ? 'file' : 'changeset'
    console.log(
      JSON.stringify({
        ok: true,
        threadId: thread.id,
        as: command.as,
        ...(anchored !== aimed
          ? {
              anchored:
                anchored === 'file'
                  ? `the file: line ${command.line} is not among its changed lines`
                  : `the whole change: ${command.file} is not in the changeset`,
            }
          : {}),
        ...art,
        next_step: REVIEWER_NEXT_STEP.comment(command.as),
      }),
    )
    process.exit(0)
  }
  const { status, body } = await postJson(port, '/api/review/threads', {
    author: 'agent',
    file: command.file,
    line: command.line,
    text: message,
    ...(command.suggestReply ? { suggestedReply: command.suggestReply } : {}),
    ...(command.prComment ? { prComment: command.prComment } : {}),
  })
  if (status === 400)
    fail(`comment refused: ${(body as { error?: string } | null)?.error ?? 'bad request'}`)
  if (status !== 200) fail(`comment failed (${status})`)
  const thread = body as { id: string }
  console.log(
    JSON.stringify({
      ok: true,
      threadId: thread.id,
      ...art,
      ...(command.prComment ? { prComment: 'suggested' } : {}),
      next_step: command.prComment ? ACK_NEXT_STEP.commentPrComment : ACK_NEXT_STEP.comment,
    }),
  )
  process.exit(0)
}

if (command.kind === 'layers') {
  const { source } = command
  if (source.kind === 'stdin' && process.stdin.isTTY) {
    fail('layers --stdin needs the JSON piped on stdin, or pass it with --json')
  }
  const port = await requireServer()
  if (source.kind === 'suggest') {
    const { status, body } = await postJson(port, '/api/review/layers', {
      suggest: true,
      ...(source.reason === null ? {} : { reason: source.reason }),
      ...(source.preset === null ? {} : { preset: source.preset }),
    })
    if (status !== 200) fail(`layers failed (${status})`)
    const { suggested, note } = body as { suggested: boolean; note?: string }
    console.log(
      JSON.stringify({
        ok: true,
        suggested,
        ...(note ? { note } : {}),
        next_step: suggested ? ACK_NEXT_STEP.layersSuggested : ACK_NEXT_STEP.layersAlready,
      }),
    )
    process.exit(0)
  }
  // Validated here first so a malformed payload is refused with the layer it
  // names and never leaves the machine; the server checks it again regardless.
  const text = source.kind === 'json' ? source.text : await readStdin()
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (err) {
    fail(`layers needs JSON — a list of layers, or { preset, layers }: ${(err as Error).message}`)
  }
  const parsed = parseLayersPost(raw)
  if (!parsed.ok) fail(`layers: ${parsed.error}`)
  const { items, preset } = parsed.post
  const art = artifactPreflight(
    'layers',
    items.map((l) => l.summary ?? ''),
  )
  const { status, body } = await postJson(port, '/api/review/layers', {
    items,
    ...(preset ? { preset } : {}),
  })
  if (status === 400) fail(`layers: ${(body as { error?: string } | null)?.error ?? 'rejected'}`)
  if (status !== 200) fail(`layers failed (${status})`)
  const {
    layers,
    uncovered = [],
    note,
  } = body as { layers: Layers; uncovered?: UncoveredRef[]; note?: string }
  console.log(
    JSON.stringify({
      ok: true,
      layers: layers.items.length,
      ...art,
      ...(uncovered.length > 0 ? { uncovered } : {}),
      ...(note ? { note } : {}),
      next_step: uncovered.length === 0 ? ACK_NEXT_STEP.layers : layersIncompleteStep(uncovered),
    }),
  )
  process.exit(0)
}

if (command.kind === 'preset') {
  const port = await requireServer()
  const action = command.action
  if (action.kind === 'list') {
    const { status, body } = await getJson(port, '/api/presets')
    if (status !== 200) fail(`preset list failed (${status})`)
    const { presets, default: def } = body as { presets: unknown[]; default: string }
    console.log(JSON.stringify({ ok: true, default: def, presets }))
    process.exit(0)
  }
  if (action.kind === 'show') {
    const { status, body } = await getJson(port, '/api/presets')
    if (status !== 200) fail(`preset show failed (${status})`)
    const preset = (body as { presets: Array<{ id: string }> }).presets.find(
      (p) => p.id === action.id,
    )
    if (!preset) fail(`no preset with id '${action.id}'`)
    const thread = await getJson(port, `/api/presets/${encodeURIComponent(action.id)}/thread`)
    console.log(
      JSON.stringify({ ok: true, preset, thread: (thread.body as { thread: unknown }).thread }),
    )
    process.exit(0)
  }
  if (action.kind === 'reply') {
    if (action.message === null && process.stdin.isTTY) {
      fail('preset reply needs a message: pass --message "<text>" or pipe it on stdin')
    }
    const message = (action.message ?? (await readStdin())).trim()
    if (!message) fail('preset reply needs a message: pass --message "<text>" or pipe it on stdin')
    const { status, body } = await postJson(
      port,
      `/api/presets/${encodeURIComponent(action.id)}/messages`,
      { author: 'agent', text: message },
    )
    if (status === 400)
      fail(`preset reply refused: ${(body as { error?: string } | null)?.error ?? 'bad request'}`)
    if (status !== 200) fail(`preset reply failed (${status})`)
    console.log(
      JSON.stringify({ ok: true, presetId: action.id, next_step: ACK_NEXT_STEP.presetReply }),
    )
    process.exit(0)
  }
  const text = action.source.kind === 'json' ? action.source.text : await readStdin()
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (err) {
    fail(
      `preset update needs JSON — { name?, blurb?, whenToUse?, instructions? }: ${(err as Error).message}`,
    )
  }
  // Checked here first so a bad field is refused with its name.
  const patch = parsePresetPatch(raw)
  if (!patch.ok) fail(`preset update: ${patch.error}`)
  const { status, body } = await postJson(port, `/api/presets/${encodeURIComponent(action.id)}`, {
    fields: patch.patch,
    ...(action.message ? { message: action.message } : {}),
  })
  if (status === 400)
    fail(`preset update refused: ${(body as { error?: string } | null)?.error ?? 'bad request'}`)
  if (status !== 200) fail(`preset update failed (${status})`)
  const { preset } = body as { preset: { id: string; name: string } }
  console.log(
    JSON.stringify({
      ok: true,
      preset: { id: preset.id, name: preset.name },
      next_step: ACK_NEXT_STEP.presetUpdate,
    }),
  )
  process.exit(0)
}

// `diffo role`: the reviewer roles, read and written the way `diffo preset`
// does presets, so the two conversations read alike to an agent.
if (command.kind === 'role') {
  const port = await requireServer()
  const action = command.action
  const path = (id: string) => `/api/reviewer/roles/${encodeURIComponent(id)}`
  if (action.kind === 'list' || action.kind === 'show') {
    const { status, body } = await getJson(port, '/api/reviewer/roles')
    if (status !== 200) fail(`role ${action.kind} failed (${status})`)
    const { roles, default: def } = body as { roles: Array<{ id: string }>; default: string }
    if (action.kind === 'list') {
      console.log(JSON.stringify({ ok: true, default: def, roles }))
      process.exit(0)
    }
    const role = roles.find((r) => r.id === action.id)
    // A draft has no role yet, only its conversation.
    if (!role && !isDraftRoleKey(action.id)) fail(`no role with id '${action.id}'`)
    const thread = await getJson(port, `${path(action.id)}/thread`)
    console.log(
      JSON.stringify({
        ok: true,
        role: role ?? null,
        thread: (thread.body as { thread: unknown }).thread,
      }),
    )
    process.exit(0)
  }
  if (action.kind === 'reply') {
    if (action.message === null && process.stdin.isTTY) {
      fail('role reply needs a message: pass --message "<text>" or pipe it on stdin')
    }
    const message = (action.message ?? (await readStdin())).trim()
    if (!message) fail('role reply needs a message: pass --message "<text>" or pipe it on stdin')
    const { status, body } = await postJson(port, `${path(action.id)}/messages`, {
      author: 'agent',
      text: message,
    })
    if (status === 400)
      fail(`role reply refused: ${(body as { error?: string } | null)?.error ?? 'bad request'}`)
    if (status !== 200) fail(`role reply failed (${status})`)
    console.log(JSON.stringify({ ok: true, roleId: action.id, next_step: ACK_NEXT_STEP.roleReply }))
    process.exit(0)
  }
  const text = action.source.kind === 'json' ? action.source.text : await readStdin()
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (err) {
    fail(`role update needs JSON — { name?, blurb?, focus? }: ${(err as Error).message}`)
  }
  // Checked here first so a bad field is refused with its name.
  const patch = parseRolePatch(raw)
  if (!patch.ok) fail(`role update: ${patch.error}`)
  const { status, body } = await postJson(port, path(action.id), {
    fields: patch.patch,
    ...(action.message ? { message: action.message } : {}),
  })
  if (status === 400)
    fail(`role update refused: ${(body as { error?: string } | null)?.error ?? 'bad request'}`)
  if (status !== 200) fail(`role update failed (${status})`)
  const { role } = body as { role: { id: string; name: string } }
  console.log(
    JSON.stringify({
      ok: true,
      role: { id: role.id, name: role.name },
      next_step: ACK_NEXT_STEP.roleUpdate,
    }),
  )
  process.exit(0)
}

/**
 * The pull request `diffo share` posts on: the one named, else the one this
 * review is of (a pull-request worktree), else the open pull request for this
 * branch on the origin.
 */
async function sharePrRef(target: string | undefined, forge: GhClient): Promise<PrRef> {
  // The URL as configured: an `insteadOf` rewrite names where git talks to,
  // not which repository this is.
  const origin =
    listRemotes(repoPath).find((r) => r.name === 'origin')?.url ?? getRemoteUrl(repoPath)
  const named = target ?? ownedPullRequest(repoPath)?.target
  if (named !== undefined) {
    const parsed = parseTarget(named, origin)
    if (!parsed.ok) fail(parsed.error)
    if (parsed.target.kind !== 'pr') {
      fail(
        `'${named}' is not a pull request; pass a link like https://github.com/owner/repo/pull/482`,
      )
    }
    return parsed.target.ref
  }
  const repo = parseRemoteUrl(origin ?? '')
  if (!repo)
    fail(
      'this repo has no GitHub origin to find the pull request on; name it: diffo share <PR URL>',
    )
  const branch = getBranchName(repoPath)
  const auth = await forge.authStatus(repo.host)
  if (!auth.ok) fail(auth.message)
  let number: number | null
  try {
    number = await forge.findPrForBranch(repo, branch)
  } catch (err) {
    fail(`could not look up the pull request for ${branch}: ${(err as Error).message}`)
  }
  if (number === null) {
    fail(
      `no open pull request for branch '${branch}' on ${repo.owner}/${repo.repo}; push it and open one, or name it: diffo share <PR URL>`,
    )
  }
  return { ...repo, number }
}

if (command.kind === 'share') {
  const port = await requireServer()
  const review = await fetchReviewState(port)
  if (!review) fail('could not read the review from its server')
  const layers = review.layers
  if (!layers || layers.items.length === 0) {
    fail('this review has no layers to share yet; post them first (`diffo help layers`)')
  }
  const forge = new GhClient()
  const ref = await sharePrRef(command.target, forge)
  const auth = await forge.authStatus(ref.host)
  if (!auth.ok) fail(auth.message)
  let fetched: Awaited<ReturnType<GhClient['fetchPr']>>
  try {
    fetched = await forge.fetchPr(ref)
  } catch (err) {
    fail(`could not read pull request #${ref.number}: ${(err as Error).message}`)
  }
  const { pr, threads } = fetched
  // The layers name head-side lines of this checkout. Shared against any other
  // commit they would point the reader at the wrong lines.
  const head = getHeadSha(repoPath)
  if (head !== pr.head.sha) {
    fail(
      `pull request #${pr.number} is at ${pr.head.sha.slice(0, 7)} but this checkout is at ${head?.slice(0, 7) ?? 'no commit'}; ` +
        'the layers point at lines in this checkout, so push (or pull) until they match, then share',
    )
  }
  const dirty = spawnSync('git', ['status', '--porcelain', '--untracked-files=no'], {
    cwd: repoPath,
    encoding: 'utf-8',
  })
  if (dirty.status !== 0 || dirty.stdout.trim() !== '') {
    fail(
      "this checkout has uncommitted changes, so its lines may not be the pull request's; commit and push them, then share",
    )
  }
  const body = renderShareComment(ref, packOf(layers.items, pr.head.sha, new Date().toISOString()))
  if (command.dryRun) {
    console.log(body)
    process.exit(0)
  }
  const existing = ownPackComment(threads, pr.viewer.login)
  let url: string | undefined
  try {
    url = existing
      ? ((await forge.updatePrComment(ref, existing.id, body)).url ?? existing.url)
      : (await forge.addPrComment(ref, pr.nodeId, body)).url
  } catch (err) {
    fail(`could not post the guide on pull request #${pr.number}: ${(err as Error).message}`)
  }
  const db = new DiffoDb()
  try {
    const telemetry = cliTelemetry(db)
    telemetry.layersShared({ update: existing !== null, layers: layers.items.length })
    await telemetry.flush()
  } catch {
    // usage data never stands between the sender and the share
  } finally {
    db.close()
  }
  const n = layers.items.length
  console.log(
    `${existing ? 'updated' : 'shared'} ${n} ${n === 1 ? 'layer' : 'layers'} on pull request #${pr.number}${url ? `: ${url}` : ''}`,
  )
  console.log(
    `to read it with these layers, the reviewer runs: npx -y @diffohq/diffo ${pr.url}` +
      ' (in Claude Code: /diffo ' +
      pr.url +
      ')',
  )
  process.exit(0)
}

if (command.kind === 'end') {
  const port = await requireServer()
  const { status, body } = await postJson(port, '/api/agent/end', {})
  if (status !== 200) fail(`end failed (${status})`)
  const result = body as { ok?: boolean; reason?: string; message?: string } | null
  console.log(
    JSON.stringify(
      result?.ok === false
        ? { ...result, next_step: 'nothing to do: you were not the attached agent' }
        : { ok: true, next_step: ACK_NEXT_STEP.end },
    ),
  )
  process.exit(0)
}

// Opening a review runs a current CLI (npx resolves fresh), so it carries any
// installed skill copies forward. The spawned daemon re-enters this path; once
// is enough.
if (!process.env.DIFFO_DAEMON) {
  const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  for (const target of refreshInstalledSkills({ packageRoot, homeDir: homedir() })) {
    process.stderr.write(`diffo: refreshed the installed skill (${target})\n`)
  }
}

/** The sets of reviewer agents on offer, and whether the picker opens on the
 * agent's pick, for the open's nudge. Null when the server cannot say. */
async function reviewerSetOffer(
  port: number,
): Promise<{ sets: Array<{ id: string; when: string }>; agentPicks: boolean } | null> {
  try {
    const { status, body } = await getJson(port, '/api/reviewer/roles')
    if (status !== 200) return null
    const { sets, defaultSet } = body as {
      sets?: Array<{ id: string; when: string }>
      defaultSet?: string
    }
    return {
      sets: (sets ?? []).map((s) => ({ id: s.id, when: s.when })),
      agentPicks: defaultSet === AGENT_PICKS_SET,
    }
  } catch {
    return null
  }
}

/** The presets the reviewer has on, for the open's layers nudge. Empty when
 * the server cannot say: the nudge then goes without them. */
async function activePresetList(port: number): Promise<Array<{ id: string; blurb: string }>> {
  try {
    const { status, body } = await getJson(port, '/api/presets')
    if (status !== 200) return []
    const { presets } = body as { presets?: Array<{ id: string; blurb: string; on: boolean }> }
    return (presets ?? []).filter((p) => p.on).map((p) => ({ id: p.id, blurb: p.blurb }))
  } catch {
    return []
  }
}

/** Agents read piped stdout; a human's terminal never shows these lines. */
async function printAgentNextStep(port: number, pr?: PrInfo): Promise<void> {
  if (process.stdout.isTTY) return
  // A courtesy that must not block the open: if the review can't be read, the
  // nudge is simply skipped and the base next-step still prints.
  const review = await fetchReviewState(port)
  const D = doctrineFor(pr ? { pr } : null)
  if (pr) console.log(`note: ${prOpenNote(repoPath, pr)}`)
  // The poll comes first, right under the URL: it is the one step with no later
  // surface, and the review has no listener until it runs. The guide and the
  // layers flag are written while it listens.
  console.log(
    pr
      ? `next: run \`${CLI_COMMANDS.poll}\` ${POLL_NOW}. Hold it as ${POLL_STANCE}; ${POLL_NOW_FOREGROUND}. ` +
          "It receives the reviewer's private questions; the pull request already names their tab " +
          '(`diffo help agent` prints the whole loop)'
      : `next: run \`${CLI_COMMANDS.firstPoll}\` ${POLL_NOW}. Hold it as ${POLL_STANCE}; ${POLL_NOW_FOREGROUND}. It receives the reviewer's feedback; the ` +
          `title is ${TAB_TITLE.what} (${TAB_TITLE.examples}): ${TAB_TITLE.why} ` +
          '(`diffo help agent` prints the whole loop)',
  )
  const nudge = review ? guideNudge(findGuideThread(review) !== undefined, D) : null
  if (nudge) console.log(`then: ${nudge}`)
  // The presets that are on ride the nudge, so the flag can name the one
  // that fits without another command.
  const presets =
    review && !review.layers && !review.layersSuggested ? await activePresetList(port) : []
  const layers = review ? layersNudge(review, D, presets) : null
  if (layers) console.log(`also: ${layers}`)
  // Not on a pull request: reviewer agents join branch and working-tree
  // reviews only.
  if (review && !pr) {
    const offer = review.reviewerSet ? null : await reviewerSetOffer(port)
    const sets = offer ? reviewerSetNudge(review, offer.sets, offer.agentPicks) : null
    if (sets) console.log(`also: ${sets}`)
  }
  const shared = review?.layers?.shared
  if (shared && review?.layers) {
    console.log(
      `also: ${sharedLayersNote(shared, review.layers.items.length, pr?.head.sha ?? null)}`,
    )
  }
}

/**
 * Dev builds serve the client from the checkout's `dist/client`, which nothing
 * rebuilds on its own — so opening a review after a source edit showed last
 * build's UI over this build's server. Rebuild it here, before the server is
 * settled: the server reads client files from disk per request, so even a
 * reused server serves the fresh bundle. `.dev-stamp` (written after a
 * successful build, into a directory vite has just emptied) makes the no-change
 * open free. The foreground path is exempt — that is `pnpm dev:server`'s tsx
 * watch loop, where the client is vite's dev server, not this bundle.
 */
function rebuildDevClient(foreground: boolean): void {
  if (SRC_STAMP === null || foreground) return
  const stampFile = join(CHECKOUT_ROOT, 'dist', 'client', '.dev-stamp')
  try {
    if (readFileSync(stampFile, 'utf-8').trim() === SRC_STAMP) return
  } catch {
    // no stamp yet — build below
  }
  process.stderr.write(`diffo: dev checkout changed, rebuilding the client bundle\n`)
  const vite = join(
    CHECKOUT_ROOT,
    'node_modules',
    '.bin',
    process.platform === 'win32' ? 'vite.cmd' : 'vite',
  )
  const built = spawnSync(vite, ['build'], { cwd: CHECKOUT_ROOT, encoding: 'utf-8' })
  if (built.status !== 0) {
    const said = (built.stderr || built.stdout || String(built.error ?? '')).trim()
    fail(`the client rebuild failed. Fix the build, then re-run\n${said.slice(-2000)}`)
  }
  writeFileSync(stampFile, `${SRC_STAMP}\n`)
}

/**
 * A pull-request target. Everything the plan calls "the inversion" happens in
 * these lines: the code is fetched into a worktree diffo owns, the review runs
 * there as an ordinary branch review, and the forge rides along so the server
 * can pull the conversation and post the reviewer's comments.
 */
async function openPullRequest(
  target: string,
  ref: PrRef,
  baseOverride: string | undefined,
  explicitPr: boolean,
): Promise<{ prepared: PreparedWorktree; pr: PrInfo; context: PrContext }> {
  const forge = new GhClient()
  const auth = await forge.authStatus(ref.host)
  if (!auth.ok) {
    await reportOpenFailure('gh_auth')
    fail(auth.message)
  }
  let pr: PrInfo
  let threads: Awaited<ReturnType<GhClient['fetchPr']>>['threads']
  try {
    ;({ pr, threads } = await forge.fetchPr(ref))
  } catch (err) {
    await reportOpenFailure('pr_fetch')
    fail(
      `could not read pull request #${ref.number} from ${ref.host}/${ref.owner}/${ref.repo}: ${(err as Error).message}`,
    )
  }
  // The user's own pull request is two reviews in one name — a local branch
  // review, or the GitHub pull request review — and they teach the agent
  // opposite things. `diffo pr <PR>` says which; a bare `diffo <PR>` stops
  // before the worktree exists and lets the user choose.
  if (pr.viewer.isAuthor && !explicitPr) {
    const origin = parseRemoteUrl(getRemoteUrl(repoPath) ?? '')
    const sameRepo =
      origin !== null &&
      origin.host === ref.host &&
      origin.owner.toLowerCase() === ref.owner.toLowerCase() &&
      origin.repo.toLowerCase() === ref.repo.toLowerCase()
    // A clean exit: the CLI did its job, which was to ask. A failure code
    // made agents report a crash to the user instead of putting the question.
    console.log(ownPrAsk(target, pr, { branch: getBranchName(repoPath), sameRepo }))
    process.exit(0)
  }
  if (pr.state !== 'open') {
    process.stderr.write(
      `diffo: pull request #${pr.number} is ${pr.state}, opening it read-mostly\n`,
    )
  }
  const mainRepo = mainRepoOf(repoPath)
  const baseBranch = baseOverride ?? pr.base.ref
  const db = new DiffoDb()
  let prepared: PreparedWorktree
  try {
    // Reap what is over before making room for what is next — never the one
    // being opened: the daemon runs this same path from inside it.
    const own = worktreePathFor(mainRepo, ref.number)
    for (const entry of sweepWorktrees(db, mainRepo, { except: own })) {
      if (entry.outcome === 'removed') {
        process.stderr.write(
          `diffo: removed the worktree for ${entry.record.prKey} (${entry.reason})\n`,
        )
      }
    }
    prepared = prepareWorktree(mainRepo, ref, baseBranch, db)
  } catch (err) {
    await reportOpenFailure('pr_checkout')
    fail(`could not check the pull request out: ${(err as Error).message}`)
  } finally {
    db.close()
  }
  if (prepared.keptDirty) {
    process.stderr.write(
      `diffo: the worktree at ${prepared.path} has uncommitted changes; left at its current head, not ${prepared.headSha.slice(0, 7)}\n`,
    )
  }
  process.stderr.write(
    `diffo: pull request #${pr.number} "${pr.title}" by @${pr.author.login}, ${prepared.created ? 'checked out at' : 'worktree at'} ${prepared.path}\n`,
  )
  const shared = findSharedPack(threads, pr)
  if (shared) {
    process.stderr.write(
      `diffo: found @${shared.from.by}'s reading guide on the pull request (${shared.layers.length} layers)\n`,
    )
  }
  return {
    prepared,
    pr,
    context: { ref, forge, mainRepo, baseBranch, ...(shared ? { shared } : {}) },
  }
}

// What the server watches. A branch target is a spec; a pull-request target is
// resolved here, and the spec becomes the worktree's branch review.
let spec: CliSpec = command.spec
let prOpen: Awaited<ReturnType<typeof openPullRequest>> | null = null
if (command.target !== undefined) {
  const parsed = parseTarget(command.target, getRemoteUrl(repoPath))
  if (!parsed.ok) {
    await reportOpenFailure('target')
    fail(parsed.error)
  }
  if (parsed.target.kind === 'pr') {
    openKind = 'pr'
    prOpen = await openPullRequest(
      command.target,
      parsed.target.ref,
      command.spec.kind === 'branch' ? command.spec.base.replace(/^origin\//, '') : undefined,
      command.explicitPr,
    )
    root = prOpen.prepared.path
    repoPath = resolve(root)
    spec = { kind: 'branch', base: prOpen.prepared.base }
  }
}
openKind = reviewKindOf(spec, prOpen !== null)

rebuildDevClient(command.foreground)

const existing = await discoverServer()

const takeOverPort =
  existing !== null &&
  command.foreground &&
  command.port !== undefined &&
  command.port !== existing.port
    ? command.port
    : null

if (existing !== null && takeOverPort === null) {
  const url = reviewUrl(existing.port)
  console.log(
    prOpen ? 'diffo is already watching this pull request' : 'diffo is already watching this repo',
  )
  await warnSpecMismatch(existing.port, spec)
  await announceOpen(existing.port)
  await announceArrival(existing.port)
  console.log(`→ ${url}`)
  await printAgentNextStep(existing.port, prOpen?.pr)
  process.exit(0)
}

if (existing !== null && takeOverPort !== null) {
  // Check the port we're taking over FOR before retiring the incumbent: retiring
  // first cost the reviewer a working server when the bind then failed.
  try {
    await probePort(takeOverPort)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    await reportOpenFailure('port')
    fail(
      code === 'EADDRINUSE'
        ? `port ${takeOverPort} is already in use, so there is nothing to take over to; ` +
            `the server on port ${existing.port} is untouched and still watching this repo`
        : `cannot listen on port ${takeOverPort} (${code ?? (err as Error).message})`,
    )
  }
  console.error(`diffo: taking this repo over from the server on port ${existing.port}`)
  if (!(await retireServer(existing.port, existing.pid, existing.pid))) {
    await reportOpenFailure('port')
    fail(`the server on port ${existing.port} would not step aside; stop it, then re-run`)
  }
  const db = new DiffoDb()
  db.removeServer(repoPath, existing.port)
  db.close()
}

if (!command.foreground) {
  const daemonPort = await requireServer(
    command.port,
    spec.kind === 'branch' ? spec.base : undefined,
    SRC_STAMP,
    prOpen ? command.target : undefined,
  )
  await announceOpen(daemonPort)
  await announceArrival(daemonPort)
  const url = reviewUrl(daemonPort)
  await printChangesetSummary(daemonPort)
  console.log(`→ ${url}`)
  await printAgentNextStep(daemonPort, prOpen?.pr)
  if (command.open) openBrowser(url)
  process.exit(0)
}

let port: number
try {
  port = command.port === undefined ? await preferredPort() : await probePort(command.port)
} catch (err) {
  const code = (err as NodeJS.ErrnoException).code
  await reportOpenFailure('port')
  if (command.port === undefined) fail(`no free port available (${code ?? (err as Error).message})`)
  fail(
    code === 'EADDRINUSE'
      ? `port ${command.port} is already in use; omit --port to take any free one`
      : `cannot listen on port ${command.port} (${code ?? (err as Error).message})`,
  )
}

// Built client sits next to the built CLI (dist/client); in dev it's the checkout's
// dist/client — resolved relative to THIS file, never cwd, since the dev skill runs
// from whatever repo is under review.
const here = dirname(fileURLToPath(import.meta.url))
const clientDir =
  [resolve(here, 'client'), resolve(here, '../dist/client')].find(existsSync) ??
  resolve(here, 'client')

let started: ReturnType<typeof startServer>
try {
  started = startServer({
    port,
    clientDir,
    root,
    spec,
    ...(prOpen
      ? { pr: { ...prOpen.context, info: prOpen.pr } }
      : {
          // The URL as configured: an `insteadOf` rewrite names where git
          // talks to, not which repository this is.
          canShare: shareCheck(
            () => listRemotes(root).find((r) => r.name === 'origin')?.url ?? getRemoteUrl(root),
            new GhClient(),
          ),
        }),
  })
} catch (err) {
  if (err instanceof MissingBaseError) {
    await reportOpenFailure('base')
    fail(missingBaseMessage(err.base))
  }
  if (err instanceof RepoAlreadyServedError) {
    console.log(`diffo is already watching this repo`)
    console.log(`→ ${reviewUrl(err.holder.port)}`)
    process.exit(0)
  }
  await reportOpenFailure('server_start')
  throw err
}

// A daemon leaves the open to the CLI that spawned it, whose announce knows the
// agent; the daemon itself, detached, would report `unknown`, and a daemon a
// `poll` respawned is the same review coming back, not a new one.
if (!process.env.DIFFO_DAEMON) {
  started.telemetry.reviewOpened({
    kind: reviewKindOf(spec, prOpen !== null),
    agent: detectHarness() ?? 'unknown',
  })
}

const changeset = started.store.get()
const { stats, repo } = changeset
const url = reviewUrl(port)
const label = prOpen ? `pull request #${prOpen.pr.number} "${prOpen.pr.title}"` : specLabel(spec)

console.log(`diffo · ${repo.name}${repo.branch ? ` (${repo.branch})` : ''}`)
if (stats.files === 0) {
  console.log(`watching ${label} · working tree is clean, nothing to review yet`)
} else {
  console.log(
    `watching ${label} · ${stats.files} ${stats.files === 1 ? 'file' : 'files'} · +${stats.additions} −${stats.deletions}`,
  )
}
if (!prOpen) printBaseHint(spec, stats.files)
console.log(`→ ${url}`)

if (command.open) openBrowser(url)

// Exit through process.exit so the 'exit' handlers run — that's what removes this
// server's row from the registry. SIGTERM's default would skip them.
process.on('SIGINT', () => {
  process.exit(0)
})
process.on('SIGTERM', () => {
  process.exit(0)
})
