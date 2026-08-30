#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { detectSessionPid } from './agentSession.js'
import { helpFor, parseCliArgs } from './cliArgs.js'
import { SRC_STAMP } from './devStamp.js'
import { DiffoDb } from './server/db.js'
import { findRepoRoot, MissingBaseError, suggestedBase } from './server/git.js'
import { RepoAlreadyServedError, startServer } from './server/index.js'
import { ACK_NEXT_STEP, CHECKOUT_ROOT, guideInherit, guideNudge } from './server/prompt.js'
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
import type { ReviewState } from './shared/review.js'
import type { ChangesetSpec as CliSpec } from './shared/types.js'
import { VERSION } from './version.js'

const command = parseCliArgs(process.argv.slice(2))

function fail(message: string): never {
  console.error(`diffo: ${message}`)
  process.exit(1)
}

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

if (command.kind === 'setup') {
  const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  const outcomes = runSetup({ packageRoot, homeDir: homedir() })
  const width = Math.max(...outcomes.map((o) => o.client.length))
  for (const outcome of outcomes) {
    const hint = outcome.status === 'registered' ? postRegisterHint[outcome.client] : undefined
    console.log(
      `${outcome.client.padEnd(width)}  ${outcome.status.padEnd(10)}  ${outcome.detail}${hint ? ` — ${hint}` : ''}`,
    )
  }
  if (outcomes.some((o) => o.status === 'manual')) {
    console.log('rows marked manual need the one step described; re-run `diffo setup` after')
  }
  if (outcomes.every((o) => o.status === 'absent')) {
    console.log('\nno supported client found — install one, then re-run `diffo setup`')
  }
  process.exit(outcomes.some((o) => o.status === 'failed') ? 1 : 0)
}

const root = findRepoRoot(process.cwd())
if (!root) fail('not inside a git repository')
const repoPath = resolve(root)

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

async function requireServer(
  port?: number,
  base?: string,
  srcStamp: string | null = null,
): Promise<number> {
  try {
    return await ensureServer({
      repoPath,
      version: VERSION,
      entry: resolve(process.argv[1] ?? fileURLToPath(import.meta.url)),
      execPath: process.execPath,
      execArgv: process.execArgv,
      port,
      base,
      srcStamp,
      logPath: process.env.DIFFO_SERVER_LOG || defaultLogPath(repoPath),
      onStatus: (line) => process.stderr.write(`diffo: ${line}\n`),
    })
  } catch (err) {
    fail((err as Error).message)
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
    `this branch has ${hint.commits} ${hint.commits === 1 ? 'commit' : 'commits'} since ${hint.base} — review them with \`diffo --base ${hint.base}\``,
  )
}

interface ChangesetInfo {
  spec: CliSpec
  stats: { files: number; additions: number; deletions: number }
  repo: { name: string; branch: string }
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
  console.log(
    stats.files === 0
      ? `watching ${specLabel(spec)} · working tree is clean — nothing to review yet`
      : `watching ${specLabel(spec)} · ${stats.files} ${stats.files === 1 ? 'file' : 'files'} · +${stats.additions} −${stats.deletions}`,
  )
  printBaseHint(spec, stats.files)
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
    `diffo: this server is watching ${specLabel(watching)}, not vs ${asked.base} — ` +
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
    fail('lost connection to the diffo server — re-run the command')
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
          ? ` (the checkout's source changed — the next \`diffo\` replaces it)`
          : ` (this CLI is v${VERSION} — the next \`diffo\` replaces it)`
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
      console.log('no diffo server is watching this repo — nothing to stop')
      process.exit(0)
    }
    const health = await fetchHealth(record.port)
    if (assessRunningServer(health, repoPath, VERSION) === 'foreign') {
      db.removeServer(repoPath, record.port)
      console.log('no diffo server is watching this repo — cleared a stale registration')
      process.exit(0)
    }
    if (!(await retireServer(record.port, record.pid ?? null, health?.pid ?? null))) {
      fail(
        `the server on port ${record.port}` +
          (record.pid ? ` (pid ${record.pid})` : '') +
          ` would not stop — kill it yourself, then re-run \`diffo stop\``,
      )
    }
    db.removeServer(repoPath, record.port)
    console.log(`stopped the diffo server on port ${record.port}`)
  } finally {
    db.close()
  }
  process.exit(0)
}

if (command.kind === 'poll') {
  const port = await requireServer()
  process.stderr.write(
    'diffo: waiting for the reviewer — keep this process attended: a tracked\n' +
      'background task or the foreground, never detached. If it dies, just\n' +
      're-run it — feedback is held in the review and survives.\n',
  )
  // The response streams whitespace heartbeats until the reviewer acts, then one
  // JSON payload. text() rides the heartbeats out; trim leaves the JSON.
  try {
    const res = await fetch(apiUrl(port, '/api/agent/poll'), {
      headers: sessionHeaders(),
    })
    if (!res.ok) fail(`poll failed (${res.status})`)
    const tookOverFrom = res.headers.get('x-diffo-took-over-from')
    if (tookOverFrom) {
      process.stderr.write(
        `diffo: another agent session (pid ${tookOverFrom}) was connected to this review —\n` +
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
    fail('lost connection to the diffo server — re-run `poll` to keep listening')
  }
  process.exit(0)
}

if (command.kind === 'reply') {
  if (command.message === null && process.stdin.isTTY) {
    fail('reply needs a message — pass --message "<text>" or pipe it on stdin')
  }
  const message = (command.message ?? (await readStdin())).trim()
  if (!message) fail('reply needs a message — pass --message "<text>" or pipe it on stdin')
  const port = await requireServer()
  const { status, body } = await postJson(
    port,
    `/api/review/threads/${encodeURIComponent(command.threadId)}/messages`,
    { author: 'agent', text: message },
  )
  if (status === 404) fail(`no thread with id '${command.threadId}'`)
  if (status !== 200) fail(`reply failed (${status})`)
  const thread = (body as { thread: { id: string; state: string } }).thread
  console.log(
    JSON.stringify({
      ok: true,
      threadId: thread.id,
      state: thread.state,
      next_step: ACK_NEXT_STEP.reply,
    }),
  )
  process.exit(0)
}

if (command.kind === 'comment') {
  if (command.message === null && process.stdin.isTTY) {
    fail('comment needs a message — pass --message "<text>" or pipe it on stdin')
  }
  const message = (command.message ?? (await readStdin())).trim()
  if (!message) fail('comment needs a message — pass --message "<text>" or pipe it on stdin')
  const port = await requireServer()
  const { status, body } = await postJson(port, '/api/review/threads', {
    author: 'agent',
    file: command.file,
    line: command.line,
    text: message,
  })
  if (status !== 200) fail(`comment failed (${status})`)
  const thread = body as { id: string }
  console.log(
    JSON.stringify({
      ok: true,
      threadId: thread.id,
      next_step: ACK_NEXT_STEP.comment,
    }),
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
        ? { ...result, next_step: 'nothing to do — you were not the attached agent' }
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

/** Agents read piped stdout; a human's terminal never shows these lines. */
async function printAgentNextStep(port: number): Promise<void> {
  if (process.stdout.isTTY) return
  // A courtesy that must not block the open: if the review can't be read, the
  // nudge is simply skipped and the base next-step still prints.
  const review = await fetchReviewState(port)
  const nudge = review ? guideNudge(findGuideThread(review) !== undefined) : null
  if (nudge) console.log(`first: ${nudge}`)
  console.log(
    "next: run `diffo poll` to receive the reviewer's feedback (`diffo help agent` prints the whole loop)",
  )
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
  process.stderr.write(`diffo: dev checkout changed — rebuilding the client bundle\n`)
  const vite = join(
    CHECKOUT_ROOT,
    'node_modules',
    '.bin',
    process.platform === 'win32' ? 'vite.cmd' : 'vite',
  )
  const built = spawnSync(vite, ['build'], { cwd: CHECKOUT_ROOT, encoding: 'utf-8' })
  if (built.status !== 0) {
    const said = (built.stderr || built.stdout || String(built.error ?? '')).trim()
    fail(`the client rebuild failed — fix the build, then re-run\n${said.slice(-2000)}`)
  }
  writeFileSync(stampFile, `${SRC_STAMP}\n`)
}

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
  console.log(`diffo is already watching this repo`)
  await warnSpecMismatch(existing.port, command.spec)
  console.log(`→ ${url}`)
  await printAgentNextStep(existing.port)
  process.exit(0)
}

if (existing !== null && takeOverPort !== null) {
  // Check the port we're taking over FOR before retiring the incumbent: retiring
  // first cost the reviewer a working server when the bind then failed.
  try {
    await probePort(takeOverPort)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    fail(
      code === 'EADDRINUSE'
        ? `port ${takeOverPort} is already in use, so there is nothing to take over to — ` +
            `the server on port ${existing.port} is untouched and still watching this repo`
        : `cannot listen on port ${takeOverPort} (${code ?? (err as Error).message})`,
    )
  }
  console.error(`diffo: taking this repo over from the server on port ${existing.port}`)
  if (!(await retireServer(existing.port, existing.pid, existing.pid))) {
    fail(`the server on port ${existing.port} would not step aside — stop it, then re-run`)
  }
  const db = new DiffoDb()
  db.removeServer(repoPath, existing.port)
  db.close()
}

if (!command.foreground) {
  const daemonPort = await requireServer(
    command.port,
    command.spec.kind === 'branch' ? command.spec.base : undefined,
    SRC_STAMP,
  )
  const url = reviewUrl(daemonPort)
  await printChangesetSummary(daemonPort)
  console.log(`→ ${url}`)
  await printAgentNextStep(daemonPort)
  if (command.open) openBrowser(url)
  process.exit(0)
}

let port: number
try {
  port = command.port === undefined ? await preferredPort() : await probePort(command.port)
} catch (err) {
  const code = (err as NodeJS.ErrnoException).code
  if (command.port === undefined) fail(`no free port available (${code ?? (err as Error).message})`)
  fail(
    code === 'EADDRINUSE'
      ? `port ${command.port} is already in use — omit --port to take any free one`
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
  started = startServer({ port, clientDir, root, spec: command.spec })
} catch (err) {
  if (err instanceof MissingBaseError) {
    console.error(`diffo: base branch '${err.base}' doesn't exist in this repo`)
    process.exit(1)
  }
  if (err instanceof RepoAlreadyServedError) {
    console.log(`diffo is already watching this repo`)
    console.log(`→ ${reviewUrl(err.holder.port)}`)
    process.exit(0)
  }
  throw err
}

const changeset = started.store.get()
const { stats, repo } = changeset
const url = reviewUrl(port)
const label = specLabel(command.spec)

console.log(`diffo · ${repo.name}${repo.branch ? ` (${repo.branch})` : ''}`)
if (stats.files === 0) {
  console.log(`watching ${label} · working tree is clean — nothing to review yet`)
} else {
  console.log(
    `watching ${label} · ${stats.files} ${stats.files === 1 ? 'file' : 'files'} · +${stats.additions} −${stats.deletions}`,
  )
}
printBaseHint(command.spec, stats.files)
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
