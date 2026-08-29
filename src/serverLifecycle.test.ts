import {
  appendFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DiffoDb } from './server/db.js'
import {
  assessRunningServer,
  defaultLogPath,
  ensureServer,
  fetchHealth,
  retireServer,
  rotateLog,
  type ServerHealth,
  serverSpawnArgs,
  settleExistingServer,
} from './serverLifecycle.js'

const cleanups: (() => void | Promise<void>)[] = []
afterEach(async () => {
  for (const fn of cleanups.splice(0)) await fn()
})

const REPO = tmpdir()
const V = '1.2.3'

describe('assessRunningServer', () => {
  const ours = (over: Partial<ServerHealth> = {}): ServerHealth => ({
    ok: true,
    repo: REPO,
    app: 'diffo',
    version: V,
    ...over,
  })

  it('reuses a same-build server for this repo', () => {
    expect(assessRunningServer(ours(), REPO, V)).toBe('reuse')
  })

  it('replaces our server from another build', () => {
    expect(assessRunningServer(ours({ version: '0.9.0' }), REPO, V)).toBe('replace')
  })

  it('replaces a pre-handshake server (no app/version in health)', () => {
    expect(assessRunningServer({ ok: true, repo: REPO }, REPO, V)).toBe('replace')
  })

  it('treats a dead port as foreign — nothing to signal', () => {
    expect(assessRunningServer(null, REPO, V)).toBe('foreign')
  })

  it("treats another repo's server as foreign", () => {
    expect(assessRunningServer(ours({ repo: '/other' }), REPO, V)).toBe('foreign')
  })

  it('treats a non-diffo squatter as foreign even when it echoes ok', () => {
    expect(assessRunningServer({ ok: true }, REPO, V)).toBe('foreign')
  })

  it('reuses a same-build server whose source stamp matches', () => {
    expect(assessRunningServer(ours({ srcStamp: 'aaa' }), REPO, V, 'aaa')).toBe('reuse')
  })

  it('replaces a same-build server started from other source', () => {
    expect(assessRunningServer(ours({ srcStamp: 'aaa' }), REPO, V, 'bbb')).toBe('replace')
  })

  it('replaces a same-build server that reports no stamp when one is expected', () => {
    expect(assessRunningServer(ours(), REPO, V, 'aaa')).toBe('replace')
  })

  it('ignores the stamp entirely when none is expected — polls must not churn', () => {
    expect(assessRunningServer(ours({ srcStamp: 'aaa' }), REPO, V)).toBe('reuse')
    expect(assessRunningServer(ours({ srcStamp: 'aaa' }), REPO, V, null)).toBe('reuse')
  })
})

describe('serverSpawnArgs', () => {
  it('carries the runtime flags, the same entry, and headless', () => {
    expect(serverSpawnArgs('/x/cli.ts', ['--import', 'tsx'])).toEqual([
      '--import',
      'tsx',
      '/x/cli.ts',
      '--no-open',
      '--foreground',
    ])
    expect(serverSpawnArgs('/x/dist/cli.mjs', [])).toEqual([
      '/x/dist/cli.mjs',
      '--no-open',
      '--foreground',
    ])
  })

  it('the port promise and the base spec both survive the hand-off', () => {
    expect(serverSpawnArgs('/x/cli.mjs', [], 4949, 'main')).toEqual([
      '/x/cli.mjs',
      '--no-open',
      '--foreground',
      '-p',
      '4949',
      '--base',
      'main',
    ])
    expect(serverSpawnArgs('/x/cli.mjs', [], undefined, 'main')).toContain('--base')
  })
})

async function fakeServer(opts: {
  repo: string
  version?: string
  onShutdown?: () => void
  pid?: number
}): Promise<{ port: number; shutdownCalls: () => number; close: () => Promise<void> }> {
  let shutdowns = 0
  const server: Server = createServer((req, res) => {
    if (req.url === '/api/health') {
      res.setHeader('content-type', 'application/json')
      res.end(
        JSON.stringify({
          ok: true,
          repo: opts.repo,
          app: 'diffo',
          ...(opts.version ? { version: opts.version } : {}),
          ...(opts.pid !== undefined ? { pid: opts.pid } : {}),
        }),
      )
      return
    }
    if (req.url === '/api/shutdown' && req.method === 'POST') {
      shutdowns++
      res.end(JSON.stringify({ ok: true }))
      opts.onShutdown?.()
      return
    }
    res.statusCode = 404
    res.end()
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const close = () =>
    new Promise<void>((r) => {
      server.close(() => r())
      server.closeAllConnections?.()
    })
  cleanups.push(close)
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('no port')
  return { port: address.port, shutdownCalls: () => shutdowns, close }
}

function tempDb(): { db: DiffoDb; path: string } {
  const dir = mkdtempSync(join(tmpdir(), 'diffo-lifecycle-'))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  const path = join(dir, 'diffo.db')
  const db = new DiffoDb(path)
  cleanups.push(() => {
    try {
      db.close()
    } catch {
      // already closed
    }
  })
  return { db, path }
}

function ensureOpts(dbPath: string, over: Record<string, unknown> = {}) {
  return {
    repoPath: REPO,
    version: V,
    entry: '/x/cli.ts',
    execPath: process.execPath,
    execArgv: [],
    logPath: join(tmpdir(), 'diffo-lifecycle-test.log'),
    dbPath,
    spawnTimeoutMs: 1500,
    ...over,
  }
}

describe('ensureServer', () => {
  it('reuses a healthy same-build server without spawning', async () => {
    const { db, path } = tempDb()
    const running = await fakeServer({ repo: REPO, version: V })
    db.claimServer(REPO, running.port, 999999)
    let spawned = 0
    const port = await ensureServer(ensureOpts(path), { spawnDaemon: () => spawned++ })
    expect(port).toBe(running.port)
    expect(spawned).toBe(0)
    expect(running.shutdownCalls()).toBe(0)
  })

  it('retires an other-build server, then waits for the daemon it spawned', async () => {
    const { db, path } = tempDb()
    const stale = await fakeServer({
      repo: REPO,
      version: '0.9.0',
      onShutdown: () => void stale.close(),
    })
    db.claimServer(REPO, stale.port, process.pid)
    const statuses: string[] = []
    const port = await ensureServer(
      ensureOpts(path, { onStatus: (line: string) => statuses.push(line) }),
      {
        spawnDaemon: () => {
          void fakeServer({ repo: REPO, version: V }).then((fresh) => {
            db.claimServer(REPO, fresh.port, process.pid)
          })
        },
      },
    )
    expect(stale.shutdownCalls()).toBe(1)
    const health = await fetchHealth(port)
    expect(health?.version).toBe(V)
    expect(statuses.some((s) => s.includes('replacing'))).toBe(true)
  })

  it('spawns a daemon when nothing is registered', async () => {
    const { db, path } = tempDb()
    const port = await ensureServer(ensureOpts(path), {
      spawnDaemon: () => {
        void fakeServer({ repo: REPO, version: V }).then((fresh) => {
          db.claimServer(REPO, fresh.port, process.pid)
        })
      },
    })
    const health = await fetchHealth(port)
    expect(health?.repo).toBe(REPO)
  })

  it('clears a stale row (dead port) and spawns instead of failing', async () => {
    const { db, path } = tempDb()
    const gone = await fakeServer({ repo: REPO, version: V })
    const deadPort = gone.port
    await gone.close()
    db.claimServer(REPO, deadPort, 999999)
    const port = await ensureServer(ensureOpts(path), {
      spawnDaemon: () => {
        void fakeServer({ repo: REPO, version: V }).then((fresh) => {
          db.claimServer(REPO, fresh.port, process.pid)
        })
      },
    })
    expect(port).not.toBe(deadPort)
  })

  it('fails with the log path when the daemon never comes up', async () => {
    const { path } = tempDb()
    await expect(
      ensureServer(ensureOpts(path, { spawnTimeoutMs: 300 }), { spawnDaemon: () => {} }),
    ).rejects.toThrow(/server\.log|did not start/)
  })

  it("a failed handshake quotes the daemon's own reason — and only this spawn's", async () => {
    const { path } = tempDb()
    const logPath = join(tmpdir(), `diffo-lifecycle-complaint-${process.pid}.log`)
    cleanups.push(() => rmSync(logPath, { force: true }))
    writeFileSync(logPath, 'diffo: an older run said something else\n')
    const err = await ensureServer(ensureOpts(path, { spawnTimeoutMs: 300, logPath }), {
      spawnDaemon: () => {
        appendFileSync(logPath, "diffo: base branch 'nope' doesn't exist in this repo\n")
      },
    }).then(
      () => null,
      (e: Error) => e,
    )
    expect(err?.message).toContain("base branch 'nope' doesn't exist in this repo")
    expect(err?.message).not.toContain('older run')
  })
})

describe('settleExistingServer', () => {
  it('returns a healthy same-build server for reuse, with the pid it reported', async () => {
    const { db } = tempDb()
    const running = await fakeServer({ repo: REPO, version: V, pid: 4242 })
    db.claimServer(REPO, running.port, 999999)
    expect(await settleExistingServer(db, REPO, V)).toEqual({ port: running.port, pid: 4242 })
    expect(db.getServer(REPO)).not.toBeNull()
  })

  it('clears a stale row (dead port) and reports nothing to reuse', async () => {
    const { db } = tempDb()
    const gone = await fakeServer({ repo: REPO, version: V })
    const deadPort = gone.port
    await gone.close()
    db.claimServer(REPO, deadPort, 999999)
    expect(await settleExistingServer(db, REPO, V)).toBeNull()
    expect(db.getServer(REPO)).toBeNull()
  })

  it('retires an other-build server and clears its row', async () => {
    const { db } = tempDb()
    const stale = await fakeServer({
      repo: REPO,
      version: '0.9.0',
      onShutdown: () => void stale.close(),
    })
    db.claimServer(REPO, stale.port, process.pid)
    const statuses: string[] = []
    expect(await settleExistingServer(db, REPO, V, (line) => statuses.push(line))).toBeNull()
    expect(stale.shutdownCalls()).toBe(1)
    expect(db.getServer(REPO)).toBeNull()
    expect(statuses.some((s) => s.includes('replacing'))).toBe(true)
  })

  it('throws on a stuck other-build server and leaves the row in place', async () => {
    const { db } = tempDb()
    const stuck = await fakeServer({
      repo: REPO,
      version: '0.9.0',
      onShutdown: () => {},
      pid: 4242,
    })
    db.claimServer(REPO, stuck.port, 999999)
    await expect(settleExistingServer(db, REPO, V)).rejects.toThrow(/would not step aside/)
    expect(db.getServer(REPO)).toMatchObject({ port: stuck.port })
  }, 15_000)
})

describe('retireServer', () => {
  it('asks over HTTP first and reports the port gone', async () => {
    const target = await fakeServer({
      repo: REPO,
      version: '0.9.0',
      onShutdown: () => void target.close(),
    })
    expect(await retireServer(target.port, null)).toBe(true)
    expect(target.shutdownCalls()).toBe(1)
  })
})

describe('retireServer — the SIGTERM has to be earned', () => {
  const stubborn = (over: { pid?: number } = {}) =>
    fakeServer({ repo: REPO, version: '0.9.0', onShutdown: () => {}, ...over })

  it('refuses to signal when the server names a different pid than the registry', async () => {
    const server = await stubborn({ pid: 4242 })
    const signalled: number[] = []
    const realKill = process.kill.bind(process)
    process.kill = ((p: number) => {
      signalled.push(p)
      return true
    }) as typeof process.kill
    try {
      const retired = await retireServer(server.port, 999999, 4242)
      expect(retired).toBe(false)
      expect(signalled).toEqual([])
    } finally {
      process.kill = realKill
    }
    expect(server.shutdownCalls()).toBe(1)
  }, 15_000)

  it('signals when the server confirms the registry pid', async () => {
    const server = await stubborn({ pid: 4242 })
    const signalled: number[] = []
    const realKill = process.kill.bind(process)
    process.kill = ((p: number) => {
      signalled.push(p)
      return true
    }) as typeof process.kill
    try {
      await retireServer(server.port, 4242, 4242)
      expect(signalled).toEqual([4242])
    } finally {
      process.kill = realKill
    }
  }, 15_000)

  it('still signals a build that reports no pid — nothing else can retire it', async () => {
    const server = await stubborn()
    const signalled: number[] = []
    const realKill = process.kill.bind(process)
    process.kill = ((p: number) => {
      signalled.push(p)
      return true
    }) as typeof process.kill
    try {
      await retireServer(server.port, 777, null)
      expect(signalled).toEqual([777])
    } finally {
      process.kill = realKill
    }
  }, 15_000)
})

describe('ensureServer — a stuck old build stops everything', () => {
  it('refuses to spawn beside a server that would not step aside', async () => {
    const { db, path } = tempDb()
    const stuck = await fakeServer({
      repo: REPO,
      version: '0.9.0',
      onShutdown: () => {},
      pid: 4242,
    })
    db.claimServer(REPO, stuck.port, 999999)

    let spawned = 0
    await expect(ensureServer(ensureOpts(path), { spawnDaemon: () => spawned++ })).rejects.toThrow(
      /stuck on port|would not step aside/,
    )
    expect(spawned).toBe(0)
    expect(db.getServer(REPO)).toMatchObject({ port: stuck.port })
  }, 15_000)
})

describe('rotateLog', () => {
  function logDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'diffo-log-'))
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
    return dir
  }

  it('leaves a small log alone — rotating every start would throw away context', () => {
    const path = join(logDir(), 'server.log')
    writeFileSync(path, 'a few lines\n')
    rotateLog(path)
    expect(existsSync(`${path}.1`)).toBe(false)
    expect(readFileSync(path, 'utf-8')).toBe('a few lines\n')
  })

  it('rotates an oversize log to .1 and starts fresh', () => {
    const path = join(logDir(), 'server.log')
    writeFileSync(path, 'x'.repeat(3 * 1024 * 1024))
    rotateLog(path)
    expect(existsSync(path)).toBe(false)
    expect(statSync(`${path}.1`).size).toBe(3 * 1024 * 1024)
  })

  it('keeps exactly two generations — the previous .1 is replaced', () => {
    const path = join(logDir(), 'server.log')
    writeFileSync(`${path}.1`, 'older run')
    writeFileSync(path, 'y'.repeat(3 * 1024 * 1024))
    rotateLog(path)
    expect(statSync(`${path}.1`).size).toBe(3 * 1024 * 1024)
  })

  it('a missing log is not an error — the first run has none', () => {
    expect(() => rotateLog(join(logDir(), 'never-written.log'))).not.toThrow()
  })
})

describe('defaultLogPath', () => {
  it('gives each repo its own file, so two daemons cannot interleave', () => {
    const a = defaultLogPath('/Users/x/work/alpha')
    const b = defaultLogPath('/Users/x/work/beta')
    expect(a).not.toBe(b)
    expect(a.endsWith('.log')).toBe(true)
  })

  it('separates two checkouts that share a basename', () => {
    const a = defaultLogPath('/Users/x/personal/diffo')
    const b = defaultLogPath('/Users/x/worktrees/diffo')
    expect(a).not.toBe(b)
    expect(basename(a).startsWith('diffo-')).toBe(true)
    expect(basename(b).startsWith('diffo-')).toBe(true)
  })

  it('is stable for the same repo across runs', () => {
    expect(defaultLogPath('/Users/x/work/alpha')).toBe(defaultLogPath('/Users/x/work/alpha/'))
  })
})
