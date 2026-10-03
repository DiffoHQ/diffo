import { describe, expect, it } from 'vitest'
import { createApp, markDevIndex } from './index.js'

const ctx = {
  root: '/nonexistent-repo',
  spec: { kind: 'working-tree' } as const,
  clientDir: '/nonexistent-client-dir',
}

const INDEX = [
  '<!DOCTYPE html>',
  '<html lang="en">',
  '  <head>',
  '    <title>Diffo</title>',
  '  </head>',
  '  <body><div id="root"></div></body>',
  '</html>',
].join('\n')

describe('markDevIndex', () => {
  it('leaves a released page exactly as built', () => {
    expect(markDevIndex(INDEX, false)).toBe(INDEX)
  })

  it('renames the tab and plants the marker the header reads', () => {
    const out = markDevIndex(INDEX, true)
    expect(out).toContain('<title>diffo-dev</title>')
    expect(out).not.toContain('<title>Diffo</title>')
    expect(out).toContain('<meta name="diffo-env" content="development" />')
  })

  it('is idempotent — a second pass neither doubles the marker nor renames again', () => {
    const once = markDevIndex(INDEX, true)
    const twice = markDevIndex(once, true)
    expect(twice.match(/diffo-env/g)).toHaveLength(1)
    expect(twice).toContain('<title>diffo-dev</title>')
  })
})

describe('server', () => {
  it('responds on /api/health, naming its repo and build for the CLI handshake', async () => {
    const app = createApp(ctx)
    const res = await app.request('/api/health')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      ok: true,
      repo: '/nonexistent-repo',
      app: 'diffo',
      version: expect.stringMatching(/^\d+\.\d+\.\d+/),
      pid: process.pid,
    })
  })

  it('rejects path traversal out of the client dir', async () => {
    const app = createApp(ctx)
    const res = await app.request('/%2e%2e/etc/passwd')
    expect(res.status).not.toBe(200)
  })
})

describe('ui settings', () => {
  const put = (app: ReturnType<typeof createApp>, body: string) =>
    app.request('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body,
    })

  const withStore = () => {
    const kv = new Map<string, string>()
    const app = createApp({
      ...ctx,
      uiSettings: {
        get: (key) => kv.get(key) ?? null,
        set: (key, value) => void kv.set(key, value),
      },
    })
    return { app, kv }
  }

  it('answers null without a store, and refuses writes', async () => {
    const app = createApp(ctx)
    const res = await app.request('/api/settings')
    expect(await res.json()).toEqual({ theme: null, critter: null })
    expect((await put(app, '{"theme":"dark"}')).status).toBe(503)
  })

  it('round-trips the shared theme', async () => {
    const { app, kv } = withStore()
    expect((await put(app, '{"theme":"dark"}')).status).toBe(200)
    expect(kv.get('theme')).toBe('dark')
    const res = await app.request('/api/settings')
    expect(await res.json()).toEqual({ theme: 'dark', critter: null })
  })

  it('rejects a theme outside the three real values', async () => {
    const { app, kv } = withStore()
    expect((await put(app, '{"theme":"neon"}')).status).toBe(400)
    expect((await put(app, 'not json')).status).toBe(400)
    expect(kv.size).toBe(0)
  })

  it('reads a stored junk value as null, never as a theme', async () => {
    const { app, kv } = withStore()
    kv.set('theme', 'neon')
    kv.set('critter', 'maybe')
    const res = await app.request('/api/settings')
    expect(await res.json()).toEqual({ theme: null, critter: null })
  })

  it('round-trips the critter switch on its own, leaving the theme alone', async () => {
    const { app, kv } = withStore()
    kv.set('theme', 'dark')
    expect((await put(app, '{"critter":"off"}')).status).toBe(200)
    const res = await app.request('/api/settings')
    expect(await res.json()).toEqual({ theme: 'dark', critter: 'off' })
  })

  it('rejects a critter value other than on or off, and writes nothing', async () => {
    const { app, kv } = withStore()
    expect((await put(app, '{"critter":"maybe"}')).status).toBe(400)
    expect((await put(app, '{"theme":"dark","critter":"maybe"}')).status).toBe(400)
    expect((await put(app, '{}')).status).toBe(400)
    expect(kv.size).toBe(0)
  })
})
