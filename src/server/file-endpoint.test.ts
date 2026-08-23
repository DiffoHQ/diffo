import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createApp } from './index.js'
import { ChangesetStore } from './store.js'

const cleanups: string[] = []
afterEach(() => {
  for (const dir of cleanups.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tempRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'diffo-file-'))
  cleanups.push(dir)
  git(dir, 'init', '-b', 'main')
  git(dir, 'config', 'user.email', 'test@example.com')
  git(dir, 'config', 'user.name', 'Test')
  git(dir, 'config', 'commit.gpgsign', 'false')
  return dir
}

function git(dir: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd: dir,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

function app(root: string) {
  const ctx = { root, spec: { kind: 'working-tree' } as const, clientDir: '/nonexistent' }
  return createApp(ctx, new ChangesetStore(root, ctx.spec))
}

describe('GET /api/file', () => {
  it('serves head (working tree) and base (HEAD) sides', async () => {
    const repo = tempRepo()
    writeFileSync(join(repo, 'a.ts'), 'committed\n')
    git(repo, 'add', '-A')
    git(repo, 'commit', '-m', 'c1')
    writeFileSync(join(repo, 'a.ts'), 'edited\n')

    const server = app(repo)
    const head = await server.request('/api/file?path=a.ts&side=head')
    expect(await head.text()).toBe('edited\n')
    const base = await server.request('/api/file?path=a.ts&side=base')
    expect(await base.text()).toBe('committed\n')
  })

  it('404s the head side of a deleted file and the base side of a new file', async () => {
    const repo = tempRepo()
    writeFileSync(join(repo, 'gone.ts'), 'x\n')
    git(repo, 'add', '-A')
    git(repo, 'commit', '-m', 'c1')
    rmSync(join(repo, 'gone.ts'))
    writeFileSync(join(repo, 'new.ts'), 'y\n')

    const server = app(repo)
    expect((await server.request('/api/file?path=gone.ts&side=head')).status).toBe(404)
    expect((await server.request('/api/file?path=new.ts&side=base')).status).toBe(404)
    expect((await server.request('/api/file?path=gone.ts&side=base')).status).toBe(200)
    expect((await server.request('/api/file?path=new.ts&side=head')).status).toBe(200)
  })

  it('rejects bad params and path escapes', async () => {
    const repo = tempRepo()
    writeFileSync(join(repo, 'a.ts'), 'x\n')
    git(repo, 'add', '-A')
    git(repo, 'commit', '-m', 'c1')

    const server = app(repo)
    expect((await server.request('/api/file?path=a.ts')).status).toBe(400)
    expect((await server.request('/api/file?side=head')).status).toBe(400)
    expect((await server.request('/api/file?path=a.ts&side=nope')).status).toBe(400)
    const traversal = await server.request(
      `/api/file?path=${encodeURIComponent('../../etc/passwd')}&side=head`,
    )
    expect(traversal.status).toBe(404)
  })

  it('serves images with an image content-type', async () => {
    const repo = tempRepo()
    writeFileSync(join(repo, 'seed.ts'), 'x\n')
    git(repo, 'add', '-A')
    git(repo, 'commit', '-m', 'c1')
    writeFileSync(join(repo, 'logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]))

    const server = app(repo)
    const res = await server.request('/api/file?path=logo.png&side=head')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('image/png')
  })

  it('never serves repo content as executable: .html and .js come back as plain text', async () => {
    const repo = tempRepo()
    writeFileSync(join(repo, 'seed.ts'), 'x\n')
    git(repo, 'add', '-A')
    git(repo, 'commit', '-m', 'c1')
    writeFileSync(join(repo, 'evil.html'), '<script>fetch("/api/shutdown")</script>\n')
    writeFileSync(join(repo, 'evil.js'), 'alert(1)\n')

    const server = app(repo)
    for (const path of ['evil.html', 'evil.js']) {
      const res = await server.request(`/api/file?path=${path}&side=head`)
      expect(res.status).toBe(200)
      expect(res.headers.get('content-type')).toBe('text/plain; charset=utf-8')
      expect(res.headers.get('x-content-type-options')).toBe('nosniff')
    }
  })

  it('keeps the svg image type for <img>, but sandboxes it (and everything here) for navigation', async () => {
    const repo = tempRepo()
    writeFileSync(join(repo, 'seed.ts'), 'x\n')
    git(repo, 'add', '-A')
    git(repo, 'commit', '-m', 'c1')
    writeFileSync(join(repo, 'pic.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>\n')

    const server = app(repo)
    const res = await server.request('/api/file?path=pic.svg&side=head')
    expect(res.headers.get('content-type')).toBe('image/svg+xml')
    expect(res.headers.get('content-security-policy')).toBe('sandbox')
    const text = await server.request('/api/file?path=seed.ts&side=head')
    expect(text.headers.get('content-security-policy')).toBe('sandbox')
  })
})
