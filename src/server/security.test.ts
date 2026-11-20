import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp } from './index.js'

const ctx = {
  root: '/nonexistent-repo',
  spec: { kind: 'working-tree' } as const,
  clientDir: '/nonexistent-client-dir',
}

describe('Host / Origin guard', () => {
  it('allows a loopback request (the normal case)', async () => {
    const app = createApp(ctx)
    const res = await app.request('/api/health')
    expect(res.status).toBe(200)
  })

  it('rejects a non-loopback Host (DNS rebinding)', async () => {
    const app = createApp(ctx)
    const res = await app.request('/api/health', { headers: { host: 'evil.com' } })
    expect(res.status).toBe(403)
  })

  it('rejects a cross-origin request even with a loopback Host', async () => {
    const app = createApp(ctx)
    const res = await app.request('/api/health', {
      headers: { host: '127.0.0.1:4949', origin: 'https://evil.com' },
    })
    expect(res.status).toBe(403)
  })

  it('allows a same-origin (loopback) Origin', async () => {
    const app = createApp(ctx)
    const res = await app.request('/api/health', {
      headers: { host: '127.0.0.1:4949', origin: 'http://127.0.0.1:4949' },
    })
    expect(res.status).toBe(200)
  })

  it('handles bracketed IPv6 Hosts: loopback passes with a port, others never do', async () => {
    const app = createApp(ctx)
    const ok = await app.request('/api/health', { headers: { host: '[::1]:4949' } })
    expect(ok.status).toBe(200)
    const bad = await app.request('/api/health', { headers: { host: '[2001:db8::1]:4949' } })
    expect(bad.status).toBe(403)
  })
})

it('checks the URL host when the Host header is missing', async () => {
  const app = createApp(ctx)
  expect((await app.request('http://localhost/api/health')).status).toBe(200)
  expect((await app.request('http://evil.com/api/health')).status).toBe(403)
})

describe('DIFFO_ALLOWED_HOSTS: a reverse proxy in front of the loopback server', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('lets the named proxy host through as Host and Origin, and nothing else', async () => {
    vi.stubEnv('DIFFO_ALLOWED_HOSTS', 'review.example.test, .devbox.internal')
    const app = createApp(ctx)
    const status = async (host: string, origin?: string) =>
      (await app.request('/api/health', { headers: { host, ...(origin ? { origin } : {}) } }))
        .status
    expect(await status('review.example.test')).toBe(200)
    expect(await status('diffo-4949.devbox.internal', 'https://diffo-4949.devbox.internal')).toBe(
      200,
    )
    expect(await status('Diffo-4949.Devbox.Internal:443')).toBe(200)
    // a suffix entry covers subdomains only, and only on a label boundary
    expect(await status('devbox.internal')).toBe(403)
    expect(await status('evildevbox.internal')).toBe(403)
    expect(await status('evil.com')).toBe(403)
    expect(await status('127.0.0.1:4949', 'https://evil.com')).toBe(403)
  })

  it('changes nothing when unset', async () => {
    const app = createApp(ctx)
    const res = await app.request('/api/health', { headers: { host: 'diffo.devbox.internal' } })
    expect(res.status).toBe(403)
  })
})
