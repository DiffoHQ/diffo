import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ChangesetStore } from './store.js'
import { affectsDiff, watchRepo } from './watcher.js'

const cleanups: (() => void | Promise<void>)[] = []
afterEach(async () => {
  for (const fn of cleanups.splice(0)) await fn()
})

function tempRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'diffo-live-'))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  git(dir, 'init', '-b', 'main')
  git(dir, 'config', 'user.email', 'test@example.com')
  git(dir, 'config', 'user.name', 'Test')
  git(dir, 'config', 'commit.gpgsign', 'false')
  writeFileSync(join(dir, 'seed.ts'), 'seed\n')
  git(dir, 'add', '-A')
  git(dir, 'commit', '-m', 'seed')
  return dir
}

function git(dir: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd: dir,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

function until(check: () => boolean, timeoutMs = 3000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now()
    const tick = () => {
      if (check()) return resolve()
      if (Date.now() - start > timeoutMs) return reject(new Error('condition not met in time'))
      setTimeout(tick, 25)
    }
    tick()
  })
}

describe('ChangesetStore', () => {
  it('bumps version only when the diff actually changed', async () => {
    const repo = tempRepo()
    const store = new ChangesetStore(repo, { kind: 'working-tree' })
    expect(store.get().version).toBe(1)

    utimesSync(join(repo, 'seed.ts'), new Date(), new Date())
    expect(await store.refresh()).toBe(false)
    expect(store.get().version).toBe(1)

    writeFileSync(join(repo, 'seed.ts'), 'changed\n')
    expect(await store.refresh()).toBe(true)
    expect(store.get().version).toBe(2)

    expect(await store.refresh()).toBe(false)
    expect(store.get().version).toBe(2)
  })

  it('staging a modified file bumps the version even though the raw diff is identical', async () => {
    const repo = tempRepo()
    const store = new ChangesetStore(repo, { kind: 'working-tree' })
    writeFileSync(join(repo, 'seed.ts'), 'edited\n')
    await store.refresh()
    const v = store.get().version
    expect(store.get().files[0]!.staged).toBe(false)

    git(repo, 'add', 'seed.ts')
    expect(await store.refresh()).toBe(true)
    expect(store.get().version).toBe(v + 1)
    expect(store.get().files[0]!.staged).toBe(true)
  })

  it('notifies subscribers on real change only', async () => {
    const repo = tempRepo()
    const store = new ChangesetStore(repo, { kind: 'working-tree' })
    const versions: number[] = []
    store.subscribe((cs) => versions.push(cs.version))

    await store.refresh()
    writeFileSync(join(repo, 'seed.ts'), 'v2\n')
    await store.refresh()
    await store.refresh()
    expect(versions).toEqual([2])
  })
})

describe('ChangesetStore.refresh — off the event loop', () => {
  it('keeps serving while it recomputes', async () => {
    const repo = tempRepo()
    const store = new ChangesetStore(repo, { kind: 'working-tree' })
    writeFileSync(join(repo, 'seed.ts'), 'edited\n')

    let ticks = 0
    const probe = setInterval(() => ticks++, 5)
    try {
      await store.refresh()
    } finally {
      clearInterval(probe)
    }
    expect(ticks).toBeGreaterThan(0)
  })

  it('coalesces overlapping refreshes into one run', async () => {
    const repo = tempRepo()
    const store = new ChangesetStore(repo, { kind: 'working-tree' })
    writeFileSync(join(repo, 'seed.ts'), 'edited\n')
    const [a, b] = await Promise.all([store.refresh(), store.refresh()])
    expect(a).toBe(b)
    expect(store.get().files).toHaveLength(1)
  })
})

describe('watchRepo', () => {
  it('debounces a burst of writes into one onChange', async () => {
    const repo = tempRepo()
    let calls = 0
    const stop = watchRepo(repo, () => calls++, 150)
    cleanups.push(stop)
    await new Promise((r) => setTimeout(r, 300))

    for (let i = 0; i < 10; i++) writeFileSync(join(repo, `burst-${i}.ts`), `${i}\n`)
    await until(() => calls >= 1)
    await new Promise((r) => setTimeout(r, 400))
    expect(calls).toBe(1)
  })

  it('fires when files are staged (index replaced by rename)', async () => {
    const repo = tempRepo()
    writeFileSync(join(repo, 'seed.ts'), 'edited\n')
    let fired = false
    const stop = watchRepo(repo, () => (fired = true), 100)
    cleanups.push(stop)
    await new Promise((r) => setTimeout(r, 300))

    git(repo, 'add', 'seed.ts')
    await until(() => fired)
  })

  it('sees commits (diff changes with no working-file event)', async () => {
    const repo = tempRepo()
    const store = new ChangesetStore(repo, { kind: 'working-tree' })
    writeFileSync(join(repo, 'seed.ts'), 'edited\n')
    await store.refresh()
    expect(store.get().files).toHaveLength(1)

    let fired = false
    const stop = watchRepo(
      repo,
      () => {
        fired = true
        return store.refresh()
      },
      100,
    )
    cleanups.push(stop)
    await new Promise((r) => setTimeout(r, 300))

    git(repo, 'add', '-A')
    git(repo, 'commit', '-m', 'absorb the edit')
    await until(() => fired && store.get().files.length === 0)
    expect(store.get().files).toHaveLength(0)
  })

  it('picks up a directory created after it started watching', async () => {
    const repo = tempRepo()
    let fired = false
    const stop = watchRepo(repo, () => (fired = true), 100)
    cleanups.push(stop)
    await new Promise((r) => setTimeout(r, 300))

    mkdirSync(join(repo, 'src', 'nested'), { recursive: true })
    writeFileSync(join(repo, 'src', 'nested', 'late.ts'), 'new\n')
    await until(() => fired)
  })

  it('charges a slow recompute back as idle time before the next one', async () => {
    const repo = tempRepo()
    const starts: number[] = []
    const stop = watchRepo(
      repo,
      () => {
        starts.push(Date.now())
        const deadline = Date.now() + 200
        while (Date.now() < deadline) {
          // block the loop
        }
      },
      50,
    )
    cleanups.push(stop)
    await new Promise((r) => setTimeout(r, 300))

    writeFileSync(join(repo, 'a.ts'), '1\n')
    await until(() => starts.length >= 1)
    writeFileSync(join(repo, 'b.ts'), '2\n')
    await until(() => starts.length >= 2, 5000)
    expect(starts[1]! - starts[0]!).toBeGreaterThanOrEqual(380)
  })

  it('survives a watch that cannot start — the review still serves', () => {
    const bad = join(tmpdir(), 'diffo-does-not-exist-ever')
    expect(() => cleanups.push(watchRepo(bad, () => {}, 100))).not.toThrow()
  })
})

describe('affectsDiff', () => {
  it('passes working-tree paths and skips dependency dirs', () => {
    expect(affectsDiff('src/app.ts')).toBe(true)
    expect(affectsDiff('deep/er/x.cs')).toBe(true)
    expect(affectsDiff('node_modules/pkg/index.js')).toBe(false)
    expect(affectsDiff('packages/web/node_modules/pkg/index.js')).toBe(false)
    expect(affectsDiff('node_modules_notes.md')).toBe(true)
  })

  it('keeps only the four git files that are the changeset', () => {
    expect(affectsDiff('.git/HEAD')).toBe(true)
    expect(affectsDiff('.git/index')).toBe(true)
    expect(affectsDiff('.git/packed-refs')).toBe(true)
    expect(affectsDiff('.git/logs/HEAD')).toBe(true)
    expect(affectsDiff('.git/objects/ab/cdef')).toBe(false)
    expect(affectsDiff('.git/index.lock')).toBe(false)
    expect(affectsDiff('.git/FETCH_HEAD')).toBe(false)
    expect(affectsDiff('.git/logs/refs/heads/main')).toBe(false)
  })

  it('reads Windows separators too', () => {
    expect(affectsDiff('.git\\index')).toBe(true)
    expect(affectsDiff('packages\\web\\node_modules\\pkg')).toBe(false)
  })
})
