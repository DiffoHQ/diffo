import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DiffoDb } from './db.js'
import { DeliveryQueue } from './delivery.js'
import { IDLE_TIMEOUT_MS, IdleMonitor, resolveIdleTimeoutMs } from './idle.js'
import { createApp } from './index.js'
import { ReviewStore } from './review.js'
import { ChangesetStore } from './store.js'

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const fn of cleanups.splice(0)) fn()
})

describe('resolveIdleTimeoutMs', () => {
  it('is off for a user-started server (no env)', () => {
    expect(resolveIdleTimeoutMs({})).toBeNull()
  })

  it('defaults a CLI-spawned daemon to the 30m budget', () => {
    expect(resolveIdleTimeoutMs({ DIFFO_DAEMON: '1' })).toBe(IDLE_TIMEOUT_MS)
  })

  it('honours an explicit budget anywhere, daemon or not', () => {
    expect(resolveIdleTimeoutMs({ DIFFO_IDLE_TIMEOUT_MS: '5000' })).toBe(5000)
    expect(resolveIdleTimeoutMs({ DIFFO_IDLE_TIMEOUT_MS: '5000', DIFFO_DAEMON: '1' })).toBe(5000)
  })

  it("0 / 'off' / junk disables self-stop even for a daemon", () => {
    expect(resolveIdleTimeoutMs({ DIFFO_IDLE_TIMEOUT_MS: '0', DIFFO_DAEMON: '1' })).toBeNull()
    expect(resolveIdleTimeoutMs({ DIFFO_IDLE_TIMEOUT_MS: 'off', DIFFO_DAEMON: '1' })).toBeNull()
    expect(resolveIdleTimeoutMs({ DIFFO_IDLE_TIMEOUT_MS: 'soon', DIFFO_DAEMON: '1' })).toBeNull()
  })
})

describe('IdleMonitor', () => {
  function monitor() {
    let now = 0
    const mon = new IdleMonitor({
      timeoutMs: 1000,
      onIdle: () => {},
      now: () => now,
    })
    return { mon, tick: (ms: number) => (now += ms) }
  }

  it('goes idle only after the budget of true silence', () => {
    const { mon, tick } = monitor()
    expect(mon.isIdle()).toBe(false)
    tick(999)
    expect(mon.isIdle()).toBe(false)
    tick(1)
    expect(mon.isIdle()).toBe(true)
  })

  it('any request resets the clock', () => {
    const { mon, tick } = monitor()
    tick(900)
    mon.touch()
    tick(900)
    expect(mon.isIdle()).toBe(false)
    tick(100)
    expect(mon.isIdle()).toBe(true)
  })

  it('an open browser stream blocks idleness however long it sits', () => {
    const { mon, tick } = monitor()
    mon.connect()
    tick(10_000)
    expect(mon.isIdle()).toBe(false)
    mon.disconnect()
    expect(mon.isIdle()).toBe(false)
    tick(1000)
    expect(mon.isIdle()).toBe(true)
  })

  it('unbalanced disconnects never go negative and wedge the counter', () => {
    const { mon, tick } = monitor()
    mon.disconnect()
    mon.connect()
    tick(10_000)
    expect(mon.isIdle()).toBe(false)
  })

  it('fires onIdle exactly once through the watchdog', async () => {
    let fired = 0
    let now = 0
    const mon = new IdleMonitor({
      timeoutMs: 5,
      onIdle: () => fired++,
      checkEveryMs: 5,
      now: () => now,
    })
    mon.start()
    now = 100
    await new Promise((r) => setTimeout(r, 40))
    expect(fired).toBe(1)
    mon.stop()
  })
})

describe('/api/events connection accounting', () => {
  it('counts a browser in on connect and back out when it disappears', async () => {
    const calls: string[] = []
    const idle = {
      touch: () => {},
      connect: () => calls.push('connect'),
      disconnect: () => calls.push('disconnect'),
    } as unknown as IdleMonitor
    const store = new ChangesetStore(process.cwd(), { kind: 'working-tree' })
    const app = createApp(
      { root: process.cwd(), spec: { kind: 'working-tree' }, clientDir: '/nonexistent', idle },
      store,
    )

    const res = await app.request('/api/events')
    const reader = res.body!.getReader()
    await reader.read()
    expect(calls).toEqual(['connect'])

    await reader.cancel()
    await vi.waitFor(() => expect(calls).toEqual(['connect', 'disconnect']))
  })
})

describe('/api/agent/poll connection accounting', () => {
  function pollApp(pollMaxMs: number) {
    const calls: string[] = []
    const idle = {
      touch: () => {},
      connect: () => calls.push('connect'),
      disconnect: () => calls.push('disconnect'),
    } as unknown as IdleMonitor
    const dbDir = mkdtempSync(join(tmpdir(), 'diffo-idle-poll-'))
    cleanups.push(() => rmSync(dbDir, { recursive: true, force: true }))
    const db = new DiffoDb(join(dbDir, 'diffo.db'))
    cleanups.push(() => db.close())
    const review = new ReviewStore(process.cwd(), db, { kind: 'working-tree' })
    const queue = new DeliveryQueue()
    const app = createApp(
      {
        root: process.cwd(),
        spec: { kind: 'working-tree' },
        clientDir: '/nonexistent',
        idle,
        pollHeartbeatMs: 10,
        pollMaxMs,
      },
      undefined,
      review,
      queue,
    )
    return { app, calls, review, queue }
  }

  it('a listening poll counts as a connection and releases it on timeout', async () => {
    const { app, calls } = pollApp(40)
    const res = await app.request('/api/agent/poll', { headers: { 'x-diffo-agent': 'cli' } })
    const payload = JSON.parse((await res.text()).trim()) as { status: string }
    expect(payload.status).toBe('timeout')
    expect(calls).toEqual(['connect', 'disconnect'])
  })

  it('a poll that collects feedback releases its connection with the payload', async () => {
    const { app, calls, review, queue } = pollApp(5_000)
    const thread = review.createThread({ kind: 'changeset' }, 'why 42?', null)
    review.send(thread.id)
    queue.enqueueThreads([thread.id])

    const res = await app.request('/api/agent/poll', { headers: { 'x-diffo-agent': 'cli' } })
    const payload = JSON.parse((await res.text()).trim()) as { status: string }
    expect(payload.status).toBe('feedback')
    expect(calls).toEqual(['connect', 'disconnect'])
  })

  it('a poll whose client vanishes mid-wait releases its connection', async () => {
    const { app, calls } = pollApp(5_000)
    const res = await app.request('/api/agent/poll', { headers: { 'x-diffo-agent': 'cli' } })
    const reader = res.body!.getReader()
    // The first read is a heartbeat — the poll is live and counted.
    await reader.read()
    expect(calls).toEqual(['connect'])

    await reader.cancel()
    await vi.waitFor(() => expect(calls).toEqual(['connect', 'disconnect']))
  })
})
