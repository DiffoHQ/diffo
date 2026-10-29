import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Every child the daemon spawns must carry `windowsHide: true`. On Windows a
// `detached` daemon has no console, so each `git` would otherwise be handed a
// fresh cmd window that flashes open and shut. Spy on the real functions and
// let the calls go through.
vi.mock('node:child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:child_process')>()
  const { promisify } = await import('node:util')
  const execFile = vi.fn(real.execFile) as unknown as typeof real.execFile
  // `promisify(execFile)` reads this symbol; a bare spy would lose it, and
  // copying the real one would route the promisified path past the spy.
  Object.defineProperty(execFile, promisify.custom, {
    value: (...args: unknown[]) =>
      new Promise((res, rej) =>
        (execFile as (...a: unknown[]) => void)(
          ...args,
          (err: unknown, stdout: string, stderr: string) =>
            err ? rej(err) : res({ stdout, stderr }),
        ),
      ),
  })
  return {
    ...real,
    execFile,
    execFileSync: vi.fn(real.execFileSync),
    spawn: vi.fn(real.spawn),
  }
})

const cp = vi.mocked(await import('node:child_process'))
const real = await vi.importActual<typeof import('node:child_process')>('node:child_process')

function optionsOf(calls: unknown[][]): unknown[] {
  // (file, args, options, cb?) — options is always the third argument here.
  return calls.map((c) => c[2])
}

function expectAllHidden(calls: unknown[][]): void {
  expect(calls.length).toBeGreaterThan(0)
  for (const opts of optionsOf(calls)) expect(opts).toMatchObject({ windowsHide: true })
}

let repo: string
beforeEach(() => {
  cp.execFile.mockClear()
  cp.execFileSync.mockClear()
  cp.spawn.mockClear()
  repo = mkdtempSync(join(tmpdir(), 'diffo-windowshide-'))
  const git = (...args: string[]) =>
    real.execFileSync('git', args, { cwd: repo, stdio: 'ignore', env: { ...process.env } })
  git('init', '-q', '-b', 'main')
  git('config', 'user.email', 't@t')
  git('config', 'user.name', 't')
  writeFileSync(join(repo, 'a.txt'), 'hi\n')
  git('add', '.')
  git('commit', '-q', '-m', 'init')
})
afterEach(() => rmSync(repo, { recursive: true, force: true }))

describe('windowsHide on every child process', () => {
  it('git: the sync and async wrappers and every direct call', async () => {
    const g = await import('./server/git.js')
    g.findRepoRoot(repo)
    g.getBaseFileBytes(repo, 'HEAD', 'a.txt')
    await g.getBranchNameAsync(repo)
    await g.branchExistsAsync(repo, 'main')
    // No remote: the fetches fail, which is fine — the options were handed over.
    expect(() => g.fetchPrHead(repo, 1)).toThrow()
    expect(() => g.fetchBranch(repo, 'main')).toThrow()
    await expect(g.fetchPrHeadAsync(repo, 1)).rejects.toThrow()
    await expect(g.fetchBranchAsync(repo, 'main')).rejects.toThrow()

    expectAllHidden(cp.execFileSync.mock.calls)
    expectAllHidden(cp.execFile.mock.calls)
    // One call per helper above: four sync, four async.
    expect(cp.execFileSync.mock.calls.length).toBe(4)
    expect(cp.execFile.mock.calls.length).toBe(4)
  })

  it('gh', async () => {
    const { execGh } = await import('./forge/github/gh.js')
    await execGh(['--version']).catch(() => {})
    expectAllHidden(cp.execFile.mock.calls)
  })

  it('the daemon spawn itself', async () => {
    const { ensureServer } = await import('./serverLifecycle.js')
    cp.spawn.mockImplementationOnce(() => ({ unref() {} }) as never)
    const dbDir = mkdtempSync(join(tmpdir(), 'diffo-windowshide-db-'))
    await expect(
      ensureServer({
        repoPath: repo,
        version: '0.0.0',
        entry: '/x/cli.ts',
        execPath: process.execPath,
        execArgv: [],
        logPath: join(dbDir, 'server.log'),
        dbPath: join(dbDir, 'diffo.db'),
        spawnTimeoutMs: 200,
      }),
    ).rejects.toThrow()
    rmSync(dbDir, { recursive: true, force: true })
    expect(cp.spawn).toHaveBeenCalledTimes(1)
    expect(cp.spawn.mock.calls[0]![2]).toMatchObject({ detached: true, windowsHide: true })
  })
})
