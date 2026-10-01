import { chmodSync, existsSync, mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { branchExists, branchExistsAsync } from './git.js'

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

/**
 * A bump used to DROP the affected table rather than migrate it (pre-release).
 * 3 added `worktrees` and dropped nothing. The version is a floor, not a
 * migration log: an older build sharing this file writes its own (lower)
 * number back unconditionally — 0.5.0 sets 2 on every open — so the number
 * can go backwards under us. Nothing here reads a lower version as a reason
 * to drop `worktrees`; every open creates what is missing and raises the
 * version again. What this build cannot prevent: that older build retires
 * `worktrees` itself on its next open, once the version is at its own.
 */
const SCHEMA_VERSION = 3

/** Files written before this version carry a `reviews` table of another shape. */
const REVIEWS_RESHAPED_AT = 2

export const REVIEW_TTL_DAYS = 60

export interface ServerRecord {
  repoPath: string
  port: number
  pid: number
  startedAt: string
}

/**
 * A worktree Diffo made for a pull request. `repoPath` is the main checkout it
 * hangs off; the review itself is scoped to `worktreePath` like any other
 * review, which is why the review and the worktree live and die together.
 */
export interface WorktreeRecord {
  worktreePath: string
  repoPath: string
  /** `host/owner/repo#n` — see `prRefKey`. */
  prKey: string
  branch: string
  base: string
  createdAt: string
  /** Set once the PR was seen merged or closed. */
  closedAt: string | null
}

/** What a {@link DiffoDb.maintain} sweep retired. */
export interface MaintenanceReport {
  /** Review rows dropped: their repo is gone, or their branch is. */
  reviews: number
}

export class DiffoDb {
  private db: DatabaseSync
  private closed = false
  readonly path: string

  /**
   * Opening is cheap on purpose: the schema, and one SQL statement for the TTL.
   * Nothing here touches the filesystem beyond the database file, and nothing
   * asks git. It used to: every open checked every review's branch with a
   * `git show-ref`, across every repo this machine ever reviewed — 73 git
   * processes, 1.5s, on a database a few weeks old, and an open constructs
   * this five times. The checks live in {@link pruneRepo} (one repo, before its
   * review loads) and {@link maintain} (everything, in the daemon's background).
   */
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
    this.ensureSchema()
    this.pruneExpiredReviews()
  }

  /**
   * Creates what is missing and retires what is unknown. Runs at open, and
   * again when a sibling process has dropped a table under us: an older build
   * sharing this file retires every table it does not know, so a table this
   * build added can vanish mid-run. The version is only ever raised here, never
   * lowered, so a newer build's tables survive an older build's open.
   */
  private ensureSchema(): void {
    const { user_version: version } = this.db.prepare('PRAGMA user_version').get() as {
      user_version: number
    }
    // Retired tables are dropped, not kept. Guarded by version: if a *newer*
    // Diffo upgraded this file, its tables are not ours to judge.
    if (version <= SCHEMA_VERSION) {
      const known = new Set(['reviews', 'servers', 'repo_ports', 'ui_settings', 'worktrees'])
      const tables = this.db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
        .all() as { name: string }[]
      for (const { name } of tables) {
        if (!known.has(name)) this.db.exec(`DROP TABLE IF EXISTS "${name.replaceAll('"', '""')}"`)
      }
    }
    if (version < REVIEWS_RESHAPED_AT) this.db.exec('DROP TABLE IF EXISTS reviews')
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
      CREATE TABLE IF NOT EXISTS worktrees (
        worktree_path TEXT PRIMARY KEY,
        repo_path     TEXT NOT NULL,
        pr_key        TEXT NOT NULL,
        branch        TEXT NOT NULL,
        base          TEXT NOT NULL,
        created_at    TEXT NOT NULL,
        closed_at     TEXT
      );
    `)
    if (version < SCHEMA_VERSION) this.db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`)
  }

  /** Runs a query on a table a sibling build may have dropped; one rebuild, one retry. */
  private onTable<T>(run: () => T): T {
    try {
      return run()
    } catch (err) {
      if (!/no such table/.test(err instanceof Error ? err.message : String(err))) throw err
      this.ensureSchema()
      return run()
    }
  }

  /**
   * Reviews untouched for `REVIEW_TTL_DAYS` go on every open: one statement,
   * no git, and the backstop for everything the two targeted sweeps below leave
   * for later.
   */
  private pruneExpiredReviews(): void {
    const cutoff = new Date(Date.now() - REVIEW_TTL_DAYS * 86_400_000).toISOString()
    const stale = this.db.prepare('DELETE FROM reviews WHERE updated_at < ?').run(cutoff)
    if (Number(stale.changes) > 0) this.checkpoint()
  }

  /**
   * Retire this one repo's reviews for branches it no longer has. The server
   * runs it before loading the review it is about to serve, so a branch
   * deleted since the last server start is forgotten before a namesake could
   * inherit its threads. Only this repo's branches are asked about, so the
   * cost is a handful of `git show-ref`s, once per server start, never per CLI
   * call. Branch existence is asked of git rather than assumed — when git can't
   * answer the row is kept, because guessing here deletes threads.
   */
  pruneRepo(repoPath: string): number {
    const rows = this.db
      .prepare('SELECT DISTINCT branch FROM reviews WHERE repo_path = ?')
      .all(repoPath) as { branch: string }[]
    let dropped = 0
    for (const { branch } of rows) {
      if (branch === '' || branchExists(repoPath, branch)) continue
      dropped += this.dropReviews(repoPath, branch)
    }
    return dropped
  }

  /**
   * The full sweep, for a long-lived process with time on its hands: rows about
   * repos that are gone, and reviews for branches that are. The daemon runs it
   * once, a few seconds after it is serving; `diffo clean` runs it on demand.
   * Git is asked asynchronously and one repo at a time, so a sweep over every
   * repo this machine ever reviewed never blocks a request. A `close()` midway
   * ends it quietly between steps.
   *
   * Rows about a worktree that is gone can never be reached again — the path
   * *is* the key. An unmounted volume looks the same as a deleted worktree, so
   * its rows go too; the `servers` row needs its process dead as well, or a live
   * server's claim could be dropped over a moment of unreachability.
   */
  async maintain(): Promise<MaintenanceReport> {
    const report: MaintenanceReport = { reviews: 0 }
    if (this.closed) return report
    for (const { repo_path } of this.distinctRepoPaths('reviews')) {
      if (!existsSync(repo_path)) report.reviews += this.dropReviews(repo_path)
    }
    for (const { repo_path } of this.distinctRepoPaths('repo_ports')) {
      if (!existsSync(repo_path)) {
        this.db.prepare('DELETE FROM repo_ports WHERE repo_path = ?').run(repo_path)
      }
    }
    // A worktree directory someone rm -rf'd still owes the main repo a
    // cleanup — git's stale entry, the branch, the ref — which is the sweep's
    // 'missing' branch, and it needs the row to find them. The row goes only
    // once the main repo itself is gone: nothing is left to clean.
    const worktrees = this.db.prepare('SELECT worktree_path, repo_path FROM worktrees').all() as {
      worktree_path: string
      repo_path: string
    }[]
    for (const { worktree_path, repo_path } of worktrees) {
      if (!existsSync(repo_path)) {
        this.db.prepare('DELETE FROM worktrees WHERE worktree_path = ?').run(worktree_path)
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
    const rows = this.db.prepare('SELECT DISTINCT repo_path, branch FROM reviews').all() as {
      repo_path: string
      branch: string
    }[]
    for (const { repo_path, branch } of rows) {
      if (branch === '') continue
      const exists = await branchExistsAsync(repo_path, branch)
      if (this.closed) return report
      if (!exists) report.reviews += this.dropReviews(repo_path, branch)
    }
    if (report.reviews > 0) this.checkpoint()
    return report
  }

  /** Every review of a repo, or only one branch's. Returns the rows dropped. */
  private dropReviews(repoPath: string, branch?: string): number {
    const result =
      branch === undefined
        ? this.db.prepare('DELETE FROM reviews WHERE repo_path = ?').run(repoPath)
        : this.db
            .prepare('DELETE FROM reviews WHERE repo_path = ? AND branch = ?')
            .run(repoPath, branch)
    return Number(result.changes)
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

  hasReview(scope: ReviewScope): boolean {
    return this.getReview(scope) !== null
  }

  registerWorktree(record: Omit<WorktreeRecord, 'closedAt'>): void {
    this.onTable(() =>
      this.db
        .prepare(
          `INSERT INTO worktrees (worktree_path, repo_path, pr_key, branch, base, created_at, closed_at)
         VALUES (?, ?, ?, ?, ?, ?, NULL)
         ON CONFLICT(worktree_path) DO UPDATE SET
           repo_path = excluded.repo_path, pr_key = excluded.pr_key, branch = excluded.branch,
           base = excluded.base, closed_at = NULL`,
        )
        .run(
          record.worktreePath,
          record.repoPath,
          record.prKey,
          record.branch,
          record.base,
          record.createdAt,
        ),
    )
  }

  getWorktree(worktreePath: string): WorktreeRecord | null {
    const row = this.onTable(
      () =>
        this.db.prepare('SELECT * FROM worktrees WHERE worktree_path = ?').get(worktreePath) as
          | WorktreeRow
          | undefined,
    )
    return row ? worktreeRecord(row) : null
  }

  /** Every worktree Diffo owns, or only those hanging off one main checkout. */
  listWorktrees(repoPath?: string): WorktreeRecord[] {
    const rows = this.onTable(
      () =>
        (repoPath === undefined
          ? this.db.prepare('SELECT * FROM worktrees ORDER BY created_at').all()
          : this.db
              .prepare('SELECT * FROM worktrees WHERE repo_path = ? ORDER BY created_at')
              .all(repoPath)) as unknown as WorktreeRow[],
    )
    return rows.map(worktreeRecord)
  }

  markWorktreeClosed(worktreePath: string): void {
    this.onTable(() =>
      this.db
        .prepare('UPDATE worktrees SET closed_at = COALESCE(closed_at, ?) WHERE worktree_path = ?')
        .run(new Date().toISOString(), worktreePath),
    )
  }

  removeWorktree(worktreePath: string): void {
    this.onTable(() =>
      this.db.prepare('DELETE FROM worktrees WHERE worktree_path = ?').run(worktreePath),
    )
  }

  getServer(repoPath: string): ServerRecord | null {
    const row = this.db
      .prepare('SELECT port, pid, started_at FROM servers WHERE repo_path = ?')
      .get(repoPath) as { port: number; pid: number; started_at: string } | undefined
    return row ? { repoPath, port: row.port, pid: row.pid, startedAt: row.started_at } : null
  }

  /** The registered server whose process is still running, if there is one.
   * A registration a dead process left behind is not a server. */
  liveServer(repoPath: string): ServerRecord | null {
    const record = this.getServer(repoPath)
    return record && pidAlive(record.pid) ? record : null
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
    this.closed = true
    this.db.close()
  }
}

interface WorktreeRow {
  worktree_path: string
  repo_path: string
  pr_key: string
  branch: string
  base: string
  created_at: string
  closed_at: string | null
}

function worktreeRecord(row: WorktreeRow): WorktreeRecord {
  return {
    worktreePath: row.worktree_path,
    repoPath: row.repo_path,
    prKey: row.pr_key,
    branch: row.branch,
    base: row.base,
    createdAt: row.created_at,
    closedAt: row.closed_at,
  }
}
