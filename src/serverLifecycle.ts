import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, openSync, readFileSync, renameSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { DiffoDb } from './server/db.js'
import { apiUrl } from './serverUrl.js'

const MAX_LOG_BYTES = 2 * 1024 * 1024

export interface ServerHealth {
  ok?: boolean
  repo?: string
  app?: string
  version?: string
  pid?: number
}

export type ServerAssessment = 'reuse' | 'replace' | 'foreign'

export function assessRunningServer(
  health: ServerHealth | null,
  repoPath: string,
  version: string,
): ServerAssessment {
  if (health?.ok !== true || health.repo !== repoPath) return 'foreign'
  return health.app === 'diffo' && health.version === version ? 'reuse' : 'replace'
}

/**
 * argv for the daemon: the same runtime flags executing this CLI, the same entry
 * script, headless. `--foreground` is not a contradiction — it means "hold the
 * server in THIS process", and without it the child would spawn another one of
 * itself, forever.
 */
export function serverSpawnArgs(
  entry: string,
  execArgv: string[],
  port?: number,
  base?: string,
): string[] {
  const args = [...execArgv, entry, '--no-open', '--foreground']
  // An explicit `--port` is a promise to the caller, so it has to survive the
  // hand-off. Omitted, the daemon prefers the repo's last port.
  if (port !== undefined) args.push('-p', String(port))
  // The spec is the whole point of the open: a daemon that dropped `--base`
  // would watch the working tree no matter what was asked.
  if (base !== undefined) args.push('--base', base)
  return args
}

export async function fetchHealth(port: number, timeoutMs = 1500): Promise<ServerHealth | null> {
  try {
    const res = await fetch(apiUrl(port, '/api/health'), {
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!res.ok) return null
    return (await res.json()) as ServerHealth
  } catch {
    return null
  }
}

async function delay(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms))
}

async function waitUntil(
  predicate: () => Promise<boolean>,
  timeoutMs: number,
  stepMs = 120,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return true
    await delay(stepMs)
  }
  return predicate()
}

/**
 * Retire a server we own: ask nicely over HTTP, and only if it lingers (a
 * pre-shutdown-endpoint build 404s the POST) fall back to SIGTERM.
 *
 * The health check proves the *port* belongs to this repo's diffo; the pid comes
 * from the registry, and after a crash and a pid reuse it can name something else.
 * So the signal is only sent when the server itself named the same pid — except on
 * builds that report no pid, where the registry's stays the fallback.
 */
export async function retireServer(
  port: number,
  pid: number | null,
  reportedPid: number | null = null,
): Promise<boolean> {
  try {
    await fetch(apiUrl(port, '/api/shutdown'), {
      method: 'POST',
      signal: AbortSignal.timeout(1500),
    })
  } catch {
    // it may have died between the health check and now — the wait decides
  }
  const gone = () => fetchHealth(port).then((h) => h === null)
  if (await waitUntil(gone, 2000)) return true
  if (pid !== null && (reportedPid === null || reportedPid === pid)) {
    try {
      process.kill(pid, 'SIGTERM')
    } catch {
      // already gone, or not ours to signal — the wait below is the truth
    }
    return waitUntil(gone, 3000)
  }
  return false
}

export interface DiscoveredServer {
  port: number
  pid: number | null
}

/**
 * Look up this repo's registered server and settle its fate: a healthy same-build
 * server is returned for reuse; a server from another build is retired; a stale
 * row (dead port, or a foreign squatter) is cleared. Returns null once the
 * registry holds no reusable server. Throws when an other-build server would not
 * step aside — the row is NOT cleared then: two servers on one review each hold
 * their own copy and write the whole blob back, so the slower watcher erases the
 * reviewer's threads, and clearing the row would hand the claim to a newcomer.
 */
export async function settleExistingServer(
  db: DiffoDb,
  repoPath: string,
  version: string,
  onStatus: (line: string) => void = () => {},
): Promise<DiscoveredServer | null> {
  const record = db.getServer(repoPath)
  if (!record) return null
  const health = await fetchHealth(record.port)
  const verdict = assessRunningServer(health, repoPath, version)
  if (verdict === 'reuse') return { port: record.port, pid: health?.pid ?? record.pid ?? null }
  if (verdict === 'replace') {
    onStatus(
      `replacing the diffo server from another build (${health?.version ?? 'pre-handshake'} → ${version})`,
    )
    if (!(await retireServer(record.port, record.pid ?? null, health?.pid ?? null))) {
      throw new Error(
        `a diffo server from another build is stuck on port ${record.port}` +
          (record.pid ? ` (pid ${record.pid})` : '') +
          ` and would not step aside — stop it, then re-run`,
      )
    }
  }
  db.removeServer(repoPath, record.port)
  return null
}

export interface EnsureServerOptions {
  repoPath: string
  version: string
  entry: string
  execPath: string
  execArgv: string[]
  logPath: string
  port?: number
  base?: string
  env?: NodeJS.ProcessEnv
  dbPath?: string
  spawnTimeoutMs?: number
  onStatus?: (line: string) => void
}

export interface EnsureServerDeps {
  spawnDaemon?: (opts: EnsureServerOptions) => void
}

export function defaultLogPath(repoPath: string): string {
  const abs = resolve(repoPath)
  const hash = createHash('sha256').update(abs).digest('hex').slice(0, 8)
  return join(homedir(), '.diffo', 'logs', `${basename(abs)}-${hash}.log`)
}

export function rotateLog(logPath: string): void {
  try {
    if (statSync(logPath).size < MAX_LOG_BYTES) return
    renameSync(logPath, `${logPath}.1`)
  } catch {
    // No log yet, or it cannot be rotated (permissions, a racing daemon). The
    // append below still works, and losing the rotation is no reason to fail.
  }
}

function logSize(logPath: string): number {
  try {
    return statSync(logPath).size
  } catch {
    return 0
  }
}

/**
 * The daemon's own last word — only what THIS spawn appended (past `from`),
 * preferring its `diffo:` lines — so a failed handshake names the reason
 * instead of pointing at a file.
 */
function daemonComplaint(logPath: string, from: number): string | null {
  try {
    const fresh = readFileSync(logPath).subarray(from).toString('utf-8')
    const lines = fresh
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
    const line = lines.filter((l) => l.startsWith('diffo: ')).at(-1) ?? lines.at(-1)
    return line ? line.replace(/^diffo: /, '').slice(0, 300) : null
  } catch {
    return null
  }
}

function spawnDaemonProcess(opts: EnsureServerOptions): void {
  mkdirSync(dirname(opts.logPath), { recursive: true })
  rotateLog(opts.logPath)
  const logFd = openSync(opts.logPath, 'a')
  const child = spawn(
    opts.execPath,
    serverSpawnArgs(opts.entry, opts.execArgv, opts.port, opts.base),
    {
      cwd: opts.repoPath,
      detached: true,
      stdio: ['ignore', logFd, logFd],
      env: { ...(opts.env ?? process.env), DIFFO_DAEMON: '1' },
    },
  )
  child.unref()
}

export async function ensureServer(
  opts: EnsureServerOptions,
  deps: EnsureServerDeps = {},
): Promise<number> {
  const status = opts.onStatus ?? (() => {})
  const db = new DiffoDb(opts.dbPath)
  try {
    const existing = await settleExistingServer(db, opts.repoPath, opts.version, status)
    if (existing) return existing.port

    status('no diffo server for this repo — starting one')
    // Rotate before measuring: anything past this offset is what THIS daemon
    // said, so a failed handshake below can quote the actual reason.
    mkdirSync(dirname(opts.logPath), { recursive: true })
    rotateLog(opts.logPath)
    const logStart = logSize(opts.logPath)
    ;(deps.spawnDaemon ?? spawnDaemonProcess)(opts)

    // The daemon claims repo→port when it is ready, so the registry row appearing
    // (and answering as our build) IS the startup handshake.
    let port: number | null = null
    const up = await waitUntil(async () => {
      const row = db.getServer(opts.repoPath)
      if (!row) return false
      const health = await fetchHealth(row.port, 500)
      if (assessRunningServer(health, opts.repoPath, opts.version) !== 'reuse') return false
      port = row.port
      return true
    }, opts.spawnTimeoutMs ?? 8000)
    if (!up || port === null) {
      const complaint = daemonComplaint(opts.logPath, logStart)
      throw new Error(
        complaint
          ? `the diffo server did not start: ${complaint} (log: ${opts.logPath})`
          : `the diffo server did not start — see ${opts.logPath}`,
      )
    }
    return port
  } finally {
    db.close()
  }
}
