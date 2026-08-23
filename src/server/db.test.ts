import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { DiffoDb, REVIEW_TTL_DAYS } from './db.js'

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const fn of cleanups.splice(0)) fn()
})

function makeDb(): DiffoDb {
  const dir = mkdtempSync(join(tmpdir(), 'diffo-db-'))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  const db = new DiffoDb(join(dir, 'diffo.db'))
  cleanups.push(() => db.close())
  return db
}

describe('permissions', () => {
  it.skipIf(process.platform === 'win32')(
    'keeps a fresh DB dir and file private to the user',
    () => {
      const dir = mkdtempSync(join(tmpdir(), 'diffo-db-'))
      cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
      const path = join(dir, 'private', 'diffo.db')
      const db = new DiffoDb(path)
      cleanups.push(() => db.close())
      expect(statSync(join(dir, 'private')).mode & 0o777).toBe(0o700)
      expect(statSync(path).mode & 0o777).toBe(0o600)
    },
  )
})

describe('retired tables', () => {
  it('drops tables the current schema no longer knows, keeps live data', () => {
    const dir = mkdtempSync(join(tmpdir(), 'diffo-db-'))
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
    const path = join(dir, 'diffo.db')

    const first = new DiffoDb(path)
    const scope = { repoPath: dir, branch: 'main', base: '' }
    first.setReview(scope, '{"kept":true}')
    first.close()

    const bare = new DatabaseSync(path)
    bare.exec("CREATE TABLE runs (id TEXT PRIMARY KEY); INSERT INTO runs VALUES ('r1')")
    bare.close()

    const second = new DiffoDb(path)
    cleanups.push(() => second.close())
    const inspect = new DatabaseSync(path)
    const tables = inspect
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
      .all() as { name: string }[]
    inspect.close()
    expect(tables.map((t) => t.name).sort()).toEqual(['repo_ports', 'reviews', 'servers'])
    expect(second.getReview(scope)).toBe('{"kept":true}')
  })
})

describe('reviews', () => {
  it('prunes reviews whose worktree no longer exists on disk', () => {
    const dir = mkdtempSync(join(tmpdir(), 'diffo-db-'))
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
    const path = join(dir, 'diffo.db')

    const first = new DiffoDb(path)
    const living = { repoPath: dir, branch: 'main', base: '' }
    const gone = { repoPath: join(dir, 'deleted-worktree'), branch: 'main', base: '' }
    first.setReview(living, '{"kept":true}')
    first.setReview(gone, '{"stale":true}')
    first.close()

    const second = new DiffoDb(path)
    cleanups.push(() => second.close())
    expect(second.getReview(living)).toBe('{"kept":true}')
    expect(second.getReview(gone)).toBeNull()
  })

  it('every part of the scope keys a separate review', () => {
    const db = makeDb()
    const base = { repoPath: '/repo/a', branch: 'main', base: '' }
    db.setReview(base, '{"main":true}')

    expect(db.getReview(base)).toBe('{"main":true}')
    expect(db.getReview({ ...base, branch: 'feature/x' })).toBeNull()
    expect(db.getReview({ ...base, repoPath: '/repo/a-wt' })).toBeNull()
    expect(db.getReview({ ...base, base: 'main' })).toBeNull()

    db.setReview(base, '{"main":"updated"}')
    expect(db.getReview(base)).toBe('{"main":"updated"}')
  })
})

describe('server registry', () => {
  it('registers, looks up, and removes a server per repo', () => {
    const db = makeDb()
    expect(db.getServer('/repo/a')).toBeNull()
    db.claimServer('/repo/a', 4001, 111)
    db.claimServer('/repo/b', 4002, 222)

    const a = db.getServer('/repo/a')
    expect(a).toMatchObject({ repoPath: '/repo/a', port: 4001, pid: 111 })
    expect(typeof a?.startedAt).toBe('string')

    db.removeServer('/repo/a')
    expect(db.getServer('/repo/a')).toBeNull()
    expect(db.getServer('/repo/b')).toMatchObject({ port: 4002 })
  })

  it('a second claim on the same repo loses, and reports the incumbent', () => {
    const db = makeDb()
    expect(db.claimServer('/repo/a', 4001, 111)).toMatchObject({
      claimed: true,
      holder: { port: 4001, pid: 111 },
    })
    expect(db.claimServer('/repo/a', 5005, 333)).toMatchObject({
      claimed: false,
      holder: { port: 4001, pid: 111 },
    })
    expect(db.getServer('/repo/a')).toMatchObject({ port: 4001, pid: 111 })
  })

  it('an identical re-claim still loses — the insert reports it, not a comparison', () => {
    const db = makeDb()
    db.claimServer('/repo/a', 4001, 111)
    expect(db.claimServer('/repo/a', 4001, 111).claimed).toBe(false)
  })

  it('a repo whose server stood down can be claimed again', () => {
    const db = makeDb()
    db.claimServer('/repo/a', 4001, 111)
    db.removeServer('/repo/a', 4001)
    expect(db.claimServer('/repo/a', 5005, 333)).toMatchObject({
      claimed: true,
      holder: { port: 5005, pid: 333 },
    })
  })

  it('prunes registrations whose worktree no longer exists on disk', () => {
    const dir = mkdtempSync(join(tmpdir(), 'diffo-db-'))
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
    const path = join(dir, 'diffo.db')

    const first = new DiffoDb(path)
    first.claimServer(dir, 4001, 111)
    first.claimServer(join(dir, 'deleted-worktree'), 4002, 222)
    first.close()

    const second = new DiffoDb(path)
    cleanups.push(() => second.close())
    expect(second.getServer(dir)).toMatchObject({ port: 4001 })
    expect(second.getServer(join(dir, 'deleted-worktree'))).toBeNull()
  })

  it('keeps a live server registered even when its worktree is unreachable', () => {
    const dir = mkdtempSync(join(tmpdir(), 'diffo-db-'))
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
    const path = join(dir, 'diffo.db')
    const unmounted = join(dir, 'volume-that-went-away')

    const first = new DiffoDb(path)
    first.claimServer(unmounted, 4001, process.pid)
    first.close()

    const second = new DiffoDb(path)
    cleanups.push(() => second.close())
    expect(second.getServer(unmounted)).toMatchObject({ port: 4001 })
  })

  it('a dying server cannot wipe the row of the server that replaced it', () => {
    const db = makeDb()
    db.claimServer('/repo/a', 4001, 111)
    db.removeServer('/repo/a', 4001)
    db.claimServer('/repo/a', 5005, 333)
    db.removeServer('/repo/a', 4001)
    expect(db.getServer('/repo/a')).toMatchObject({ port: 5005 })
    db.removeServer('/repo/a', 5005)
    expect(db.getServer('/repo/a')).toBeNull()
  })
})

describe('review pruning', () => {
  function repo(branch = 'main'): string {
    const dir = mkdtempSync(join(tmpdir(), 'diffo-prune-'))
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
    const run = (...args: string[]) =>
      execFileSync('git', args, { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] })
    run('init', '-b', branch)
    run('config', 'user.email', 'test@example.com')
    run('config', 'user.name', 'Test')
    run('config', 'commit.gpgsign', 'false')
    writeFileSync(join(dir, 'a.txt'), 'x')
    run('add', '-A')
    run('commit', '-m', 'seed')
    return dir
  }

  const reopen = (path: string) => {
    const db = new DiffoDb(path)
    cleanups.push(() => db.close())
    return db
  }

  it('retires a branch that has been merged and deleted', () => {
    const dir = mkdtempSync(join(tmpdir(), 'diffo-db-'))
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
    const path = join(dir, 'diffo.db')
    const root = repo('main')
    const db = new DiffoDb(path)
    db.setReview({ repoPath: root, branch: 'main', base: '' }, '{"threads":[]}')
    db.setReview({ repoPath: root, branch: 'gone-branch', base: '' }, '{"threads":[]}')
    db.close()

    const fresh = reopen(path)
    expect(fresh.getReview({ repoPath: root, branch: 'main', base: '' })).not.toBeNull()
    expect(fresh.getReview({ repoPath: root, branch: 'gone-branch', base: '' })).toBeNull()
  })

  it('keeps the review when git cannot answer — never guess away a thread', () => {
    const dir = mkdtempSync(join(tmpdir(), 'diffo-db-'))
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
    const path = join(dir, 'diffo.db')
    const notARepo = mkdtempSync(join(tmpdir(), 'diffo-plain-'))
    cleanups.push(() => rmSync(notARepo, { recursive: true, force: true }))
    const db = new DiffoDb(path)
    db.setReview({ repoPath: notARepo, branch: 'main', base: '' }, '{"threads":[]}')
    db.close()

    expect(reopen(path).getReview({ repoPath: notARepo, branch: 'main', base: '' })).not.toBeNull()
  })

  it('retires a review nothing has touched for the TTL', () => {
    const dir = mkdtempSync(join(tmpdir(), 'diffo-db-'))
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
    const path = join(dir, 'diffo.db')
    const root = repo('main')
    const db = new DiffoDb(path)
    db.setReview({ repoPath: root, branch: 'main', base: '' }, '{"threads":[]}')
    db.close()

    const raw = new DatabaseSync(path)
    const old = new Date(Date.now() - (REVIEW_TTL_DAYS + 1) * 86_400_000).toISOString()
    raw.prepare('UPDATE reviews SET updated_at = ?').run(old)
    raw.close()

    expect(reopen(path).getReview({ repoPath: root, branch: 'main', base: '' })).toBeNull()
  })

  it('a detached HEAD is left to the TTL, not to the branch check', () => {
    const dir = mkdtempSync(join(tmpdir(), 'diffo-db-'))
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
    const path = join(dir, 'diffo.db')
    const root = repo('main')
    const db = new DiffoDb(path)
    db.setReview({ repoPath: root, branch: '', base: '' }, '{"threads":[]}')
    db.close()

    expect(reopen(path).getReview({ repoPath: root, branch: '', base: '' })).not.toBeNull()
  })
})

describe('remembered ports', () => {
  it('has no preference until something records one', () => {
    const db = makeDb()
    expect(db.getPreferredPort('/repo')).toBeNull()
    db.setPreferredPort('/repo', 4949)
    expect(db.getPreferredPort('/repo')).toBe(4949)
  })

  it('keeps one port per repo, latest wins', () => {
    const db = makeDb()
    db.setPreferredPort('/a', 4000)
    db.setPreferredPort('/b', 5000)
    db.setPreferredPort('/a', 4001)
    expect(db.getPreferredPort('/a')).toBe(4001)
    expect(db.getPreferredPort('/b')).toBe(5000)
  })

  it('outlives the server registration it was recorded alongside', () => {
    const dir = mkdtempSync(join(tmpdir(), 'diffo-db-'))
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
    const path = join(dir, 'diffo.db')

    const first = new DiffoDb(path)
    first.claimServer(dir, 4949, process.pid)
    first.setPreferredPort(dir, 4949)
    first.removeServer(dir, 4949)
    first.close()

    const second = new DiffoDb(path)
    cleanups.push(() => second.close())
    expect(second.getServer(dir)).toBeNull()
    expect(second.getPreferredPort(dir)).toBe(4949)
  })

  it('forgets the port of a worktree that is gone', () => {
    const dir = mkdtempSync(join(tmpdir(), 'diffo-db-'))
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
    const path = join(dir, 'diffo.db')
    const vanished = mkdtempSync(join(tmpdir(), 'diffo-gone-'))

    const first = new DiffoDb(path)
    first.setPreferredPort(vanished, 4321)
    first.setPreferredPort(dir, 4322)
    first.close()
    rmSync(vanished, { recursive: true, force: true })

    const second = new DiffoDb(path)
    cleanups.push(() => second.close())
    expect(second.getPreferredPort(vanished)).toBeNull()
    expect(second.getPreferredPort(dir)).toBe(4322)
  })
})
