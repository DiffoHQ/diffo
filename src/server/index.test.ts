import { describe, expect, it } from 'vitest'
import { createApp } from './index.js'

const ctx = {
  root: '/nonexistent-repo',
  spec: { kind: 'working-tree' } as const,
  clientDir: '/nonexistent-client-dir',
}

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
