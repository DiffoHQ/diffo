import { readFile } from 'node:fs/promises'
import { extname, resolve, sep } from 'node:path'
import { serve } from '@hono/node-server'
import { type Context, Hono } from 'hono'
import { stream, streamSSE } from 'hono/streaming'
import {
  type Anchor,
  type Coverage,
  type OutgoingThread,
  REVIEW_VERDICTS,
  type ReviewThread,
  type ReviewVerdict,
  THREAD_INTENTS,
  type ThreadIntent,
  threadsInChangeset,
  undeliveredThreadIds,
  untouchedAgentVoice,
} from '../shared/review.js'
import type { ChangesetSpec } from '../shared/types.js'
import { VERSION } from '../version.js'
import { DiffoDb, type ServerRecord } from './db.js'
import { DeliveryQueue, type Snapshot } from './delivery.js'
import {
  getBaseFileBytes,
  getCommitSubject,
  getHeadFileBytes,
  getHeadSha,
  isAncestor,
  MissingBaseError,
  resolveBaseRef,
} from './git.js'
import { IdleMonitor, resolveIdleTimeoutMs } from './idle.js'
import { maintainLanded } from './landed.js'
import {
  buildCoalescedPrompt,
  buildFinishPrompt,
  buildThreadPrompt,
  INSTALL_SKILL,
  IS_DEV,
  JOIN_PROMPT,
  nextStepFor,
  type PromptContext,
  snapshotHunk,
} from './prompt.js'
import { parseAnchor, ReviewStore } from './review.js'
import { ChangesetStore } from './store.js'
import { watchRepo } from './watcher.js'

/** Types the UI embeds in <img>/srcset — the only repo content that may keep
 * its real MIME on `/api/file`. `.svg` can carry script, so every `/api/file`
 * response also gets `Content-Security-Policy: sandbox`: a direct navigation
 * renders it scriptless in an opaque origin, while <img> decoding is untouched. */
const IMAGE_MIME: Record<string, string> = {
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
}

const MIME: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.woff2': 'font/woff2',
  ...IMAGE_MIME,
}

/** Whitespace heartbeats keep a long poll alive through proxies and idle
 * timeouts — the final JSON parses fine after them. */
const POLL_HEARTBEAT_MS = 15_000

/**
 * How long one `diffo poll` may wait before being sent away to try again.
 * Bounds the *connection*, not the agent's patience: a half-open socket never
 * aborts, and a listening poll blocks the daemon's idle reap.
 */
const POLL_MAX_MS = 30 * 60_000

export interface ServerContext {
  root: string
  spec: ChangesetSpec
  clientDir: string
  pollHeartbeatMs?: number
  pollMaxMs?: number
  onShutdownRequest?: () => void
  onListenError?: (err: NodeJS.ErrnoException) => void
  idle?: IdleMonitor
}

export function createApp(
  ctx: ServerContext,
  store?: ChangesetStore,
  review?: ReviewStore,
  queue?: DeliveryQueue,
) {
  const app = new Hono()

  if (review && queue) {
    queue.onBatchClosed((closed) => {
      if (closed.unanswered.length > 0) review.markUnanswered(closed.unanswered)
    })
  }

  // Anti-DNS-rebinding / CSRF guard. The server binds loopback, but a browser
  // pointed at evil.com (rebound to 127.0.0.1) still reaches it with `Host` and
  // `Origin` of evil.com — so accept only loopback Hosts and reject non-loopback
  // Origins, or any web page could read repo files and inject review threads.
  const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]', '::1'])
  const isLoopbackHost = (value: string): boolean => {
    // Strip a trailing :port — for a bracketed IPv6 host that means everything
    // after the closing bracket, never the colons inside it.
    const host = value.startsWith('[')
      ? value.replace(/^(\[[^\]]*\])(?::\d+)?$/, '$1')
      : value.replace(/:\d+$/, '')
    return LOOPBACK.has(host.toLowerCase())
  }
  app.use('*', async (c, next) => {
    // No Host header is not a free pass: HTTP/1.1 requires one, so its absence
    // means a hand-rolled request. Fall back to the URL's own host.
    const host = c.req.header('host') ?? new URL(c.req.url).host
    if (!isLoopbackHost(host)) {
      return c.text('Forbidden: unexpected Host header', 403)
    }
    const origin = c.req.header('origin')
    if (origin !== undefined) {
      let originHost: string
      try {
        originHost = new URL(origin).hostname
      } catch {
        return c.text('Forbidden: malformed Origin', 403)
      }
      if (!LOOPBACK.has(originHost.toLowerCase())) {
        return c.text('Forbidden: cross-origin request', 403)
      }
    }
    return next()
  })

  const parseSessionPid = (raw: string | undefined): number | null => {
    if (!raw) return null
    const pid = Number.parseInt(raw, 10)
    return Number.isInteger(pid) && pid > 1 ? pid : null
  }

  app.use('*', async (_c, next) => {
    ctx.idle?.touch()
    return next()
  })

  app.get('/api/health', (c) =>
    c.json({
      ok: true,
      repo: resolve(ctx.root),
      app: 'diffo',
      version: VERSION,
      pid: process.pid,
    }),
  )

  app.post('/api/shutdown', (c) => {
    setImmediate(() => ctx.onShutdownRequest?.())
    return c.json({ ok: true, note: 'shutting down' })
  })

  const repoInfo = () =>
    store?.get().repo ?? {
      path: resolve(ctx.root),
      name: '',
      branch: '',
      worktree: null,
    }

  const promptCtx = (...excludeThreadIds: string[]): PromptContext => ({
    repo: repoInfo(),
    changeset: store?.get() ?? null,
    siblings:
      review
        ?.get()
        .threads.filter(
          (t) => !excludeThreadIds.includes(t.id) && (t.state === 'open' || t.state === 'sent'),
        ) ?? [],
  })

  const deliverThreads = (threadIds: string[]): boolean => {
    if (!queue) return false
    const live = queue.hasListener()
    queue.enqueueThreads(threadIds)
    return live
  }

  app.get('/api/review', (c) => {
    if (!review) return c.json({ error: 'review unavailable' }, 503)
    return c.json(review.get())
  })

  /** Where an agent thread lands: the hunk showing its new-side line, else its
   * file, else the changeset — the same fallback ladder rendered threads use. */
  const agentAnchor = (file: string | null, line: number | null): Anchor => {
    if (file === null) return { kind: 'changeset' }
    const inChangeset = (store?.get().files ?? []).find((f) => f.path === file)
    if (inChangeset && line !== null) {
      for (const hunk of inChangeset.hunks) {
        if (hunk.lines.some((l) => l.kind !== 'del' && l.newNo === line)) {
          return { kind: 'hunk', hunkId: hunk.id, path: file, side: 'new', line }
        }
      }
    }
    return inChangeset ? { kind: 'file', path: file } : { kind: 'changeset' }
  }

  app.post('/api/review/threads', async (c) => {
    if (!review) return c.json({ error: 'review unavailable' }, 503)
    const body = await c.req.json().catch(() => null)
    const text = typeof body?.text === 'string' ? body.text.trim() : ''
    if (!text) return c.json({ error: 'need {anchor, text}' }, 400)
    // The agent speaks in file/line coordinates, not anchors: it has no hunk ids,
    // and the ladder below turns "this file, this line" into the best live anchor.
    if (body?.author === 'agent') {
      const file =
        typeof body?.file === 'string' && body.file.trim() !== '' ? body.file.trim() : null
      const line =
        typeof body?.line === 'number' && Number.isInteger(body.line) && body.line >= 1
          ? body.line
          : null
      const anchor = agentAnchor(file, line)
      const codeContext =
        anchor.kind === 'hunk' && store ? snapshotHunk(store.get(), anchor.hunkId) : null
      return c.json(review.createThread(anchor, text, codeContext, undefined, 'agent'))
    }
    const anchor = parseAnchor(body?.anchor)
    if (!anchor) return c.json({ error: 'need {anchor, text}' }, 400)
    const intent = THREAD_INTENTS.includes(body?.intent) ? (body.intent as ThreadIntent) : undefined
    const codeContext =
      anchor.kind === 'hunk' && store ? snapshotHunk(store.get(), anchor.hunkId) : null
    return c.json(review.createThread(anchor, text, codeContext, intent))
  })

  app.post('/api/review/threads/:id/messages', async (c) => {
    if (!review) return c.json({ error: 'review unavailable' }, 503)
    const body = await c.req.json().catch(() => null)
    const text = typeof body?.text === 'string' ? body.text.trim() : ''
    if (!text) return c.json({ error: 'need {text}' }, 400)
    if (body?.author === 'agent') {
      const id = c.req.param('id')
      // Conclude the delivery BEFORE writing the reply: the wait tells us where the
      // agent's knowledge ends, so the reply can land at its causal spot instead of
      // after reviewer comments that raced in while the agent was answering. The
      // existence check keeps a bogus id from concluding a real delivery.
      if (!review.get().threads.some((t) => t.id === id)) {
        return c.json({ error: 'no such thread' }, 404)
      }
      // Refresh the OWNER's clock, never retarget it: a reply from a second session
      // must not point the liveness watch at its harness (delivery.ts `noteSession`).
      queue?.noteSession(parseSessionPid(c.req.header('x-diffo-session-pid')))
      const waitedMs = queue?.agentReplied(id) ?? null
      const seenThroughMs = waitedMs === null ? undefined : Date.now() - waitedMs
      const thread = review.addMessage(id, 'agent', text, false, seenThroughMs)
      if (!thread) return c.json({ error: 'no such thread' }, 404)
      if (waitedMs !== null) review.annotateAgentReplies([thread.id], waitedMs)
      return c.json({ thread, delivered: false })
    }
    const deliver = body?.deliver !== false
    let thread = review.addMessage(c.req.param('id'), 'reviewer', text, !deliver)
    if (!thread) return c.json({ error: 'no such thread' }, 404)
    let delivered = false
    if (deliver && (thread.state === 'sent' || thread.state === 'addressed')) {
      delivered = deliverThreads([thread.id])
      // The queued prompt carries the whole thread, held lines included — the
      // hand-over is as real as Send's, so the flag must not outlive it.
      review.clearWithheld([thread.id])
      thread = review.get().threads.find((t) => t.id === thread!.id) ?? thread
    }
    return c.json({
      thread,
      delivered,
      presence: queue?.presence() ?? 'waiting',
    })
  })

  app.post('/api/review/threads/:id/state', async (c) => {
    if (!review) return c.json({ error: 'review unavailable' }, 503)
    const body = await c.req.json().catch(() => null)
    const state = body?.state
    if (state !== 'open' && state !== 'resolved') {
      return c.json({ error: 'state must be "resolved" or "open" (reopen)' }, 400)
    }
    const thread = review.setState(c.req.param('id'), state)
    return thread ? c.json(thread) : c.json({ error: 'no such thread' }, 404)
  })

  // Declared before the `:id` route so the bare path isn't swallowed by it.
  app.delete('/api/review/threads', (c) => {
    if (!review) return c.json({ error: 'review unavailable' }, 503)
    const removed = review.reset()
    for (const id of removed) queue?.drop(id)
    return c.json({ removed: removed.length })
  })

  // "Keep it": drop the landed marker without touching the review — the
  // reviewer looked at the offer and wants the threads to stay.
  app.delete('/api/review/landed', (c) => {
    if (!review) return c.json({ error: 'review unavailable' }, 503)
    review.clearLanded()
    return c.json({ ok: true })
  })

  app.delete('/api/review/threads/:id', (c) => {
    if (!review) return c.json({ error: 'review unavailable' }, 503)
    const id = c.req.param('id')
    if (!review.removeThread(id)) return c.json({ error: 'no such thread' }, 404)
    queue?.drop(id)
    return c.json({ removed: true })
  })

  app.post('/api/review/threads/:id/send', (c) => {
    if (!review) return c.json({ error: 'review unavailable' }, 503)
    const thread = review.send(c.req.param('id'))
    if (!thread) return c.json({ error: 'no such thread' }, 404)
    const prompt = buildThreadPrompt(thread, promptCtx(thread.id))
    const presence = queue?.presence() ?? 'waiting'
    // Only a freshly-sent thread goes to the agent; re-shipping a resolved one
    // would re-prompt about something the reviewer closed. A withheld reply on an
    // `addressed` thread is the exception — the agent has never seen that line.
    const handedOver =
      thread.state === 'sent' || (thread.state === 'addressed' && thread.withheld === true)
    const delivered = handedOver ? deliverThreads([thread.id]) : false
    if (handedOver) review.clearWithheld([thread.id])
    return c.json({ thread, prompt, delivered, presence })
  })

  /** Coverage off the wire: a real 0 must not read as "absent" (which
   * `Number(x) || 0` would), and NaN-shaped garbage must not read as a number. */
  const parseCoverage = (raw: unknown): Coverage => {
    const src = (raw ?? {}) as Record<string, unknown>
    const count = (value: unknown): number | undefined => {
      const n = Number(value)
      return Number.isFinite(n) ? n : undefined
    }
    const verdict = REVIEW_VERDICTS.includes(src.verdict as ReviewVerdict)
      ? (src.verdict as ReviewVerdict)
      : undefined
    const note =
      typeof src.note === 'string' && src.note.trim() !== ''
        ? src.note.trim().slice(0, 4000)
        : undefined
    const fileList = (value: unknown): string[] | undefined =>
      Array.isArray(value)
        ? value.filter((f: unknown): f is string => typeof f === 'string')
        : undefined
    const changedFiles = fileList(src.changedFiles)
    const commentedUnread = fileList(src.commentedUnread)
    return {
      viewedHunks: count(src.viewedHunks) ?? 0,
      totalHunks: count(src.totalHunks) ?? 0,
      viewedFiles: count(src.viewedFiles),
      totalFiles: count(src.totalFiles),
      skippedFiles: fileList(src.skippedFiles) ?? [],
      ...(changedFiles !== undefined ? { changedFiles } : {}),
      ...(commentedUnread !== undefined ? { commentedUnread } : {}),
      ...(verdict !== undefined ? { verdict } : {}),
      ...(note !== undefined ? { note } : {}),
    }
  }

  const activeThreads = (threads: ReviewThread[]): ReviewThread[] =>
    threadsInChangeset(store?.get().files ?? [], threads).active

  // Finish speaks for the reviewer, so it must never flush a thread that is still
  // purely the agent's voice — those wait for a reply or a resolution.
  const flushableIds = (threads: ReviewThread[]) =>
    new Set(
      activeThreads(threads)
        .filter((t) => !untouchedAgentVoice(t))
        .map((t) => t.id),
    )

  const projectFinish = (threads: ReviewThread[]): ReviewThread[] => {
    const flushable = flushableIds(threads)
    return threads.map((t) =>
      t.state === 'open' && flushable.has(t.id) ? { ...t, state: 'sent' as const } : t,
    )
  }

  const outgoing = (projected: ReviewThread[], before: ReviewThread[]): OutgoingThread[] =>
    projected
      .filter((t) => t.state === 'sent')
      .map((t) => ({
        id: t.id,
        anchor: t.anchor,
        text: t.messages[0]?.text ?? '',
        fresh: before.find((b) => b.id === t.id)?.state === 'open',
      }))

  app.post('/api/review/finish/preview', async (c) => {
    if (!review) return c.json({ error: 'review unavailable' }, 503)
    const body = await c.req.json().catch(() => null)
    const coverage = parseCoverage(body?.coverage)
    const before = review.get().threads
    const batch = activeThreads(projectFinish(before))
    return c.json({
      outgoing: outgoing(batch, before),
      prompt: buildFinishPrompt(
        batch,
        { repo: repoInfo(), changeset: store?.get() ?? null },
        coverage,
      ),
    })
  })

  app.post('/api/review/finish', async (c) => {
    if (!review) return c.json({ error: 'review unavailable' }, 503)
    const body = await c.req.json().catch(() => null)
    const coverage = parseCoverage(body?.coverage)
    const deliver = body?.deliver !== false
    const before = review.get().threads
    const threads = review.finish(flushableIds(before))
    const batch = activeThreads(threads)
    review.recordFinish(
      (store?.get().files ?? []).flatMap((f) => f.hunks.map((h) => h.id)),
      coverage,
    )
    const prompt = buildFinishPrompt(
      batch,
      { repo: repoInfo(), changeset: store?.get() ?? null },
      coverage,
    )
    const presence = queue?.presence() ?? 'waiting'
    let delivered = false
    if (queue && deliver) {
      delivered = queue.hasListener()
      queue.enqueueFinish(coverage)
    }
    review.clearWithheld(batch.map((t) => t.id))
    return c.json({
      threads: review.get().threads,
      prompt,
      delivered,
      presence,
    })
  })

  const pollPayload = (snapshot: Snapshot) => {
    const threads = review?.get().threads ?? []
    if (snapshot.kind === 'finish') {
      const batch = activeThreads(threads)
      const actionable = batch.filter((t) => t.state === 'sent').map((t) => t.id)
      return {
        status: 'feedback' as const,
        kind: 'finish' as const,
        threadIds: actionable,
        prompt: buildFinishPrompt(
          batch,
          { repo: repoInfo(), changeset: store?.get() ?? null },
          snapshot.coverage,
        ),
      }
    }
    const delivered = threads.filter((t) => snapshot.threadIds.includes(t.id))
    const prompt =
      delivered.length === 1
        ? buildThreadPrompt(delivered[0]!, promptCtx(delivered[0]!.id))
        : buildCoalescedPrompt(delivered, promptCtx(...snapshot.threadIds))
    return {
      status: 'feedback' as const,
      kind: 'threads' as const,
      threadIds: delivered.map((t) => t.id),
      prompt,
    }
  }

  app.get('/api/agent/poll', (c) => {
    if (!review || !queue) return c.json({ error: 'review unavailable' }, 503)
    // This GET has side effects (claims the session, confirms delivery), and
    // browsers omit `Origin` on no-cors GETs — so the rebinding guard alone
    // can't protect it. A custom x-diffo-* header can only reach us via a CORS
    // preflight, which that guard rejects: requiring one shuts out hostile web
    // pages while `diffo poll` (which always sends it) is unaffected.
    if (!c.req.header('x-diffo-agent') && !c.req.header('x-diffo-session-pid')) {
      return c.json(
        { error: 'agent polls must send the x-diffo-agent header — use `diffo poll`' },
        403,
      )
    }
    const tookOverFrom = queue.claimSession(parseSessionPid(c.req.header('x-diffo-session-pid')))
    if (tookOverFrom !== null) c.header('x-diffo-took-over-from', String(tookOverFrom))
    const heartbeatMs = ctx.pollHeartbeatMs ?? POLL_HEARTBEAT_MS
    return stream(c, async (s) => {
      let aborted = false
      let detach: (() => void) | null = null
      const release = () => detach?.()
      // A listening poll is a live agent connection — it holds the daemon up
      // exactly like a browser tab. Balanced exactly once by `drop`: the abort
      // handler fires promptly on a vanished client, the finally covers every
      // return path.
      ctx.idle?.connect()
      let counted = true
      const drop = () => {
        if (!counted) return
        counted = false
        ctx.idle?.disconnect()
      }
      s.onAbort(() => {
        aborted = true
        release()
        drop()
      })
      try {
        const deadline = Date.now() + (ctx.pollMaxMs ?? POLL_MAX_MS)
        while (!aborted) {
          let settled = false
          const attach = queue
            .attach((d) => (detach = d))
            .then((outcome) => {
              settled = true
              return outcome
            })
          while (!settled && !aborted && Date.now() < deadline) {
            const nap = Math.min(heartbeatMs, deadline - Date.now())
            await Promise.race([attach, new Promise((r) => setTimeout(r, nap))])
            if (!settled && !aborted) await s.write(' ')
          }
          if (aborted) return
          if (!settled) {
            release()
            await s.write(
              JSON.stringify({
                status: 'timeout',
                message:
                  'no feedback within the poll window — nothing is lost; re-run `diffo poll` to keep listening',
              }),
            )
            return
          }
          const outcome = await attach
          if (outcome === 'gone') {
            return
          }
          if (outcome === 'superseded') {
            await s.write(
              JSON.stringify({
                status: 'superseded',
                message:
                  'another poll attached for this repo — this one is released. The newer poll ' +
                  'carries the review now, so do nothing here and do not re-poll unless the user ' +
                  'asks. If that was not you, another agent session is on this repo: say so, so ' +
                  'the user knows where their feedback is going.',
              }),
            )
            return
          }
          if (outcome === 'ended') {
            await s.write(
              JSON.stringify({
                status: 'ended',
                message:
                  'the agent detached (`diffo end`) — do not re-poll unless asked; deliver anything remaining directly in the conversation',
              }),
            )
            return
          }
          const snapshot = queue.take()
          if (!snapshot) continue
          const inner = pollPayload(snapshot)
          const payload = {
            ...inner,
            next_step: nextStepFor(inner.kind, inner.threadIds.length),
          }
          await s.write(JSON.stringify(payload))
          // If the client vanished during the write, don't mark it delivered: Hono's
          // stream swallows write errors, so a "successful" write isn't proof of
          // receipt. Leaving it pending re-delivers next poll (at-least-once).
          if (aborted) return
          queue.confirm(snapshot, payload.threadIds)
          review.markDelivered(payload.threadIds)
          review.clearUnanswered(payload.threadIds)
          if (snapshot.kind === 'finish') review.markFinishCollected()
          return
        }
      } finally {
        drop()
      }
    })
  })

  app.post('/api/agent/end', (c) => {
    if (!queue) return c.json({ error: 'agent queue unavailable' }, 503)
    const sessionPid = parseSessionPid(c.req.header('x-diffo-session-pid'))
    if (queue.end(sessionPid)) return c.json({ ok: true })
    return c.json({
      ok: false,
      reason: 'not-owner',
      ownerPid: queue.ownerPid(),
      message:
        'this review belongs to another agent session — nothing was detached, and that ' +
        "session's poll is untouched",
    })
  })

  app.get('/api/agent/invite', (c) =>
    c.json({
      install: INSTALL_SKILL,
      join: JOIN_PROMPT,
      presence: queue?.presence() ?? 'waiting',
    }),
  )

  app.get('/api/changeset', (c) => {
    try {
      return c.json(store ? store.get() : new ChangesetStore(ctx.root, ctx.spec).get())
    } catch (err) {
      if (err instanceof MissingBaseError) {
        return c.json({ error: err.message }, 400)
      }
      throw err
    }
  })

  app.get('/api/file', (c) => {
    const path = c.req.query('path')
    const side = c.req.query('side')
    if (!path || (side !== 'base' && side !== 'head')) {
      return c.json({ error: 'need ?path= and ?side=base|head' }, 400)
    }
    let bytes: Buffer | null
    try {
      bytes =
        side === 'head'
          ? getHeadFileBytes(ctx.root, path)
          : getBaseFileBytes(ctx.root, resolveBaseRef(ctx.root, ctx.spec), path)
    } catch (err) {
      if (err instanceof MissingBaseError) return c.json({ error: err.message }, 400)
      throw err
    }
    if (bytes === null) return c.json({ error: 'no such file on that side' }, 404)
    // The repo under review is untrusted (often agent-written) content: nothing
    // served here may ever execute on this origin, or a linked evil.html could
    // drive the whole review API. Images keep their type for <img>; everything
    // else — .html and .js included — goes out as plain text, so a clicked link
    // shows source instead of running it.
    const mime = IMAGE_MIME[extname(path)] ?? 'text/plain; charset=utf-8'
    return c.body(new Uint8Array(bytes), 200, {
      'Content-Type': mime,
      'Content-Security-Policy': 'sandbox',
      'X-Content-Type-Options': 'nosniff',
    })
  })

  app.get('/api/events', (c) =>
    streamSSE(c, async (sse) => {
      if (!store) {
        await sse.close()
        return
      }
      let id = 0
      let closed = false
      // One live browser = not idle. Balanced exactly once by `drop` below.
      ctx.idle?.connect()
      let counted = true
      const drop = () => {
        if (!counted) return
        counted = false
        ctx.idle?.disconnect()
      }
      // Subscribe BEFORE the first awaited write: a transition firing in that
      // microtask window would otherwise never reach this stream.
      const unsubscribe = store.subscribe((changeset) => {
        void sse.writeSSE({
          event: 'changeset',
          data: JSON.stringify({ version: changeset.version }),
          id: String(id++),
        })
      })
      const unsubscribeReview = review?.subscribe(() => {
        void sse.writeSSE({ event: 'review', data: '{}', id: String(id++) })
      })
      const unsubscribePresence = queue?.subscribe(() => {
        void sse.writeSSE({
          event: 'presence',
          data: JSON.stringify({
            ...queue.presenceDetail(),
            workingOn: queue.deliveredThreadIds(),
            queued: queue.queuedThreadIds(),
            answered: queue.currentBatch()?.answered ?? [],
          }),
          id: String(id++),
        })
      })
      // Register the abort handler BEFORE the first awaited write — Hono never
      // fires a late `onAbort`, so a connection dying under backpressure would
      // leak all three subscriptions and spin the ping loop forever.
      sse.onAbort(() => {
        closed = true
        drop()
        unsubscribe()
        unsubscribeReview?.()
        unsubscribePresence?.()
      })
      await sse.writeSSE({
        event: 'changeset',
        data: JSON.stringify({ version: store.get().version }),
        id: String(id++),
      })
      if (queue) {
        await sse.writeSSE({
          event: 'presence',
          data: JSON.stringify({
            ...queue.presenceDetail(),
            workingOn: queue.deliveredThreadIds(),
            queued: queue.queuedThreadIds(),
            answered: queue.currentBatch()?.answered ?? [],
          }),
          id: String(id++),
        })
      }
      while (!closed) {
        await sse.sleep(15000)
        await sse.writeSSE({ event: 'ping', data: '' })
      }
    }),
  )

  const serveIndex = async (c: Context) => {
    try {
      const index = await readFile(resolve(ctx.clientDir, 'index.html'))
      return c.html(markDevIndex(index.toString(), IS_DEV))
    } catch {
      return c.text('Client not built — run `pnpm build`', 404)
    }
  }

  // Static client; anything that isn't a file falls back to index.html (SPA).
  app.get('/*', async (c) => {
    const requested = c.req.path === '/' ? 'index.html' : c.req.path.slice(1)
    const fullPath = resolve(ctx.clientDir, requested)
    if (!fullPath.startsWith(resolve(ctx.clientDir) + sep)) {
      return c.text('Forbidden', 403)
    }
    // index.html is the one static file the server rewrites, so it goes through
    // the same path as the SPA fallback rather than being streamed as a blob.
    if (resolve(fullPath) === resolve(ctx.clientDir, 'index.html')) return serveIndex(c)
    try {
      const content = await readFile(fullPath)
      const mime = MIME[extname(fullPath)] ?? 'application/octet-stream'
      return c.body(new Uint8Array(content), 200, { 'Content-Type': mime })
    } catch {
      return serveIndex(c)
    }
  })

  return app
}

/**
 * A review served from a source checkout has to LOOK like one. The reviewer may
 * have the shipped `/diffo` open in another tab, and nothing else on the page
 * distinguishes them — same UI, same repo, same diff. The title carries it into
 * the tab strip; the meta tag lets the header render a badge without an extra
 * round trip, so there is no flash of a review that looks released.
 */
export function markDevIndex(html: string, isDev: boolean): string {
  if (!isDev || html.includes('name="diffo-env"')) return html
  return html
    .replace(/<title>[^<]*<\/title>/, '<title>diffo-dev</title>')
    .replace(/<\/head>/, '    <meta name="diffo-env" content="development" />\n  </head>')
}

export function rehydrateQueue(review: ReviewStore, queue: DeliveryQueue): void {
  const state = review.get()
  queue.enqueueThreads(undeliveredThreadIds(state.threads))
  const finish = state.lastFinish
  if (finish && !finish.collectedAt) queue.enqueueFinish(finish.coverage)
}

export class RepoAlreadyServedError extends Error {
  constructor(readonly holder: ServerRecord) {
    super(`diffo is already serving this repo on port ${holder.port}`)
    this.name = 'RepoAlreadyServedError'
  }
}

export function startServer(options: ServerContext & { port: number }) {
  // Built first, deliberately: pure git, and the likeliest thing here to throw
  // (a missing base branch), so it fails before the claim below.
  const store = new ChangesetStore(options.root, options.spec)
  const db = new DiffoDb()
  // One server per repo. The claim comes before the ReviewStore on purpose: both
  // copies write the whole blob back, so a loser's watcher would erase threads.
  const { claimed, holder } = db.claimServer(resolve(options.root), options.port, process.pid)
  if (!claimed) {
    db.close()
    throw new RepoAlreadyServedError(holder)
  }
  db.setPreferredPort(resolve(options.root), options.port)
  const review = new ReviewStore(options.root, db, options.spec)
  const queue = new DeliveryQueue()
  // Start the queue on the review's scope, or feedback queued before the first
  // checkout would park under the default scope and never deliver.
  queue.rescope(store.get().repo.branch)
  rehydrateQueue(review, queue)
  const log = (message: string) =>
    console.log(`[${new Date().toLocaleTimeString('en-GB', { hour12: false })}] ${message}`)
  queue.subscribe((presence) => log(`agent ${presence}`))
  const unsubscribeBatch = queue.onBatchClosed((closed) => {
    const took = Math.round((closed.closedAt - closed.deliveredAt) / 1000)
    log(
      `agent finished a batch of ${closed.threadIds.length} in ${took}s (${closed.reason})` +
        (closed.unanswered.length > 0 ? ` — ${closed.unanswered.length} unanswered` : ''),
    )
  })
  const landedGit = {
    head: () => getHeadSha(options.root),
    isAncestor: (ancestor: string, descendant: string) =>
      isAncestor(options.root, ancestor, descendant),
    subject: (sha: string) => getCommitSubject(options.root, sha),
  }
  const checkLanded = (hasFiles: boolean) => {
    if (maintainLanded(review, hasFiles, landedGit) === 'stamped') {
      const landed = review.get().landed
      if (landed) log(`changeset landed in ${landed.sha.slice(0, 7)} — offering a fresh review`)
    }
  }
  const stopWatching = watchRepo(options.root, () => store.refresh())
  const unsubscribeReconcile = store.subscribe((changeset) => {
    // A checkout under a running server is a change of work: swap to that branch's
    // review before reconciling, or new hunks meet the old branch's threads.
    const before = review.scope.branch
    review.rescope(changeset.repo.branch)
    queue.rescope(changeset.repo.branch)
    if (review.scope.branch !== before)
      log(`branch ${before || 'detached'} → ${changeset.repo.branch || 'detached'}`)
    review.reconcile(new Set(changeset.files.flatMap((f) => f.hunks.map((h) => h.id))))
    checkLanded(changeset.files.length > 0)
  })
  review.reconcile(new Set(store.get().files.flatMap((f) => f.hunks.map((h) => h.id))))
  // Startup runs the same check: the commit that landed this review may have
  // happened while no server was watching (the idle reap makes that ordinary).
  checkLanded(store.get().files.length > 0)
  const idleTimeoutMs = resolveIdleTimeoutMs(process.env)
  let idle: IdleMonitor | undefined
  // The queue's presence is deliberately not consulted: a delivered-but-unanswered
  // batch is durable (rehydrateQueue re-sends it), so it must not pin the daemon —
  // only live connections (browser tabs, agent polls) and request recency count.
  if (idleTimeoutMs !== null) {
    idle = new IdleMonitor({
      timeoutMs: idleTimeoutMs,
      onIdle: () => {
        log(
          `idle for ${Math.round(idleTimeoutMs / 60_000)}m with no browser or agent — shutting down`,
        )
        process.exit(0)
      },
    })
    idle.start()
  }
  const app = createApp(
    {
      ...options,
      idle,
      onShutdownRequest: options.onShutdownRequest ?? (() => process.exit(0)),
    },
    store,
    review,
    queue,
  )
  const server = serve({
    fetch: app.fetch,
    port: options.port,
    hostname: '127.0.0.1',
  })
  const deregister = () => {
    try {
      db.removeServer(review.repoPath, options.port)
    } catch {
      // the DB may already be closed — the stale row is health-checked away
    }
  }
  process.once('exit', deregister)
  // `serve()` binds asynchronously: a failed listen arrives an 'error' event a
  // tick after startServer returned, so no caller's try/catch can reach it and
  // unhandled it takes the process down with a raw stack trace.
  server.on('error', (err: NodeJS.ErrnoException) => {
    deregister() // we never listened; the row must not outlive that
    if (options.onListenError) return options.onListenError(err)
    console.error(
      err.code === 'EADDRINUSE'
        ? `diffo: port ${options.port} was taken while starting up — re-run to pick another`
        : `diffo: cannot listen on port ${options.port} — ${err.message}`,
    )
    process.exit(1)
  })
  return {
    server,
    store,
    review,
    queue,
    stopWatching: async () => {
      idle?.stop()
      unsubscribeReconcile()
      unsubscribeBatch()
      await stopWatching()
      deregister()
      process.removeListener('exit', deregister)
      db.close()
    },
  }
}
