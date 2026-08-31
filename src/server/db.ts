import { chmodSync, existsSync, mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { branchExists } from './git.js'

const require = createRequire(import.meta.url)

/** Signal 0 asks "does this process exist?" without touching it; EPERM is still
 * a yes (it exists, it just isn't ours). */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

export function defaultDbPath(): string {
  return process.env.DIFFO_DB || join(homedir(), '.diffo', 'diffo.db')
}

/** node:sqlite still emits an ExperimentalWarning on load — swallow exactly that
 * one so every CLI run isn't noisy. */
function loadSqlite(): typeof import('node:sqlite') {
  const originalEmit = process.emitWarning.bind(process)
  process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
    if (String(warning instanceof Error ? warning.message : warning).includes('SQLite')) return
    return (originalEmit as (...a: unknown[]) => void)(warning, ...rest)
  }) as typeof process.emitWarning
  try {
    return require('node:sqlite') as typeof import('node:sqlite')
  } finally {
    process.emitWarning = originalEmit
  }
}

export interface ReviewScope {
  repoPath: string
  branch: string
  base: string
}

/** A bump DROPS the affected table rather than migrating it (pre-release). */
const SCHEMA_VERSION = 2

export const REVIEW_TTL_DAYS = 60

export interface ServerRecord {
  repoPath: string
  port: number
  pid: number
  startedAt: string
}

export class DiffoDb {
  private db: DatabaseSync
  readonly path: string

  constructor(path: string = defaultDbPath()) {
    this.path = path
    // The DB holds every repo's review threads and code snapshots: on a shared
    // machine that is not other users' business. 0700 on a fresh dir covers the
    // WAL/SHM siblings too; the chmod repairs files created before this guard.
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    const { DatabaseSync } = loadSqlite()
    this.db = new DatabaseSync(path)
    chmodSync(path, 0o600)
    // One DB file is shared across processes. WAL lets readers and a writer
    // coexist; `journal_size_limit` stops the log growing between checkpoints.
    this.db.exec(
      'PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 3000; PRAGMA journal_size_limit = 4194304;',
    )
    const { user_version: version } = this.db.prepare('PRAGMA user_version').get() as {
      user_version: number
    }
    // Retired tables are dropped, not kept. Guarded by version: if a *newer*
    // Diffo upgraded this file, its tables are not ours to judge.
    if (version <= SCHEMA_VERSION) {
      const known = new Set(['reviews', 'servers', 'repo_ports', 'ui_settings'])
      const tables = this.db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
        .all() as { name: string }[]
      for (const { name } of tables) {
        if (!known.has(name)) this.db.exec(`DROP TABLE IF EXISTS "${name.replaceAll('"', '""')}"`)
      }
    }
    if (version < SCHEMA_VERSION) this.db.exec('DROP TABLE IF EXISTS reviews')
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS reviews (
        repo_path  TEXT NOT NULL,
        branch     TEXT NOT NULL,
        base       TEXT NOT NULL,
        state_json TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (repo_path, branch, base)
      );
      CREATE TABLE IF NOT EXISTS servers (
        repo_path  TEXT PRIMARY KEY,
        port       INTEGER NOT NULL,
        pid        INTEGER NOT NULL,
        started_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS repo_ports (
        repo_path TEXT PRIMARY KEY,
        port      INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS ui_settings (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      PRAGMA user_version = ${SCHEMA_VERSION};
    `)
    this.pruneVanishedRepos()
  }

  /**
   * Rows about a worktree that is gone can never be reached again — the path *is*
   * the key. An unmounted volume looks the same as a deleted worktree, so its rows
   * go too; the `servers` row needs its process dead as well, or a live server's
   * claim could be dropped over a moment of unreachability.
   */
  private pruneVanishedRepos(): void {
    for (const { repo_path } of this.distinctRepoPaths('reviews')) {
      if (!existsSync(repo_path)) {
        this.db.prepare('DELETE FROM reviews WHERE repo_path = ?').run(repo_path)
      }
    }
    for (const { repo_path } of this.distinctRepoPaths('repo_ports')) {
      if (!existsSync(repo_path)) {
        this.db.prepare('DELETE FROM repo_ports WHERE repo_path = ?').run(repo_path)
      }
    }
    const servers = this.db.prepare('SELECT repo_path, pid FROM servers').all() as {
      repo_path: string
      pid: number
    }[]
    for (const { repo_path, pid } of servers) {
      if (!existsSync(repo_path) && !pidAlive(pid)) {
        this.db.prepare('DELETE FROM servers WHERE repo_path = ?').run(repo_path)
      }
    }
    this.pruneStaleReviews()
  }

  /**
   * Reviews the reviewer can never return to: a branch that no longer exists, or
   * one untouched for `REVIEW_TTL_DAYS`. Branch existence is asked of git rather
   * than assumed — if git can't answer the row is kept, because guessing here
   * deletes threads.
   */
  private pruneStaleReviews(): void {
    const cutoff = new Date(Date.now() - REVIEW_TTL_DAYS * 86_400_000).toISOString()
    const stale = this.db.prepare('DELETE FROM reviews WHERE updated_at < ?').run(cutoff)
    if (Number(stale.changes) > 0) {
      this.checkpoint()
      return
    }
    const rows = this.db.prepare('SELECT DISTINCT repo_path, branch FROM reviews').all() as {
      repo_path: string
      branch: string
    }[]
    for (const { repo_path, branch } of rows) {
      if (branch === '' || branchExists(repo_path, branch)) continue
      this.db
        .prepare('DELETE FROM reviews WHERE repo_path = ? AND branch = ?')
        .run(repo_path, branch)
    }
  }

  /** Fold the write-ahead log back into the database file and truncate it. WAL
   * only shrinks at a checkpoint, which a long-lived server never reaches. */
  checkpoint(): void {
    try {
      this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
    } catch {
      // A concurrent reader can block a truncating checkpoint — the log just stays
      // until the next one.
    }
  }

  private distinctRepoPaths(table: 'reviews' | 'servers' | 'repo_ports'): { repo_path: string }[] {
    return this.db.prepare(`SELECT DISTINCT repo_path FROM ${table}`).all() as {
      repo_path: string
    }[]
  }

  getReview(scope: ReviewScope): string | null {
    const row = this.db
      .prepare('SELECT state_json FROM reviews WHERE repo_path = ? AND branch = ? AND base = ?')
      .get(scope.repoPath, scope.branch, scope.base) as { state_json: string } | undefined
    return row?.state_json ?? null
  }

  setReview(scope: ReviewScope, stateJson: string): void {
    this.db
      .prepare(
        `INSERT INTO reviews (repo_path, branch, base, state_json, updated_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(repo_path, branch, base) DO UPDATE SET state_json = excluded.state_json, updated_at = excluded.updated_at`,
      )
      .run(scope.repoPath, scope.branch, scope.base, stateJson, new Date().toISOString())
  }

  /**
   * Claim this repo for a starting server — atomically, so the row is a lock and
   * not merely a note: two servers hold separate copies of the same review and
   * `setReview` writes the whole blob, so one would erase the other's threads.
   * `claimed` comes from the insert itself, the only answer two lookalike servers
   * can't confuse.
   */
  claimServer(
    repoPath: string,
    port: number,
    pid: number,
  ): { claimed: boolean; holder: ServerRecord } {
    const { changes } = this.db
      .prepare(
        `INSERT INTO servers (repo_path, port, pid, started_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(repo_path) DO NOTHING`,
      )
      .run(repoPath, port, pid, new Date().toISOString())
    return { claimed: Number(changes) === 1, holder: this.getServer(repoPath) as ServerRecord }
  }

  getPreferredPort(repoPath: string): number | null {
    const row = this.db.prepare('SELECT port FROM repo_ports WHERE repo_path = ?').get(repoPath) as
      | { port: number }
      | undefined
    return row?.port ?? null
  }

  setPreferredPort(repoPath: string, port: number): void {
    this.db
      .prepare(
        `INSERT INTO repo_ports (repo_path, port) VALUES (?, ?)
         ON CONFLICT(repo_path) DO UPDATE SET port = excluded.port`,
      )
      .run(repoPath, port)
  }

  /** Reviewer preferences that must outlive one server's origin — every repo is
   * served from its own port, so localStorage alone can't hold a choice like
   * the theme. Keyed blobs, no scope: these are per-human, not per-repo. */
  getUiSetting(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM ui_settings WHERE key = ?').get(key) as
      | { value: string }
      | undefined
    return row?.value ?? null
  }

  setUiSetting(key: string, value: string): void {
    this.db
      .prepare(
        `INSERT INTO ui_settings (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run(key, value)
  }

  getServer(repoPath: string): ServerRecord | null {
    const row = this.db
      .prepare('SELECT port, pid, started_at FROM servers WHERE repo_path = ?')
      .get(repoPath) as { port: number; pid: number; started_at: string } | undefined
    return row ? { repoPath, port: row.port, pid: row.pid, startedAt: row.started_at } : null
  }

  /** Remove a registration — but only the one being asked about. A dying server
   * passes its own port so it can't wipe the row of a newer server that already
   * replaced it. */
  removeServer(repoPath: string, port?: number): void {
    if (port === undefined) {
      this.db.prepare('DELETE FROM servers WHERE repo_path = ?').run(repoPath)
    } else {
      this.db.prepare('DELETE FROM servers WHERE repo_path = ? AND port = ?').run(repoPath, port)
    }
  }

  close(): void {
    this.db.close()
  }
}
