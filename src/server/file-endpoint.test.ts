import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
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

describe('GET /api/file from a remote device', () => {
  const relayed = { headers: { 'x-diffo-via': 'relay' } }

  it('reads tracked files and the changeset, never an ignored or untracked one', async () => {
    const repo = tempRepo()
    writeFileSync(join(repo, '.gitignore'), '.env\n')
    writeFileSync(join(repo, 'kept.ts'), 'tracked, unchanged\n')
    git(repo, 'add', '-A')
    git(repo, 'commit', '-m', 'c1')
    writeFileSync(join(repo, 'new.ts'), 'untracked, in the changeset\n')
    writeFileSync(join(repo, '.env'), 'SECRET=1\n')

    const server = app(repo)
    const read = (path: string) => server.request(`/api/file?path=${path}&side=head`, relayed)
    expect((await read('kept.ts')).status).toBe(200)
    expect(await (await read('new.ts')).text()).toBe('untracked, in the changeset\n')
    expect((await read('.env')).status).toBe(404)
    // The same file is still readable on this machine.
    expect((await server.request('/api/file?path=.env&side=head')).status).toBe(200)
  })

  it('takes the path literally, so pathspec magic cannot match an ignored file', async () => {
    const repo = tempRepo()
    writeFileSync(join(repo, '.gitignore'), '.env\n')
    git(repo, 'add', '-A')
    git(repo, 'commit', '-m', 'c1')
    writeFileSync(join(repo, '.env'), 'SECRET=1\n')

    const server = app(repo)
    for (const path of [':(glob)*env', '*env', ':/.env']) {
      const res = await server.request(
        `/api/file?path=${encodeURIComponent(path)}&side=head`,
        relayed,
      )
      expect(res.status).toBe(404)
    }
  })

  it('never leaves the repo: traversal, absolute paths, symlinks, and unlisted revs', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'diffo-outside-'))
    cleanups.push(outside)
    writeFileSync(join(outside, 'secret.txt'), 'OUTSIDE\n')
    const repo = tempRepo()
    writeFileSync(join(repo, 'a.ts'), 'x\n')
    symlinkSync(join(outside, 'secret.txt'), join(repo, 'link.txt'))
    symlinkSync(outside, join(repo, 'dirlink'))
    git(repo, 'add', '-A')
    git(repo, 'commit', '-m', 'c1')
    mkdirSync(join(repo, 'sub'))

    const server = app(repo)
    const read = async (query: string) => {
      const res = await server.request(`/api/file?${query}`, relayed)
      return { status: res.status, text: await res.text() }
    }
    for (const side of ['head', 'base']) {
      for (const path of [
        '../secret.txt',
        `${outside}/secret.txt`,
        'sub/../../secret.txt',
        'dirlink/secret.txt',
        '.git/config',
      ]) {
        const res = await read(`path=${encodeURIComponent(path)}&side=${side}`)
        expect(res.status).toBe(404)
        expect(res.text).not.toContain('OUTSIDE')
      }
    }
    // A tracked symlink is its link text, never its target.
    const link = await read('path=link.txt&side=head')
    expect(link.text).not.toContain('OUTSIDE')
    // Only a sha the changeset lists, so never another ref or a revision expression.
    for (const rev of ['HEAD', 'main', 'HEAD~0', git(repo, 'rev-parse', 'HEAD').trim()]) {
      expect((await read(`path=a.ts&side=head&rev=${encodeURIComponent(rev)}`)).status).toBe(404)
    }
  })
})
