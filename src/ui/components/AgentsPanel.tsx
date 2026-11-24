import {
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
  useEffect,
  useRef,
  useState,
} from 'react'
import {
  openedByReviewerAgent,
  REVIEWER_MESSAGE_MAX,
  type ReviewerChatMessage,
  type ReviewerCoverage,
  type ReviewThread,
} from '../../shared/review.js'
import { DEFAULT_ROLE } from '../../shared/roles.js'
import {
  type CommentStatus,
  formatWorked,
  REVIEWER_STATUS_WORDS,
  type ReviewerRow,
  type ReviewerStatus,
  reviewerHue,
  reviewerRows,
  reviewerStory,
  type StoryItem,
  threadCountsBy,
  unreadMessages,
  useReviewers,
  waitsOnYou,
  workedMs,
} from '../actors.js'
import { reviewerApi, useChangeset, useReviewerRoles } from '../api.js'
import { shortAgo } from '../markdown.js'
import { Confirm } from './Confirm.js'
import { type CritterEyes, CritterFace } from './Critter.js'
import { Icon } from './Icon.js'
import { Menu, MenuItem } from './Menu.js'

/** The panel's width, kept per browser like the file list's. */
const WIDTH_KEY = 'diffo:ui:agentsWidth'
const WIDTH_DEFAULT = 300
const WIDTH_MIN = 240
const WIDTH_MAX = 520
const clampWidth = (w: number) => Math.min(WIDTH_MAX, Math.max(WIDTH_MIN, w))

const sentence = (text: string) => `${text.charAt(0).toUpperCase()}${text.slice(1)}`

/**
 * A status's mark, from the conventions agent tools already share: a spinner
 * while working, an orange dot when it waits on you, a clock while it waits on
 * your agent, a check when done, a hollow circle when gone.
 */
export function StatusMark({ status }: { status: ReviewerStatus }) {
  if (status === 'done') {
    return (
      <span className="st st-done" aria-hidden="true">
        <Icon name="check" size="xs" />
      </span>
    )
  }
  return <span className={`st st-${status}`} aria-hidden="true" />
}

/** How a reviewer's critter looks: asleep when gone, pleased when done. */
const STATUS_EYES: Record<ReviewerStatus, CritterEyes> = {
  needs: 'open',
  working: 'open',
  waiting: 'open',
  starting: 'open',
  done: 'happy',
  away: 'shut',
  stopped: 'shut',
}

/** A reviewer's face: the critter, in its colour. */
export function Face({ hue, eyes = 'open' }: { hue: number; eyes?: CritterEyes }) {
  return (
    <span className={`face actor-rev-${hue}`} aria-hidden="true">
      <CritterFace eyes={eyes} />
    </span>
  )
}

/**
 * A reviewer's face with its status on the corner, the way chat apps badge an
 * avatar's presence: a spinner, an orange dot, a clock, a check, a hollow
 * ring. One gone is faded and asleep, so it reads at a glance.
 */
export function StatusFace({ row }: { row: ReviewerRow }) {
  return (
    <span className={`stack-face-in stack-${row.status}`}>
      <Face hue={row.hue} eyes={STATUS_EYES[row.status]} />
      <span className="stack-badge" aria-hidden="true">
        <StatusMark status={row.status} />
      </span>
    </span>
  )
}

/** When the human last read each reviewer's conversation, kept per browser,
 * so a reply they have not seen marks its row like an unread chat. */
const SEEN_KEY = 'diffo:ui:agentsSeen'

function readSeen(): Record<string, string> {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(SEEN_KEY) ?? '{}')
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, string>) : {}
  } catch {
    return {}
  }
}

function markSeen(name: string, at: string) {
  try {
    const seen = readSeen()
    if (seen[name] !== undefined && seen[name] >= at) return
    localStorage.setItem(SEEN_KEY, JSON.stringify({ ...seen, [name]: at }))
  } catch {
    // a blocked store only means the dot comes back
  }
}

/** The row's one line, in the reviewer's own words where it has said any:
 * its last reply to the human when that is newer than its last step,
 * otherwise what it is on, trailing off while it is still at it. */
function preview(row: ReviewerRow, reply: ReviewerChatMessage | undefined): string {
  if (row.status === 'needs' && row.line) return sentence(row.line)
  if (row.status === 'starting') return 'Your agent is starting it…'
  if (row.status === 'away') return REVIEWER_STATUS_WORDS.away
  if (reply && (!row.at || reply.at >= row.at)) return reply.text
  if (!row.line)
    return row.status === 'working' ? 'Getting started…' : REVIEWER_STATUS_WORDS[row.status]
  const line = sentence(row.line)
  return row.status === 'working' && !/[.…!?:]$/.test(line) ? `${line}…` : line
}

/**
 * The reviewer agents, in a sidebar on the right of the diff built like the
 * file list on the left: its tabs, its rows, its resizable edge, opened and
 * shut from the top bar. Reviewers lists them as a pull request lists its
 * reviewers (GitHub, Graphite): one row each with its status and, on hover,
 * what can be done with it. Activity is what they all did. A row opens that
 * reviewer: its steps, a box to write to it while it can read, and its removal.
 */
export function AgentsPanel({
  focus,
  threads,
  onAdd,
  onManage,
  onOpenThread,
}: {
  /** The reviewer to open on; the list when absent. */
  focus?: string
  /** The review's threads: where a reviewer that needs you is waiting. */
  threads: readonly ReviewThread[]
  onAdd: () => void
  /** The reviewer agents page: what each kind of reviewer looks for. */
  onManage: () => void
  onOpenThread: (threadId: string) => void
}) {
  const reviewers = useReviewers()
  const rows = reviewerRows(reviewers)
  // Opened on a reviewer or on the list; each ask remounts the sidebar (the
  // app keys it), so this is read once.
  const [open, setOpen] = useState<string | null>(focus ?? null)
  // Focus follows a move inside the sidebar, never its first opening: into a
  // reviewer (its box, or Back when it can't read you), and back out to the
  // row it came from (or Add reviewer, once that row is gone). Without it, a
  // keyboard or screen-reader user lands on the page's body each time.
  const moved = useRef<{ from: string | null } | null>(null)
  const go = (next: string | null) => {
    moved.current = { from: open }
    setOpen(next)
  }
  // Spent on the render it was made for: the view or list that mounted took
  // it in its own effect, which runs before this one. A later remount (a tab
  // switched back) must leave focus on what the human just pressed.
  useEffect(() => {
    moved.current = null
  })
  // The ages tick on their own while the panel is up.
  const [, tick] = useState(0)
  useEffect(() => {
    const timer = setInterval(() => tick((n) => n + 1), 20_000)
    return () => clearInterval(timer)
  }, [])
  const [tab, setTab] = useState<'reviewers' | 'activity'>('reviewers')
  // Escape inside the sidebar steps back from one reviewer to the list; one
  // pressed anywhere else is another panel's, and one in a box with words in
  // it would throw a draft away. The sidebar itself opens and closes from the
  // top bar, as the file list does.
  const aside = useRef<HTMLElement>(null)
  const openRef = useRef(open)
  openRef.current = open
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented || openRef.current === null) return
      const target = e.target as Node | null
      if (!target || !aside.current?.contains(target)) return
      if (target instanceof HTMLTextAreaElement && target.value.trim() !== '') return
      moved.current = { from: openRef.current }
      setOpen(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
  const showReviewer = (name: string) => {
    setTab('reviewers')
    go(name)
  }

  const [width, setWidth] = useState(() => {
    try {
      const stored = Number(localStorage.getItem(WIDTH_KEY))
      return stored > 0 ? clampWidth(stored) : WIDTH_DEFAULT
    } catch {
      return WIDTH_DEFAULT
    }
  })
  const commitWidth = (w: number) => {
    const next = clampWidth(w)
    setWidth(next)
    try {
      localStorage.setItem(WIDTH_KEY, String(next))
    } catch {
      // a blocked store only means the width is not remembered
    }
  }
  const beginResize = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return
    e.preventDefault()
    const startX = e.clientX
    const startW = width
    let next = startW
    // The panel is on the right: dragging its edge left widens it.
    const move = (ev: PointerEvent) => {
      next = clampWidth(startW - (ev.clientX - startX))
      setWidth(next)
    }
    const end = () => {
      document.removeEventListener('pointermove', move)
      document.removeEventListener('pointerup', end)
      document.removeEventListener('pointercancel', end)
      document.body.style.userSelect = ''
      document.body.style.cursor = ''
      commitWidth(next)
    }
    document.addEventListener('pointermove', move)
    document.addEventListener('pointerup', end)
    document.addEventListener('pointercancel', end)
    document.body.style.userSelect = 'none'
    document.body.style.cursor = 'col-resize'
  }

  const shown = open !== null ? rows.find((r) => r.seated && r.name === open) : undefined
  return (
    <>
      {/* biome-ignore lint/a11y/useSemanticElements: a splitter is role=separator with aria-valuenow; an hr element cannot be one */}
      <div
        className="rail-resize agents-resize"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize reviewer agents"
        aria-valuemin={WIDTH_MIN}
        aria-valuemax={WIDTH_MAX}
        aria-valuenow={width}
        tabIndex={0}
        data-tip="Drag to resize · double-click to reset"
        onPointerDown={beginResize}
        onDoubleClick={() => commitWidth(WIDTH_DEFAULT)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowLeft') {
            e.preventDefault()
            commitWidth(width + 16)
          } else if (e.key === 'ArrowRight') {
            e.preventDefault()
            commitWidth(width - 16)
          }
        }}
      />
      <aside
        ref={aside}
        className="agents"
        aria-label="Reviewer agents"
        style={{ '--agents-w': `${width}px` } as CSSProperties}
      >
        <div className="tabs" role="tablist" aria-label="Reviewer agents">
          <button
            type="button"
            role="tab"
            className="tab"
            aria-selected={tab === 'reviewers'}
            onClick={() => setTab('reviewers')}
          >
            Reviewers <span className="tab-n">{rows.length}</span>
          </button>
          <button
            type="button"
            role="tab"
            className="tab"
            aria-selected={tab === 'activity'}
            onClick={() => setTab('activity')}
          >
            Activity
          </button>
        </div>
        {tab === 'activity' ? (
          <ActivityList onShow={showReviewer} onOpenThread={onOpenThread} />
        ) : shown ? (
          <ReviewerView
            key={shown.name}
            row={shown}
            threads={threads}
            takeFocus={moved.current !== null}
            onBack={() => go(null)}
            onOpenThread={onOpenThread}
            onRemoved={() => go(null)}
          />
        ) : (
          <ReviewerList
            rows={rows}
            threads={threads}
            focusOn={moved.current?.from ?? undefined}
            onOpen={go}
            onAdd={onAdd}
            onManage={onManage}
            onOpenThread={onOpenThread}
          />
        )}
      </aside>
    </>
  )
}

/** A reviewer's time at work and its threads, as "14m · 3 comments · 1 open"
 * (the open count only while some are closed: until then all of them are). */
function rowMeta(
  events: Parameters<typeof workedMs>[0],
  live: boolean,
  counts: { open: number; closed: number },
  now: number,
): string | null {
  const worked = workedMs(events, live, now)
  const total = counts.open + counts.closed
  const parts = [
    ...(worked !== null ? [formatWorked(worked)] : []),
    ...(total > 0 ? [`${total} ${total === 1 ? 'comment' : 'comments'}`] : []),
    ...(counts.open > 0 && counts.closed > 0 ? [`${counts.open} open`] : []),
  ]
  return parts.length > 0 ? parts.join(' · ') : null
}

/**
 * How much of the change a reviewer read, in a few words for the line under
 * its name, and both accounts in full for its hover: the files it fetched
 * through `diffo diff` (measured; it may read some with plain git), and what
 * it said it skipped when it finished (`diffo covered`, its own word).
 */
function coverageWords(
  mine: ReviewerCoverage | undefined,
  all: readonly string[],
  working: boolean,
): { text: string; title: string } | null {
  if (all.length === 0) return null
  const fetched = (mine?.fetched ?? []).filter((p) => all.includes(p)).length
  const skipped = mine?.reported ? all.filter((p) => mine.reported!.skipped.includes(p)) : null
  const through = `Read through Diffo: ${fetched} of ${all.length} files.`
  if (skipped === null) {
    return {
      text: `read ${fetched} of ${all.length}`,
      title: `${through} ${working ? 'It says what it skipped when it finishes.' : 'It didn’t say what it skipped.'}`,
    }
  }
  return {
    text: `says it read ${all.length - skipped.length} of ${all.length}`,
    title: `${through} It says it skipped ${skipped.length === 0 ? 'none' : skipped.join(', ')}.`,
  }
}

/** What a reviewer's agent is called, from its role id. */
function useTypeName(): (name: string) => string {
  const { roles } = useReviewers()
  const { data } = useReviewerRoles()
  return (name) => {
    const id = roles?.get(name) ?? name
    return data?.roles.find((r) => r.id === id)?.name ?? id
  }
}

/**
 * Every reviewer, one row each, the way a chat app lists its conversations:
 * its face with its status on the corner, its name, and its latest line in
 * its own words; a dot on the right when something waits on the human (a
 * thread that needs them, or a reply they have not read). Hover a row for
 * what can be done with it now.
 */
function ReviewerList({
  rows,
  threads,
  focusOn,
  onOpen,
  onAdd,
  onManage,
  onOpenThread,
}: {
  rows: readonly ReviewerRow[]
  threads: readonly ReviewThread[]
  /** Back from this reviewer: its row takes focus, or Add reviewer when it
   * has left the list. */
  focusOn?: string
  onOpen: (name: string) => void
  onAdd: () => void
  onManage: () => void
  onOpenThread: (threadId: string) => void
}) {
  const typeOf = useTypeName()
  const list = useRef<HTMLDivElement>(null)
  const addButton = useRef<HTMLButtonElement>(null)
  // biome-ignore lint/correctness/useExhaustiveDependencies: once, as the list comes back
  useEffect(() => {
    if (focusOn === undefined) return
    const row = [...(list.current?.querySelectorAll<HTMLElement>('[data-reviewer]') ?? [])].find(
      (r) => r.dataset.reviewer === focusOn,
    )
    ;(row?.querySelector<HTMLElement>('.agents-row-open') ?? addButton.current)?.focus()
  }, [])
  const { activity, chats, roles } = useReviewers()
  // The panel's own tick re-renders this every 20s: enough for "14m".
  const now = Date.now()
  const seen = readSeen()
  const [error, setError] = useState<string | null>(null)
  const [removing, setRemoving] = useState<string | null>(null)
  const [clearing, setClearing] = useState(false)
  const seated = rows.filter((r) => r.seated)
  const running = seated.filter(
    (r) => r.status !== 'done' && r.status !== 'away' && r.status !== 'stopped',
  ).length
  const act = (work: Promise<unknown>) => {
    setError(null)
    work.catch((err: Error) => setError(err.message))
  }
  return (
    <div ref={list} className="rail-scroll agents-list">
      {rows.length === 0 && (
        <p className="agents-empty">
          No reviewer agents yet. One reads the change and comments on it; your agent answers.
        </p>
      )}
      {rows.map((row) => {
        const words = REVIEWER_STATUS_WORDS[row.status]
        const reply = row.seated
          ? chats?.get(row.name)?.findLast((m) => m.from === 'agent')
          : undefined
        const line = preview(row, reply)
        const unread = reply !== undefined && (seen[row.name] ?? '') < reply.at
        const dot = row.status === 'needs' || unread
        const waiting =
          row.status === 'needs'
            ? threads.find((t) => waitsOnYou(t) && openedByReviewerAgent(t) === row.name)
            : undefined
        const live = row.status !== 'done' && row.status !== 'away' && row.status !== 'stopped'
        const meta = row.seated
          ? rowMeta(activity?.get(row.name), live, threadCountsBy(threads, row.name), now)
          : null
        const text = (
          <>
            <StatusFace row={row} />
            <span className="agents-row-text">
              <span className="agents-row-name">
                <span className="agents-row-who">
                  {row.name}
                  {row.seated && <span className="agents-row-type">{typeOf(row.name)}</span>}
                </span>
                {meta && <span className="agents-row-meta">{meta}</span>}
              </span>
              <span className={`agents-row-line${dot ? ' agents-row-line-new' : ''}`}>{line}</span>
            </span>
          </>
        )
        return (
          <div
            key={`${row.seated ? '' : 'starting:'}${row.name}`}
            className={`agents-row agents-row-${row.status}`}
            {...(row.seated ? { 'data-reviewer': row.name } : {})}
          >
            {row.seated ? (
              <button
                type="button"
                className="agents-row-open"
                aria-label={`${row.name}: ${words}. ${line}${unread ? ' New reply.' : ''} Open it`}
                onClick={() => onOpen(row.name)}
              >
                {text}
              </button>
            ) : (
              <span className="agents-row-open">{text}</span>
            )}
            <span className="agents-row-end">
              {dot && (
                <span className="agents-row-mark" title={unread ? 'New reply' : words}>
                  <span className="agents-dot" />
                </span>
              )}
              {row.seated && (
                <span className="agents-acts">
                  {(row.status === 'working' || row.status === 'waiting') && (
                    <button
                      type="button"
                      className="pane-icon"
                      aria-label={`Write to ${row.name}`}
                      data-tip="Write to it"
                      onClick={() => onOpen(row.name)}
                    >
                      <Icon name="chat" size="sm" />
                    </button>
                  )}
                  {waiting && (
                    <button
                      type="button"
                      className="pane-icon"
                      aria-label={`Open the thread ${row.name} needs you in`}
                      data-tip="Open the thread"
                      onClick={() => onOpenThread(waiting.id)}
                    >
                      <Icon name="arrow" size="sm" />
                    </button>
                  )}
                  {!live && (
                    <button
                      type="button"
                      className="pane-icon"
                      aria-label={`Start a new ${typeOf(row.name)} reviewer`}
                      data-tip={`Start a new ${typeOf(row.name)} reviewer: your agent starts it`}
                      onClick={() =>
                        act(reviewerApi.request([roles?.get(row.name) ?? DEFAULT_ROLE]))
                      }
                    >
                      <Icon name="undo" size="sm" />
                    </button>
                  )}
                  {live ? (
                    <button
                      type="button"
                      className="pane-icon"
                      aria-label={`Stop ${row.name}`}
                      data-tip="Stop it: what it did stays"
                      onClick={() => act(reviewerApi.stop(row.name))}
                    >
                      <Icon name="stop" size="sm" />
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="pane-icon"
                      aria-label={`Delete ${row.name}`}
                      data-tip="Delete it from the list"
                      onClick={() => setRemoving(row.name)}
                    >
                      <Icon name="trash" size="sm" />
                    </button>
                  )}
                </span>
              )}
            </span>
          </div>
        )
      })}
      {removing !== null && (
        <DeleteConfirm
          name={removing}
          // Its row is gone: focus goes on to the next thing to do.
          onDone={() => addButton.current?.focus()}
          onClose={() => setRemoving(null)}
        />
      )}
      {error && (
        <div className="warn agents-warn">
          <Icon name="alert" size="sm" />
          <div>{error}</div>
        </div>
      )}
      <button ref={addButton} type="button" className="agents-row agents-add" onClick={onAdd}>
        <span className="agents-add-mark" aria-hidden="true">
          <Icon name="plus" size="sm" />
        </span>
        Add reviewer
      </button>
      <div className="agents-actions">
        <button type="button" className="agents-action" onClick={onManage}>
          <span className="agents-action-mark" aria-hidden="true">
            <Icon name="edit" size="sm" />
          </span>
          Edit agents
          <span className="agents-action-aside">what each one looks for</span>
        </button>
        {seated.length > 1 && (
          <button
            type="button"
            className="agents-action agents-action-danger"
            onClick={() => setClearing(true)}
          >
            <span className="agents-action-mark" aria-hidden="true">
              <Icon name="trash" size="sm" />
            </span>
            Delete all
          </button>
        )}
      </div>
      {clearing && (
        <Confirm
          title={`Delete all ${seated.length} reviewers?`}
          action="Delete all"
          onConfirm={() => reviewerApi.removeAll().then(() => addButton.current?.focus())}
          onClose={() => setClearing(false)}
        >
          They leave the list, with what each did and your conversations with them. Their review
          threads stay.
          {running > 0 &&
            ` ${running === 1 ? 'One is still running: its session ends' : `${running} are still running: their sessions end`}.`}
        </Confirm>
      )}
    </div>
  )
}

/** The steps worth showing in Activity: what a reviewer did or said, and what
 * the human wrote to it. Waits and receipts are its own business. */
const ACTIVITY_KINDS = new Set([
  'joined',
  'doing',
  'commented',
  'replied',
  'asked',
  'closed',
  'done',
  'told',
  'said',
  'stopped',
])

/** Everything every reviewer did, newest first, in plain sentences. */
function ActivityList({
  onShow,
  onOpenThread,
}: {
  onShow: (name: string) => void
  onOpenThread: (threadId: string) => void
}) {
  const { activity, hues } = useReviewers()
  const lines = [...(activity?.entries() ?? [])]
    .flatMap(([name, events]) =>
      events.filter((e) => ACTIVITY_KINDS.has(e.kind)).map((event) => ({ name, event })),
    )
    .sort((a, b) => Date.parse(b.event.at) - Date.parse(a.event.at))
  return (
    <ol
      className="rail-scroll agents-activity"
      aria-label="What the reviewer agents did, newest first"
    >
      {lines.length === 0 && <li className="agents-empty">Nothing yet.</li>}
      {lines.map(({ name, event }) => {
        const you = event.kind === 'told'
        const words = (
          <>
            <b>{you ? 'You' : name}</b>{' '}
            {you
              ? `wrote to ${name}: ${event.text}`
              : event.kind === 'said'
                ? `to you: ${event.text}`
                : event.kind === 'done'
                  ? 'finished its review'
                  : event.text}
          </>
        )
        return (
          <li key={`${name}:${event.at}:${event.kind}:${event.text}`} className="agents-line">
            {you ? (
              <span className="face face-you" aria-hidden="true">
                <Icon name="user" size="xs" />
              </span>
            ) : (
              <button
                type="button"
                className="agents-line-face"
                aria-label={`Open ${name}`}
                onClick={() => onShow(name)}
              >
                <Face hue={reviewerHue(name, hues)} />
              </button>
            )}
            {event.threadId !== undefined ? (
              <button
                type="button"
                className="agents-line-text agents-step-link"
                title="Open this thread"
                onClick={() => onOpenThread(event.threadId!)}
              >
                {words}
              </button>
            ) : (
              <span className="agents-line-text">{words}</span>
            )}
            <span className="agents-row-when">{shortAgo(event.at)}</span>
          </li>
        )
      })}
    </ol>
  )
}

/**
 * One reviewer: who it is and how it went, in a line under its name; a box to
 * write to it while it can still read; and its story, newest first, where the
 * human's messages and its answers sit at the moment they were said. The
 * conversation is the human's and this reviewer's alone: the author agent
 * never sees it.
 */
function ReviewerView({
  row,
  threads,
  takeFocus,
  onBack,
  onOpenThread,
  onRemoved,
}: {
  row: ReviewerRow
  threads: readonly ReviewThread[]
  /** Opened from inside the sidebar: focus comes along (see `go`). */
  takeFocus?: boolean
  onBack: () => void
  onOpenThread: (threadId: string) => void
  onRemoved: () => void
}) {
  const { activity, chats, coverage, roles, states } = useReviewers()
  const back = useRef<HTMLButtonElement>(null)
  const box = useRef<HTMLTextAreaElement>(null)
  const { data: roleList } = useReviewerRoles()
  const { data: changeset } = useChangeset()
  // The panel's own tick re-renders this every 20s: enough for "14m".
  const now = Date.now()
  const events = activity?.get(row.name) ?? []
  const working = row.status === 'working' || row.status === 'waiting'
  const chat = chats?.get(row.name) ?? []
  const story = reviewerStory(events, chat, threads, working)
  const roleId = roles?.get(row.name)
  const role = roleList?.roles.find((r) => r.id === roleId)?.name ?? roleId ?? 'General'
  // Only a reviewer still running reads a message: one gone, or finished,
  // would never see it.
  const state = states.get(row.name) ?? 'away'
  const here = state === 'listening' || state === 'active'
  // A finished reviewer still listens a short while after its last thread
  // closes; while it does, it can still read you.
  const canWrite = here && (row.status !== 'done' || state === 'listening')
  const [removing, setRemoving] = useState(false)
  const [startError, setStartError] = useState<string | null>(null)
  // What the list's row offers on hover, here too: the only way in on touch.
  const waiting =
    row.status === 'needs'
      ? threads.find((t) => waitsOnYou(t) && openedByReviewerAgent(t) === row.name)
      : undefined
  const gone = row.status === 'done' || row.status === 'away' || row.status === 'stopped'
  const [stopError, setStopError] = useState<string | null>(null)
  const startNew = () => {
    setStartError(null)
    reviewerApi.request([roleId ?? DEFAULT_ROLE]).catch((err: Error) => setStartError(err.message))
  }
  // Into its box when it can read you, else onto Back.
  // biome-ignore lint/correctness/useExhaustiveDependencies: once, as the view opens
  useEffect(() => {
    if (takeFocus) (box.current ?? back.current)?.focus()
  }, [])
  // Open, its replies are read: the list drops its dot.
  const lastReplyMessage = chat.findLast((m) => m.from === 'agent')
  const lastReply = lastReplyMessage?.at
  // Announced only when it lands while you are here, not on opening the view.
  const [lastReplyText, setLastReplyText] = useState<string | null>(null)
  const openedWith = useRef(lastReply)
  useEffect(() => {
    if (lastReply !== undefined && lastReply !== openedWith.current) {
      setLastReplyText(lastReplyMessage?.text ?? null)
    }
  }, [lastReply, lastReplyMessage?.text])
  useEffect(() => {
    if (lastReply) markSeen(row.name, lastReply)
  }, [row.name, lastReply])
  // The line under its name: how long, how many comments, how much it read.
  const worked = workedMs(events, !gone, now)
  const { open, closed } = threadCountsBy(threads, row.name)
  const comments = open + closed
  const read = coverageWords(
    coverage?.get(row.name),
    (changeset?.files ?? []).map((f) => f.path),
    working,
  )
  const meta = [
    ...(worked !== null ? [formatWorked(worked)] : []),
    comments === 0 ? 'no comments' : `${comments} ${comments === 1 ? 'comment' : 'comments'}`,
    ...(read ? [read.text] : []),
  ].join(' · ')
  return (
    <div className="rail-scroll agents-one">
      <div className="agents-one-head">
        <button
          ref={back}
          type="button"
          className="btn btn-ghost btn-icon agents-back"
          aria-label="All reviewer agents"
          onClick={onBack}
        >
          <Icon name="chev" size="sm" />
        </button>
        <StatusFace row={row} />
        <span className="agents-one-id">
          <span className="agents-one-name">{row.name}</span>
          <span className="agents-one-status">
            {REVIEWER_STATUS_WORDS[row.status]} · {role} reviewer
          </span>
          <span className="agents-one-meta" title={read?.title}>
            {meta}
          </span>
        </span>
        <Menu label={`Options for ${row.name}`}>
          {(close) => (
            <>
              {waiting && (
                <MenuItem
                  onClick={() => {
                    close()
                    onOpenThread(waiting.id)
                  }}
                >
                  Open the thread it needs you in
                </MenuItem>
              )}
              {gone && (
                <MenuItem
                  title="Your agent starts a new reviewer like this one"
                  onClick={() => {
                    close()
                    startNew()
                  }}
                >
                  Start a new {role} reviewer
                </MenuItem>
              )}
              {!gone && (
                <MenuItem
                  title="Its session ends; what it did and your conversation stay"
                  onClick={() => {
                    close()
                    setStopError(null)
                    reviewerApi.stop(row.name).catch((err: Error) => setStopError(err.message))
                  }}
                >
                  Stop
                </MenuItem>
              )}
              <MenuItem
                danger
                onClick={() => {
                  close()
                  setRemoving(true)
                }}
              >
                Delete
              </MenuItem>
            </>
          )}
        </Menu>
      </div>
      {canWrite && <Composer name={row.name} unread={unreadMessages(events)} inputRef={box} />}
      <Story name={row.name} items={story} onOpenThread={onOpenThread} />
      {/* Its newest answer, said aloud while the view is open: the story list
          itself is not a live region, or every step would be read out. */}
      <p className="sr-only" aria-live="polite">
        {lastReplyText ? `${row.name} replied: ${lastReplyText}` : ''}
      </p>
      {startError && (
        <div className="warn">
          <Icon name="alert" size="sm" />
          <div>
            <b>Couldn't ask your agent</b>: {startError}
          </div>
        </div>
      )}
      {stopError && (
        <div className="warn">
          <Icon name="alert" size="sm" />
          <div>
            <b>Couldn't stop it</b>: {stopError}
          </div>
        </div>
      )}
      {removing && (
        <DeleteConfirm name={row.name} onDone={onRemoved} onClose={() => setRemoving(false)} />
      )}
    </div>
  )
}

/** Deleting a reviewer asks first: its log and conversation go with it. */
function DeleteConfirm({
  name,
  onDone,
  onClose,
}: {
  name: string
  onDone: () => void
  onClose: () => void
}) {
  return (
    <Confirm
      title={`Delete ${name}?`}
      action="Delete"
      onConfirm={() => reviewerApi.remove(name).then(onDone)}
      onClose={onClose}
    >
      {name} leaves the list, with what it did and your conversation with it. Its review threads
      stay. To keep all of it, stop it instead.
    </Confirm>
  )
}

/** How a comment's thread stands, in the word its line ends with. */
const COMMENT_STATUS_WORDS: Record<CommentStatus, string> = {
  closed: 'closed',
  open: 'open',
  'needs you': 'needs you',
  gone: 'deleted',
}

/**
 * A reviewer's story, newest first: one line a step, one line a comment (its
 * place, which opens the thread, and how it stands; its first words on
 * hover), and the messages between it and the human as they were said.
 */
function Story({
  name,
  items,
  onOpenThread,
}: {
  name: string
  items: readonly StoryItem[]
  onOpenThread: (threadId: string) => void
}) {
  return (
    <ol className="story" aria-label={`What ${name} did, newest first`}>
      {items.length === 0 && <li className="agents-empty">Nothing yet.</li>}
      {items.map((item, i) => {
        const key = `${item.kind}:${item.at}:${i}`
        const when = <span className="story-when">{shortAgo(item.at)}</span>
        if (item.kind === 'message') {
          const mine = item.from === 'you'
          return (
            <li key={key} className="story-it story-msg">
              <span className={`story-mark${mine ? ' story-mark-you' : ''}`} aria-hidden="true" />
              <span className="story-text">
                <span className="story-who">{mine ? 'You' : name}</span>
                <span className={`story-bubble${mine ? ' story-bubble-you' : ''}`}>
                  {item.text}
                </span>
              </span>
              {when}
            </li>
          )
        }
        if (item.kind === 'comment') {
          return (
            <li key={key} className="story-it">
              <span className="story-mark" aria-hidden="true" />
              <span className="story-text story-line">
                Commented on{' '}
                {item.threadId !== undefined ? (
                  <button
                    type="button"
                    className="story-where"
                    title={item.first}
                    aria-label={`Open the thread on ${item.where}`}
                    onClick={() => onOpenThread(item.threadId!)}
                  >
                    {item.where}
                  </button>
                ) : (
                  <code className="story-where">{item.where}</code>
                )}
                <span className={`story-st story-st-${item.status.replace(' ', '-')}`}>
                  {COMMENT_STATUS_WORDS[item.status]}
                </span>
              </span>
              {when}
            </li>
          )
        }
        if (item.kind === 'done') {
          return (
            <li key={key} className="story-it">
              <span className="story-mark story-mark-done" aria-hidden="true" />
              <span className="story-text story-line">
                <b>Finished</b>
              </span>
              {when}
            </li>
          )
        }
        if (item.kind === 'step' && item.current) {
          return (
            <li key={key} className="story-it">
              <span className="story-mark story-mark-now" aria-hidden="true" />
              <span className="story-text story-line" title={sentence(item.text)}>
                <b>{sentence(item.text)}</b>
              </span>
              {when}
            </li>
          )
        }
        const text =
          item.kind === 'step'
            ? sentence(item.text)
            : item.kind === 'joined'
              ? 'Joined'
              : 'Stopped by you'
        return (
          <li key={key} className="story-it story-minor">
            <span className="story-mark story-mark-dot" aria-hidden="true" />
            <span className="story-text story-line" title={text}>
              {text}
            </span>
            {when}
          </li>
        )
      })}
    </ol>
  )
}

/**
 * The box on top of a reviewer's view: a message to it, which it reads at
 * its next step (a poll it is holding wakes for it). Enter sends; Shift+Enter
 * breaks the line.
 */
function Composer({
  name,
  unread,
  inputRef,
}: {
  name: string
  unread: number
  inputRef?: RefObject<HTMLTextAreaElement | null>
}) {
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const trimmed = text.trim()
  const send = () => {
    if (trimmed === '' || sending) return
    setError(null)
    setSending(true)
    reviewerApi
      .message(name, trimmed)
      .then(() => setText(''))
      .catch((err: Error) => setError(err.message))
      .finally(() => setSending(false))
  }
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      send()
    }
  }
  return (
    <div className="story-write-wrap">
      <div className="story-write">
        <textarea
          ref={inputRef}
          className="story-input"
          rows={1}
          maxLength={REVIEWER_MESSAGE_MAX}
          placeholder={`Write to ${name}…`}
          aria-label={`Write to ${name}`}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKey}
        />
        <button
          type="button"
          className="pane-icon"
          disabled={trimmed === '' || sending}
          aria-label={`Send to ${name}`}
          data-tip="Send (↵)"
          onClick={send}
        >
          <Icon name="send" size="sm" />
        </button>
      </div>
      <p className="story-hint" role="status">
        {error
          ? `Couldn't send: ${error}`
          : unread > 0
            ? `It hasn't read ${unread === 1 ? 'your last message' : `your last ${unread} messages`} yet`
            : `Only you and ${name} see this; your agent never does.`}
      </p>
    </div>
  )
}
