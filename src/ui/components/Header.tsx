import { type ReactNode, useEffect, useRef, useState } from 'react'
import type { Changeset } from '../../shared/types.js'
import type { Presence } from '../api.js'
import { isDevServer } from '../devMode.js'
import type { Theme } from '../theme.js'
import { Icon } from './Icon.js'
import { Menu, MenuItem, MenuLabel, MenuSep } from './Menu.js'

const n = (x: number) => x.toLocaleString('en-US')

function Comparison({ changeset }: { changeset: Changeset }) {
  const { spec, stats, repo } = changeset
  const working = spec.kind === 'working-tree'
  const from = working ? 'working tree' : repo.branch || 'HEAD'
  const to = working ? 'HEAD' : spec.base
  return (
    <span
      className="cmp"
      title={
        working
          ? `comparing your working tree against HEAD${repo.branch ? ` on ${repo.branch}` : ''}`
          : `comparing ${from} against ${to}`
      }
    >
      <Icon name="cmp" size="sm" />
      <span className="cmp-side">{from}</span>
      <Icon name="arrow" size="sm" className="cmp-arrow" />
      <span className="cmp-side cmp-side-base">{to}</span>
      <span className="cmp-n">
        <span className="stat-add">+{n(stats.additions)}</span>{' '}
        <span className="stat-del">−{n(stats.deletions)}</span>
      </span>
    </span>
  )
}

function Where({ repo }: { repo: Changeset['repo'] }) {
  return (
    <span className="where">
      <span className="repo">{repo.name}</span>
      {repo.worktree && (
        <span className="where-bit" title={`linked worktree '${repo.worktree}'`}>
          <Icon name="worktree" size="sm" />
          {repo.worktree}
        </span>
      )}
      {repo.branch && (
        <span className="where-bit" title={`on branch ${repo.branch}`}>
          <Icon name="branch" size="sm" />
          {repo.branch}
        </span>
      )}
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
    'no agent is attached — sends queue for the next poll, and the prompt is copied so you can paste it yourself',
  listening: 'an agent is polling — a send is delivered to it immediately',
  working: 'the agent received feedback and is working on it',
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

function PresenceChip({
  presence,
  since,
  onInvite,
  batch,
  monitorOpen = false,
  onOpenMonitor,
  monitorPanel,
}: {
  presence: Presence
  since?: number | null
  onInvite?: () => void
  batch?: AgentBatch
  monitorOpen?: boolean
  onOpenMonitor?: (open: boolean) => void
  monitorPanel?: ReactNode
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
        {PRESENCE_LABEL[presence]}
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
  if (presence === 'waiting' || total === 0 || !onOpenMonitor) {
    return (
      <span className={`presence presence-${presence}`} title={PRESENCE_TITLE[presence]}>
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
        title={`${PRESENCE_TITLE[presence]} — ${batch!.done} of ${total} answered; click to watch the queue`}
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
  since?: number | null
  onInvite?: () => void
  batch?: AgentBatch
  monitorOpen?: boolean
  onOpenMonitor?: (open: boolean) => void
  monitorPanel?: ReactNode
}

export interface HeaderReview {
  openComments?: number
  onFinishReview?: () => void
}

export interface HeaderSettings {
  theme?: Theme
  onSetTheme?: (theme: Theme) => void
  onShowShortcuts?: () => void
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
  const { openComments = 0, onFinishReview } = review
  const { theme, onSetTheme, onShowShortcuts } = settings
  return (
    <header className="top">
      <span className="mark">
        <Icon name="logo" size="lg" />
        Diffo
        {isDevServer() && (
          <span
            className="dev-badge"
            title="this review is served by a diffo running from a source checkout, not the released CLI"
          >
            dev
          </span>
        )}
      </span>
      <Where repo={changeset.repo} />
      <Comparison changeset={changeset} />
      <span className="grow" />
      {agent.presence && (
        <PresenceChip
          presence={agent.presence}
          since={agent.since}
          onInvite={agent.onInvite}
          batch={agent.batch}
          monitorOpen={agent.monitorOpen}
          onOpenMonitor={agent.onOpenMonitor}
          monitorPanel={agent.monitorPanel}
        />
      )}
      {onFinishReview && (
        <button
          type="button"
          className="btn btn-primary"
          onClick={onFinishReview}
          title="finish review: send open comments + coverage to your agent"
        >
          Finish review{openComments > 0 ? ` (${openComments})` : ''}
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
          </>
        )}
      </Menu>
    </header>
  )
}
