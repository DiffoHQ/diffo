import { type CSSProperties, type ReactNode, useEffect, useRef, useState } from 'react'
import type { Changeset, PrInfo } from '../../shared/types.js'
import type { Presence, PresenceReason } from '../api.js'
import { isDevServer } from '../devMode.js'
import { shortAgo } from '../markdown.js'
import type { Theme } from '../theme.js'
import { Icon } from './Icon.js'
import { LivingMark } from './LivingMark.js'
import { Menu, MenuItem, MenuLabel, MenuSep } from './Menu.js'

/** Where you are, in one line: `repo · from → to`. The branch is one of the two
 * sides, so it is never repeated beside them; the worktree, when there is one,
 * and the size of the change are not where you are, so they live in the hover
 * and in the pane bar respectively. On a pull request the PR chips say all of
 * this, and the line steps aside. */
function Comparison({ changeset }: { changeset: Changeset }) {
  const { spec, repo, pr } = changeset
  if (pr) return null
  const working = spec.kind === 'working-tree'
  const from = working ? 'working tree' : repo.branch || 'HEAD'
  const to = working ? 'HEAD' : spec.base
  const where = [
    working
      ? `comparing your working tree against HEAD${repo.branch ? ` on branch ${repo.branch}` : ''}`
      : `comparing ${from} against ${to}`,
    repo.worktree && `linked worktree '${repo.worktree}'`,
  ]
    .filter(Boolean)
    .join(' · ')
  return (
    <span className="cmp" title={where}>
      <span className="repo">{repo.name}</span>
      <span className="cmp-dot" aria-hidden="true">
        ·
      </span>
      <span className="cmp-side">{from}</span>
      <Icon name="arrow" size="sm" className="cmp-arrow" />
      <span className="cmp-side cmp-side-base">{to}</span>
    </span>
  )
}

const CHECK_LABEL: Record<PrInfo['checks']['state'], string> = {
  success: 'CI passing',
  failure: 'CI failing',
  pending: 'CI running',
  none: 'no checks',
  unknown: 'checks not visible to your token',
}

/** The one chip the header shows beside the title: the most decision-relevant
 * state, by priority. Everything else is in the card. */
function prStatus(pr: PrInfo): { label: string; className: string } | null {
  if (pr.state !== 'open')
    return { label: pr.state, className: `chip-mute pr-state pr-state-${pr.state}` }
  if (pr.changesRequested > 0) return { label: 'changes requested', className: 'chip-attn' }
  if (pr.checks.state === 'failure') return { label: 'CI failing', className: 'pr-check-failure' }
  if (pr.draft) return { label: 'draft', className: 'chip-mute pr-state pr-state-draft' }
  if (pr.checks.state === 'pending') return { label: 'CI running', className: 'pr-check-pending' }
  return null
}

function Avatar({ user, large = false }: { user: PrInfo['author']; large?: boolean }) {
  const cls = large ? 'pr-avatar pr-avatar-lg' : 'pr-avatar'
  return user.avatarUrl ? (
    <img className={cls} src={user.avatarUrl} alt="" />
  ) : (
    <span className={`${cls} pr-avatar-none`}>
      <Icon name="user" size={large ? 'md' : 'sm'} />
    </span>
  )
}

const ago = (iso: string) => {
  const t = shortAgo(iso)
  return /^\d/.test(t) ? `${t} ago` : t
}

/** Everything about the pull request that is not glance-time: who, from where,
 * how it stands, what was pushed, and the way to GitHub. Opens from the title
 * chip and adds to it, never repeats it. */
function PrCard({ pr }: { pr: PrInfo }) {
  const [commitsOpen, setCommitsOpen] = useState(false)
  const last = pr.commits.at(-1)
  const checks = [CHECK_LABEL[pr.checks.state], last ? `pushed ${ago(last.at)}` : '']
    .filter(Boolean)
    .join(' · ')
  const reviews =
    pr.approvals === 0 && pr.changesRequested === 0
      ? { text: 'no reviews yet', tone: 'mute' }
      : pr.changesRequested > 0
        ? {
            text: `changes requested${pr.approvals > 0 ? ` · ${pr.approvals} ${pr.approvals === 1 ? 'approval' : 'approvals'}` : ''}`,
            tone: 'attn',
          }
        : { text: `${pr.approvals} ${pr.approvals === 1 ? 'approval' : 'approvals'}`, tone: 'ok' }
  const n = pr.commits.length
  const commitUrl = (sha: string) =>
    `https://${pr.host}/${pr.owner}/${pr.repo}/pull/${pr.number}/commits/${sha}`
  return (
    <section className="menu-panel menu-panel-left pr-card" aria-label="pull request details">
      <div className="pr-card-who">
        <Avatar user={pr.author} large />
        <span className="pr-card-who-text">
          <span className="pr-card-login">{pr.author.login}</span>
          <span className="pr-card-where">
            {pr.owner}/{pr.repo} #{pr.number}
          </span>
        </span>
      </div>
      <div className="pr-card-body">
        <div className="pr-card-refs" title={`${pr.head.ref} into ${pr.base.ref}`}>
          <code className="pr-ref">{pr.head.ref}</code>
          <Icon name="arrow" size="sm" className="cmp-arrow" />
          <code className="pr-ref pr-ref-base">{pr.base.ref}</code>
        </div>
        <ul className="pr-card-facts">
          <li className={`pr-fact pr-fact-${pr.checks.state}`}>
            <i className="pr-fact-dot" aria-hidden="true" />
            {pr.checks.url ? (
              <a href={pr.checks.url} target="_blank" rel="noreferrer">
                {checks}
              </a>
            ) : (
              checks
            )}
          </li>
          <li className={`pr-fact pr-fact-${reviews.tone}`}>
            <Icon
              name={reviews.tone === 'ok' ? 'check' : reviews.tone === 'attn' ? 'alert' : 'chat'}
              size="sm"
            />
            {reviews.text}
          </li>
        </ul>
        {n > 0 && (
          <div className="pr-commits">
            <button
              type="button"
              className="pr-commits-toggle"
              aria-expanded={commitsOpen}
              onClick={() => setCommitsOpen((v) => !v)}
            >
              <span className={`chevron${commitsOpen ? '' : ' chevron-shut'}`}>
                <Icon name="chev" size="sm" />
              </span>
              {n} {n === 1 ? 'commit' : 'commits'}
            </button>
            {commitsOpen && (
              <ol className="pr-commit-list">
                {[...pr.commits].reverse().map((c) => (
                  <li key={c.sha}>
                    <a
                      className="pr-commit"
                      href={commitUrl(c.sha)}
                      target="_blank"
                      rel="noreferrer"
                      title={`${c.subject}${c.author ? `, by ${c.author.login}` : ''}, opens on GitHub`}
                    >
                      <code className="pr-commit-sha">{c.sha.slice(0, 7)}</code>
                      <span className="pr-commit-subject">{c.subject}</span>
                      <span className="pr-commit-ago">{shortAgo(c.at)}</span>
                    </a>
                  </li>
                ))}
              </ol>
            )}
          </div>
        )}
      </div>
      <a className="btn btn-ghost pr-card-link" href={pr.url} target="_blank" rel="noreferrer">
        Open on GitHub
        <Icon name="link" size="sm" />
      </a>
    </section>
  )
}

/** The pull request's chips: the title owns the row, one status chip beside it,
 * and the card behind the title holds the rest. */
function PrChips({ pr }: { pr: PrInfo }) {
  const [open, setOpen] = useState(false)
  const wrap = useRef<HTMLSpanElement>(null)
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey, true)
    }
  }, [open])
  const status = prStatus(pr)
  return (
    <span className="where pr-chips menu" ref={wrap}>
      <button
        type="button"
        className="pr-title"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        title={
          open
            ? undefined
            : `${pr.owner}/${pr.repo}#${pr.number}: author, branches, checks, reviews`
        }
      >
        <Icon name="pr" size="sm" />
        <span className="pr-number">#{pr.number}</span>
        <span className="pr-title-text">{pr.title}</span>
      </button>
      {status && <span className={`chip ${status.className}`}>{status.label}</span>}
      {open && <PrCard pr={pr} />}
    </span>
  )
}

const PRESENCE_LABEL: Record<Presence, string> = {
  waiting: 'no agent',
  listening: 'agent · listening',
  working: 'agent · working',
}

const PRESENCE_TITLE: Record<Presence, string> = {
  waiting:
    'no agent is attached; sends queue for the next poll, and the prompt is copied so you can paste it yourself',
  listening: 'an agent is polling; a send is delivered to it immediately',
  working: 'the agent received feedback and is working on it',
}

/** Between polls because the poll ended on its own (the window closed, or the
 * process was killed under its harness), not because anyone left: the chip
 * keeps the agent, and the tooltip says what a send does meanwhile. */
const REPOLLING_TITLE =
  'the agent is attached but its last poll ended; a send queues and reaches it when it polls again'

/** Between the open and the first poll: the agent's CLI opened this review and
 * the agent is reading the change for its guide. It has not polled yet, so a
 * send queues — but it is here, and the chip says what it is doing. */
const ARRIVING_LABEL = 'agent · reading the change'
const ARRIVING_TITLE =
  'your agent opened this review and is reading the change before it starts listening — ' +
  'its guide lands first; a send queues and reaches it at its first poll'

function presenceTitle(presence: Presence, reason: PresenceReason | undefined): string {
  if (presence !== 'working') return PRESENCE_TITLE[presence]
  if (reason === 'repolling') return REPOLLING_TITLE
  if (reason === 'arriving') return ARRIVING_TITLE
  return PRESENCE_TITLE[presence]
}

function formatAgo(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  return `${Math.round(s / 60)}m`
}

export interface AgentBatch {
  segments: readonly ('done' | 'now' | 'wait')[]
  done: number
}

/** The agent flagged at open that this read benefits from layers. The chip
 * becomes the call to action, the way it does for Invite when nobody is
 * attached: agent status is the header's job, and the rail carries no
 * notifications. */
export interface LayersSuggestion {
  reason?: string
  onOutline: () => void
}

function PresenceChip({
  presence,
  reason,
  since,
  activity,
  onInvite,
  batch,
  monitorOpen = false,
  onOpenMonitor,
  monitorPanel,
  suggestion,
}: {
  presence: Presence
  reason?: PresenceReason
  since?: number | null
  activity?: string | null
  onInvite?: () => void
  batch?: AgentBatch
  monitorOpen?: boolean
  onOpenMonitor?: (open: boolean) => void
  monitorPanel?: ReactNode
  suggestion?: LayersSuggestion
}) {
  // A ticking clock needs ticking renders — but only while it shows one.
  const [, setTick] = useState(0)
  const wrap = useRef<HTMLDivElement>(null)
  const showAgo = presence === 'working' && typeof since === 'number'
  useEffect(() => {
    if (!showAgo) return
    const timer = setInterval(() => setTick((t) => t + 1), 10_000)
    return () => clearInterval(timer)
  }, [showAgo])
  // Outside mousedown closes, as everywhere. Escape is the monitor's own listener.
  useEffect(() => {
    if (!monitorOpen || !onOpenMonitor) return
    const onDown = (e: MouseEvent) => {
      if (!wrap.current?.contains(e.target as Node)) onOpenMonitor(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [monitorOpen, onOpenMonitor])
  const body = (
    <>
      {/* Three bars, not a lamp: the state is in how they move, so the chip reads
          without relying on hue — flat and grey is nobody there. */}
      <span className="presence-live" aria-hidden="true">
        <i />
        <i />
        <i />
      </span>
      <span className="presence-label">
        {(presence === 'working' &&
          (activity || (reason === 'arriving' ? ARRIVING_LABEL : null))) ||
          PRESENCE_LABEL[presence]}
        {showAgo && <span className="presence-ago"> · {formatAgo(Date.now() - since)}</span>}
      </span>
    </>
  )
  if (presence === 'waiting' && onInvite) {
    return (
      <button
        type="button"
        className="presence presence-waiting presence-invite"
        onClick={onInvite}
        title="bring your agent into this review"
      >
        {body}
        <span className="presence-cta">Invite</span>
      </button>
    )
  }
  const total = batch?.segments.length ?? 0
  // A live batch outranks the suggestion: what the agent is doing right now is
  // the thing to show, and the offer waits in the Layers tab meanwhile.
  if (presence !== 'waiting' && suggestion && total === 0) {
    return (
      <button
        type="button"
        className={`presence presence-${presence} presence-invite presence-suggests`}
        onClick={suggestion.onOutline}
        title={
          suggestion.reason
            ? `the agent suggests reading this in layers: “${suggestion.reason}”`
            : 'the agent suggests reading this in layers'
        }
      >
        <span className="presence-live" aria-hidden="true">
          <i />
          <i />
          <i />
        </span>
        <span className="presence-label">agent · suggests layers</span>
        <span className="presence-cta">Ask it</span>
      </button>
    )
  }
  if (presence === 'waiting' || total === 0 || !onOpenMonitor) {
    return (
      <span className={`presence presence-${presence}`} title={presenceTitle(presence, reason)}>
        {body}
      </span>
    )
  }
  return (
    <div className="menu monitor-anchor" ref={wrap}>
      <button
        type="button"
        className={`presence presence-${presence} presence-batch`}
        aria-haspopup="dialog"
        aria-expanded={monitorOpen}
        onClick={() => onOpenMonitor(!monitorOpen)}
        title={`${PRESENCE_TITLE[presence]}. ${batch!.done} of ${total} answered; click to watch the queue`}
      >
        {body}
        <span className="presence-qbar" aria-hidden>
          {batch!.segments.map((kind, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: position is a segment's identity — the bar recolours in place
            <i key={i} className={`q-${kind}`} />
          ))}
        </span>
        <span className="presence-batch-n">
          {batch!.done}/{total}
        </span>
      </button>
      {monitorOpen && monitorPanel}
    </div>
  )
}

export interface HeaderAgent {
  presence?: Presence
  /** Why the state holds — only `repolling` and `arriving` change what the chip says. */
  reason?: PresenceReason
  since?: number | null
  /** What the agent is doing right now — replaces the static working label. */
  activity?: string | null
  onInvite?: () => void
  batch?: AgentBatch
  monitorOpen?: boolean
  onOpenMonitor?: (open: boolean) => void
  monitorPanel?: ReactNode
  /** Set while the agent's layers suggestion stands and no layers exist yet. */
  suggestion?: LayersSuggestion
}

export interface HeaderReview {
  openComments?: number
  /** Public drafts among them: Finish also submits to GitHub. */
  publicDrafts?: number
  onFinishReview?: () => void
}

export interface HeaderSettings {
  theme?: Theme
  onSetTheme?: (theme: Theme) => void
  onShowShortcuts?: () => void
  /** Opens the Privacy dialog, where the usage-data switch lives. */
  onShowPrivacy?: () => void
}

export function Header({
  changeset,
  agent = {},
  review = {},
  settings = {},
}: {
  changeset: Changeset
  agent?: HeaderAgent
  review?: HeaderReview
  settings?: HeaderSettings
}) {
  const { openComments = 0, publicDrafts = 0, onFinishReview } = review
  const { theme, onSetTheme, onShowShortcuts, onShowPrivacy } = settings
  return (
    <header className="top">
      <span className="mark">
        <LivingMark size={36} />
        <span className="wordmark" role="img" aria-label="Diffo">
          {[...'Diffo'].map((letter, i) => (
            <span
              // biome-ignore lint/suspicious/noArrayIndexKey: letters of a fixed word; the index is the identity
              key={i}
              className="wordmark-letter"
              style={{ '--i': i } as CSSProperties}
              aria-hidden="true"
            >
              {letter}
            </span>
          ))}
        </span>
        {isDevServer() && (
          <span
            className="dev-badge"
            title="this review is served by a diffo running from a source checkout, not the released CLI"
          >
            dev
          </span>
        )}
      </span>
      {changeset.pr && <PrChips pr={changeset.pr} />}
      <Comparison changeset={changeset} />
      <span className="grow" />
      {agent.presence && (
        <PresenceChip
          presence={agent.presence}
          reason={agent.reason}
          since={agent.since}
          activity={agent.activity}
          onInvite={agent.onInvite}
          batch={agent.batch}
          monitorOpen={agent.monitorOpen}
          onOpenMonitor={agent.onOpenMonitor}
          monitorPanel={agent.monitorPanel}
          suggestion={agent.suggestion}
        />
      )}
      {onFinishReview && (
        <button
          type="button"
          className="btn btn-primary"
          onClick={onFinishReview}
          title={
            changeset.pr
              ? publicDrafts > 0
                ? `submit your review on GitHub with ${publicDrafts} pending ${publicDrafts === 1 ? 'comment' : 'comments'}; private threads go to your agent`
                : 'submit your review on GitHub; private threads and coverage go to your agent'
              : 'finish review: send open comments + coverage to your agent'
          }
        >
          {changeset.pr ? (
            <>
              <Icon name="globe" size="sm" /> Submit review
              {publicDrafts > 0 ? ` (${publicDrafts})` : ''}
            </>
          ) : (
            `Finish review${openComments > 0 ? ` (${openComments})` : ''}`
          )}
        </button>
      )}
      <Menu label="Settings" triggerClassName="btn btn-ghost btn-icon">
        {(close) => (
          <>
            {onSetTheme && (
              <>
                <MenuLabel>Theme</MenuLabel>
                <MenuItem
                  icon="display"
                  checked={theme === 'system'}
                  onClick={() => {
                    close()
                    onSetTheme('system')
                  }}
                >
                  System
                </MenuItem>
                <MenuItem
                  icon="sun"
                  checked={theme === 'light'}
                  onClick={() => {
                    close()
                    onSetTheme('light')
                  }}
                >
                  Light
                </MenuItem>
                <MenuItem
                  icon="moon"
                  checked={theme === 'dark'}
                  onClick={() => {
                    close()
                    onSetTheme('dark')
                  }}
                >
                  Dark
                </MenuItem>
              </>
            )}
            {onShowShortcuts && (
              <>
                {onSetTheme && <MenuSep />}
                <MenuItem
                  icon="keys"
                  kbd="?"
                  onClick={() => {
                    close()
                    onShowShortcuts()
                  }}
                >
                  Shortcuts
                </MenuItem>
              </>
            )}
            {onShowPrivacy && (
              <>
                {(onSetTheme || onShowShortcuts) && <MenuSep />}
                <MenuItem
                  icon="lock"
                  onClick={() => {
                    close()
                    onShowPrivacy()
                  }}
                >
                  Privacy
                </MenuItem>
              </>
            )}
          </>
        )}
      </Menu>
    </header>
  )
}
