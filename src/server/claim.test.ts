import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { RepoAlreadyServedError, startServer } from './index.js'

const cleanups: (() => void | Promise<void>)[] = []
afterEach(async () => {
  for (const fn of cleanups.splice(0)) await fn()
  delete process.env.DIFFO_DB
})

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const probe = createServer()
    probe.listen({ port: 0, host: '127.0.0.1' }, () => {
      const { port } = probe.address() as { port: number }
      probe.close(() => resolve(port))
    })
  })
}

function git(dir: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd: dir,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

function tempRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'diffo-claim-'))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  git(dir, 'init', '-b', 'main')
  git(dir, 'config', 'user.email', 'test@example.com')
  git(dir, 'config', 'user.name', 'Test')
  git(dir, 'config', 'commit.gpgsign', 'false')
  writeFileSync(join(dir, 'seed.ts'), 'seed\n')
  git(dir, 'add', '-A')
  git(dir, 'commit', '-m', 'seed')
  process.env.DIFFO_DB = join(dir, '..', `${dir.split('/').pop()}-db`, 'diffo.db')
  return dir
}

function start(root: string, port: number) {
  const started = startServer({
    root,
    port,
    spec: { kind: 'working-tree' },
    clientDir: join(root, 'no-client'),
  })
  let stopped = false
  const stop = async () => {
    if (stopped) return
    stopped = true
    started.server.close()
    await started.stopWatching()
  }
  cleanups.push(stop)
  return { ...started, stop }
}

describe('startServer — one server per repo', () => {
  it('refuses to start a second server on a repo, naming the one that has it', async () => {
    const repo = tempRepo()
    const held = await freePort()
    start(repo, held)

    let thrown: unknown
    try {
      start(repo, await freePort())
    } catch (err) {
      thrown = err
    }
    expect(thrown).toBeInstanceOf(RepoAlreadyServedError)
    expect((thrown as RepoAlreadyServedError).holder).toMatchObject({
      pid: process.pid,
      port: held,
    })
  })

  it('lets the next server in once the holder stands down', async () => {
    const repo = tempRepo()
    await start(repo, 0).stop()

    expect(() => start(repo, 0)).not.toThrow()
  })

  it('does not claim the repo when the changeset itself fails to build', () => {
    const repo = tempRepo()
    expect(() => start2(repo)).toThrow()
    expect(() => start(repo, 0)).not.toThrow()
  })
})

function start2(root: string) {
  return startServer({
    root,
    port: 0,
    spec: { kind: 'branch', base: 'no-such-branch' },
    clientDir: join(root, 'no-client'),
  })
}

describe('startServer — a failed bind', () => {
  it('reports the collision instead of throwing an unhandled error', async () => {
    const repo = tempRepo()
    const taken = await freePort()
    const squatter = createServer()
    cleanups.push(() => void squatter.close())
    await new Promise<void>((r) => squatter.listen({ port: taken, host: '127.0.0.1' }, r))

    const errors: NodeJS.ErrnoException[] = []
    const started = startServer({
      root: repo,
      port: taken,
      spec: { kind: 'working-tree' },
      clientDir: join(repo, 'no-client'),
      onListenError: (err) => errors.push(err),
    })
    cleanups.push(() => started.stopWatching())
    await new Promise((r) => setTimeout(r, 100))

    expect(errors.map((e) => e.code)).toEqual(['EADDRINUSE'])
  })

  it('releases the registry claim, so the next attempt is not locked out', async () => {
    const repo = tempRepo()
    const taken = await freePort()
    const squatter = createServer()
    cleanups.push(() => void squatter.close())
    await new Promise<void>((r) => squatter.listen({ port: taken, host: '127.0.0.1' }, r))

    const failed = startServer({
      root: repo,
      port: taken,
      spec: { kind: 'working-tree' },
      clientDir: join(repo, 'no-client'),
      onListenError: () => {},
    })
    cleanups.push(() => failed.stopWatching())
    await new Promise((r) => setTimeout(r, 100))

    expect(() => start(repo, 0)).not.toThrow()
  })
})
