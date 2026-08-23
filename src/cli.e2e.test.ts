import { type ChildProcess, execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { DiffoDb } from './server/db.js'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const cliPath = join(repoRoot, 'dist', 'cli.mjs')

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const fn of cleanups.splice(0)) fn()
})

function tempRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'diffo-e2e-'))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] })
  git('init', '-b', 'main')
  git('config', 'user.email', 'test@example.com')
  git('config', 'user.name', 'Test')
  git('config', 'commit.gpgsign', 'false')
  writeFileSync(join(dir, 'app.ts'), 'const answer = 42\n')
  git('add', '-A')
  git('commit', '-m', 'seed')
  writeFileSync(join(dir, 'app.ts'), 'const answer = 43\n')
  return dir
}

async function waitForServer(port: number, timeoutMs = 8000): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/health`)
      if (res.ok) return
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error('server did not come up')
}

describe.skipIf(!existsSync(cliPath))('diffo binary (e2e smoke)', () => {
  it('boots in a dirty repo and serves the changeset + UI', async () => {
    const repo = tempRepo()
    const port = 4321 + Math.floor(Math.random() * 1000)
    const dbDir = mkdtempSync(join(tmpdir(), 'diffo-e2e-db-'))
    cleanups.push(() => rmSync(dbDir, { recursive: true, force: true }))
    const child: ChildProcess = spawn(
      'node',
      [cliPath, '--no-open', '--foreground', '-p', String(port)],
      {
        cwd: repo,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, DIFFO_DB: join(dbDir, 'diffo.db') },
      },
    )
    cleanups.push(() => child.kill())

    await waitForServer(port)

    const changeset = (await (await fetch(`http://127.0.0.1:${port}/api/changeset`)).json()) as {
      files: { path: string; hunks: unknown[] }[]
      stats: { files: number }
    }
    expect(changeset.stats.files).toBe(1)
    expect(changeset.files[0]?.path).toBe('app.ts')
    expect(changeset.files[0]?.hunks).toHaveLength(1)

    const page = await (await fetch(`http://127.0.0.1:${port}/`)).text()
    expect(page).toContain('<div id="root">')
  })

  it('drives the pull loop end to end: registry discovery, poll, reply, comment, end', {
    timeout: 30_000,
  }, async () => {
    const repo = tempRepo()
    const port = 4321 + Math.floor(Math.random() * 1000)
    const dbDir = mkdtempSync(join(tmpdir(), 'diffo-e2e-db-'))
    cleanups.push(() => rmSync(dbDir, { recursive: true, force: true }))
    const env = { ...process.env, DIFFO_DB: join(dbDir, 'diffo.db') }
    const server: ChildProcess = spawn(
      'node',
      [cliPath, '--no-open', '--foreground', '-p', String(port)],
      {
        cwd: repo,
        stdio: ['ignore', 'pipe', 'pipe'],
        env,
      },
    )
    cleanups.push(() => server.kill())
    await waitForServer(port)

    const run = (args: string[], input?: string) =>
      new Promise<{ code: number | null; stdout: string; stderr: string }>((resolvePromise) => {
        const child = spawn('node', [cliPath, ...args], {
          cwd: repo,
          stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
          env,
        })
        let stdout = ''
        let stderr = ''
        child.stdout?.on('data', (d: Buffer) => (stdout += d.toString()))
        child.stderr?.on('data', (d: Buffer) => (stderr += d.toString()))
        if (input !== undefined) child.stdin?.end(input)
        child.on('close', (code) => resolvePromise({ code, stdout, stderr }))
      })

    const rerun = await run(['--no-open'])
    expect(rerun.code).toBe(0)
    expect(rerun.stdout).toContain('already watching this repo')
    expect(rerun.stdout).toContain(`:${port}`)

    const pollPromise = run(['poll'])
    await new Promise((r) => setTimeout(r, 300))

    const created = (await (
      await fetch(`http://127.0.0.1:${port}/api/review/threads`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ anchor: { kind: 'changeset' }, text: 'is 43 right?' }),
      })
    ).json()) as { id: string }
    await fetch(`http://127.0.0.1:${port}/api/review/threads/${created.id}/send`, {
      method: 'POST',
    })

    const poll = await pollPromise
    expect(poll.code).toBe(0)
    expect(poll.stderr).toContain('waiting for the reviewer')
    const payload = JSON.parse(poll.stdout.trim()) as {
      status: string
      threadIds: string[]
      prompt: string
    }
    expect(payload.status).toBe('feedback')
    expect(payload.threadIds).toEqual([created.id])
    expect(payload.prompt).toContain('is 43 right?')

    const reply = await run(['reply', created.id], 'yes — 43 is intentional')
    expect(reply.code).toBe(0)
    expect(JSON.parse(reply.stdout) as { ok: boolean }).toMatchObject({ ok: true })
    const review = (await (await fetch(`http://127.0.0.1:${port}/api/review`)).json()) as {
      threads: { messages: { author: string; text: string }[] }[]
    }
    expect(review.threads[0]?.messages.at(-1)).toMatchObject({
      author: 'agent',
      text: 'yes — 43 is intentional',
    })

    const onLine = await run([
      'comment',
      'app.ts',
      '--line',
      '1',
      '--message',
      'consider a named constant',
    ])
    expect(onLine.code).toBe(0)
    const onChangeset = await run([
      'comment',
      '--message',
      'start with app.ts — the rest is plumbing',
    ])
    expect(onChangeset.code).toBe(0)
    const after = (await (await fetch(`http://127.0.0.1:${port}/api/review`)).json()) as {
      threads: {
        anchor: { kind: string }
        messages: { author: string }[]
      }[]
    }
    expect(after.threads).toHaveLength(3)
    const agentThreads = after.threads.filter((t) => t.messages[0]?.author === 'agent')
    expect(agentThreads.map((t) => t.anchor.kind).sort()).toEqual(['changeset', 'hunk'])

    const end = await run(['end'])
    expect(end.code).toBe(0)
    expect(JSON.parse(end.stdout) as { ok: boolean }).toMatchObject({ ok: true })

    const bad = await run(['reply', 'nope', '--message', 'x'])
    expect(bad.code).toBe(1)
    expect(bad.stderr).toContain("no thread with id 'nope'")
  })

  it('a verb with no server spawns a daemon and succeeds (the CLI owns the lifecycle)', {
    timeout: 30_000,
  }, async () => {
    const repo = tempRepo()
    const dbDir = mkdtempSync(join(tmpdir(), 'diffo-e2e-db-'))
    cleanups.push(() => rmSync(dbDir, { recursive: true, force: true }))
    const dbPath = join(dbDir, 'diffo.db')
    const env = {
      ...process.env,
      DIFFO_DB: dbPath,
      DIFFO_SERVER_LOG: join(dbDir, 'server.log'),
    }
    const run = (args: string[]) =>
      new Promise<{ code: number | null; stdout: string; stderr: string }>((resolvePromise) => {
        const child = spawn('node', [cliPath, ...args], {
          cwd: repo,
          stdio: ['ignore', 'pipe', 'pipe'],
          env,
        })
        let stdout = ''
        let stderr = ''
        child.stdout?.on('data', (d: Buffer) => (stdout += d.toString()))
        child.stderr?.on('data', (d: Buffer) => (stderr += d.toString()))
        child.on('close', (code) => resolvePromise({ code, stdout, stderr }))
      })

    const first = await run(['end'])
    expect(first.code).toBe(0)
    expect(first.stderr).toContain('starting one')
    expect(JSON.parse(first.stdout) as { ok: boolean }).toMatchObject({ ok: true })

    const { DiffoDb } = await import('./server/db.js')
    const { realpathSync } = await import('node:fs')
    const db = new DiffoDb(dbPath)
    const record = db.getServer(realpathSync(repo)) ?? db.getServer(repo)
    db.close()
    if (!record) throw new Error('the daemon registered no server for this repo')
    const daemonPort = record.port
    cleanups.push(() => {
      void fetch(`http://127.0.0.1:${daemonPort}/api/shutdown`, { method: 'POST' }).catch(() => {})
    })
    const health = (await (await fetch(`http://127.0.0.1:${daemonPort}/api/health`)).json()) as {
      app: string
      version: string
    }
    expect(health.app).toBe('diffo')

    const second = await run(['end'])
    expect(second.code).toBe(0)
    expect(second.stderr).not.toContain('starting one')
  })

  it('a background open carries --base to the daemon it spawns', { timeout: 30_000 }, async () => {
    const repo = tempRepo()
    const git = (...args: string[]) =>
      execFileSync('git', args, { cwd: repo, stdio: ['ignore', 'pipe', 'pipe'] })
    git('checkout', '-b', 'feature')
    git('commit', '-am', 'committed work')
    const dbDir = mkdtempSync(join(tmpdir(), 'diffo-e2e-db-'))
    cleanups.push(() => rmSync(dbDir, { recursive: true, force: true }))
    const env = {
      ...process.env,
      DIFFO_DB: join(dbDir, 'diffo.db'),
      DIFFO_SERVER_LOG: join(dbDir, 'server.log'),
    }
    const run = (args: string[]) =>
      new Promise<{ code: number | null; stdout: string; stderr: string }>((resolvePromise) => {
        const child = spawn('node', [cliPath, ...args], {
          cwd: repo,
          stdio: ['ignore', 'pipe', 'pipe'],
          env,
        })
        let stdout = ''
        let stderr = ''
        child.stdout?.on('data', (d: Buffer) => (stdout += d.toString()))
        child.stderr?.on('data', (d: Buffer) => (stderr += d.toString()))
        child.on('close', (code) => resolvePromise({ code, stdout, stderr }))
      })
    const opened = await run(['--base', 'main', '--no-open'])
    const db = new DiffoDb(join(dbDir, 'diffo.db'))
    const record = db.getServer(realpathSync(repo)) ?? db.getServer(repo)
    db.close()
    if (record) {
      const daemonPort = record.port
      cleanups.push(() => {
        void fetch(`http://127.0.0.1:${daemonPort}/api/shutdown`, { method: 'POST' }).catch(
          () => {},
        )
      })
    }
    expect(opened.code).toBe(0)
    // The daemon reports what it actually watches — the base must survive the spawn.
    expect(opened.stdout).toContain('watching vs main')
    expect(opened.stdout).toContain('1 file')

    // An explicit --base against a server watching something else is told the truth.
    const other = await run(['--base', 'feature', '--no-open'])
    expect(other.code).toBe(0)
    expect(other.stdout).toContain('already watching this repo')
    expect(other.stderr).toContain('watching vs main, not vs feature')

    const stopped = await run(['stop'])
    expect(stopped.code).toBe(0)
  })

  it('help, help agent, and version need no repo and no server', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'diffo-norepo-'))
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
    const run = (args: string[]) =>
      new Promise<{ code: number | null; stdout: string; stderr: string }>((resolvePromise) => {
        const child = spawn('node', [cliPath, ...args], {
          cwd: dir,
          stdio: ['ignore', 'pipe', 'pipe'],
        })
        let stdout = ''
        let stderr = ''
        child.stdout?.on('data', (d: Buffer) => (stdout += d.toString()))
        child.stderr?.on('data', (d: Buffer) => (stderr += d.toString()))
        child.on('close', (code) => resolvePromise({ code, stdout, stderr }))
      })

    const help = await run(['help'])
    expect(help.code).toBe(0)
    expect(help.stdout).toContain('help agent')

    const agent = await run(['help', 'agent'])
    expect(agent.code).toBe(0)
    for (const cmd of ['diffo poll', 'diffo reply', 'diffo comment', 'diffo end']) {
      expect(agent.stdout).toContain(cmd)
    }
    expect(agent.stdout).toContain('tracked background task')

    const version = await run(['--version'])
    expect(version.code).toBe(0)
    expect(version.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/)

    const unknown = await run(['frobnicate'])
    expect(unknown.code).toBe(1)
    expect(unknown.stderr).toContain("unknown command 'frobnicate'")

    const typo = await run(['staus'])
    expect(typo.code).toBe(1)
    expect(typo.stderr).toContain("did you mean 'status'")
  })

  it('an empty piped message fails fast — before any daemon is spawned', async () => {
    const repo = tempRepo()
    const dbDir = mkdtempSync(join(tmpdir(), 'diffo-e2e-db-'))
    cleanups.push(() => rmSync(dbDir, { recursive: true, force: true }))
    const dbPath = join(dbDir, 'diffo.db')
    const env = { ...process.env, DIFFO_DB: dbPath }
    const run = (args: string[], input: string) =>
      new Promise<{ code: number | null; stderr: string }>((resolvePromise) => {
        const child = spawn('node', [cliPath, ...args], {
          cwd: repo,
          stdio: ['pipe', 'ignore', 'pipe'],
          env,
        })
        let stderr = ''
        child.stderr?.on('data', (d: Buffer) => (stderr += d.toString()))
        child.stdin?.end(input)
        child.on('close', (code) => resolvePromise({ code, stderr }))
      })

    const reply = await run(['reply', 't-1'], '')
    expect(reply.code).toBe(1)
    expect(reply.stderr).toContain('reply needs a message')

    const comment = await run(['comment'], '   \n')
    expect(comment.code).toBe(1)
    expect(comment.stderr).toContain('comment needs a message')

    const db = new DiffoDb(dbPath)
    const record = db.getServer(realpathSync(repo)) ?? db.getServer(repo)
    db.close()
    expect(record).toBeNull()
  })

  it('a background open with a missing base names the reason, not just a log', {
    timeout: 30_000,
  }, async () => {
    const repo = tempRepo()
    const dbDir = mkdtempSync(join(tmpdir(), 'diffo-e2e-db-'))
    cleanups.push(() => rmSync(dbDir, { recursive: true, force: true }))
    const env = {
      ...process.env,
      DIFFO_DB: join(dbDir, 'diffo.db'),
      DIFFO_SERVER_LOG: join(dbDir, 'server.log'),
    }
    const opened = await new Promise<{ code: number | null; stderr: string }>((resolvePromise) => {
      const child = spawn('node', [cliPath, '--base', 'nope', '--no-open'], {
        cwd: repo,
        stdio: ['ignore', 'ignore', 'pipe'],
        env,
      })
      let stderr = ''
      child.stderr?.on('data', (d: Buffer) => (stderr += d.toString()))
      child.on('close', (code) => resolvePromise({ code, stderr }))
    })
    expect(opened.code).toBe(1)
    expect(opened.stderr).toContain("base branch 'nope' doesn't exist")
  })

  it('fails with a human message outside a git repo', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'diffo-norepo-'))
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
    const output = await new Promise<{ code: number | null; stderr: string }>((resolvePromise) => {
      const child = spawn('node', [cliPath, '--no-open'], {
        cwd: dir,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let stderr = ''
      child.stderr?.on('data', (d: Buffer) => (stderr += d.toString()))
      child.on('close', (code) => resolvePromise({ code, stderr }))
    })
    expect(output.code).toBe(1)
    expect(output.stderr).toContain('not inside a git repository')
    expect(output.stderr).not.toContain('at ')
  })

  it('leaves a daemon behind that outlives the command, on the port asked for', async () => {
    const repo = tempRepo()
    const port = 4321 + Math.floor(Math.random() * 1000)
    const dbDir = mkdtempSync(join(tmpdir(), 'diffo-e2e-db-'))
    cleanups.push(() => rmSync(dbDir, { recursive: true, force: true }))
    const env = {
      ...process.env,
      DIFFO_DB: join(dbDir, 'diffo.db'),
      DIFFO_SERVER_LOG: join(dbDir, 'server.log'),
    }
    cleanups.push(() => {
      void fetch(`http://127.0.0.1:${port}/api/shutdown`, { method: 'POST' }).catch(() => {})
    })

    const opened = await new Promise<{ code: number | null; stdout: string }>((resolvePromise) => {
      const child = spawn('node', [cliPath, '--no-open', '-p', String(port)], {
        cwd: repo,
        stdio: ['ignore', 'pipe', 'pipe'],
        env,
      })
      let stdout = ''
      child.stdout?.on('data', (d: Buffer) => (stdout += d.toString()))
      child.on('close', (code) => resolvePromise({ code, stdout }))
    })

    expect(opened.code).toBe(0)
    expect(opened.stdout).toContain(`:${port}`)
    // stdout is piped here, so the agent-directed next step must appear.
    expect(opened.stdout).toContain('diffo poll')
    await waitForServer(port)
    const health = (await (await fetch(`http://127.0.0.1:${port}/api/health`)).json()) as {
      repo: string
      pid: number
    }
    const realRepo = realpathSync(repo)
    expect(health.repo).toBe(realRepo)
    expect(health.pid).toBeGreaterThan(0)

    const db = new DiffoDb(join(dbDir, 'diffo.db'))
    cleanups.push(() => db.close())
    expect(db.getPreferredPort(realRepo)).toBe(port)

    const run = (args: string[]) =>
      new Promise<{ code: number | null; stdout: string; stderr: string }>((resolvePromise) => {
        const child = spawn('node', [cliPath, ...args], {
          cwd: repo,
          stdio: ['ignore', 'pipe', 'pipe'],
          env,
        })
        let stdout = ''
        let stderr = ''
        child.stdout?.on('data', (d: Buffer) => (stdout += d.toString()))
        child.stderr?.on('data', (d: Buffer) => (stderr += d.toString()))
        child.on('close', (code) => resolvePromise({ code, stdout, stderr }))
      })

    const status = await run(['status'])
    expect(status.code).toBe(0)
    expect(status.stdout).toContain(`port ${port}`)
    expect(status.stdout).toContain(`:${port}`)
    expect(status.stdout).toContain('watching working tree vs HEAD')

    const statusJson = await run(['status', '--json'])
    expect(statusJson.code).toBe(0)
    expect(JSON.parse(statusJson.stdout)).toMatchObject({
      running: true,
      port,
      url: `http://localhost:${port}`,
    })

    const stop = await run(['stop'])
    expect(stop.code).toBe(0)
    expect(stop.stdout).toContain(`stopped the diffo server on port ${port}`)
    await new Promise((r) => setTimeout(r, 200))
    await expect(fetch(`http://127.0.0.1:${port}/api/health`)).rejects.toThrow()

    const after = await run(['status'])
    expect(after.code).toBe(1)
    expect(after.stdout).toContain('no diffo server is watching this repo')

    const afterJson = await run(['status', '--json'])
    expect(afterJson.code).toBe(1)
    expect(JSON.parse(afterJson.stdout)).toEqual({ running: false })
  })
})
