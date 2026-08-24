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
