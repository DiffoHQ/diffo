import { useMemo, useState } from 'react'
import { shortAgo } from '../markdown.js'
import { bySection, SECTION_LABEL, type Section, type ThreadItem } from '../threads.js'
import { Icon } from './Icon.js'
import { formatQueuePlace } from './Threads.js'

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
  const toggle = resolved ? onReopen : onResolve
  const hot = item.turn === 'yours' || item.turn === 'unanswered'
  const anchor = item.anchor ?? 'the whole changeset'
  return (
    <div
      className={`crow${hot ? ' crow-hot' : ''}${resolved ? ' crow-done' : ''}`}
      aria-current={current ? 'true' : undefined}
      data-thread={item.thread.id}
    >
      <button
        type="button"
        className="crow-mark"
        aria-pressed={resolved}
        data-tip={resolved ? 'Reopen — moves back to its turn' : 'Resolve — moves to Settled'}
        aria-label={resolved ? 'Reopen thread' : 'Resolve thread'}
        disabled={!toggle}
        onClick={() => toggle && void toggle(item.thread.id)}
      >
        <Icon name="check" size="sm" />
      </button>
      <button
        type="button"
        className="crow-pick"
        title={`${anchor}${item.gone ? ' — this file left the changeset' : ''}`}
        onClick={() => onOpen?.(item)}
      >
        <span className="crow-q">{item.question}</span>
        <span className="crow-sub">
          <span className={`crow-where${item.gone ? ' crow-where-gone' : ''}`}>
            {shortAnchor(anchor)}
          </span>
          <span className="crow-sep">·</span>
          <span className={`crow-state crow-state-${item.turn}`}>{stateLine(item)}</span>
        </span>
      </button>
      <span className="crow-when">{shortAgo(item.updatedAt)}</span>
      {onDelete && (
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
      return 'no answer — the agent moved on'
    case 'proposed':
      return 'from the agent — reply or resolve'
    case 'agent':
      if (item.working) return 'agent is on it'
      if (item.queued !== undefined) return `queued — ${formatQueuePlace(item.queued)}`
      return 'waiting on the agent'
    case 'note':
      return 'not sent'
    case 'resolved':
      return item.answer ?? 'resolved'
  }
}

const FOLDED_BY_DEFAULT: ReadonlySet<Section> = new Set<Section>(['settled'])

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
}) {
  const [folded, setFolded] = useState<ReadonlySet<Section>>(FOLDED_BY_DEFAULT)
  const groups = useMemo(
    () => bySection([...items, ...pastItems.map((i) => ({ ...i, gone: true }))]),
    [items, pastItems],
  )

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

  if (groups.size === 0) {
    return (
      <div className="rail-empty">
        No threads yet.
        <br />
        Comment on any diff line to start one.
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
            {!shut &&
              group.map((item) => (
                <Row
                  key={item.thread.id}
                  item={item}
                  current={selectedThreadId === item.thread.id}
                  onOpen={onOpen}
                  onResolve={onResolve}
                  onReopen={onReopen}
                  onDelete={onDelete}
                />
              ))}
          </div>
        )
      })}
      {clearAll}
    </div>
  )
}
