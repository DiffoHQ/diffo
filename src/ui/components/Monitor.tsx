import { useEffect, useState } from 'react'
import type { ThreadItem } from '../threads.js'
import { formatAgentDuration, formatQueuePlace } from './Threads.js'

export function Monitor({
  stillTo,
  back,
  onOpen,
  onClose,
}: {
  stillTo: ThreadItem[]
  back: ThreadItem[]
  onOpen: (item: ThreadItem) => void
  onClose: () => void
}) {
  const working = stillTo.filter((i) => i.working === true).length
  const waiting = stillTo.length - working
  const settled = stillTo.length === 0 && back.length > 0

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
      }
    }
    document.addEventListener('keydown', onKey, true)
    return () => document.removeEventListener('keydown', onKey, true)
  }, [onClose])

  const counts = [
    back.length > 0 ? `${back.length} answered` : null,
    working > 0 ? `${working} in progress` : null,
    waiting > 0 ? `${waiting} waiting` : null,
  ].filter(Boolean)

  return (
    <div className="monitor" role="dialog" aria-label="Comments with your agent">
      <div className="monitor-inner">
        <QueueBar stillTo={stillTo} back={back} />
        {counts.length > 0 && (
          <div className={`monitor-counts${settled ? ' monitor-counts-done' : ''}`}>
            {settled ? `all ${back.length} answered` : counts.join(' · ')}
          </div>
        )}

        {stillTo.length > 0 && (
          <>
            <div className="monitor-group">Still to answer · {stillTo.length}</div>
            <ul className="monitor-rows">
              {stillTo.map((item) => (
                <MonitorRow key={item.thread.id} item={item} onOpen={onOpen} />
              ))}
            </ul>
          </>
        )}

        {back.length > 0 && (
          <>
            <div className="monitor-group">Answered · {back.length}</div>
            <ul className="monitor-rows monitor-rows-done">
              {back.map((item) => (
                <MonitorRow key={item.thread.id} item={item} onOpen={onOpen} />
              ))}
            </ul>
          </>
        )}
      </div>
    </div>
  )
}

function QueueBar({ stillTo, back }: { stillTo: ThreadItem[]; back: ThreadItem[] }) {
  return (
    <div className="monitor-qbar" aria-hidden>
      {back.map((i) => (
        <i key={i.thread.id} className="q-done" />
      ))}
      {stillTo.map((i) => (
        <i key={i.thread.id} className={i.working ? 'q-now' : 'q-wait'} />
      ))}
    </div>
  )
}

function statusLabel(item: ThreadItem): { label: string; kind: string } {
  if (item.working) return { label: 'working on it', kind: 'now' }
  if (item.queued !== undefined) return { label: formatQueuePlace(item.queued), kind: 'wait' }
  if (item.turn === 'agent') return { label: 'sent', kind: 'wait' }
  if (item.turn === 'resolved') return { label: 'settled', kind: 'done' }
  switch (item.outcome) {
    case 'fixed':
      return { label: 'fixed', kind: 'done' }
    case 'answered':
      return { label: 'answered', kind: 'done' }
    case 'changed':
      return { label: 'changed, no reply', kind: 'silent' }
    case 'no-answer':
      return { label: 'no answer', kind: 'silent' }
    default:
      return { label: 'back', kind: 'done' }
  }
}

function MonitorRow({ item, onOpen }: { item: ThreadItem; onOpen: (item: ThreadItem) => void }) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (item.working !== true) return
    const timer = setInterval(() => setNow(Date.now()), 10_000)
    return () => clearInterval(timer)
  }, [item.working])
  const { label, kind } = statusLabel(item)
  const elapsed = item.working === true ? Math.max(0, now - Date.parse(item.updatedAt)) : undefined
  return (
    <li>
      <button type="button" className="monitor-row" onClick={() => onOpen(item)}>
        <span className="monitor-row-top">
          <span className={`monitor-st monitor-st-${kind}`}>
            {item.working === true && <span className="monitor-pulse" />}
            {label}
          </span>
          {elapsed !== undefined && (
            <span className="monitor-took">{formatAgentDuration(elapsed)}…</span>
          )}
          {item.durationMs !== undefined && !item.working && (
            <span className="monitor-took">{formatAgentDuration(item.durationMs)}</span>
          )}
        </span>
        <span className="monitor-q">
          <span className="monitor-anchor">{item.anchor ?? 'the whole changeset'}</span>
          {item.question}
        </span>
        {item.answer !== null && <span className="monitor-a">↳ {item.answer}</span>}
      </button>
    </li>
  )
}
