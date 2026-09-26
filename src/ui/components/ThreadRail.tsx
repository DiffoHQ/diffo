import { type ReactElement, useMemo, useState } from 'react'
import { isDraft, isPublic, type ReviewThread, unpostedReplies } from '../../shared/review.js'
import { shortAgo } from '../markdown.js'
import { usePr } from '../prMode.js'
import {
  bySection,
  bySide,
  involves,
  SECTION_LABEL,
  type Section,
  type Side,
  type ThreadItem,
} from '../threads.js'
import { Icon } from './Icon.js'
import { formatQueuePlace, INTENT_WORD } from './Threads.js'

/** `src/server/db.ts:295` → `db.ts:295`. The leading directories are the part every
 * row shares; the full path stays on the row's tooltip, which is also what a screen
 * reader gets. */
function shortAnchor(anchor: string): string {
  const slash = anchor.lastIndexOf('/')
  return slash === -1 ? anchor : anchor.slice(slash + 1)
}

function Row({
  item,
  current,
  onOpen,
  onResolve,
  onReopen,
  onDelete,
}: {
  item: ThreadItem
  current: boolean
  onOpen?: (item: ThreadItem) => void
  onResolve?: (threadId: string) => Promise<unknown>
  onReopen?: (threadId: string) => Promise<unknown>
  onDelete?: (threadId: string) => Promise<unknown>
}) {
  const resolved = item.turn === 'resolved'
  // A public draft has nothing to resolve: resolving it would only drop it from
  // the submit while the row went on reading as settled on GitHub. Its one way
  // out is the card's — discard — so the mark does that, or nothing.
  const draft = isDraft(item.thread)
  const toggle = resolved ? onReopen : onResolve
  const hot = item.turn === 'yours' || item.turn === 'unanswered'
  const anchor = item.anchor ?? 'the whole changeset'
  const where = item.outdated
    ? ', outdated on GitHub: the line left the diff'
    : item.gone
      ? ', this file left the changeset'
      : ''
  return (
    <div
      className={`crow${hot ? ' crow-hot' : ''}${resolved ? ' crow-done' : ''}`}
      aria-current={current ? 'true' : undefined}
      data-thread={item.thread.id}
    >
      {draft ? (
        <button
          type="button"
          className="crow-mark"
          data-tip="Discard draft: drops it; nothing was posted"
          aria-label="Discard draft"
          disabled={!onDelete}
          onClick={() => onDelete && void onDelete(item.thread.id)}
        >
          <Icon name="trash" size="sm" />
        </button>
      ) : (
        <button
          type="button"
          className="crow-mark"
          aria-pressed={resolved}
          data-tip={resolved ? 'Reopen: moves back to its turn' : 'Resolve: moves to Settled'}
          aria-label={resolved ? 'Reopen thread' : 'Resolve thread'}
          disabled={!toggle}
          onClick={() => toggle && void toggle(item.thread.id)}
        >
          <Icon name="check" size="sm" />
        </button>
      )}
      <button
        type="button"
        className="crow-pick"
        title={`${anchor}${where}`}
        onClick={() => onOpen?.(item)}
      >
        <span className="crow-q">{item.question}</span>
        <span className="crow-sub">
          {item.turn === 'note' && isPublic(item.thread) && (
            <span className="crow-pill">Draft</span>
          )}
          {item.thread.intent && item.turn !== 'proposed' && (
            <>
              <span className={`crow-kind crow-kind-${item.thread.intent}`}>
                {INTENT_WORD[item.thread.intent]}
              </span>
              <span className="crow-sep">·</span>
            </>
          )}
          <span className={`crow-where${item.gone ? ' crow-where-gone' : ''}`}>
            {shortAnchor(anchor)}
          </span>
          {isPublic(item.thread) ? (
            publicLine(item) && (
              <>
                <span className="crow-sep">·</span>
                <span className="crow-state">{publicLine(item)}</span>
              </>
            )
          ) : (
            <>
              <span className="crow-sep">·</span>
              <span className={`crow-state crow-state-${item.turn}`}>{stateLine(item)}</span>
            </>
          )}
        </span>
      </button>
      <span className="crow-when">{shortAgo(item.updatedAt)}</span>
      {onDelete && !draft && (
        <button
          type="button"
          className="row-act row-act-danger crow-del"
          data-tip="Delete thread"
          aria-label="Delete thread"
          onClick={() => void onDelete(item.thread.id)}
        >
          <Icon name="trash" size="sm" />
        </button>
      )}
    </div>
  )
}

function stateLine(item: ThreadItem): string {
  switch (item.turn) {
    case 'yours':
      // A silent code edit is an answer too, and "answered" over a thread with no
      // reply in it reads as a missing message, not a fix.
      if (item.outcome === 'changed') return 'changed the code, no reply'
      return item.answer ?? 'answered'
    case 'unanswered':
      return 'no answer, the agent moved on'
    case 'proposed':
      return 'from the agent: reply or resolve'
    case 'agent':
      if (item.working) return 'agent is on it'
      if (item.queued !== undefined) return `queued, ${formatQueuePlace(item.queued)}`
      return 'waiting on the agent'
    case 'note':
      return 'draft, not sent'
    case 'posted':
      return item.answer ?? 'on GitHub'
    case 'resolved':
      return item.answer ?? 'resolved'
  }
}

/** A public row's second line, after the anchor: a draft says nothing more
 * (the pill already does), a posted thread names its last GitHub voice, and a
 * reply, resolve or reopen of yours that GitHub has not seen says it is waiting
 * for the submit. */
function publicLine(item: ThreadItem): string | null {
  const t = item.thread
  if (item.turn === 'note') return null
  if (unpostedReplies(t).length > 0) return 'reply pending'
  if (t.queued?.resolve) return 'resolves when you submit'
  if (t.queued?.unresolve) return 'reopens when you submit'
  const login = lastGithubLogin(t)
  if (item.turn === 'resolved') return login ? `${login} · resolved` : 'resolved'
  return login ?? 'on GitHub'
}

function lastGithubLogin(thread: ReviewThread): string | null {
  for (let i = thread.messages.length - 1; i >= 0; i--) {
    const m = thread.messages[i]!
    if (m.author === 'github' && m.github) return m.github.user.login
  }
  return null
}

const FOLDED_BY_DEFAULT: ReadonlySet<Section> = new Set<Section>(['settled'])

/** A side's fold: following the selection, or held open or shut by a click. */
type Fold = 'auto' | 'open' | 'closed'

/* ---------- the rail on a pull request: two sides, not six turns ---------- */

const SIDE: Record<Side, { icon: 'globe' | 'lock'; label: string; empty: string }> = {
  github: { icon: 'globe', label: 'GitHub', empty: 'No PR comments yet' },
  agent: { icon: 'lock', label: 'Private', empty: 'Nothing asked of the agent yet' },
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

/** The one number a side's header carries: what is pending for GitHub, what
 * is on you for the agent. Null when nothing is. */
function sideBadge(
  side: Side,
  group: readonly ThreadItem[],
): { text: string; hot: boolean } | null {
  const count = (pred: (i: ThreadItem) => boolean) => group.filter(pred).length
  if (side === 'github') {
    const drafts = count((i) => i.turn === 'note')
    return drafts > 0 ? { text: plural(drafts, 'draft'), hot: false } : null
  }
  const yours = count((i) => i.turn === 'yours' || i.turn === 'unanswered')
  if (yours > 0) return { text: `${yours} your turn`, hot: true }
  const proposed = count((i) => i.turn === 'proposed')
  if (proposed > 0) return { text: `${proposed} from the agent`, hot: false }
  const waiting = count((i) => i.turn === 'agent')
  if (waiting > 0) return { text: `${waiting} waiting`, hot: false }
  return null
}

function SideGroup({
  side,
  group,
  selectedThreadId,
  row,
}: {
  side: Side
  group: ThreadItem[]
  selectedThreadId?: string | null
  row: (item: ThreadItem) => ReactElement
}) {
  const [shut, setShut] = useState(false)
  // Each fold is auto until clicked: auto follows the selection into the fold,
  // a click wins over that. A fresh selection inside a fold shut by hand reopens
  // it, though — the thread picked has to be on screen.
  const [more, setMore] = useState<Fold>('auto')
  const [settledOpen, setSettledOpen] = useState<Fold>('auto')
  const [seenSelected, setSeenSelected] = useState(selectedThreadId)
  const login = usePr()?.viewer.login ?? null
  const meta = SIDE[side]
  const badge = sideBadge(side, group)

  const active = group.filter((i) => i.turn !== 'resolved')
  const settled = group.filter((i) => i.turn === 'resolved')
  // On GitHub, yours first and the rest folded; a private thread is always yours.
  const mine = side === 'github' ? active.filter((i) => involves(i.thread, login)) : active
  const others = active.filter((i) => !mine.includes(i))
  const isOpen = (i: ThreadItem) => i.thread.id === selectedThreadId
  if (seenSelected !== selectedThreadId) {
    setSeenSelected(selectedThreadId)
    if (more === 'closed' && others.some(isOpen)) setMore('auto')
    if (settledOpen === 'closed' && settled.some(isOpen)) setSettledOpen('auto')
  }
  const unfolded = (fold: Fold, inside: boolean) => fold === 'open' || (fold === 'auto' && inside)
  const showOthers = unfolded(more, others.some(isOpen))
  const shown = showOthers ? [...mine, ...others] : mine
  const showSettled = unfolded(settledOpen, settled.some(isOpen))

  return (
    <section className={`side side-${side}`} aria-label={`${meta.label} threads`}>
      <button
        type="button"
        className="side-head"
        aria-expanded={!shut}
        onClick={() => setShut(!shut)}
      >
        <span className={`chevron${shut ? ' chevron-shut' : ''}`}>
          <Icon name="chev" size="sm" />
        </span>
        <Icon name={meta.icon} size="sm" />
        <span className="side-name">{meta.label}</span>{' '}
        <span className="side-n">{group.length}</span>
        {badge && (
          <>
            {' '}
            <span className={`side-badge${badge.hot ? ' side-badge-hot' : ''}`}>{badge.text}</span>
          </>
        )}
      </button>
      {!shut && group.length === 0 && <div className="side-empty">{meta.empty}</div>}
      {!shut && shown.map(row)}
      {!shut && (others.length > 0 || settled.length > 0) && (
        <div className="side-tail">
          {others.length > 0 && (
            <button
              type="button"
              className="side-more"
              aria-expanded={showOthers}
              title={
                showOthers
                  ? 'back to the threads you are part of'
                  : 'threads on this pull request you are not part of, bots included'
              }
              onClick={() => setMore(showOthers ? 'closed' : 'open')}
            >
              {showOthers ? 'Only mine' : `${others.length} from others`}
            </button>
          )}
          {settled.length > 0 && (
            <button
              type="button"
              className="side-more"
              aria-expanded={showSettled}
              onClick={() => setSettledOpen(showSettled ? 'closed' : 'open')}
            >
              {settled.length} {side === 'github' ? 'resolved' : 'settled'}
            </button>
          )}
        </div>
      )}
      {!shut && showSettled && settled.map(row)}
    </section>
  )
}

export function ThreadRail({
  items,
  pastItems = [],
  selectedThreadId,
  totalThreads,
  onOpen,
  onResolve,
  onReopen,
  onDelete,
  onClearAll,
  pr = false,
}: {
  items: ThreadItem[]
  pastItems?: ThreadItem[]
  selectedThreadId?: string | null
  totalThreads?: number
  onOpen?: (item: ThreadItem) => void
  onResolve?: (threadId: string) => Promise<unknown>
  onReopen?: (threadId: string) => Promise<unknown>
  onDelete?: (threadId: string) => Promise<unknown>
  onClearAll?: () => void
  /** On a pull request the rail has two groups, GitHub and Private, instead of
   * the turn sections: the side is the thing a row must never leave in doubt. */
  pr?: boolean
}) {
  const [folded, setFolded] = useState<ReadonlySet<Section>>(FOLDED_BY_DEFAULT)
  const all = useMemo(
    () => [...items, ...pastItems.map((i) => ({ ...i, gone: true }))],
    [items, pastItems],
  )
  const groups = useMemo(() => bySection(all), [all])
  const sides = useMemo(() => (pr ? bySide(all) : null), [pr, all])

  const batchFor = (section: Section, group: ThreadItem[]) => {
    if (section === 'yours' && onResolve)
      return {
        icon: 'check' as const,
        danger: false,
        label: `Resolve all ${group.length}`,
        run: () => group.forEach((i) => void onResolve(i.thread.id)),
      }
    if (section === 'settled' && onDelete)
      return {
        icon: 'trash' as const,
        danger: true,
        label: `Delete all ${group.length} settled`,
        run: () => group.forEach((i) => void onDelete(i.thread.id)),
      }
    return null
  }

  const clearAll = onClearAll && (
    <button type="button" className="clist-clear" onClick={onClearAll}>
      Clear all threads{totalThreads !== undefined && totalThreads > 0 ? ` (${totalThreads})` : ''}…
    </button>
  )

  const row = (item: ThreadItem) => (
    <Row
      key={item.thread.id}
      item={item}
      current={selectedThreadId === item.thread.id}
      onOpen={onOpen}
      onResolve={onResolve}
      onReopen={onReopen}
      onDelete={onDelete}
    />
  )

  if (sides) {
    return (
      <div className="clist clist-pr">
        {(['github', 'agent'] as const).map((side) => (
          <SideGroup
            key={side}
            side={side}
            group={sides[side]}
            selectedThreadId={selectedThreadId}
            row={row}
          />
        ))}
        {all.length > 0 && clearAll}
      </div>
    )
  }

  if (groups.size === 0) {
    return (
      <div className="clist">
        <div className="rail-empty">
          No threads yet.
          <br />
          Comment on any diff line to start one.
        </div>
      </div>
    )
  }

  const quiet = groups.size === 1 && groups.has('settled')

  return (
    <div className="clist">
      {quiet && (
        <div className="clist-quiet">
          Nothing needs you.
          <br />
          <span className="clist-quiet-n">{groups.get('settled')!.length} settled.</span>
        </div>
      )}
      {[...groups].map(([section, group]) => {
        const shut = folded.has(section)
        const batch = batchFor(section, group)
        return (
          <div key={section}>
            <div className={`sec-row${batch ? ' sec-row-hasact' : ''}`}>
              <button
                type="button"
                className={`sec-head sec-head-fold${section === 'yours' ? ' sec-head-hot' : ''}`}
                aria-expanded={!shut}
                onClick={() =>
                  setFolded((prev) => {
                    const next = new Set(prev)
                    if (next.has(section)) next.delete(section)
                    else next.add(section)
                    return next
                  })
                }
              >
                <span className={`chevron${shut ? ' chevron-shut' : ''}`}>
                  <Icon name="chev" size="sm" />
                </span>
                {SECTION_LABEL[section]} <span className="sec-n">{group.length}</span>
              </button>
              {batch && (
                <button
                  type="button"
                  className={`row-act sec-act${batch.danger ? ' row-act-danger' : ''}`}
                  data-tip={batch.label}
                  aria-label={batch.label}
                  onClick={batch.run}
                >
                  <Icon name={batch.icon} size="sm" />
                </button>
              )}
            </div>
            {!shut && group.map(row)}
          </div>
        )
      })}
      {clearAll}
    </div>
  )
}
