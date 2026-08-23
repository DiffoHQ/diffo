export const IDLE_TIMEOUT_MS = 30 * 60_000

/** The idle budget for this process, or null when self-stop is off.
 * `DIFFO_IDLE_TIMEOUT_MS` overrides anywhere (0 or 'off' disables); otherwise only
 * a daemon (`DIFFO_DAEMON=1`, set by the spawning CLI) gets the default budget. */
export function resolveIdleTimeoutMs(env: Record<string, string | undefined>): number | null {
  const raw = env.DIFFO_IDLE_TIMEOUT_MS?.trim()
  if (raw !== undefined && raw !== '') {
    if (raw === 'off') return null
    const value = Number(raw)
    if (!Number.isFinite(value) || value <= 0) return null
    return value
  }
  return env.DIFFO_DAEMON === '1' ? IDLE_TIMEOUT_MS : null
}

/**
 * Idleness is decided by live connections (browser tabs and agent polls) and
 * request recency — deliberately NOT by the delivery queue's state. Feedback the
 * agent never answered is durable (`rehydrateQueue` re-delivers it after a
 * respawn), so an abandoned batch must not hold the daemon alive forever.
 */
export class IdleMonitor {
  private connections = 0
  private lastActivity: number
  private timer: ReturnType<typeof setInterval> | null = null

  constructor(
    private readonly opts: {
      timeoutMs: number
      onIdle: () => void
      checkEveryMs?: number
      now?: () => number
    },
  ) {
    this.lastActivity = this.now()
  }

  private now(): number {
    return this.opts.now?.() ?? Date.now()
  }

  touch(): void {
    this.lastActivity = this.now()
  }

  connect(): void {
    this.connections++
    this.touch()
  }

  disconnect(): void {
    this.connections = Math.max(0, this.connections - 1)
    this.touch()
  }

  isIdle(): boolean {
    if (this.connections > 0) return false
    return this.now() - this.lastActivity >= this.opts.timeoutMs
  }

  start(): void {
    if (this.timer) return
    const every = this.opts.checkEveryMs ?? 60_000
    const timer = setInterval(() => {
      if (this.isIdle()) {
        this.stop()
        this.opts.onIdle()
      }
    }, every)
    // A watchdog must never be what keeps the process alive.
    timer.unref?.()
    this.timer = timer
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }
}
