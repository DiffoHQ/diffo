import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { extname, resolve, sep } from 'node:path'
import { serve } from '@hono/node-server'
import { type Context, Hono } from 'hono'
import { stream, streamSSE } from 'hono/streaming'
import { SRC_STAMP } from '../devStamp.js'
import type { ForgeClient, PrRef, ReviewEvent } from '../forge/types.js'
import { publicUrl } from '../serverUrl.js'
import type { FoundPack } from '../share/pack.js'
import { findHunk, translateHunkAnchor } from '../shared/anchors.js'
import {
  checkArtifacts,
  findArtifacts,
  parseArtifactReport,
  REPORT_ISSUES_MAX,
} from '../shared/artifacts.js'
import {
  describeUncovered,
  formatSpan,
  hunkHeadSpan,
  parseLayersPost,
  parseSuggestReason,
  sharedByLayers,
  uncoveredByLayers,
} from '../shared/layers.js'
import {
  AGENT_PICKS,
  activePresets,
  DEFAULT_PRESET_SETTINGS,
  findPreset,
  PRESET_MESSAGE_MAX,
  parseLayersNote,
  parsePresetPatch,
  parsePresetSettings,
  presetDefault,
} from '../shared/presets.js'
import {
  type Anchor,
  askedBy,
  type Coverage,
  type DraftOrigin,
  describeAnchor,
  isHumanMessage,
  isPublic,
  type Layer,
  layerFilePath,
  liveSuggestion,
  normalizeTitle,
  type OutgoingThread,
  openedByReviewerAgent,
  parsePrComment,
  parseReviewerName,
  parseSuggestedReply,
  REVIEWER_LIMITS,
  REVIEWER_MESSAGE_MAX,
  type ReviewersPayload,
  type ReviewThread,
  roundsOf,
  seenByAgent,
  startedByAgent,
  THREAD_INTENTS,
  type ThreadIntent,
  threadsInChangeset,
  undeliveredThreadIds,
  untouchedAgentVoice,
} from '../shared/review.js'
import {
  AGENT_PICKS_SET,
  allRoles,
  allSets,
  DEFAULT_ROLE,
  findRole,
  findSet,
  isActiveRole,
  isDraftRoleKey,
  parseCustomRoles,
  parseCustomSets,
  parseRolePatch,
  type ReviewerRole,
  type ReviewerSet,
  ROLE_MESSAGE_MAX,
} from '../shared/roles.js'
import type { ChangesetSpec, PrInfo } from '../shared/types.js'
import { normalizeVoice, VOICE_MAX } from '../shared/voice.js'
import { VERSION } from '../version.js'
import {
  getCommitChangeset,
  getCommitMessage,
  isListedCommit,
  listCommitMessages,
  listCommits,
} from './commits.js'
import { DiffoDb, type ServerRecord } from './db.js'
import {
  DeliveryQueue,
  type LayersAsk,
  pidAlive,
  QUIET_POLL_LIMIT,
  REMINDER_MAX,
  type Snapshot,
} from './delivery.js'
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
  describeLeg,
  type PublicLegOutcome,
  planPublicLeg,
  REVIEW_EVENTS,
  runPublicLeg,
  suggestionsSummary,
} from './pr/finish.js'
import { PrPuller } from './pr/puller.js'
import { removeWorktree } from './pr/worktree.js'
import { DELETED, PresetStore } from './presets.js'
import {
  type AgentState,
  answeredByAgent,
  buildArtifactsPrompt,
  buildClearedPrompt,
  buildCoalescedPrompt,
  buildConnectAsk,
  buildFinishPrompt,
  buildLayersAddPrompt,
  buildLayersRequestPrompt,
  buildPresetThreadPrompt,
  buildReviewerAsk,
  buildReviewerRequestPrompt,
  buildRoleThreadPrompt,
  buildSubmittedPrompt,
  buildThreadPrompt,
  captureAnchor,
  IS_DEV,
  layersSharedError,
  nextStepFor,
  OWED_LAYERS,
  type OwedEntry,
  owedEntry,
  type PromptContext,
  REVIEWER_BRIEF,
  REVIEWER_NEXT_STEP,
  reminderStep,
  reviewerCommands,
  reviewerSetNudge,
  specLine,
  timeoutMessage,
} from './prompt.js'
import { parseAnchor, ReviewStore } from './review.js'
import {
  parseHubSnapshot,
  parseProgress,
  parseReviewerMessage,
  pickReviewerName,
  ReviewerHub,
  renderFilePatch,
  reviewerInbox,
  voiceOf,
} from './reviewers.js'
import { ROLE_DELETED, RoleStore, roleKey } from './roles.js'
import { ChangesetStore } from './store.js'
import {
  agentNameOf,
  fileMachineIdStore,
  type LayersAskKind,
  reviewKindOf,
  Telemetry,
} from './telemetry.js'
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
/** How long a reviewer agent stays listening once all its threads are closed:
 * the human's last word on one, or a message to it, still reaches it. */
const REVIEWER_GRACE_MS = 5 * 60_000

/** What a poll says when the reviewer has been quiet for `QUIET_POLL_LIMIT`
 * polls in a row: stop, and let the user decide whether to keep listening. */
function quietPayload(limit: number): string {
  return JSON.stringify({
    status: 'quiet',
    message:
      `the reviewer has sent nothing through the last ${limit} polls, so stop listening instead ` +
      'of re-polling: end your turn by asking the user, in one short line, whether to keep ' +
      'listening (yes or no), and re-run `diffo poll` only on a yes. The review stays open and ' +
      'nothing is lost: anything the reviewer sends meanwhile is held and arrives on the next poll.',
  })
}

/** How long after listening the daemon starts the machine-wide database sweep:
 * past the first page load, which is what the sweep must never delay. */
const MAINTENANCE_DELAY_MS = 5_000

/** Reviewer preferences shared across every repo's server — backed by the one
 * DiffoDb, narrowed here so createApp (and its tests) never hold a database. */
export interface UiSettings {
  get(key: string): string | null
  set(key: string, value: string): void
}

export interface ServerContext {
  root: string
  spec: ChangesetSpec
  clientDir: string
  pollHeartbeatMs?: number
  pollMaxMs?: number
  /** Overrides `QUIET_POLL_LIMIT` (tests). */
  pollQuietLimit?: number
  /** The names new reviewer agents are given, in order (tests); the default
   * is `REVIEWER_NAMES`, picked at random. */
  reviewerNames?: readonly string[]
  /** Overrides `REVIEWER_GRACE_MS` (tests). */
  reviewerGraceMs?: number
  /** Overrides `REVIEWER_ACTIVE_MS` (tests). */
  reviewerActiveMs?: number
  /** Overrides `REVIEWER_START_MS` (tests). */
  reviewerStartMs?: number
  onShutdownRequest?: () => void
  onListenError?: (err: NodeJS.ErrnoException) => void
  idle?: IdleMonitor
  uiSettings?: UiSettings
  /** Anonymous usage data; absent in tests that never touch it. */
  telemetry?: Telemetry
  /** Set when the server was opened on a pull request: the forge to talk to,
   * which PR, and the user's checkout the worktree (`root`) hangs off. */
  pr?: PrContext
  /** The port it listens on; with `DIFFO_PUBLIC_URL`, it names the one proxy
   * host this server answers to. */
  port?: number
  /** Could `diffo share` post from this repo (a GitHub origin `gh` is signed in
   * to)? Finish offers to share only then. Absent ⇒ never. */
  canShare?: () => Promise<boolean>
}

export interface PrContext {
  ref: PrRef
  forge: ForgeClient
  mainRepo: string
  /** The branch the review diffs against — the PR's base, or the override. */
  baseBranch: string
  /** The pull request as the open read it, so the changeset carries it before
   * the puller's first tick — a first tick that waits on the network. */
  info?: PrInfo
  /** A reading guide shared on the pull request, as the open found it: loaded
   * before the server listens, so the agent's first read of the review already
   * sees the layers. The puller keeps it current after that. */
  shared?: FoundPack
  /** Pull GitHub state now (tests, and the reviewer's refresh). */
  refresh?: () => Promise<void>
}

export function createApp(
  ctx: ServerContext,
  store?: ChangesetStore,
  review?: ReviewStore,
  queue?: DeliveryQueue,
) {
  const app = new Hono()

  if (review && queue) {
    // Threads that left the agent's hands with no reply: it detached, its
    // session died, or the reminders ran out on them. The review stops waiting
    // on them and says so. A thread the agent is merely slow on is not here:
    // a new poll closes nothing, and the queue reminds the agent itself
    // (delivery.ts `stallRanOut`), a reviewer agent's thread and the human's alike.
    queue.onBatchClosed((closed) => {
      if (closed.unanswered.length > 0) review.markUnanswered(closed.unanswered)
    })
  }

  // Anti-DNS-rebinding / CSRF guard. The server binds loopback, but a browser
  // pointed at evil.com (rebound to 127.0.0.1) still reaches it with `Host` and
  // `Origin` of evil.com — so accept only loopback Hosts and reject non-loopback
  // Origins, or any web page could read repo files and inject review threads.
  // DIFFO_PUBLIC_URL adds exactly one more: the origin a reverse proxy serves
  // this server at. Its host passes the Host check and its full origin the
  // Origin check; a sibling app behind the same proxy passes neither.
  const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]', '::1'])
  const pub = ctx.port === undefined ? undefined : publicUrl(ctx.port)
  const isAllowedHost = (value: string): boolean => {
    // Strip a trailing :port — for a bracketed IPv6 host that means everything
    // after the closing bracket, never the colons inside it.
    const host = value.startsWith('[')
      ? value.replace(/^(\[[^\]]*\])(?::\d+)?$/, '$1')
      : value.replace(/:\d+$/, '')
    if (LOOPBACK.has(host.toLowerCase())) return true
    if (!pub) return false
    // Parse it as the proxy's own scheme would, so case and a default port
    // (`:443` on https) compare equal.
    try {
      return new URL(`${pub.protocol}//${value}`).host === pub.host
    } catch {
      return false
    }
  }
  app.use('*', async (c, next) => {
    // No Host header is not a free pass: HTTP/1.1 requires one, so its absence
    // means a hand-rolled request. Fall back to the URL's own host.
    const host = c.req.header('host') ?? new URL(c.req.url).host
    if (!isAllowedHost(host)) {
      return c.text('Forbidden: unexpected Host header', 403)
    }
    const origin = c.req.header('origin')
    if (origin !== undefined) {
      let originUrl: URL
      try {
        originUrl = new URL(origin)
      } catch {
        return c.text('Forbidden: malformed Origin', 403)
      }
      if (!LOOPBACK.has(originUrl.hostname.toLowerCase()) && originUrl.origin !== pub?.origin) {
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

  // Reviewer agents (see reviewers.ts). Their presence and their polls live in
  // the hub, never in the author agent's queue.
  const hub = new ReviewerHub(ctx.reviewerActiveMs, pidAlive, ctx.reviewerStartMs)
  // What the hub knows of each reviewer outlives the server: its log, the
  // messages it has not read, its conversation, and who the human removed or
  // stopped. Saved on every change.
  if (review) {
    hub.restore(parseHubSnapshot(review.loadReviewerHub()))
    // Runs inside every hub change, the hub's own timers included: a failed
    // write (a busy or full database) is logged, never thrown, or a timer
    // would take the server down and a route would fail after its work.
    hub.subscribe(() => {
      try {
        review.saveReviewerHub(JSON.stringify(hub.snapshot()))
      } catch (err) {
        console.error(
          `diffo: could not save the reviewer agents' state for ${JSON.stringify(review.scope)}: ${(err as Error).message}`,
        )
      }
    })
    // A checkout under a running server swaps the review to that branch's
    // (ReviewStore.rescope): the hub swaps with it, or one branch's logs,
    // conversations and removals would show on, and be saved over, the other's.
    let hubScope = JSON.stringify(review.scope)
    review.subscribe(() => {
      const scope = JSON.stringify(review.scope)
      if (scope === hubScope) return
      hubScope = scope
      hub.reload(parseHubSnapshot(review.loadReviewerHub()))
    })
  }

  // The reviewer's own roles (shared/roles.ts) follow the human, not the repo,
  // like the layers presets: one list in the shared DB, with each role's
  // conversation with the agent beside it (server/roles.ts).
  const roleStore = ctx.uiSettings ? new RoleStore(ctx.uiSettings) : null
  const customRoles = (): ReviewerRole[] => roleStore?.roles() ?? []
  const customSets = (): ReviewerSet[] => roleStore?.sets() ?? []
  const NO_REVIEWERS_ON_PR =
    'reviewer agents join branch and working-tree reviews only; this review is of a pull request'

  /** A request only the CLI can make: a custom header a web page cannot send
   * without a preflight the Origin guard refuses (see the poll route). */
  const fromCli = (c: Context): boolean =>
    c.req.header('x-diffo-agent') !== undefined || c.req.header('x-diffo-session-pid') !== undefined

  const stoppedNotice = (name: string) =>
    `the human stopped reviewer agent "${name}". Stop here: do not comment, reply or poll again, and tell the user you were stopped`
  const removedNotice = (name: string) =>
    `the human removed reviewer agent "${name}" from this review. Stop here: do not comment, reply or poll again, and tell the user you were removed`

  /**
   * The door every reviewer-agent request comes through: the CLI's header, a
   * review that takes reviewer agents, a name that passes. A name that gets in
   * has a seat from then on, so `comment --as` without a `join` still shows the
   * reviewer in the review, and it reads as here for a while.
   */
  const reviewerAt = (
    c: Context,
    raw: unknown,
    role?: string,
    /** A join: the one command that brings a removed reviewer back in. */
    joining = false,
  ): { name: string } | Response => {
    if (!review) return c.json({ error: 'review unavailable' }, 503)
    if (!fromCli(c)) {
      return c.json({ error: 'reviewer agents reach the review through the diffo CLI' }, 403)
    }
    if (ctx.pr) return c.json({ error: NO_REVIEWERS_ON_PR }, 400)
    const parsed = parseReviewerName(raw)
    if (!parsed.ok) return c.json({ error: parsed.error }, 400)
    if (hub.isRemoved(parsed.name) || hub.isStopped(parsed.name)) {
      if (!joining) {
        return c.json(
          {
            error: hub.isStopped(parsed.name)
              ? stoppedNotice(parsed.name)
              : removedNotice(parsed.name),
          },
          403,
        )
      }
      hub.readmit(parsed.name)
    }
    const pid = parseSessionPid(c.req.header('x-diffo-session-pid'))
    const holder = hub.heldBy(parsed.name, pid)
    if (holder !== null) {
      return c.json(
        {
          error: `another session (pid ${holder}) is in this review as reviewer agent "${parsed.name}"; pick a different name with --as <name>`,
        },
        409,
      )
    }
    review.registerReviewer(parsed.name, role)
    hub.touch(parsed.name, pid)
    return { name: parsed.name }
  }

  /** What the page's strip shows: who of the seated reviewers is connected,
   * and the roles a reviewer is on its way in. */
  const reviewerPresence = (): ReviewersPayload => ({
    seats: hub.presence((review?.get().reviewers ?? []).map((r) => r.name)).map((seat) => ({
      ...seat,
      activity: hub.activity(seat.name),
      chat: hub.chat(seat.name),
      coverage: hub.coverage(seat.name),
    })),
    starting: hub.starting(),
  })

  /** Why an agent may not write in a thread that ran out of rounds. */
  const STOPPED = `this thread reached ${REVIEWER_LIMITS.rounds} rounds between the reviewer agent and the author agent, so it stopped and waits for the human reviewer: no agent may write in it until they reply or resolve it`
  /** Why a stopped thread is the human's: an agent asked them, or the rounds ran out. */
  const stoppedWhy = (thread: ReviewThread): string =>
    askedBy(thread)
      ? `the ${askedBy(thread) === 'author' ? 'author agent' : 'reviewer agent'} asked the human reviewer to decide this thread, so it waits for them: no agent may write in it until they reply or resolve it`
      : STOPPED

  app.get('/api/health', (c) =>
    c.json({
      ok: true,
      repo: resolve(ctx.root),
      app: 'diffo',
      version: VERSION,
      pid: process.pid,
      // Captured at startup, so it names the source this server LOADED — the
      // CLI compares it to the checkout on disk and retires a stale dev server.
      ...(SRC_STAMP === null ? {} : { srcStamp: SRC_STAMP }),
    }),
  )

  app.post('/api/shutdown', (c) => {
    setImmediate(() => ctx.onShutdownRequest?.())
    return c.json({ ok: true, note: 'shutting down' })
  })

  // Reviewer preferences that follow the human, not the origin: every repo is
  // served from its own port, so a localStorage choice dies with the tab. The
  // shared DB holds the durable copy; localStorage stays only as the
  // before-first-paint cache.
  const THEME_VALUES = new Set(['system', 'light', 'dark'])
  // The header critter: on unless the reviewer switched it off.
  const CRITTER_VALUES = new Set(['on', 'off'])
  const stored = (key: string, values: Set<string>) => {
    const value = ctx.uiSettings?.get(key) ?? null
    return value !== null && values.has(value) ? value : null
  }
  // The reviewer's voice (see shared/voice.ts): null is the default, which the
  // client knows on its own. Stored empty to reset, so the row never has to go.
  const storedVoice = () => normalizeVoice(ctx.uiSettings?.get('voice'))
  // The one GitHub-star ask (see ui/starNudge.ts): the critter asks after a finished
  // review, from the third one on across every repo. Counted here, not in the
  // page, because each repo's page lives on its own origin. The page reads it
  // after the finish is counted, so 3 means the third finish itself.
  // Answered with the star: never again. Answered with ✕: snoozed (stored as
  // `snoozed:<finish>`) until the tenth finish, or a few more if that is already
  // behind; a second ✕ ends it for good.
  const STAR_AFTER_FINISHES = 3
  const STAR_AGAIN_AT = 10
  const STAR_AGAIN_GAP = 7
  const finishCount = () => Number.parseInt(ctx.uiSettings?.get('finishes') ?? '0', 10) || 0
  const starState = () => ctx.uiSettings?.get('starNudge') ?? null
  const starNudge = () => {
    const state = starState()
    if (state === 'dismissed') return 'hide'
    const snoozedTo = state?.startsWith('snoozed:')
      ? Number.parseInt(state.slice(8), 10)
      : Number.NaN
    const from = Number.isFinite(snoozedTo) ? snoozedTo : STAR_AFTER_FINISHES
    return finishCount() >= from ? 'show' : 'hide'
  }
  const answerStar = (answer: 'dismissed' | 'snoozed') => {
    // A second "not now" is a no.
    if (answer === 'dismissed' || starState()?.startsWith('snoozed:')) {
      ctx.uiSettings?.set('starNudge', 'dismissed')
      return
    }
    const at = Math.max(STAR_AGAIN_AT, finishCount() + STAR_AGAIN_GAP)
    ctx.uiSettings?.set('starNudge', `snoozed:${at}`)
  }
  // The layers presets (see shared/presets.ts and server/presets.ts): the
  // reviewer's own presets with what is switched off and the default, and
  // each preset's conversation with the agent. Read leniently — a bad blob is
  // the defaults, never a review that fails to open.
  const presetStore = ctx.uiSettings ? new PresetStore(ctx.uiSettings) : null
  const presetSettings = () => presetStore?.settings() ?? DEFAULT_PRESET_SETTINGS
  app.get('/api/settings', (c) => {
    return c.json({
      theme: stored('theme', THEME_VALUES),
      critter: stored('critter', CRITTER_VALUES),
      voice: storedVoice(),
      layersPresets: presetSettings(),
      starNudge: starNudge(),
    })
  })

  app.put('/api/settings', async (c) => {
    if (!ctx.uiSettings) return c.json({ error: 'settings unavailable' }, 503)
    const body = await c.req.json().catch(() => null)
    const theme: unknown = body?.theme
    const critter: unknown = body?.critter
    const voice: unknown = body?.voice
    const presets: unknown = body?.layersPresets
    const star: unknown = body?.starNudge
    const themeOk = typeof theme === 'string' && THEME_VALUES.has(theme)
    const critterOk = typeof critter === 'string' && CRITTER_VALUES.has(critter)
    // An empty voice is the reset; anything else must fit the prompt budget.
    const voiceOk = typeof voice === 'string' && voice.trim().length <= VOICE_MAX
    // The presets are the whole blob, replaced: the dialog saves what it shows.
    const presetsParsed = presets === undefined ? null : parsePresetSettings(presets)
    if (presetsParsed !== null && !presetsParsed.ok) {
      return c.json({ error: `layersPresets: ${presetsParsed.error}` }, 400)
    }
    const presetsOk = presetsParsed?.ok === true
    const starOk = star === 'dismissed' || star === 'snoozed'
    // Each key is optional, but one must be there and whatever is there must be valid.
    if (
      (theme !== undefined && !themeOk) ||
      (critter !== undefined && !critterOk) ||
      (voice !== undefined && !voiceOk) ||
      (star !== undefined && !starOk) ||
      !(themeOk || critterOk || voiceOk || presetsOk || starOk)
    ) {
      return c.json(
        {
          error: `need {theme?: "system" | "light" | "dark", critter?: "on" | "off", voice?: string (up to ${VOICE_MAX} characters, empty for the default), layersPresets?: { presets, disabled, default }, starNudge?: "dismissed" | "snoozed"}, at least one`,
        },
        400,
      )
    }
    if (themeOk) ctx.uiSettings.set('theme', theme)
    if (critterOk) ctx.uiSettings.set('critter', critter)
    if (voiceOk) ctx.uiSettings.set('voice', voice.trim())
    if (starOk) answerStar(star)
    if (presetsParsed?.ok && presetStore) {
      const kept = new Set(presetsParsed.settings.presets.map((p) => p.id))
      const gone = presetStore.settings().presets.filter((p) => !kept.has(p.id))
      presetStore.saveSettings(presetsParsed.settings)
      // A deleted preset's parked message has nothing left to be about.
      for (const preset of gone) queue?.dropPreset(preset.id)
    }
    return c.json({ ok: true })
  })

  // Anonymous usage data (see telemetry.ts). The page reads the state to show
  // the one-time notice and the Settings toggle; the CLI's open lands here so
  // the decision to report a review is made once, in the process that reports.
  const reviewKind = () => reviewKindOf(ctx.spec, ctx.pr !== undefined)
  app.get('/api/telemetry', (c) => {
    if (!ctx.telemetry) return c.json({ error: 'telemetry unavailable' }, 503)
    return c.json(ctx.telemetry.status())
  })

  app.put('/api/telemetry', async (c) => {
    if (!ctx.telemetry) return c.json({ error: 'telemetry unavailable' }, 503)
    const body = await c.req.json().catch(() => null)
    if (typeof body?.enabled === 'boolean') {
      ctx.telemetry.setEnabled(body.enabled, 'ui')
    } else if (body?.notice === 'shown') {
      ctx.telemetry.noticeShown()
    } else if (body?.notice === 'acknowledged') {
      ctx.telemetry.acknowledge()
    } else {
      return c.json({ error: 'need {enabled: boolean} or {notice: "shown" | "acknowledged"}' }, 400)
    }
    return c.json(ctx.telemetry.status())
  })

  app.post('/api/telemetry/opened', async (c) => {
    const body = await c.req.json().catch(() => null)
    const armed =
      ctx.telemetry?.reviewOpened({
        kind: reviewKind(),
        agent: agentNameOf(body?.agent),
        ...(ctx.pr ? { sharedLayers: review?.get().layers?.shared !== undefined } : {}),
      }) ?? false
    return c.json({ ok: true, armed })
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
    ...(ctx.pr && review ? { voice: review.get().threads, voiceSetting: storedVoice() } : {}),
    siblings:
      review
        ?.get()
        .threads.filter(
          (t) => !excludeThreadIds.includes(t.id) && (t.state === 'open' || t.state === 'sent'),
        ) ?? [],
  })

  const deliverThreads = (threadIds: string[]): boolean => {
    if (!queue) return false
    // A public thread is for GitHub, never the agent — whatever route asked.
    const publicIds = new Set(
      (review?.get().threads ?? []).filter((t) => isPublic(t)).map((t) => t.id),
    )
    const ids = threadIds.filter((id) => !publicIds.has(id))
    if (ids.length === 0) return queue.hasListener()
    const live = queue.hasListener()
    queue.enqueueThreads(ids)
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

  /** Where a PR comment drafted from a layer thread lands on GitHub, which has
   * no layers: the first place of the decision the thread cites, else the
   * layer's one file, else the changeset — the review body. */
  const layerDraftAnchor = (layer: Layer, source: ReviewThread): Anchor => {
    const cited = /^> decision: (.+)$/m.exec(source.messages[0]?.text ?? '')?.[1]?.trim()
    const place = layer.decisions?.find((d) => d.text === cited)?.at?.[0]
    if (place) {
      const placed = agentAnchor(place.path, place.line ?? null)
      if (placed.kind !== 'hunk' || place.endLine === undefined) return placed
      const hunk = findHunk(store?.get().files ?? [], placed.hunkId)
      const inHunk = hunk?.lines.some((l) => l.kind !== 'del' && l.newNo === place.endLine)
      return inHunk ? { ...placed, endLine: place.endLine } : placed
    }
    const files = layer.files.map(layerFilePath)
    return files.length === 1 ? agentAnchor(files[0]!, null) : { kind: 'changeset' }
  }

  // An agent artifact broke in the reviewer's browser (src/ui/artifacts.ts):
  // queue it for the agent's next poll. Only the agent's own text counts —
  // a reviewer's preview is theirs to fix — and each distinct issue once.
  const artifactIssuesSeen = new Map<string, Set<string>>()
  app.post('/api/review/artifacts/issues', async (c) => {
    if (!review) return c.json({ error: 'review unavailable' }, 503)
    const report = parseArtifactReport(await c.req.json().catch(() => null))
    if (!report) return c.json({ error: 'need {owner, index, title, issues}' }, 400)
    const state = review.get()
    let source: string | undefined
    if (report.owner.kind === 'message') {
      const { threadId, messageId } = report.owner
      const m = state.threads
        .find((t) => t.id === threadId)
        ?.messages.find((x) => x.id === messageId)
      if (m?.author === 'agent') source = m.text
    } else {
      const { layerId } = report.owner
      source = state.layers?.items.find((l) => l.id === layerId)?.summary
    }
    if (source === undefined) return c.json({ error: 'no agent text with that artifact' }, 404)
    const found = findArtifacts(source)[report.index]
    if (!found) return c.json({ error: 'no artifact at that index' }, 404)
    const key = `${JSON.stringify(report.owner)}#${report.index}`
    // Each artifact gets REPORT_ISSUES_MAX distinct issues for the life of
    // the server: a page that reports in a loop costs the agent one batch.
    const seen = artifactIssuesSeen.get(key) ?? new Set<string>()
    const fresh = report.issues
      .filter((i) => !seen.has(i))
      .slice(0, Math.max(0, REPORT_ISSUES_MAX - seen.size))
    if (fresh.length === 0) return c.json({ queued: false })
    for (const i of fresh) seen.add(i)
    artifactIssuesSeen.set(key, seen)
    queue?.enqueueArtifact({ ...report, title: found.info.title ?? report.title, issues: fresh })
    return c.json({ queued: Boolean(queue) })
  })

  app.post('/api/review/threads', async (c) => {
    if (!review) return c.json({ error: 'review unavailable' }, 503)
    const body = await c.req.json().catch(() => null)
    const text = typeof body?.text === 'string' ? body.text.trim() : ''
    if (!text) return c.json({ error: 'need {anchor, text}' }, 400)
    // A reviewer agent's comment: the same file/line ladder the author agent
    // uses, in the reviewer's voice under its name, and handed to the author
    // agent at once, the way the human's Send would.
    if (body?.as !== undefined) {
      const who = reviewerAt(c, body.as)
      if (who instanceof Response) return who
      const art = checkArtifacts(text).errors
      if (art.length > 0) return c.json({ error: art.join('; ') }, 400)
      const file =
        typeof body?.file === 'string' && body.file.trim() !== '' ? body.file.trim() : null
      const line =
        typeof body?.line === 'number' && Number.isInteger(body.line) && body.line >= 1
          ? body.line
          : null
      const anchor = agentAnchor(file, line)
      const capture = store ? captureAnchor(store.get(), anchor) : null
      const created = review.createThread(anchor, text, capture, undefined, 'reviewer', {
        by: who.name,
      })
      const thread = review.send(created.id) ?? created
      const delivered = deliverThreads([thread.id])
      hub.log(who.name, 'commented', `commented on ${describeAnchor(thread.anchor)}`, thread.id)
      return c.json({ thread, delivered, anchored: anchor.kind })
    }
    // The agent speaks in file/line coordinates, not anchors: it has no hunk ids,
    // and the ladder below turns "this file, this line" into the best live anchor.
    if (body?.author === 'agent') {
      const art = checkArtifacts(text).errors
      if (art.length > 0) return c.json({ error: art.join('; ') }, 400)
      const file =
        typeof body?.file === 'string' && body.file.trim() !== '' ? body.file.trim() : null
      const line =
        typeof body?.line === 'number' && Number.isInteger(body.line) && body.line >= 1
          ? body.line
          : null
      const anchor = agentAnchor(file, line)
      // A suggested review comment has nowhere to go off a pull request; refusing
      // it tells the agent so, rather than dropping its words on the floor.
      const prComment = parsePrComment(body?.prComment)
      if (body?.prComment !== undefined && !ctx.pr) {
        return c.json({ error: 'a suggested PR comment needs a pull request under review' }, 400)
      }
      const capture = store ? captureAnchor(store.get(), anchor) : null
      return c.json(
        review.createThread(anchor, text, capture, undefined, 'agent', {
          suggestedReply: parseSuggestedReply(body?.suggestedReply),
          ...(prComment ? { prComment } : {}),
        }),
      )
    }
    let anchor = parseAnchor(body?.anchor)
    if (!anchor) return c.json({ error: 'need {anchor, text}' }, 400)
    // A layer thread needs its layer: one the outline has right now. The stored
    // title is the outline's, not the client's, so a label never drifts.
    const layerId = anchor.kind === 'layer' ? anchor.layerId : undefined
    const layer =
      layerId !== undefined ? review.get().layers?.items.find((l) => l.id === layerId) : undefined
    if (anchor.kind === 'layer') {
      if (!layer) return c.json({ error: 'that layer is no longer in the review' }, 400)
      anchor.title = layer.title
    }
    // Likewise a commit thread needs a commit the changeset lists, and its
    // message is git's, frozen here, not the client's.
    const commitMessage =
      anchor.kind === 'commit'
        ? await getCommitMessage(ctx.root, ctx.spec, anchor.sha).catch(() => null)
        : null
    if (anchor.kind === 'commit') {
      if (!commitMessage) return c.json({ error: 'that commit is not in the changeset' }, 400)
      anchor.subject = commitMessage.subject
    }
    const intent = THREAD_INTENTS.includes(body?.intent) ? (body.intent as ThreadIntent) : undefined
    // Public drafts exist only on a pull request; without one the flag is a mistake.
    const audience = body?.audience === 'pr' ? ('pr' as const) : undefined
    if (audience && !ctx.pr) {
      return c.json({ error: 'public comments need a pull request under review' }, 400)
    }
    if (audience && anchor.kind === 'commit') {
      return c.json({ error: 'a comment on a commit is for the agent' }, 400)
    }
    // GitHub has no layers: a comment on one is for the agent, unless it is the
    // agent's suggestion taken from a layer thread — then it moves to the code.
    if (audience && anchor.kind === 'layer') {
      const source =
        typeof body?.origin?.threadId === 'string'
          ? review.get().threads.find((t) => t.id === body.origin.threadId)
          : undefined
      if (!source || !layer) {
        return c.json({ error: 'a comment on a layer is for the agent, not the pull request' }, 400)
      }
      anchor = layerDraftAnchor(layer, source)
    }
    const parentId =
      typeof body?.parentId === 'string' && review.get().threads.some((t) => t.id === body.parentId)
        ? (body.parentId as string)
        : undefined
    // A draft made from the agent's suggestion names where it came from; the
    // suggestion is stamped as added in the same breath, so the two never
    // disagree. A stale or unknown origin is refused rather than guessed.
    let origin: DraftOrigin | undefined
    if (body?.origin !== undefined) {
      const o = body.origin
      const source =
        audience && typeof o?.threadId === 'string'
          ? review.get().threads.find((t) => t.id === o.threadId)
          : undefined
      const message =
        source && typeof o?.messageId === 'string'
          ? source.messages.find((m) => m.id === o.messageId)
          : undefined
      if (!source || !message || liveSuggestion(source)?.id !== message.id) {
        return c.json({ error: 'that suggested comment is no longer live' }, 409)
      }
      origin = {
        threadId: source.id,
        messageId: message.id,
        edited: message.prComment!.text.trim() !== text,
      }
    }
    // Made while reading by commit, the comment carries that commit's line
    // numbers. Where the full diff still has the hunk, the anchor is renamed
    // into the full diff's numbering, so the Files tab and a GitHub draft land
    // on the line that was read; where the hunk exists only in that commit,
    // the code is frozen from there, so the agent reads what was seen.
    const commitFiles =
      store && anchor.kind === 'hunk' && typeof body?.commit === 'string'
        ? ((await getCommitChangeset(ctx.root, ctx.spec, body.commit).catch(() => null))?.files ??
          null)
        : null
    const placed =
      commitFiles && anchor.kind === 'hunk'
        ? findHunk(store!.get().files, anchor.hunkId)
          ? translateHunkAnchor(anchor, commitFiles, store!.get().files)
          : // The hunk is that commit's alone: the line keeps its numbering and
            // says whose, so nothing later reads it as the full diff's.
            { ...anchor, commit: body.commit as string }
        : anchor
    let capture = commitMessage
      ? { codeContext: null, anchoredCommit: commitMessage }
      : store
        ? captureAnchor(store.get(), placed, review.get().layers)
        : null
    if (store && !capture && commitFiles) {
      capture = captureAnchor({ ...store.get(), files: commitFiles }, anchor)
    }
    const created = review.createThread(placed, text, capture, intent, 'reviewer', {
      ...(audience ? { audience } : {}),
      ...(parentId ? { parentId } : {}),
      ...(origin ? { origin } : {}),
    })
    if (origin) {
      review.decidePrComment(origin.threadId, origin.messageId, {
        kind: 'added',
        draftThreadId: created.id,
        edited: origin.edited,
        at: new Date().toISOString(),
      })
    }
    return c.json(created)
  })

  // The reviewer passes on a suggested review comment, or takes that back.
  // The thread stays open either way: a dismissal is a decision about the
  // words, not the conversation.
  app.post('/api/review/threads/:id/messages/:messageId/pr-comment', async (c) => {
    if (!review) return c.json({ error: 'review unavailable' }, 503)
    const body = await c.req.json().catch(() => null)
    const id = c.req.param('id')
    const messageId = c.req.param('messageId')
    if (body?.outcome === 'restored') {
      const thread = review.restorePrComment(id, messageId)
      return thread ? c.json(thread) : c.json({ error: 'nothing to restore there' }, 404)
    }
    if (body?.outcome !== 'dismissed') {
      return c.json({ error: 'outcome must be "dismissed" or "restored"' }, 400)
    }
    const thread = review.decidePrComment(id, messageId, {
      kind: 'dismissed',
      at: new Date().toISOString(),
    })
    return thread ? c.json(thread) : c.json({ error: 'no live suggested comment there' }, 404)
  })

  // The agent's reading plan — `{ items }` replaces the whole list — or its flag
  // that one would help: `{ suggest: true, reason? }`. Either way the store's
  // commit fans out over the SSE `review` event, so the rail redraws on its own.
  app.post('/api/review/layers', async (c) => {
    if (!review) return c.json({ error: 'review unavailable' }, 503)
    const body = await c.req.json().catch(() => null)
    if (body?.suggest === true) {
      // The suggestion may name the preset that fits: one that is on, or the
      // flag stands without it and the ack says why.
      const wanted = typeof body.preset === 'string' ? body.preset : undefined
      const preset =
        wanted !== undefined && activePresets(presetSettings()).some((p) => p.id === wanted)
          ? wanted
          : undefined
      const suggested = review.suggestLayers(parseSuggestReason(body.reason), preset)
      return c.json({
        suggested,
        ...(suggested
          ? wanted !== undefined && preset === undefined
            ? { note: `no active layers preset "${wanted}": suggested without one` }
            : {}
          : { note: 'layers are already posted, nothing to suggest' }),
      })
    }
    // The body is the CLI's `{ items, preset? }`; the shared parser reads the
    // agent's own `{ layers, preset? }`, so the list is handed over under its
    // name.
    const parsed = parseLayersPost({
      layers: body?.items,
      ...(body?.preset !== undefined ? { preset: body.preset } : {}),
    })
    if (!parsed.ok) return c.json({ error: parsed.error }, 400)
    const files = store?.get().files ?? []
    const shared = sharedByLayers(parsed.post.items, files)
    if (shared.length > 0) return c.json({ error: layersSharedError(shared) }, 400)
    // The note is the reviewer's, never the agent's: it comes from the ask this
    // post answers. A post nobody asked for keeps the one the layers had, and
    // layers asked for in the reviewer's own words alone follow no preset.
    // An ask to add what is outside the layers changes neither: the layers
    // still follow the preset and the note they did.
    const asked = queue?.takeLayersAsk() ?? null
    const prior = review.get().layers
    const kept = asked === null || asked.kind === 'add'
    const note = kept ? prior?.note : asked.note
    // A preset the reviewer does not have — an id the agent got wrong, or one
    // deleted while it was layering — has no name to head the layers with:
    // they are kept, following none, and the ack says so.
    const sent = parsed.post.preset
    const named = sent && findPreset(presetSettings(), sent.id) ? sent : undefined
    const preset =
      asked?.kind === 'own' ? undefined : asked?.kind === 'add' ? (prior?.preset ?? named) : named
    const layers = review.setLayers(parsed.post.items, {
      ...(preset ? { preset } : {}),
      ...(note ? { note } : {}),
    })
    // The post answers a standing request, if there was one: "Outlining…" gives
    // way to the outline, and the agent is back in the re-poll grace.
    queue?.layersPosted()
    // Gaps don't refuse the post: the changeset can move while the agent
    // outlines. The agent hears them in the ack and re-posts; until then the
    // reviewer reads them in the trailing layer.
    return c.json({
      layers,
      uncovered: uncoveredByLayers(layers.items, files).map(describeUncovered),
      ...(sent && !named && asked?.kind !== 'own'
        ? { note: `no layers preset "${sent.id}": posted as following none` }
        : {}),
    })
  })

  // The reviewer's click — Outline, or refresh over an outline that has gone
  // stale. It rides the delivery queue like a comment: the next `diffo poll`
  // carries it as a `layers` item, and presence shows the agent on it. Nothing
  // is written to the review; a request is a request, the post is the record.
  /** The poll's words for a layers ask: the whole doctrine for a split, or,
   * when the ask is only to add what is outside the layers there, the layers
   * as they stand and what to place in them. */
  const layersPrompt = (ask: LayersAsk): string => {
    const ctx = { repo: repoInfo(), changeset: store?.get() ?? null }
    const layers = review?.get().layers
    if (ask.kind === 'add') {
      if (layers && layers.items.length > 0) {
        const outside = uncoveredByLayers(layers.items, store?.get().files ?? []).map(
          describeUncovered,
        )
        return buildLayersAddPrompt(ctx, layers, outside)
      }
      return buildLayersRequestPrompt(ctx, null, { kind: 'auto' }, presetSettings())
    }
    return buildLayersRequestPrompt(ctx, layers?.items ?? null, ask, presetSettings())
  }

  app.post('/api/review/layers/request', async (c) => {
    if (!review || !queue) return c.json({ error: 'review unavailable' }, 503)
    // What the layers are for: a preset by id ("agent" leaves the pick to the
    // agent), or, without one, the default from Settings → Layers. An id
    // nothing active answers to is refused, not silently replaced: the dialog
    // only offers what is in play.
    // A `note` is what the reviewer wants this time only, on top of the preset;
    // `preset: null` says there is none, and the note is the whole ask.
    // `add: true` asks for no new layers: only that the agent place what is
    // outside the ones the review has. Without layers there is nothing to add
    // to, and the ask is an ordinary one.
    const body = (await c.req.json().catch(() => null)) as {
      preset?: unknown
      note?: unknown
      add?: unknown
    } | null
    const settings = presetSettings()
    const note = parseLayersNote(body?.note)
    const withNote = note ? { note } : {}
    const wanted = typeof body?.preset === 'string' ? body.preset : presetDefault(settings)
    let ask: LayersAsk
    let kind: LayersAskKind
    if (body?.add === true && (review.get().layers?.items.length ?? 0) > 0) {
      ask = { kind: 'add' }
      kind = 'add'
    } else if (body?.preset === null) {
      if (!note) return c.json({ error: 'layers asked for with no preset need a "note"' }, 400)
      ask = { kind: 'own', note }
      kind = 'one-time'
    } else if (wanted === AGENT_PICKS) {
      ask = { kind: 'auto', ...withNote }
      kind = 'agent'
    } else {
      const preset = activePresets(settings).find((p) => p.id === wanted)
      if (!preset) return c.json({ error: `no active layers preset "${wanted}"` }, 400)
      ask = { kind: 'preset', id: preset.id, ...withNote }
      kind = preset.builtIn ? 'built-in' : 'custom'
    }
    // A click while an ask is already on its way replaces the ask; one over a
    // stalled outline is a new one (enqueueLayers withdraws the stalled one).
    const before = queue.layersRequest()
    queue.enqueueLayers(ask)
    if (before === null || before === 'stalled') {
      const state = review.get()
      ctx.telemetry?.layersRequested({
        kind: reviewKind(),
        suggested: state.layersSuggested !== undefined && !state.layersSuggested.answered,
        refresh: (state.layers?.items.length ?? 0) > 0,
        preset: kind,
        note: ask.kind !== 'add' && note !== undefined,
      })
    }
    return c.json({ ok: true, request: queue.layersRequest(), presence: queue.presence() })
  })

  // The reviewer removed the outline: the Layers tab goes back to its empty
  // state, with the offer to ask for one. An ask still on its way is dropped
  // with it — the reviewer just said they do not want the layers.
  app.delete('/api/review/layers', (c) => {
    if (!review) return c.json({ error: 'review unavailable' }, 503)
    const removed = review.removeLayers()
    queue?.dropLayers()
    return c.json({ removed })
  })

  // The conversation about a layers preset (see server/presets.ts): the
  // reviewer writes to the agent from the Layers dialog, the message rides
  // the delivery queue like a layers request, and the agent answers with
  // `diffo preset update` (an edit, with a line on it) or `diffo preset
  // reply`. Presets and their conversations follow the reviewer, not the
  // repo; only the delivery needs a review, because that is where an agent
  // is attached.
  app.get('/api/presets', (c) => {
    if (!presetStore) return c.json({ error: 'settings unavailable' }, 503)
    return c.json({ presets: presetStore.list(), default: presetDefault(presetStore.settings()) })
  })

  app.get('/api/presets/:id/thread', (c) => {
    if (!presetStore) return c.json({ error: 'settings unavailable' }, 503)
    return c.json({ thread: presetStore.thread(c.req.param('id')) })
  })

  // A new conversation: the messages go, the preset stays. A message still
  // parked for the agent goes too — there is nothing left for it to answer.
  app.delete('/api/presets/:id/thread', (c) => {
    if (!presetStore) return c.json({ error: 'settings unavailable' }, 503)
    const id = c.req.param('id')
    const cleared = presetStore.clearThread(id)
    queue?.dropPreset(id)
    return c.json({ cleared, thread: presetStore.thread(id) })
  })

  app.post('/api/presets/:id/messages', async (c) => {
    if (!presetStore) return c.json({ error: 'settings unavailable' }, 503)
    const id = c.req.param('id')
    const body = (await c.req.json().catch(() => null)) as {
      author?: unknown
      text?: unknown
    } | null
    const text = typeof body?.text === 'string' ? body.text.trim() : ''
    if (text === '') return c.json({ error: 'need { text }' }, 400)
    if (text.length > PRESET_MESSAGE_MAX) {
      return c.json({ error: `keep a message under ${PRESET_MESSAGE_MAX} characters` }, 400)
    }
    const author = body?.author === 'agent' ? 'agent' : 'reviewer'
    if (
      author === 'reviewer' &&
      !presetStore.find(id) &&
      !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(id)
    ) {
      return c.json({ error: 'bad preset id' }, 400)
    }
    // An agent answering late about a preset the reviewer deleted: its words
    // have nowhere to go, and must not bring the conversation back.
    if (author === 'agent' && presetStore.wasDeleted(id)) return c.json({ error: DELETED }, 400)
    // The reviewer's first word about a preset nobody has yet makes it, empty:
    // the conversation has a preset to belong to from the start.
    if (author === 'reviewer') {
      const started = presetStore.start(id)
      if (!started.ok) return c.json({ error: started.error }, 400)
    }
    const message = presetStore.addMessage(id, author, text)
    // The reviewer's words are for the agent: parked for its next poll.
    if (author === 'reviewer') queue?.enqueuePreset(id)
    return c.json({
      message,
      thread: presetStore.thread(id),
      ...(queue ? { presence: queue.presence() } : {}),
    })
  })

  // The agent's edit: the fields it sends replace the preset's (a preset
  // nobody has yet is made from them), and the change lands in the
  // conversation with the agent's line on it and the values before, for undo.
  app.post('/api/presets/:id', async (c) => {
    if (!presetStore) return c.json({ error: 'settings unavailable' }, 503)
    const id = c.req.param('id')
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(id)) return c.json({ error: 'bad preset id' }, 400)
    const body = (await c.req.json().catch(() => null)) as {
      fields?: unknown
      message?: unknown
    } | null
    const patch = parsePresetPatch(body?.fields)
    if (!patch.ok) return c.json({ error: patch.error }, 400)
    const existed = presetStore.find(id) !== undefined
    const result = presetStore.upsert(id, patch.patch)
    if (!result.ok) return c.json({ error: result.error }, 400)
    const text = typeof body?.message === 'string' ? body.message : ''
    const message = presetStore.addMessage(id, 'agent', text, result.change)
    // A preset under an id of the agent's own, while a built-in's conversation
    // waits on it, is the copy the reviewer asked for there. The answer goes
    // to that conversation too, naming the copy: otherwise the reviewer waits
    // on a thread the agent has already answered somewhere else.
    if (!existed) {
      const asked = presetStore.waitingBuiltIn()
      if (asked) {
        const where = `The copy is “${result.preset.name}”, under your presets.`
        presetStore.addMessage(
          asked.id,
          'agent',
          text.trim() ? `${text.trim()}\n\n${where}` : where,
        )
      }
    }
    return c.json({ preset: result.preset, message, thread: presetStore.thread(id) })
  })

  app.post('/api/review/threads/:id/messages', async (c) => {
    if (!review) return c.json({ error: 'review unavailable' }, 503)
    const body = await c.req.json().catch(() => null)
    const text = typeof body?.text === 'string' ? body.text.trim() : ''
    if (!text) return c.json({ error: 'need {text}' }, 400)
    // A reviewer agent answers in a thread it opened, one message per turn:
    // it speaks, the author agent answers, and so on until the rounds run out.
    if (body?.as !== undefined) {
      const who = reviewerAt(c, body.as)
      if (who instanceof Response) return who
      const id = c.req.param('id')
      const current = review.get().threads.find((t) => t.id === id)
      if (!current) return c.json({ error: 'no such thread' }, 404)
      if (openedByReviewerAgent(current) !== who.name) {
        return c.json(
          {
            error: `reviewer agent "${who.name}" did not open this thread, and a reviewer agent replies only in threads it opened; open a thread of your own with \`comment --as ${who.name}\``,
          },
          403,
        )
      }
      if (current.state === 'resolved') {
        return c.json({ error: 'this thread is resolved; only the human reopens one' }, 409)
      }
      if (current.needsYou || roundsOf(current) >= REVIEWER_LIMITS.rounds) {
        return c.json({ error: stoppedWhy(current) }, 409)
      }
      // The human's until they send it: they wrote here and are holding the
      // line, or reopened the thread. A reply now would queue it for the author
      // agent with what they have not sent in it.
      if (current.withheld || current.state === 'open') {
        return c.json(
          {
            error: `the human ${current.withheld ? 'is writing in this thread and has not sent it yet' : 'reopened this thread and has not sent it again'}; leave it, and run \`poll --as ${who.name}\`: it brings their words once they send`,
          },
          409,
        )
      }
      if (current.messages.at(-1)?.by === who.name) {
        return c.json(
          {
            error: `you spoke last in this thread; wait for the answer (\`poll --as ${who.name}\`) before writing in it again`,
          },
          409,
        )
      }
      const art = checkArtifacts(text).errors
      if (art.length > 0) return c.json({ error: art.join('; ') }, 400)
      const thread = review.addMessage(
        id,
        'reviewer',
        text,
        false,
        undefined,
        false,
        undefined,
        undefined,
        who.name,
      )
      if (!thread) return c.json({ error: 'no such thread' }, 404)
      // A question for the human (`--ask`): the thread stops for their
      // decision, and the author agent is not handed it meanwhile.
      if (body?.ask === true) {
        const asked = review.askHuman(id, 'reviewer') ?? thread
        hub.log(who.name, 'asked', `asked you to decide on ${describeAnchor(thread.anchor)}`, id)
        return c.json({ thread: asked, delivered: false, asked: true })
      }
      const delivered = deliverThreads([id])
      hub.log(who.name, 'replied', `replied on ${describeAnchor(thread.anchor)}`, id)
      return c.json({
        thread,
        delivered,
        roundsLeft: REVIEWER_LIMITS.rounds - roundsOf(thread) - 1,
      })
    }
    if (body?.author === 'agent') {
      const id = c.req.param('id')
      // Conclude the delivery BEFORE writing the reply: the wait tells us where the
      // agent's knowledge ends, so the reply can land at its causal spot instead of
      // after reviewer comments that raced in while the agent was answering. The
      // existence check keeps a bogus id from concluding a real delivery.
      const answered = review.get().threads.find((t) => t.id === id)
      if (!answered) return c.json({ error: 'no such thread' }, 404)
      // Stopped for the human (rounds cap or --ask): the author agent's word
      // would land in a thread that is theirs now.
      if (answered.needsYou) return c.json({ error: `${stoppedWhy(answered)}; move on` }, 409)
      // Asking the human is for a thread between two agents; in the human's
      // own thread every reply already reaches them.
      const asking = body?.ask === true
      if (asking && openedByReviewerAgent(answered) === null) {
        return c.json(
          {
            error:
              "--ask is for a reviewer agent's thread; this one is the human's, and your reply already reaches them",
          },
          400,
        )
      }
      // A resolved thread needs nobody: asking would mark it as needing the
      // human while it reads as closed.
      if (asking && answered.state === 'resolved') {
        return c.json({ error: 'this thread is resolved; there is nothing to ask' }, 409)
      }
      if (asking && body?.more === true) {
        return c.json({ error: '--ask is a whole answer; drop --more' }, 400)
      }
      const art = checkArtifacts(text).errors
      if (art.length > 0) return c.json({ error: art.join('; ') }, 400)
      // Refresh the OWNER's clock, never retarget it: a reply from a second session
      // must not point the liveness watch at its harness (delivery.ts `noteSession`).
      queue?.noteSession(parseSessionPid(c.req.header('x-diffo-session-pid')))
      // An interim reply (`--more`): a follow-up is promised, so the thread
      // stays on the delivery clock and keeps waiting on the agent.
      const more = body?.more === true
      const prComment = parsePrComment(body?.prComment)
      if (body?.prComment !== undefined && !ctx.pr) {
        return c.json({ error: 'a suggested PR comment needs a pull request under review' }, 400)
      }
      const waitedMs = queue?.agentReplied(id, more) ?? null
      const seenThroughMs = waitedMs === null ? undefined : Date.now() - waitedMs
      const thread = review.addMessage(
        id,
        'agent',
        text,
        false,
        seenThroughMs,
        more,
        parseSuggestedReply(body?.suggestedReply),
        prComment,
      )
      if (!thread) return c.json({ error: 'no such thread' }, 404)
      if (waitedMs !== null) review.annotateAgentReplies([thread.id], waitedMs)
      if (asking) {
        return c.json({
          thread: review.askHuman(id, 'author') ?? thread,
          delivered: false,
          asked: true,
        })
      }
      return c.json({ thread, delivered: false })
    }
    const target = review.get().threads.find((t) => t.id === c.req.param('id'))
    if (target && isPublic(target)) {
      // A reply on a public thread is a draft reply for GitHub: it posts on
      // Finish, and the agent never sees it. Nothing to hand over here.
      const replied = review.addMessage(target.id, 'reviewer', text, false)
      return c.json({ thread: replied, delivered: false, presence: queue?.presence() ?? 'waiting' })
    }
    const deliver = body?.deliver !== false
    let thread = review.addMessage(c.req.param('id'), 'reviewer', text, !deliver)
    if (!thread) return c.json({ error: 'no such thread' }, 404)
    // Replying to the agent's own comment takes it up: the agent already knows
    // the thread, so the reply IS the hand-over — one click, not Reply then Send.
    // A reviewer-started thread stays open for its Send or the finish batch.
    if (deliver && thread.state === 'open' && startedByAgent(thread)) {
      thread = review.send(thread.id) ?? thread
    }
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

  // The reviewer rewrites one of their own messages (see `ReviewStore.editMessage`).
  // A rewrite the agent must hear about rides the same hand-over as a reply;
  // `deliver: false` holds it. Refused while the agent is answering the thread:
  // its reply would land under words it never read.
  app.patch('/api/review/threads/:id/messages/:messageId', async (c) => {
    if (!review) return c.json({ error: 'review unavailable' }, 503)
    const body = await c.req.json().catch(() => null)
    const text = typeof body?.text === 'string' ? body.text.trim() : ''
    if (!text) return c.json({ error: 'need {text}' }, 400)
    const id = c.req.param('id')
    const messageId = c.req.param('messageId')
    const current = review.get().threads.find((t) => t.id === id)
    const index = current?.messages.findIndex((m) => m.id === messageId) ?? -1
    if (!current || index === -1) return c.json({ error: 'no such message' }, 404)
    // Yours means the human's: a reviewer agent's message is a `reviewer`
    // message too, and rewriting it would put the human's words under its name.
    if (!isHumanMessage(current.messages[index]!)) {
      return c.json({ error: 'only your own messages can be edited' }, 400)
    }
    // A message GitHub already holds is edited there: rewriting it here would
    // show words GitHub never saw, and cut the replies under it until the next
    // import put them back. A draft, or a reply still owed, is only local.
    if (current.messages[index]!.github !== undefined) {
      return c.json({ error: 'this comment is on GitHub; edit it there' }, 409)
    }
    if (current.state === 'resolved') {
      return c.json({ error: 'reopen the thread to edit it' }, 409)
    }
    if (queue?.deliveredThreadIds().includes(id)) {
      return c.json({ error: 'the agent is answering this thread — edit after it replies' }, 409)
    }
    const seen = seenByAgent(current, index)
    const deliver = body?.deliver !== false
    let thread = review.editMessage(id, messageId, text, !deliver)!
    let delivered = false
    if (seen && deliver && (thread.state === 'sent' || thread.state === 'addressed')) {
      delivered = deliverThreads([id])
      review.clearWithheld([id])
      thread = review.get().threads.find((t) => t.id === id) ?? thread
    }
    return c.json({ thread, delivered, presence: queue?.presence() ?? 'waiting' })
  })

  app.post('/api/review/threads/:id/state', async (c) => {
    if (!review) return c.json({ error: 'review unavailable' }, 503)
    const body = await c.req.json().catch(() => null)
    const state = body?.state
    if (state !== 'open' && state !== 'resolved') {
      return c.json({ error: 'state must be "resolved" or "open" (reopen)' }, 400)
    }
    const id = c.req.param('id')
    // Who may close what: a reviewer agent, only a thread it opened; the
    // author agent, none; the human, any, and only the human reopens.
    if (body?.author === 'agent') {
      return c.json({ error: "resolving a thread is the reviewer's call, never the agent's" }, 403)
    }
    if (body?.as !== undefined) {
      const who = reviewerAt(c, body.as)
      if (who instanceof Response) return who
      const mine = review.get().threads.find((t) => t.id === id)
      if (!mine) return c.json({ error: 'no such thread' }, 404)
      if (state !== 'resolved') {
        return c.json({ error: 'a reviewer agent closes threads; only the human reopens one' }, 403)
      }
      if (openedByReviewerAgent(mine) !== who.name) {
        const opener = mine.messages[0]
        return c.json(
          {
            error: `reviewer agent "${who.name}" did not open this thread (the ${opener ? voiceOf(opener) : 'human reviewer'} did), and a reviewer agent closes only threads it opened`,
          },
          403,
        )
      }
      if (mine.state === 'resolved') return c.json({ thread: mine })
      if (mine.needsYou) {
        return c.json({ error: `${stoppedWhy(mine)}; closing it is theirs too now` }, 409)
      }
      // Reopened by the human: closing it again is not the reviewer's answer
      // to give before they have said why.
      if (mine.state === 'open') {
        return c.json(
          { error: 'the human reopened this thread; it is theirs until they send it again' },
          409,
        )
      }
      // Closed: nothing left to hand over, and no reply left to wait for. A
      // thread the author agent is answering comes off its clock without
      // counting as unanswered; a reply that still arrives lands as usual.
      queue?.drop(id)
      const thread = review.setState(id, 'resolved', who.name)
      if (thread) {
        hub.log(who.name, 'closed', `closed its thread on ${describeAnchor(thread.anchor)}`, id)
      }
      return thread ? c.json({ thread }) : c.json({ error: 'no such thread' }, 404)
    }
    const current = review.get().threads.find((t) => t.id === id)
    if (!current) return c.json({ error: 'no such thread' }, 404)
    // An inline thread GitHub knows resolves there too — on Finish. Until then
    // the change is local and queued; toggling back withdraws it. The other
    // public kinds (the description, a review body, a conversation comment)
    // have no resolution on GitHub: theirs is local only.
    if (isPublic(current) && current.github?.kind === 'inline') {
      const thread = review.queueResolve(id, state === 'resolved')
      return thread ? c.json(thread) : c.json({ error: 'no such thread' }, 404)
    }
    // Resolved by the human: the agent owes it no reply any more, so it is
    // never reminded of it. What is queued for the agent stays queued.
    if (state === 'resolved') queue?.release(id)
    const thread = review.setState(id, state)
    return thread ? c.json(thread) : c.json({ error: 'no such thread' }, 404)
  })

  // Declared before the `:id` route so the bare path isn't swallowed by it.
  app.delete('/api/review/threads', (c) => {
    if (!review) return c.json({ error: 'review unavailable' }, 503)
    const before = review.get()
    const hadRound = before.threads.length > 0 || before.lastFinish !== undefined
    const removed = review.reset()
    // The seats went with the round, and what the hub kept for them goes too.
    hub.clear()
    for (const id of removed) queue?.drop(id)
    // reset() dropped the layers; a request for them has nothing to answer.
    queue?.dropLayers()
    // The fresh round may already be on screen, guideless — wake the polling
    // agent with the heads-up so it can orient the reviewer with a new guide.
    if (hadRound && (store?.get().files.length ?? 0) > 0) queue?.enqueueCleared()
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
    const asked = review.get().threads.find((t) => t.id === c.req.param('id'))
    if (asked && isPublic(asked)) {
      return c.json(
        { error: 'a public comment is for GitHub; it posts when you finish the review' },
        400,
      )
    }
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
    // Answer with the thread as it now stands — the hand-over just cleared the flag.
    const current = review.get().threads.find((t) => t.id === thread.id) ?? thread
    return c.json({ thread: current, prompt, delivered, presence })
  })

  /** Coverage off the wire: a real 0 must not read as "absent" (which
   * `Number(x) || 0` would), and NaN-shaped garbage must not read as a number. */
  const parseCoverage = (raw: unknown): Coverage => {
    const src = (raw ?? {}) as Record<string, unknown>
    const count = (value: unknown): number | undefined => {
      const n = Number(value)
      return Number.isFinite(n) ? n : undefined
    }
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
      ...(note !== undefined ? { note } : {}),
      // Kept only when sharing is possible at all: `gateShare` decides.
      ...(src.shareLayers === true ? { shareLayers: true as const } : {}),
    }
  }

  /** Only the author shares, and only what is here to share, where it can be
   * shared: a branch review (a PR review reads someone's PR, it never posts
   * one) with layers of its own, in a repo whose origin `gh` can post to. */
  const shareable = async (): Promise<boolean> =>
    !ctx.pr &&
    (review?.get().layers?.items.length ?? 0) > 0 &&
    ctx.canShare !== undefined &&
    (await ctx.canShare().catch(() => false))

  const gateShare = async (coverage: Coverage): Promise<Coverage> => {
    if (coverage.shareLayers && !(await shareable())) {
      const { shareLayers: _dropped, ...rest } = coverage
      return rest
    }
    return coverage
  }

  // The threads Finish and the poll speak about: on the current changeset, and
  // the agent's to hear. A public thread is a GitHub draft or a GitHub
  // conversation — never the agent's, whatever route asks — and this is the one
  // place that rule is applied on the way to a prompt.
  const activeThreads = (threads: ReviewThread[]): ReviewThread[] =>
    threadsInChangeset(store?.get().files ?? [], threads, review?.get().layers).active.filter(
      (t) => !isPublic(t),
    )

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

  /**
   * A closing note only becomes a thread while the changeset still has files to
   * anchor it to — an empty diff would file it straight into the past, where the
   * reviewer can't see it and the agent is never given it. In that case the note
   * stays prose in the prompt (`buildFinishPrompt` quotes it when no thread carries
   * it), which is all it ever was.
   */
  const notable = (coverage: Coverage): boolean =>
    coverage.note !== undefined && (store?.get().files.length ?? 0) > 0

  /** The preview must show the note the same way Finish will send it — a thread in
   * the batch — without writing one for a review the reviewer may still walk away
   * from. */
  const projectClosingNote = (threads: ReviewThread[], coverage: Coverage): ReviewThread[] => {
    if (!notable(coverage)) return threads
    const at = new Date().toISOString()
    return [
      ...threads,
      {
        id: 'closing-note-preview',
        anchor: { kind: 'changeset' },
        state: 'sent',
        closingNote: true,
        codeContext: null,
        codeChanged: false,
        messages: [
          { id: 'closing-note-preview-message', author: 'reviewer', text: coverage.note!, at },
        ],
        createdAt: at,
        updatedAt: at,
      },
    ]
  }

  const outgoing = (projected: ReviewThread[], before: ReviewThread[]): OutgoingThread[] =>
    projected
      .filter((t) => t.state === 'sent')
      .map((t) => ({
        id: t.id,
        anchor: t.anchor,
        text: t.messages[0]?.text ?? '',
        // Absent from `before` ⇒ this Finish is creating it (the closing note), which
        // is as fresh as a thread that was merely open.
        fresh: (before.find((b) => b.id === t.id)?.state ?? 'open') === 'open',
      }))

  app.post('/api/review/finish/preview', async (c) => {
    if (!review) return c.json({ error: 'review unavailable' }, 503)
    const body = await c.req.json().catch(() => null)
    const coverage = await gateShare(parseCoverage(body?.coverage))
    const before = review.get().threads
    const batch = projectClosingNote(activeThreads(projectFinish(before)), coverage)
    const pr = store?.get().pr
    const leg = ctx.pr ? planPublicLeg(before, store?.get().files ?? []) : null
    return c.json({
      outgoing: outgoing(batch, before),
      canShareLayers: await shareable(),
      prompt: buildFinishPrompt(
        batch,
        { repo: repoInfo(), changeset: store?.get() ?? null },
        coverage,
      ),
      ...(leg
        ? {
            public: {
              ...describeLeg(leg),
              undecidedSuggestions: before.filter((t) => liveSuggestion(t) !== null).length,
              canApprove: pr ? !pr.viewer.isAuthor : true,
              pendingReview:
                (review.get().pr?.pendingReviewId ?? pr?.viewer.pendingReviewId ?? null) !== null,
            },
          }
        : {}),
    })
  })

  app.post('/api/review/finish', async (c) => {
    if (!review) return c.json({ error: 'review unavailable' }, 503)
    const body = await c.req.json().catch(() => null)
    const coverage = await gateShare(parseCoverage(body?.coverage))
    const deliver = body?.deliver !== false
    // The GitHub leg runs first and alone decides whether anything public
    // happens: an event names the submit, and the closing note is its body.
    let publicOutcome: PublicLegOutcome | null = null
    const event: ReviewEvent | null = REVIEW_EVENTS.includes(body?.event) ? body.event : null
    if (ctx.pr && event !== null) {
      const pr = store?.get().pr
      if (!pr) return c.json({ error: 'the pull request has not loaded yet, try again' }, 503)
      const leg = planPublicLeg(review.get().threads, store?.get().files ?? [])
      publicOutcome = await runPublicLeg(
        { forge: ctx.pr.forge, ref: ctx.pr.ref, review },
        leg,
        event,
        coverage.note ?? '',
      )
      if (publicOutcome.submitted) {
        queue?.enqueueSubmitted({
          event,
          comments: publicOutcome.posted,
          body: coverage.note ?? '',
          ...(publicOutcome.url ? { url: publicOutcome.url } : {}),
          suggestions: suggestionsSummary(review.get().threads),
        })
        // Pull the conversation back so the submitted review shows in place.
        void ctx.pr.refresh?.()
      }
      if (publicOutcome.failed) {
        // Nothing of the agent's leg runs on a failed GitHub leg, half-posted
        // or refused outright: the reviewer sees what did and did not post,
        // fixes, and finishes again — and that retry is the one finish the
        // agent hears about.
        return c.json({
          threads: review.get().threads,
          prompt: '',
          delivered: false,
          presence: queue?.presence() ?? 'waiting',
          public: publicOutcome,
        })
      }
    }
    // Before the flush, so the note rides the batch it closes rather than the next
    // one. On a submitted PR review the note IS the review body: it comes back as
    // an imported review thread, so a local copy would be a duplicate.
    if (notable(coverage) && publicOutcome === null) review.closingNote(coverage.note!)
    const threads = review.finish(flushableIds(review.get().threads))
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
    ctx.telemetry?.reviewFinished({
      kind: reviewKind(),
      threads: batch.length,
      comments: batch.reduce((n, t) => n + t.messages.filter(isHumanMessage).length, 0),
      layers: (review.get().layers?.items.length ?? 0) > 0,
      ...(event !== null ? { event } : {}),
      ...(coverage.shareLayers ? { shareLayers: true } : {}),
      reviewerAgents: review.get().reviewers?.length ?? 0,
      reviewerThreads: review.get().threads.filter((t) => openedByReviewerAgent(t) !== null).length,
    })
    ctx.uiSettings?.set('finishes', String(finishCount() + 1))
    return c.json({
      threads: review.get().threads,
      prompt,
      delivered,
      presence,
      ...(publicOutcome ? { public: publicOutcome } : {}),
    })
  })

  const pollPayload = (snapshot: Snapshot) => {
    const threads = review?.get().threads ?? []
    // A session that already got the full reply protocol gets the compact form:
    // re-shipping the full text with every delivery was the loop's largest
    // recurring token cost.
    const protocol = queue?.needsFullProtocol() === false ? ('compact' as const) : undefined
    if (snapshot.kind === 'layers') {
      return {
        status: 'feedback' as const,
        kind: 'layers' as const,
        threadIds: [] as string[],
        prompt: layersPrompt(snapshot.ask),
      }
    }
    if (snapshot.kind === 'preset') {
      return {
        status: 'feedback' as const,
        kind: 'preset' as const,
        threadIds: [] as string[],
        prompt: buildPresetThreadPrompt(
          { repo: repoInfo(), changeset: store?.get() ?? null },
          snapshot.id,
          presetStore?.find(snapshot.id) ?? null,
          presetStore?.thread(snapshot.id) ?? { presetId: snapshot.id, messages: [] },
        ),
      }
    }
    if (snapshot.kind === 'role') {
      return {
        status: 'feedback' as const,
        kind: 'role' as const,
        threadIds: [] as string[],
        prompt: buildRoleThreadPrompt(
          { repo: repoInfo(), changeset: store?.get() ?? null },
          snapshot.id,
          roleStore?.find(snapshot.id) ?? null,
          roleStore?.thread(snapshot.id) ?? { messages: [] },
        ),
      }
    }
    if (snapshot.kind === 'cleared') {
      return {
        status: 'feedback' as const,
        kind: 'cleared' as const,
        threadIds: [] as string[],
        prompt: buildClearedPrompt(
          { repo: repoInfo(), changeset: store?.get() ?? null },
          // Clearing dropped the round's pick, so the fresh round asks again,
          // as the open does.
          ctx.pr
            ? null
            : reviewerSetNudge(
                review?.get() ?? {},
                allSets(customSets()),
                (roleStore?.setDefault() ?? AGENT_PICKS_SET) === AGENT_PICKS_SET,
              ),
        ),
      }
    }
    if (snapshot.kind === 'artifacts') {
      return {
        status: 'feedback' as const,
        kind: 'artifacts' as const,
        threadIds: [] as string[],
        prompt: buildArtifactsPrompt(
          { repo: repoInfo(), changeset: store?.get() ?? null },
          snapshot.reports,
          threads,
          review?.get().layers,
        ),
      }
    }
    if (snapshot.kind === 'reviewers') {
      const roles = customRoles()
      // A role deleted since the ask has no focus to hand over: the general
      // one stands in, so the ask is never dropped on the floor.
      const asks = snapshot.roles.map((id) => {
        const role = findRole(roles, id) ?? findRole(roles, DEFAULT_ROLE)!
        return { role, ask: buildReviewerAsk(resolve(ctx.root), homedir(), role) }
      })
      return {
        status: 'feedback' as const,
        kind: 'reviewers' as const,
        threadIds: [] as string[],
        prompt: buildReviewerRequestPrompt(
          { repo: repoInfo(), changeset: store?.get() ?? null },
          asks,
        ),
      }
    }
    if (snapshot.kind === 'submitted') {
      return {
        status: 'feedback' as const,
        kind: 'submitted' as const,
        threadIds: [] as string[],
        prompt: buildSubmittedPrompt(
          { repo: repoInfo(), changeset: store?.get() ?? null },
          snapshot.submitted,
        ),
      }
    }
    if (snapshot.kind === 'finish') {
      const batch = activeThreads(threads)
      // Owed a reply = the reviewer spoke last. A thread already ending with the
      // agent's answer rides the prompt as a one-line mention (see
      // buildFinishPrompt) and owes nothing — putting it back on the reply clock
      // would read its (correct) silence as "never answered".
      // A thread stopped for the human (rounds cap or --ask) is theirs: the
      // agent's reply to it would be refused, so it owes none.
      const actionable = batch
        .filter((t) => t.state === 'sent' && !answeredByAgent(t) && !t.needsYou)
        .map((t) => t.id)
      return {
        status: 'feedback' as const,
        kind: 'finish' as const,
        threadIds: actionable,
        prompt: buildFinishPrompt(
          batch,
          { repo: repoInfo(), changeset: store?.get() ?? null, protocol },
          snapshot.coverage,
        ),
      }
    }
    const delivered = threads.filter((t) => snapshot.threadIds.includes(t.id))
    const prompt =
      delivered.length === 1
        ? buildThreadPrompt(delivered[0]!, { ...promptCtx(delivered[0]!.id), protocol })
        : buildCoalescedPrompt(delivered, { ...promptCtx(...snapshot.threadIds), protocol })
    return {
      status: 'feedback' as const,
      kind: 'threads' as const,
      threadIds: delivered.map((t) => t.id),
      prompt,
    }
  }

  /** What the agent was handed and has not answered, for a payload or an ack.
   * `except` leaves out the threads a payload is itself handing over. */
  const owedList = (except: readonly string[] = []): OwedEntry[] => {
    if (!review || !queue) return []
    const threads = review.get().threads
    const now = Date.now()
    const entries = queue.owed().flatMap((o): OwedEntry[] => {
      if (except.includes(o.threadId)) return []
      const thread = threads.find((t) => t.id === o.threadId)
      return thread ? [owedEntry(thread, now - o.deliveredAt, o.reminders)] : []
    })
    return queue.owesLayers()
      ? [...entries, { ...OWED_LAYERS, waiting: 'since the reviewer asked' }]
      : entries
  }

  /** The stall clock ran out on threads still owed: they go out again in
   * full, marked, because the likeliest reason for the silence is a session
   * that no longer has their text (a compacted context). */
  const reminderPayload = () => {
    const owed = queue?.owed() ?? []
    const ids = new Set(owed.map((o) => o.threadId))
    const threads = (review?.get().threads ?? [])
      .filter((t) => ids.has(t.id))
      .map((t) => ({ ...t, unanswered: true }))
    if (threads.length === 0) return null
    const protocol = queue?.needsFullProtocol() === false ? ('compact' as const) : undefined
    const threadIds = threads.map((t) => t.id)
    return {
      status: 'feedback' as const,
      kind: 'reminder' as const,
      threadIds,
      reminder: Math.max(...owed.map((o) => o.reminders)) + 1,
      prompt:
        threads.length === 1
          ? buildThreadPrompt(threads[0]!, { ...promptCtx(threads[0]!.id), protocol })
          : buildCoalescedPrompt(threads, { ...promptCtx(...threadIds), protocol }),
      next_step: reminderStep(REMINDER_MAX),
    }
  }

  // Where the author agent stands, for the line every command's ack ends
  // with: whether a poll is listening, what is still owed, what is queued.
  // Read-only, and it names no thread text.
  app.get('/api/agent/state', (c) => {
    if (!review || !queue) return c.json({ error: 'review unavailable' }, 503)
    const state: AgentState = {
      listening: queue.hasListener(),
      owed: owedList(),
      waiting: queue.pendingCount(),
    }
    return c.json(state)
  })

  app.get('/api/agent/poll', (c) => {
    if (!review || !queue) return c.json({ error: 'review unavailable' }, 503)
    // This GET has side effects (claims the session, confirms delivery), and
    // browsers omit `Origin` on no-cors GETs — so the rebinding guard alone
    // can't protect it. A custom x-diffo-* header can only reach us via a CORS
    // preflight, which that guard rejects: requiring one shuts out hostile web
    // pages while `diffo poll` (which always sends it) is unaffected.
    if (!c.req.header('x-diffo-agent') && !c.req.header('x-diffo-session-pid')) {
      return c.json(
        { error: 'agent polls must send the x-diffo-agent header; use `diffo poll`' },
        403,
      )
    }
    const tookOverFrom = queue.claimSession(parseSessionPid(c.req.header('x-diffo-session-pid')))
    if (tookOverFrom !== null) c.header('x-diffo-took-over-from', String(tookOverFrom))
    // The agent names the change as it starts listening, and that name becomes
    // the browser tab's (see `ReviewState.title`). Every poll may carry one and
    // the newest wins; a poll without one leaves the name it found alone, so
    // re-polling through a long review never has to repeat itself.
    const title = normalizeTitle(c.req.query('title'))
    if (title) review.setTitle(title)
    // Counted at the start, not at the timeout: a harness that cuts polls off
    // early never sees a timeout, and those are the polls that run all night.
    const quietLimit = ctx.pollQuietLimit ?? QUIET_POLL_LIMIT
    if (queue.beginPoll(quietLimit) === 'quiet') return c.body(quietPayload(quietLimit))
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
            if (queue.pollTimedOutQuiet(quietLimit)) {
              await s.write(quietPayload(quietLimit))
              return
            }
            const owed = owedList()
            await s.write(
              JSON.stringify({
                status: 'timeout',
                message: timeoutMessage(owed.length),
                ...(owed.length > 0 ? { owed } : {}),
              }),
            )
            return
          }
          const outcome = await attach
          if (outcome === 'gone') {
            return
          }
          if (outcome === 'replaced') {
            await s.write(
              JSON.stringify({
                status: 'superseded',
                message:
                  'you started a newer poll from this same session, and that one is listening ' +
                  'now. This one is released: do nothing here, and do not start another.',
              }),
            )
            return
          }
          if (outcome === 'reminder') {
            const reminder = reminderPayload()
            // Everything owed was settled between the clock and this write.
            if (!reminder) continue
            await s.write(JSON.stringify(reminder))
            if (aborted) return
            queue.confirmReminder(reminder.threadIds)
            queue.markProtocolSent()
            return
          }
          if (outcome === 'superseded') {
            await s.write(
              JSON.stringify({
                status: 'superseded',
                message:
                  'another poll attached for this repo, so this one is released. The newer poll ' +
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
                  'the agent detached (`diffo end`). Do not re-poll unless asked; deliver anything remaining directly in the conversation',
              }),
            )
            return
          }
          const snapshot = queue.take()
          if (!snapshot) continue
          const inner = pollPayload(snapshot)
          // What was handed over before this and is still unanswered rides
          // every payload, so the agent is never more than one poll away from
          // seeing what it owes.
          const owed = owedList(inner.threadIds)
          const payload = {
            ...inner,
            ...(owed.length > 0 ? { owed } : {}),
            next_step: nextStepFor(inner.kind, inner.threadIds.length, {
              owed: owed.length,
              midWork: queue.owed().length > 0,
            }),
          }
          await s.write(JSON.stringify(payload))
          // If the client vanished during the write, don't mark it delivered: Hono's
          // stream swallows write errors, so a "successful" write isn't proof of
          // receipt. Leaving it pending re-delivers next poll (at-least-once).
          if (aborted) return
          queue.confirm(snapshot, payload.threadIds)
          // The payload carried a reply protocol only when threads rode with it.
          if (payload.threadIds.length > 0) queue.markProtocolSent()
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

  /** The role a request names, or the refusal: reviewer agents are not
   * for pull-request reviews, and a role has to be one the reviewer has. */
  const roleAsked = (c: Context, raw: unknown): ReviewerRole | Response => {
    if (ctx.pr) return c.json({ error: NO_REVIEWERS_ON_PR }, 400)
    const id = typeof raw === 'string' && raw !== '' ? raw : DEFAULT_ROLE
    const roles = customRoles()
    return (
      findRole(roles, id) ??
      c.json(
        {
          error: `no reviewer role "${id}"; the roles are ${allRoles(roles)
            .map((r) => r.id)
            .join(', ')}`,
        },
        400,
      )
    )
  }

  // A reviewer agent takes its seat and is told what it needs to start: what is
  // under review and how to read it, the threads already there so it does not
  // open them again, and its limits. The CLI adds the next step.
  const JOIN_THREAD_CAP = 60
  const JOIN_FILE_CAP = 300
  app.post('/api/reviewer/join', async (c) => {
    const body = await c.req.json().catch(() => null)
    const seats = new Set((review?.get().reviewers ?? []).map((r) => r.name))
    // The role decides what the reviewer looks for. A seat taken again keeps
    // its role unless it names one.
    const roles = customRoles()
    const asked = typeof body?.role === 'string' ? body.role.trim().toLowerCase() : undefined
    if (asked === undefined && body?.as === undefined) {
      return c.json(
        { error: 'join needs a role (--role <id>), or the name you had (--as <name>)' },
        400,
      )
    }
    if (asked !== undefined) {
      const known = roleAsked(c, asked)
      if (known instanceof Response) return known
    }
    // A reviewer that brings no name is given one, never one this review
    // has known: a new reviewer in a role is a new reviewer, not the last
    // one's seat. `--as` is for coming back under one's own name.
    const fresh = () => {
      const taken = new Set([
        ...seats,
        ...hub.knownNames(),
        ...(review?.get().threads ?? []).flatMap((t) =>
          t.messages.flatMap((m) => (m.by ? [m.by] : [])),
        ),
      ])
      return ctx.reviewerNames
        ? pickReviewerName(taken, ctx.reviewerNames, (free) => free[0]!)
        : pickReviewerName(taken)
    }
    const who = reviewerAt(c, body?.as ?? fresh(), asked, true)
    if (who instanceof Response) return who
    const seat = review!.get().reviewers?.find((r) => r.name === who.name)
    const role = findRole(roles, seat?.role ?? DEFAULT_ROLE) ?? findRole(roles, DEFAULT_ROLE)!
    // The reviewer the author agent was asked to start, if one was awaited,
    // and the one it suggested, if it suggested this role.
    hub.arrived(role.id)
    hub.log(
      who.name,
      'joined',
      `${seats.has(who.name) ? 'rejoined' : 'joined'} as ${role.name} reviewer`,
    )
    review!.clearReviewerSuggestion(role.id)
    const changeset = store?.get() ?? null
    const state = review!.get()
    const files = changeset?.files ?? []
    const threads = threadsInChangeset(files, state.threads, state.layers).active.filter(
      (t) => !isPublic(t),
    )
    return c.json({
      ok: true,
      as: who.name,
      rejoined: seats.has(who.name),
      role: { id: role.id, name: role.name, focus: role.focus },
      how_to_review: REVIEWER_BRIEF,
      review: {
        repo: repoInfo().name,
        branch: repoInfo().branch,
        under_review: changeset ? specLine(changeset) : null,
        // The same diff the human reads in the browser, through Diffo, so the
        // page can say which files each reviewer read (`diffo diff`).
        read_with: `\`${reviewerCommands(who.name).diff}\`: the diff the user reads, every file or the files you name; the user sees which files you read this way`,
        // Each file with its hunks as head-side line ranges: a `--line` inside
        // one anchors the comment to that line, any other lands on the file.
        files: files.slice(0, JOIN_FILE_CAP).map((f) => ({
          path: f.path,
          status: f.status,
          lines: f.hunks.map((h) => formatSpan(hunkHeadSpan(h))),
        })),
        ...(files.length > JOIN_FILE_CAP ? { more_files: files.length - JOIN_FILE_CAP } : {}),
      },
      threads: threads.slice(0, JOIN_THREAD_CAP).map((t) => {
        const first = t.messages[0]
        return {
          threadId: t.id,
          where: describeAnchor(t.anchor),
          by: first?.by === who.name ? 'you' : first ? voiceOf(first) : 'human reviewer',
          state: t.needsYou ? 'needs the human' : t.state,
          text: (first?.text ?? '').split('\n')[0]!.slice(0, 160),
        }
      }),
      ...(threads.length > JOIN_THREAD_CAP
        ? { more_threads: threads.length - JOIN_THREAD_CAP }
        : {}),
      limits: { rounds_per_thread: REVIEWER_LIMITS.rounds },
    })
  })

  // The roles a reviewer agent can be invited in: the built-ins, then the
  // reviewer's own, and which of them are active (in the Add reviewer
  // picker; the rest wait in the library). The page reads and saves them.
  const rolesPayload = (custom: readonly ReviewerRole[]) => {
    const roles = allRoles(custom)
    const activity = roleStore?.activity() ?? { on: [], off: [] }
    return {
      roles,
      default: DEFAULT_ROLE,
      active: roles.filter((r) => isActiveRole(r, activity)).map((r) => r.id),
      // The sets ride with the roles they name: one read, one refresh.
      sets: allSets(customSets()),
      defaultSet: roleStore?.setDefault() ?? AGENT_PICKS_SET,
    }
  }
  app.get('/api/reviewer/roles', (c) => c.json(rolesPayload(customRoles())))

  // The human's own sets, replaced whole (the Sets tab of the Reviewer agents
  // page). A set they just made has no id: the server gives it one.
  app.put('/api/reviewer/sets', async (c) => {
    if (!roleStore) return c.json({ error: 'settings unavailable' }, 503)
    if (fromCli(c)) return c.json({ error: 'only the human edits their sets' }, 403)
    const body = await c.req.json().catch(() => null)
    const known = new Set(allRoles(customRoles()).map((r) => r.id))
    const parsed = parseCustomSets(body?.sets, known)
    if (!parsed.ok) return c.json({ error: parsed.error }, 400)
    roleStore.saveSets(parsed.sets)
    return c.json(rolesPayload(customRoles()))
  })

  // Which set the picker opens on: one of the sets, or the author agent's
  // pick for the change (`AGENT_PICKS_SET`).
  app.put('/api/reviewer/sets/default', async (c) => {
    if (!roleStore) return c.json({ error: 'settings unavailable' }, 503)
    if (fromCli(c)) return c.json({ error: 'only the human picks their default set' }, 403)
    const body = await c.req.json().catch(() => null)
    const id: unknown = body?.id
    if (typeof id !== 'string' || (id !== AGENT_PICKS_SET && !findSet(customSets(), id))) {
      return c.json({ error: `no set "${String(id)}"` }, 400)
    }
    roleStore.saveSetDefault(id)
    return c.json(rolesPayload(customRoles()))
  })

  // The author agent says which set fits the change it wrote (`diffo reviewer
  // --set`). It starts nobody: the human's picker opens with that set's agents
  // ticked, and the reason beside them.
  app.post('/api/reviewer/pick', async (c) => {
    if (!review) return c.json({ error: 'review unavailable' }, 503)
    if (!fromCli(c)) return c.json({ error: 'a set is picked through the diffo CLI' }, 403)
    if (ctx.pr) return c.json({ error: NO_REVIEWERS_ON_PR }, 400)
    const body = await c.req.json().catch(() => null)
    const sets = allSets(customSets())
    const set = typeof body?.set === 'string' ? sets.find((s) => s.id === body.set) : undefined
    if (!set) {
      return c.json(
        {
          error: `no set "${String(body?.set ?? '')}"; the sets are ${sets.map((s) => s.id).join(', ')}`,
        },
        400,
      )
    }
    review.pickReviewerSet(set.id, parseSuggestReason(body?.reason))
    return c.json({ picked: true, set: set.id, roles: set.roles })
  })

  // The human moves a role into the picker, or back to the library.
  app.put('/api/reviewer/roles/:id/active', async (c) => {
    if (!roleStore) return c.json({ error: 'settings unavailable' }, 503)
    if (fromCli(c)) return c.json({ error: 'only the human picks the active reviewers' }, 403)
    const body = await c.req.json().catch(() => null)
    if (typeof body?.active !== 'boolean') return c.json({ error: 'need {active: boolean}' }, 400)
    const id = roleKey(c.req.param('id'))
    if (!findRole(customRoles(), id)) return c.json({ error: `no reviewer role "${id}"` }, 404)
    roleStore.setActive(id, body.active)
    return c.json(rolesPayload(customRoles()))
  })

  app.put('/api/reviewer/roles', async (c) => {
    if (!roleStore) return c.json({ error: 'settings unavailable' }, 503)
    const body = await c.req.json().catch(() => null)
    const parsed = parseCustomRoles(body?.roles)
    if (!parsed.ok) return c.json({ error: parsed.error }, 400)
    const kept = new Set(parsed.roles.map((r) => r.id))
    const gone = roleStore.roles().filter((r) => !kept.has(r.id))
    roleStore.saveRoles(parsed.roles)
    // A deleted role's parked message has nothing left to be about.
    for (const role of gone) queue?.dropRole(role.id)
    return c.json(rolesPayload(parsed.roles))
  })

  // The conversation about a reviewer role (see server/roles.ts), the way a
  // layers preset has one: the reviewer writes to the agent from the Reviewer
  // agents page, the message rides the delivery queue, and the agent answers
  // with `diffo role update` (a role made or edited, with a line on it) or
  // `diffo role reply`. A new role talks under a draft key until the agent
  // names it.
  app.get('/api/reviewer/roles/:id/thread', (c) => {
    if (!roleStore) return c.json({ error: 'settings unavailable' }, 503)
    return c.json({ thread: roleStore.thread(roleKey(c.req.param('id'))) })
  })

  // A new conversation: the messages go, the role stays. A message still
  // parked for the agent goes too.
  app.delete('/api/reviewer/roles/:id/thread', (c) => {
    if (!roleStore) return c.json({ error: 'settings unavailable' }, 503)
    const id = roleKey(c.req.param('id'))
    const cleared = roleStore.clearThread(id)
    queue?.dropRole(id)
    return c.json({ cleared, thread: roleStore.thread(id) })
  })

  app.post('/api/reviewer/roles/:id/messages', async (c) => {
    if (!roleStore) return c.json({ error: 'settings unavailable' }, 503)
    const id = roleKey(c.req.param('id'))
    const body = (await c.req.json().catch(() => null)) as {
      author?: unknown
      text?: unknown
    } | null
    const text = typeof body?.text === 'string' ? body.text.trim() : ''
    if (text === '') return c.json({ error: 'need { text }' }, 400)
    if (text.length > ROLE_MESSAGE_MAX) {
      return c.json({ error: `keep a message under ${ROLE_MESSAGE_MAX} characters` }, 400)
    }
    const author = body?.author === 'agent' ? 'agent' : 'reviewer'
    // An agent answering late about a role the reviewer deleted: its words
    // have nowhere to go, and must not bring the conversation back.
    if (author === 'agent' && roleStore.wasDeleted(id)) {
      return c.json({ error: ROLE_DELETED }, 400)
    }
    // Unlike a preset, a new role is not made on the first word: it waits
    // under its draft key for the agent to name it.
    if (!roleStore.find(id) && !isDraftRoleKey(id)) {
      return c.json({ error: `no reviewer role "${id}"` }, 400)
    }
    const message = roleStore.addMessage(id, author, text)
    // The reviewer's words are for the agent: parked for its next poll.
    if (author === 'reviewer') queue?.enqueueRole(id)
    return c.json({
      message,
      thread: roleStore.thread(id),
      ...(queue ? { presence: queue.presence() } : {}),
    })
  })

  // The agent's edit: the fields it sends replace the role's (a role nobody
  // has yet is made from them), and the change lands in the conversation
  // with the agent's line on it and the values before, for undo.
  app.post('/api/reviewer/roles/:id', async (c) => {
    if (!roleStore) return c.json({ error: 'settings unavailable' }, 503)
    const id = roleKey(c.req.param('id'))
    const body = (await c.req.json().catch(() => null)) as {
      fields?: unknown
      message?: unknown
    } | null
    const patch = parseRolePatch(body?.fields)
    if (!patch.ok) return c.json({ error: patch.error }, 400)
    // Read before the role exists: the conversation waiting on a new one.
    const asked = roleStore.find(id) === undefined ? roleStore.waitingAsk() : undefined
    const result = roleStore.upsert(id, patch.patch)
    if (!result.ok) return c.json({ error: result.error }, 400)
    const text = typeof body?.message === 'string' ? body.message.trim() : ''
    // A role under an id of the agent's own, while a built-in's or a draft's
    // conversation waits on it, is what the reviewer asked for there. The
    // answer goes to that conversation too, naming the role: otherwise the
    // reviewer waits on a thread the agent answered somewhere else. A draft's
    // conversation carries on under the role it became.
    if (asked !== undefined && isDraftRoleKey(asked)) roleStore.carryOver(asked, id)
    const message = roleStore.addMessage(id, 'agent', text, result.change)
    if (asked !== undefined) {
      const where = isDraftRoleKey(asked)
        ? ''
        : `The copy is “${result.role.name}”, under your reviewer agents.`
      roleStore.addMessage(asked, 'agent', [text, where].filter(Boolean).join('\n\n'), {
        ...result.change,
        roleId: id,
      })
    }
    return c.json({ role: result.role, message, thread: roleStore.thread(id) })
  })

  // The line that brings a reviewer agent in, for the reviewer to paste into
  // another agent session.
  app.get('/api/reviewer/invite', (c) => {
    const role = roleAsked(c, c.req.query('role'))
    if (role instanceof Response) return role
    return c.json({ role: role.id, ask: buildReviewerAsk(resolve(ctx.root), homedir(), role) })
  })

  /** Whether the roles asked for are exactly a set, for the one usage event:
   * a built-in set by its id, one of the human's own as `custom`. */
  const setAsked = (ids: readonly string[]): { set?: string; agentPick?: true } => {
    const same = (set: ReviewerSet) =>
      set.roles.length === ids.length && set.roles.every((id) => ids.includes(id))
    const set = allSets(customSets()).find(same)
    if (!set) return {}
    return {
      set: set.builtIn ? set.id : 'custom',
      ...(review?.get().reviewerSet?.set === set.id ? { agentPick: true as const } : {}),
    }
  }

  // The reviewer's other way in: ask the agent that wrote the change to start
  // the reviewer itself, as a sub-agent. The ask rides the author agent's poll
  // like a layers request, and the page shows the reviewer as on its way until
  // one joins in that role.
  app.post('/api/reviewer/request', async (c) => {
    if (!review || !queue) return c.json({ error: 'review unavailable' }, 503)
    const body = await c.req.json().catch(() => null)
    // One role or several, each a reviewer of its own. All of them are checked
    // before any is asked for, so a bad id starts none; an empty list or a
    // non-string id is refused, never read as the default role.
    const ids: unknown[] = Array.isArray(body?.roles) ? [...new Set(body.roles)] : []
    if (ids.length === 0 || ids.some((id) => typeof id !== 'string' || id === '')) {
      return c.json({ error: 'need {roles}: one or more role ids' }, 400)
    }
    const roles: ReviewerRole[] = []
    for (const id of ids) {
      const role = roleAsked(c, id)
      if (role instanceof Response) return role
      roles.push(role)
    }
    const suggested = review.get().reviewerSuggested?.role
    ctx.telemetry?.reviewersRequested({
      kind: reviewKind(),
      count: roles.length,
      roles: [...new Set(roles.map((r) => (r.builtIn ? r.id : 'custom')))].sort(),
      suggested: suggested !== undefined && roles.some((r) => r.id === suggested),
      ...setAsked(roles.map((r) => r.id)),
    })
    for (const role of roles) {
      queue.enqueueReviewer(role.id)
      hub.expect(role.id)
      // Acting on the author agent's suggestion answers it.
      review.clearReviewerSuggestion(role.id)
    }
    return c.json({ ok: true, roles: roles.map((r) => r.id), presence: queue.presence() })
  })

  // A reviewer agent says what it is doing, in a line (`diffo progress`): the
  // human sees it on the page while the reviewer reads, long before it has
  // anything to say in a thread. Never a comment, and never the author agent's
  // to read.
  app.post('/api/reviewer/progress', async (c) => {
    const body = await c.req.json().catch(() => null)
    const text = parseProgress(body?.text)
    if (text === null)
      return c.json({ error: 'need {as, text}: one line on what you are doing' }, 400)
    const who = reviewerAt(c, body?.as)
    if (who instanceof Response) return who
    hub.log(who.name, 'doing', text)
    // A message from the human rides back on the reviewer's next word, so one
    // reading the diff hears it before it ever polls.
    const notes = hub.unread(who.name)
    if (notes.length === 0) return c.json({ ok: true })
    const handed = [...notes]
    hub.markRead(who.name, handed)
    return c.json({
      ok: true,
      messages: handed,
      next_step: REVIEWER_NEXT_STEP.message(who.name),
    })
  })

  // A reviewer agent reads the change through Diffo (`diffo diff`): the
  // same hunks the human reads, and the page counts the files it fetched.
  // No files is every file.
  app.post('/api/reviewer/diff', async (c) => {
    const body = await c.req.json().catch(() => null)
    const who = reviewerAt(c, body?.as)
    if (who instanceof Response) return who
    const files = store?.get().files ?? []
    const asked: unknown[] = Array.isArray(body?.files) ? body.files : []
    const wanted = asked.filter((p): p is string => typeof p === 'string')
    const picked = wanted.length === 0 ? files : files.filter((f) => wanted.includes(f.path))
    const missing = wanted.filter((p) => !files.some((f) => f.path === p))
    hub.fetched(
      who.name,
      picked.map((f) => f.path),
    )
    return c.json({
      patch: picked.map(renderFilePatch).join('\n\n'),
      files: picked.length,
      ...(missing.length > 0 ? { missing } : {}),
    })
  })

  // A reviewer agent's own account when it finishes (`diffo covered`): the
  // changed files it did not read. The page shows it beside what it fetched.
  app.post('/api/reviewer/coverage', async (c) => {
    const body = await c.req.json().catch(() => null)
    const who = reviewerAt(c, body?.as)
    if (who instanceof Response) return who
    const files = store?.get().files ?? []
    const raw: unknown[] = Array.isArray(body?.skipped) ? body.skipped : []
    const skipped = raw.filter((p): p is string => typeof p === 'string')
    const unknown = skipped.filter((p) => !files.some((f) => f.path === p))
    if (unknown.length > 0) {
      return c.json(
        { error: `not in this change: ${unknown.join(', ')}; --skipped takes changed files` },
        400,
      )
    }
    hub.reported(who.name, skipped)
    // Its account is the last thing it does: with nothing of its own left
    // open, that is the end of its review, raised anything or not.
    const inbox = reviewerInbox(review!.get().threads, who.name)
    const settled =
      inbox.counts.waiting === 0 && inbox.counts.human === 0 && inbox.yourMove.length === 0
    if (settled && hub.activity(who.name).at(-1)?.kind !== 'done') {
      hub.log(who.name, 'done', 'finished its review')
    }
    const read = files.length - new Set(skipped).size
    return c.json({ ok: true, read, of: files.length })
  })

  // The reviewer agent answers the human in their private conversation
  // (`diffo chat`): on the page beside it, never in a thread, never to the
  // author agent.
  app.post('/api/reviewer/chat', async (c) => {
    const body = await c.req.json().catch(() => null)
    const text = parseReviewerMessage(body?.text)
    if (text === null) {
      return c.json({ error: `need {as, text}: up to ${REVIEWER_MESSAGE_MAX} characters` }, 400)
    }
    const who = reviewerAt(c, body?.as)
    if (who instanceof Response) return who
    hub.say(who.name, text)
    return c.json({ ok: true, next_step: REVIEWER_NEXT_STEP.chat(who.name) })
  })

  // The human writes to one reviewer agent: to steer it, ask it something, or
  // tell it to stop. It waits for the reviewer's next poll or progress line.
  // The page's to do, never an agent's: no agent writes to another this way.
  app.post('/api/reviewer/message', async (c) => {
    if (!review) return c.json({ error: 'review unavailable' }, 503)
    if (fromCli(c)) {
      return c.json({ error: 'only the human writes to a reviewer agent, on the review page' }, 403)
    }
    const body = await c.req.json().catch(() => null)
    const parsed = parseReviewerName(body?.name)
    if (!parsed.ok) return c.json({ error: parsed.error }, 400)
    const text = parseReviewerMessage(body?.text)
    if (text === null) {
      return c.json({ error: `need {name, text}: up to ${REVIEWER_MESSAGE_MAX} characters` }, 400)
    }
    if (!review.get().reviewers?.some((r) => r.name === parsed.name)) {
      return c.json({ error: `no reviewer agent "${parsed.name}" in this review` }, 404)
    }
    hub.tell(parsed.name, text)
    // Whether it hears it now: a held poll wakes for it; otherwise it waits.
    return c.json({ ok: true, listening: hub.state(parsed.name) === 'listening' })
  })

  // The author agent's flag that this change deserves a second reader, in a
  // role and with a reason (`diffo reviewer --suggest`). An offer on the page,
  // nothing more: only the human starts a reviewer.
  app.post('/api/reviewer/suggest', async (c) => {
    if (!review) return c.json({ error: 'review unavailable' }, 503)
    if (!fromCli(c)) {
      return c.json({ error: 'a reviewer is suggested through the diffo CLI' }, 403)
    }
    const body = await c.req.json().catch(() => null)
    const role = roleAsked(c, body?.role)
    if (role instanceof Response) return role
    if (review.get().reviewers?.some((r) => (r.role ?? DEFAULT_ROLE) === role.id)) {
      return c.json({ suggested: false, role: role.id })
    }
    review.suggestReviewer(role.id, parseSuggestReason(body?.reason))
    return c.json({ suggested: true, role: role.id })
  })

  // The human passes on the suggestion: it goes, and nothing is started.
  app.delete('/api/reviewer/suggestion', (c) => {
    if (!review) return c.json({ error: 'review unavailable' }, 503)
    return c.json({ cleared: review.clearReviewerSuggestion() })
  })

  // The human stops a reviewer agent: its session is told to end, and it
  // stays in the review with what it did and said (see `hub.stop`).
  app.post('/api/reviewer/stop', (c) => {
    if (!review) return c.json({ error: 'review unavailable' }, 503)
    if (fromCli(c)) {
      return c.json({ error: 'only the human stops a reviewer agent, on the review page' }, 403)
    }
    const parsed = parseReviewerName(c.req.query('name'))
    if (!parsed.ok) return c.json({ error: parsed.error }, 400)
    if (!review.get().reviewers?.some((r) => r.name === parsed.name)) {
      return c.json({ error: `no reviewer agent "${parsed.name}" in this review` }, 404)
    }
    hub.stop(parsed.name)
    return c.json({ stopped: true })
  })

  // The human clears the list: every reviewer agent goes as one would with
  // Delete (a running one's session is ended), and every thread stays.
  app.delete('/api/reviewer/seats', (c) => {
    if (!review) return c.json({ error: 'review unavailable' }, 503)
    if (fromCli(c)) {
      return c.json({ error: 'only the human removes reviewer agents, on the review page' }, 403)
    }
    const names = (review.get().reviewers ?? []).map((r) => r.name)
    for (const name of names) {
      if (review.removeReviewer(name)) hub.remove(name)
    }
    return c.json({ removed: names.length })
  })

  // The human takes a reviewer agent out of the review. Its threads stay; its
  // poll is released with the word that it was removed, and its commands are
  // refused until someone brings it back in. The page's to do, never an
  // agent's: no reviewer removes another, and the author agent removes none.
  app.delete('/api/reviewer/seat', (c) => {
    if (!review) return c.json({ error: 'review unavailable' }, 503)
    if (fromCli(c)) {
      return c.json({ error: 'only the human removes a reviewer agent, on the review page' }, 403)
    }
    const parsed = parseReviewerName(c.req.query('name'))
    if (!parsed.ok) return c.json({ error: parsed.error }, 400)
    const removed = review.removeReviewer(parsed.name)
    if (removed) hub.remove(parsed.name)
    return c.json({ removed })
  })

  // The reviewer agent's inbox: one payload when something new lands on a
  // thread it opened (the author agent's answer, or the human's), or the word
  // that nothing of its own is left to wait for. Derived from the review on
  // every wake, so it holds no queue of its own, and it never goes near the
  // author agent's: no session claimed, no batch, no presence there.
  app.get('/api/reviewer/poll', (c) => {
    const who = reviewerAt(c, c.req.query('as'))
    if (who instanceof Response) return who
    const name = who.name
    const inboxOf = review!
    // The review this poll waits in. A checkout swaps the store to another
    // branch's review in place (ReviewStore.rescope): answering from that one
    // would read as "you raised nothing", and its threads here would go
    // unwatched.
    const branch = inboxOf.scope.branch
    const scope = JSON.stringify(inboxOf.scope)
    const heartbeatMs = ctx.pollHeartbeatMs ?? POLL_HEARTBEAT_MS
    const graceMs = ctx.reviewerGraceMs ?? REVIEWER_GRACE_MS
    return stream(c, async (s) => {
      let aborted = false
      let superseded = false
      let wake: (() => void) | null = null
      const nudge = () => wake?.()
      // A listening poll holds the daemon up, as the author agent's does.
      ctx.idle?.connect()
      const detach = hub.attach(name, () => {
        superseded = true
        nudge()
      })
      const unsubscribe = inboxOf.subscribe(nudge)
      const unhear = hub.onNote(name, nudge)
      let held = true
      const drop = () => {
        if (!held) return
        held = false
        ctx.idle?.disconnect()
        unsubscribe()
        unhear()
        detach()
      }
      s.onAbort(() => {
        aborted = true
        nudge()
        drop()
      })
      try {
        const deadline = Date.now() + (ctx.pollMaxMs ?? POLL_MAX_MS)
        while (!aborted) {
          if (hub.isRemoved(name)) {
            await s.write(
              JSON.stringify({ status: 'removed', as: name, message: `${removedNotice(name)}.` }),
            )
            return
          }
          if (hub.isStopped(name)) {
            await s.write(
              JSON.stringify({ status: 'stopped', as: name, message: `${stoppedNotice(name)}.` }),
            )
            return
          }
          if (superseded) {
            await s.write(
              JSON.stringify({
                status: 'superseded',
                as: name,
                message: `another poll attached as reviewer agent "${name}", so this one is released. Do nothing here and do not poll again unless the user asks; if that was not you, another session is using your name: say so to the user.`,
              }),
            )
            return
          }
          if (JSON.stringify(inboxOf.scope) !== scope) {
            await s.write(
              JSON.stringify({
                status: 'moved',
                as: name,
                message: `the review moved to branch "${inboxOf.scope.branch}" (a checkout), so your threads on "${branch}" are not in view. Stop polling here and tell the user; run poll again once they are back on "${branch}".`,
              }),
            )
            return
          }
          const inbox = reviewerInbox(inboxOf.get().threads, name)
          // The human's own words come first: they may change what it does next.
          const notes = [...hub.unread(name)]
          if (notes.length > 0) {
            await s.write(
              JSON.stringify({
                status: 'message',
                as: name,
                from: 'human reviewer',
                messages: notes,
                still_waiting: inbox.counts.waiting,
                next_step: REVIEWER_NEXT_STEP.message(name),
              }),
            )
            if (aborted) return
            hub.markRead(name, notes)
            return
          }
          if (inbox.handed.length > 0) {
            const n = inbox.threads.length
            hub.log(
              name,
              'answered',
              n > 0
                ? `got ${n === 1 ? 'an answer' : `${n} answers`} to read`
                : 'a thread stopped for the human',
            )
            await s.write(
              JSON.stringify({
                status: 'feedback',
                as: name,
                threads: inbox.threads,
                ...(inbox.needsHuman.length > 0 ? { needs_human: inbox.needsHuman } : {}),
                still_waiting: inbox.counts.waiting,
                next_step: REVIEWER_NEXT_STEP.poll(name),
              }),
            )
            // Hono's stream swallows write errors: a client that vanished
            // mid-write got nothing, and the next poll hands it over again.
            if (aborted) return
            inboxOf.markReviewerSeen(inbox.handed)
            return
          }
          const { counts, opened } = inbox
          // Finished: every thread of its own closed. It stays a short while
          // after the last word in them or to it, so the human can still
          // reach it; then it stops.
          const finished =
            opened > 0 &&
            counts.waiting === 0 &&
            counts.human === 0 &&
            counts.unanswered === 0 &&
            inbox.yourMove.length === 0
          let napUntil = deadline
          if (finished) {
            const last = Math.max(inbox.lastChange, ...hub.chat(name).map((m) => Date.parse(m.at)))
            napUntil = Math.min(deadline, last + graceMs)
            hub.log(name, 'done', 'finished its review')
          }
          // Nothing left to listen for: a reviewer that raised nothing, has
          // answers to act on, or finished and waited out its grace.
          if (
            (finished && Date.now() >= napUntil) ||
            (!finished && counts.waiting === 0 && counts.human === 0)
          ) {
            if (!finished) {
              hub.log(
                name,
                'waiting',
                opened === 0
                  ? 'has raised nothing yet'
                  : inbox.yourMove.length === 0 && counts.unanswered > 0
                    ? 'got no answer from the author agent'
                    : 'has answers to reply to or close',
              )
            }
            await s.write(
              JSON.stringify({
                status: 'idle',
                as: name,
                // `threads` is always the list of threads with news; the tally
                // is its own key.
                counts: { opened, ...counts },
                ...(inbox.yourMove.length > 0 ? { your_move: inbox.yourMove } : {}),
                next_step:
                  opened === 0
                    ? REVIEWER_NEXT_STEP.idleNone(name)
                    : inbox.yourMove.length > 0
                      ? REVIEWER_NEXT_STEP.idleYourMove(name)
                      : counts.unanswered > 0
                        ? REVIEWER_NEXT_STEP.idleUnanswered(name, counts.unanswered)
                        : REVIEWER_NEXT_STEP.idle(name),
              }),
            )
            return
          }
          if (!finished) {
            hub.log(
              name,
              'waiting',
              counts.waiting > 0
                ? `waiting for ${counts.waiting === 1 ? 'an answer' : `${counts.waiting} answers`}`
                : `waiting for your decision on ${counts.human === 1 ? 'a thread' : `${counts.human} threads`}`,
            )
          }
          const left = napUntil - Date.now()
          if (left <= 0) {
            await s.write(
              JSON.stringify({
                status: 'timeout',
                as: name,
                still_waiting: inbox.counts.waiting,
                ...(counts.human > 0 ? { with_the_human: counts.human } : {}),
                next_step:
                  counts.waiting === 0 && counts.human > 0
                    ? REVIEWER_NEXT_STEP.timeoutHuman(name)
                    : REVIEWER_NEXT_STEP.timeout(name),
              }),
            )
            return
          }
          await new Promise<void>((resolveNap) => {
            const timer = setTimeout(resolveNap, Math.min(heartbeatMs, left))
            wake = () => {
              clearTimeout(timer)
              resolveNap()
            }
          })
          wake = null
          if (!aborted && !superseded) await s.write(' ')
        }
      } finally {
        drop()
      }
    })
  })

  // The agent's CLI opened the review: it is here, reading the change for its
  // guide, and has not polled yet. Presence says so until the first poll — the
  // reviewer who opens the URL meanwhile is not told there is no agent. Same
  // guard as the poll: a side effect a web page must never reach.
  app.post('/api/agent/arrive', (c) => {
    if (!queue) return c.json({ error: 'agent queue unavailable' }, 503)
    if (!c.req.header('x-diffo-agent') && !c.req.header('x-diffo-session-pid')) {
      return c.json({ error: 'agent arrivals must send the x-diffo-agent header' }, 403)
    }
    const arrived = queue.agentArrived(parseSessionPid(c.req.header('x-diffo-session-pid')))
    return c.json({ ok: true, arrived, presence: queue.presence() })
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
        'this review belongs to another agent session; nothing was detached, and that ' +
        "session's poll is untouched",
    })
  })

  app.get('/api/agent/invite', (c) =>
    c.json({
      ask: buildConnectAsk(IS_DEV, resolve(ctx.root), homedir()),
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

  // The changeset one commit at a time: the list, then any listed commit's own
  // diff. Read on demand, never stored — a rebase is just the next answer.
  app.get('/api/commits', async (c) => {
    try {
      return c.json(await listCommits(ctx.root, ctx.spec))
    } catch (err) {
      if (err instanceof MissingBaseError) return c.json({ error: err.message }, 400)
      throw err
    }
  })

  app.get('/api/commits/:sha', async (c) => {
    try {
      const commit = await getCommitChangeset(ctx.root, ctx.spec, c.req.param('sha'))
      return commit ? c.json(commit) : c.json({ error: 'no such commit in this changeset' }, 404)
    } catch (err) {
      if (err instanceof MissingBaseError) return c.json({ error: err.message }, 400)
      throw err
    }
  })

  app.get('/api/file', async (c) => {
    const path = c.req.query('path')
    const side = c.req.query('side')
    const rev = c.req.query('rev')
    if (!path || (side !== 'base' && side !== 'head')) {
      return c.json({ error: 'need ?path= and ?side=base|head' }, 400)
    }
    let bytes: Buffer | null
    try {
      if (rev !== undefined) {
        // The file as one of the changeset's commits had it: the head side of
        // that commit's own diff. Only a sha the changeset lists is read.
        if (side !== 'head') return c.json({ error: '?rev= reads the head side only' }, 400)
        if (!(await isListedCommit(ctx.root, ctx.spec, rev))) {
          return c.json({ error: 'no such commit in this changeset' }, 404)
        }
        bytes = getBaseFileBytes(ctx.root, rev, path)
      } else {
        bytes =
          side === 'head'
            ? getHeadFileBytes(ctx.root, path)
            : getBaseFileBytes(ctx.root, resolveBaseRef(ctx.root, ctx.spec), path)
      }
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
      // The presets and their conversations moved — an edit by the agent, a
      // message, a save from another tab: an open Layers dialog re-reads.
      const unsubscribePresets = presetStore?.subscribe(() => {
        void sse.writeSSE({ event: 'presets', data: '{}', id: String(id++) })
      })
      // The reviewer roles and their conversations moved, the same way: an
      // open Reviewer agents page re-reads.
      const unsubscribeRoles = roleStore?.subscribe(() => {
        void sse.writeSSE({ event: 'roles', data: '{}', id: String(id++) })
      })
      const unsubscribePresence = queue?.subscribe(() => {
        void sse.writeSSE({
          event: 'presence',
          data: JSON.stringify({
            ...queue.presenceDetail(),
            workingOn: queue.deliveredThreadIds(),
            queued: queue.queuedThreadIds(),
            answered: queue.currentBatch()?.answered ?? [],
            layers: queue.layersRequest(),
          }),
          id: String(id++),
        })
      })
      // Which reviewer agents are connected: the page's actors strip. Seats
      // come with the review; this is who is here right now.
      const unsubscribeReviewers = hub.subscribe(() => {
        void sse.writeSSE({
          event: 'reviewers',
          data: JSON.stringify(reviewerPresence()),
          id: String(id++),
        })
      })
      // Register the abort handler BEFORE the first awaited write — Hono never
      // fires a late `onAbort`, so a connection dying under backpressure would
      // leak every subscription and spin the ping loop forever.
      sse.onAbort(() => {
        closed = true
        drop()
        unsubscribe()
        unsubscribeReview?.()
        unsubscribePresets?.()
        unsubscribeRoles?.()
        unsubscribePresence?.()
        unsubscribeReviewers()
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
            layers: queue.layersRequest(),
          }),
          id: String(id++),
        })
      }
      await sse.writeSSE({
        event: 'reviewers',
        data: JSON.stringify(reviewerPresence()),
        id: String(id++),
      })
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
      return c.text('Client not built; run `pnpm build`', 404)
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
  // A follow-up promised before the restart has no live batch left to conclude
  // it — downgrade to unanswered so the UI stops waiting. Self-healing: the
  // follow-up that does arrive clears the mark like any reply.
  const promised = review
    .get()
    .threads.filter((t) => t.awaitingFollowUp === true)
    .map((t) => t.id)
  if (promised.length > 0) review.markUnanswered(promised)
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
  const log = (message: string) =>
    console.log(`[${new Date().toLocaleTimeString('en-GB', { hour12: false })}] ${message}`)
  // This repo's reviews for branches it no longer has go before its review
  // loads, so a branch deleted since the last start is forgotten before a
  // namesake could inherit its threads. Only this repo is asked about here; the
  // rest of the machine is swept in the background below.
  const retired = db.pruneRepo(resolve(options.root))
  if (retired > 0) {
    log(
      `retired ${retired} ${retired === 1 ? 'review' : 'reviews'} for branches this repo no longer has`,
    )
  }
  const review = new ReviewStore(options.root, db, options.spec)
  const queue = new DeliveryQueue()
  // Start the queue on the review's scope, or feedback queued before the first
  // checkout would park under the default scope and never deliver.
  queue.rescope(store.get().repo.branch)
  rehydrateQueue(review, queue)
  const telemetry =
    options.telemetry ??
    new Telemetry({
      store: {
        get: (key) => db.getUiSetting(key),
        set: (key, value) => db.setUiSetting(key, value),
      },
      ids: fileMachineIdStore(),
      log,
      dev: SRC_STAMP !== null || IS_DEV,
    })
  queue.subscribe((presence) => log(`agent ${presence}`))
  const unsubscribeBatch = queue.onBatchClosed((closed) => {
    const took = Math.round((closed.closedAt - closed.deliveredAt) / 1000)
    log(
      closed.reason === 'lapsed'
        ? `agent never answered ${closed.threadIds.length} after ${REMINDER_MAX} reminders (${took}s)`
        : `agent finished a batch of ${closed.threadIds.length} in ${took}s (${closed.reason})` +
            (closed.unanswered.length > 0 ? `, ${closed.unanswered.length} unanswered` : ''),
    )
  })
  const landedGit = {
    head: () => getHeadSha(options.root),
    isAncestor: (ancestor: string, descendant: string) =>
      isAncestor(options.root, ancestor, descendant),
    subject: (sha: string) => getCommitSubject(options.root, sha),
  }
  const checkLanded = (hasFiles: boolean, hunkIds: ReadonlySet<string>) => {
    if (maintainLanded(review, hasFiles, hunkIds, landedGit) === 'stamped') {
      const landed = review.get().landed
      if (landed) log(`changeset landed in ${landed.sha.slice(0, 7)}, offering a fresh review`)
    }
  }
  const stopWatching = watchRepo(options.root, () => store.refresh())
  // A pull request under review: the forge's pulse, and the refresh hook the
  // routes call. Started after the listeners below, so its first import lands
  // on a review that is already reconciling.
  if (options.pr?.info) store.setPr(options.pr.info)
  if (
    options.pr?.shared &&
    review.applySharedLayers(options.pr.shared.layers, options.pr.shared.from)
  ) {
    log(`layers loaded from @${options.pr.shared.from.by}'s reading guide`)
  }
  const puller = options.pr
    ? new PrPuller({
        forge: options.pr.forge,
        ref: options.pr.ref,
        mainRepo: options.pr.mainRepo,
        worktree: options.root,
        baseBranch: options.pr.baseBranch,
        store,
        review,
        db,
        log,
      })
    : null
  const prContext: PrContext | undefined = options.pr
    ? { ...options.pr, refresh: () => puller!.tick() }
    : undefined
  // Commit threads follow their commit across a rebase or a reword. Only git
  // knows the branch's commits, so this runs after the hunk pass, and only when
  // there is a commit thread to move.
  // A later change's listing wins: an earlier one that lands after it is stale.
  let commitPass = 0
  const reconcileCommits = () => {
    if (!review.get().threads.some((t) => t.anchor.kind === 'commit')) return
    const pass = ++commitPass
    void listCommitMessages(options.root, options.spec)
      .then((listed) => {
        if (pass === commitPass) review.reconcileCommits(listed)
      })
      .catch((err: Error) => log(`commit threads not reconciled: ${err.message}`))
  }
  const unsubscribeReconcile = store.subscribe((changeset) => {
    // A checkout under a running server is a change of work: swap to that branch's
    // review before reconciling, or new hunks meet the old branch's threads.
    const before = review.scope.branch
    review.rescope(changeset.repo.branch)
    queue.rescope(changeset.repo.branch)
    // The tree moved: an agent holding a batch is at work, not stalled.
    queue.noteEdit()
    if (review.scope.branch !== before)
      log(`branch ${before || 'detached'} → ${changeset.repo.branch || 'detached'}`)
    const hunkIds = new Set(changeset.files.flatMap((f) => f.hunks.map((h) => h.id)))
    review.reconcile(hunkIds)
    reconcileCommits()
    checkLanded(changeset.files.length > 0, hunkIds)
  })
  const startupHunkIds = new Set(store.get().files.flatMap((f) => f.hunks.map((h) => h.id)))
  review.reconcile(startupHunkIds)
  reconcileCommits()
  // Startup runs the same check: the commit that landed this review may have
  // happened while no server was watching (the idle reap makes that ordinary).
  checkLanded(store.get().files.length > 0, startupHunkIds)
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
          `idle for ${Math.round(idleTimeoutMs / 60_000)}m with no browser or agent, shutting down`,
        )
        process.exit(0)
      },
    })
    idle.start()
  }
  puller?.start()
  const app = createApp(
    {
      ...options,
      ...(prContext ? { pr: prContext } : {}),
      idle,
      telemetry,
      onShutdownRequest: options.onShutdownRequest ?? (() => process.exit(0)),
      uiSettings: {
        get: (key) => db.getUiSetting(key),
        set: (key, value) => db.setUiSetting(key, value),
      },
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
  // The machine-wide sweep — reviews whose repo or branch is gone, across every
  // repo this machine ever reviewed — asks git once per branch it knows, which
  // is exactly the work an open must never wait for. It runs here, once the
  // server is serving and the first page has had its moment, and never holds
  // the process open.
  const maintenance = setTimeout(() => {
    db.maintain()
      .then((report) => {
        if (report.reviews > 0) {
          log(
            `retired ${report.reviews} ${report.reviews === 1 ? 'review' : 'reviews'} whose repo or branch is gone`,
          )
        }
      })
      .catch((err: Error) => log(`database sweep failed: ${err.message}`))
  }, MAINTENANCE_DELAY_MS)
  maintenance.unref()
  const deregister = () => {
    try {
      db.removeServer(review.repoPath, options.port)
      // A merged or closed pull request whose offer the reviewer has acted on
      // (the landed marker is gone) takes its worktree with it. Anything else
      // stays for the next open, or for the sweep.
      if (options.pr) {
        const record = db.getWorktree(review.repoPath)
        if (record?.closedAt && !review.get().landed) removeWorktree(db, record, false)
      }
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
        ? `diffo: port ${options.port} was taken while starting up; re-run to pick another`
        : `diffo: cannot listen on port ${options.port}: ${err.message}`,
    )
    process.exit(1)
  })
  return {
    server,
    store,
    review,
    queue,
    telemetry,
    stopWatching: async () => {
      clearTimeout(maintenance)
      idle?.stop()
      puller?.stop()
      unsubscribeReconcile()
      unsubscribeBatch()
      await stopWatching()
      deregister()
      process.removeListener('exit', deregister)
      db.close()
    },
  }
}
