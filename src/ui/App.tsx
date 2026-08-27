import { QueryClient, QueryClientProvider, useQueryClient } from '@tanstack/react-query'
import {
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import {
  type Coverage,
  type ReviewVerdict,
  threadsInChangeset,
  untouchedAgentVoice,
} from '../shared/review.js'
import type { Changeset, FileChange } from '../shared/types.js'
import { type Presence, type PresenceReason, reviewApi, useChangeset, useReview } from './api.js'
import { copyText } from './clipboard.js'
import { AgentBanner } from './components/AgentBanner.js'
import { ClearThreads } from './components/ClearThreads.js'
import { FinishReview } from './components/FinishReview.js'
import { Header } from './components/Header.js'
import { Icon, IconSprite } from './components/Icon.js'
import { InviteAgent } from './components/InviteAgent.js'
import { LeftPanel } from './components/LeftPanel.js'
import { Monitor } from './components/Monitor.js'
import { Nav } from './components/Nav.js'
import { ReadingPane, type ReviewComments, type ViewMode } from './components/ReadingPane.js'
import { Shortcuts } from './components/Shortcuts.js'
import { ThreadRail } from './components/ThreadRail.js'
import type { ReviewActions } from './components/Threads.js'
import { isFileViewed } from './fileMarks.js'
import { fileAnchor, glideTo } from './hooks.js'
import { actionForKey, isTypingTarget } from './keyboard.js'
import { computeDelta, EMPTY_DELTA } from './liveDelta.js'
import { useReviewFilter } from './reviewFilter.js'
import { partitionThreads, threadsByFile } from './reviewPlacement.js'
import { computeSinceLastReview } from './sinceLastReview.js'
import { useTheme } from './theme.js'
import {
  byFile,
  isUnsent,
  type PanelTab,
  type ThreadItem,
  threadItems,
  unsettledCount,
  yourTurnCount,
} from './threads.js'
import { useAgentNotifications } from './useAgentNotifications.js'
import { useViewed } from './useViewed.js'
import { loadViewed, storageKey } from './viewedStore.js'

const queryClient = new QueryClient()

const RAIL_DEFAULT = 264
const RAIL_MIN = 200
const RAIL_MAX = 520
const clampRail = (w: number) => Math.min(RAIL_MAX, Math.max(RAIL_MIN, w))

const FILE_BATCH = 12

const FILE_GAP = 16

const NO_THREADS: ReadonlySet<string> = new Set()
const NO_QUEUE: ReadonlyMap<string, number> = new Map()

/** Light up whatever a jump just landed on — a thread card halos, a file card
 *  washes its header (see `[data-found]` in styles.css). The attribute is invisible
 *  to React — it never appears in props, so a re-render can't wipe it mid-animation
 *  the way a className would. Clearing it first and reading layout restarts the
 *  animation when the same target is picked twice in a row. */
function flashLanding(node: Element): void {
  node.removeAttribute('data-found')
  void (node as HTMLElement).offsetWidth
  node.setAttribute('data-found', '')
  const done = () => node.removeAttribute('data-found')
  node.addEventListener('animationend', done, { once: true })
  // A card that never animates — reduced motion, a hidden subtree — never fires
  // animationend either, so the attribute would latch on. Clear it on the clock too.
  setTimeout(done, 2000)
}

function useLiveUpdates(): {
  presence: Presence
  reason: PresenceReason
  since: number | null
  workingOn: ReadonlySet<string>
  queuedOn: ReadonlyMap<string, number>
  answeredOn: ReadonlySet<string>
} {
  const client = useQueryClient()
  const [presence, setPresence] = useState<Presence>('waiting')
  const [reason, setReason] = useState<PresenceReason>('no-agent')
  const [since, setSince] = useState<number | null>(null)
  const [workingOn, setWorkingOn] = useState<ReadonlySet<string>>(NO_THREADS)
  const [queuedOn, setQueuedOn] = useState<ReadonlyMap<string, number>>(NO_QUEUE)
  const [answeredOn, setAnsweredOn] = useState<ReadonlySet<string>>(NO_THREADS)
  useEffect(() => {
    const source = new EventSource('/api/events')
    source.addEventListener('changeset', () => {
      void client.invalidateQueries({ queryKey: ['changeset'] })
    })
    source.addEventListener('review', () => {
      void client.invalidateQueries({ queryKey: ['review'] })
    })
    source.addEventListener('presence', (event) => {
      try {
        const detail = JSON.parse((event as MessageEvent).data) as {
          state: Presence
          reason?: PresenceReason
          since?: number
          workingOn?: string[]
          queued?: string[]
          answered?: string[]
        }
        const { state } = detail
        if (state === 'waiting' || state === 'listening' || state === 'working') {
          setPresence(state)
          if (detail.reason) setReason(detail.reason)
          setSince(typeof detail.since === 'number' ? detail.since : null)
          setWorkingOn(
            state === 'working' && Array.isArray(detail.workingOn)
              ? new Set(detail.workingOn.filter((id) => typeof id === 'string'))
              : NO_THREADS,
          )
          setQueuedOn(
            state !== 'waiting' && Array.isArray(detail.queued)
              ? new Map(
                  detail.queued.filter((id) => typeof id === 'string').map((id, i) => [id, i + 1]),
                )
              : NO_QUEUE,
          )
          setAnsweredOn(
            state !== 'waiting' && Array.isArray(detail.answered)
              ? new Set(detail.answered.filter((id) => typeof id === 'string'))
              : NO_THREADS,
          )
        }
      } catch {
        // a malformed event is no reason to lose the stream
      }
    })
    // On (re)connect, resync everything the server only pushes on change: the
    // changeset and presence streams replay on connect, `review` does not.
    source.onopen = () => {
      void client.invalidateQueries({ queryKey: ['review'] })
      void client.invalidateQueries({ queryKey: ['changeset'] })
    }
    source.onerror = () => {
      setPresence('waiting')
      setReason('disconnected')
      setSince(null)
      setWorkingOn(NO_THREADS)
      setQueuedOn(NO_QUEUE)
      setAnsweredOn(NO_THREADS)
    }
    return () => source.close()
  }, [client])
  return { presence, reason, since, workingOn, queuedOn, answeredOn }
}

function useReviewActions(): ReviewActions {
  const client = useQueryClient()
  return useMemo(() => {
    const refresh = () => client.invalidateQueries({ queryKey: ['review'] })
    return {
      create: async (anchor, text, intent) => {
        const thread = await reviewApi.createThread(anchor, text, intent)
        await refresh()
        return thread
      },
      reply: (id, text, deliver) => reviewApi.reply(id, text, deliver).then(refresh),
      send: async (id) => {
        const { prompt, delivered, presence } = await reviewApi.send(id)
        if (delivered || presence !== 'waiting') {
          await refresh()
          return { delivered: true }
        }
        const copied = await copyText(prompt)
        await refresh()
        return { delivered: false, copied, prompt }
      },
      resolve: (id) => reviewApi.setState(id, 'resolved').then(refresh),
      reopen: (id) => reviewApi.setState(id, 'open').then(refresh),
      remove: (id) => reviewApi.remove(id).then(refresh),
    }
  }, [client])
}

function Review() {
  const { data, isLoading, error } = useChangeset()
  const {
    presence,
    reason: presenceReason,
    since: presenceSince,
    workingOn,
    queuedOn,
    answeredOn,
  } = useLiveUpdates()
  const {
    viewed,
    loaded: viewedLoaded,
    toggleFile,
    markFiles,
    clearFiles,
    progress,
    fileProgress,
  } = useViewed(data)
  const [viewMode, setViewMode] = useState<ViewMode>('unified')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [focusPath, setFocusPath] = useState<string | null>(null)
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set())
  const [navHidden, setNavHidden] = useState(
    () => localStorage.getItem('diffo:ui:navHidden') === '1',
  )
  const [railWidth, setRailWidth] = useState(() => {
    const stored = Number(localStorage.getItem('diffo:ui:railWidth'))
    return stored > 0 ? clampRail(stored) : RAIL_DEFAULT
  })
  const [railDragging, setRailDragging] = useState(false)
  // The drag writes to the DOM, not React state: a setState per pointermove
  // re-rendered the rail and the whole diff every frame.
  const bodyRef = useRef<HTMLDivElement>(null)
  // The live width, readable during render, so a re-render mid-drag re-applies the
  // *current* width instead of snapping back to the stale committed `railWidth`.
  const railWidthRef = useRef(railWidth)
  railWidthRef.current = railDragging ? railWidthRef.current : railWidth
  const dragTeardown = useRef<(() => void) | null>(null)
  useEffect(() => () => dragTeardown.current?.(), [])

  const { data: review } = useReview()
  const reviewActions = useReviewActions()
  const [composeHunkId, setComposeHunkId] = useState<string | null>(null)
  const [composeFilePath, setComposeFilePath] = useState<string | null>(null)
  const [noteComposerOpen, setNoteComposerOpen] = useState(false)
  const [finishOpen, setFinishOpen] = useState(false)
  const [clearOpen, setClearOpen] = useState(false)
  const [shortcutsOpen, setShortcutsOpen] = useState(false)
  const [inviteOpen, setInviteOpen] = useState(false)
  const [theme, setTheme] = useTheme()
  const [panel, setPanel] = useState<PanelTab>('files')
  const [searchFocusTick, setSearchFocusTick] = useState(0)

  const agentAttached = presence !== 'waiting'

  const [onlyChanged, setOnlyChanged] = useState(false)
  // Reading a hunk the agent moved settles it, so the round drains as you work
  // through it rather than standing until the next Finish.
  const sinceLastReview = useMemo(
    () => computeSinceLastReview(data, review?.lastFinish, viewed),
    [data, review, viewed],
  )

  const allFiles = useMemo(() => data?.files ?? [], [data])
  const isFileDone = useCallback((file: FileChange) => isFileViewed(file, viewed), [viewed])
  const filter = useReviewFilter(allFiles, isFileDone, {
    on: onlyChanged,
    changed: sinceLastReview.changed,
    set: setOnlyChanged,
  })

  const [visibleCount, setVisibleCount] = useState(FILE_BATCH)
  const loadMoreFiles = useCallback(() => setVisibleCount((c) => c + FILE_BATCH), [])
  // A jump can target a file beyond the window — widen it, or the scroll finds no
  // node. It can also target a file the pane is *hiding*; pinning exempts that one
  // path from the filters. The window is sized from the file's index in the whole
  // changeset, which is never an underestimate of its index in the filtered list.
  const revealFile = useCallback(
    (path: string) => {
      filter.pin(path)
      const idx = allFiles.findIndex((f) => f.path === path)
      if (idx >= 0) setVisibleCount((c) => Math.max(c, idx + 1))
    },
    [allFiles, filter.pin],
  )
  const visibleFiles = useMemo(
    () => filter.files.slice(0, visibleCount),
    [filter.files, visibleCount],
  )

  const { active: activeThreads, past: pastThreads } = useMemo(
    () => threadsInChangeset(data?.files ?? [], review?.threads ?? []),
    [data, review],
  )
  const partition = useMemo(
    () => partitionThreads(data?.files ?? [], activeThreads),
    [data, activeThreads],
  )
  const items = useMemo(
    () => threadItems(activeThreads, workingOn, queuedOn),
    [activeThreads, workingOn, queuedOn],
  )
  const batch = useMemo(() => {
    const stillTo = items
      .filter((i) => i.turn === 'agent')
      .sort(
        (a, b) =>
          (a.working === true ? 0 : (a.queued ?? Number.MAX_SAFE_INTEGER)) -
          (b.working === true ? 0 : (b.queued ?? Number.MAX_SAFE_INTEGER)),
      )
    const back = items.filter((i) => answeredOn.has(i.thread.id))
    return { stillTo, back }
  }, [items, answeredOn])
  const batchForBadge = useMemo(
    () => ({
      segments: [
        ...batch.back.map(() => 'done' as const),
        ...batch.stillTo.map((i) => (i.working === true ? ('now' as const) : ('wait' as const))),
      ],
      done: batch.back.length,
    }),
    [batch],
  )
  const [monitorOpen, setMonitorOpen] = useState(false)
  useEffect(() => {
    if (monitorOpen && batch.stillTo.length === 0 && batch.back.length === 0) setMonitorOpen(false)
  }, [monitorOpen, batch])
  useEffect(() => {
    if (onlyChanged && sinceLastReview.changed.size === 0) setOnlyChanged(false)
  }, [onlyChanged, sinceLastReview])
  const pastItems = useMemo(() => threadItems(pastThreads), [pastThreads])
  const fileAttention = useMemo(() => byFile(items), [items])
  const fileThreads = useMemo(() => threadsByFile(data?.files ?? [], partition), [data, partition])
  const wantsYou = yourTurnCount(items) + yourTurnCount(pastItems)
  const liveThreads = unsettledCount(items) + unsettledCount(pastItems)
  const settledThreads = items.length + pastItems.length - liveThreads
  const [revealNotesTick, setRevealNotesTick] = useState(0)
  const [revealPastTick, setRevealPastTick] = useState(0)
  const [openThreadId, setOpenThreadId] = useState<string | null>(null)
  const comments: ReviewComments = useMemo(
    () => ({
      partition,
      past: pastThreads,
      actions: reviewActions,
      agentConnected: agentAttached,
      workingOn,
      queuedOn,
      composeHunkId,
      onComposeHandled: () => setComposeHunkId(null),
      composeFilePath,
      onComposeFileHandled: () => setComposeFilePath(null),
      changesetComposerOpen: noteComposerOpen,
      onOpenChangesetComposer: () => setNoteComposerOpen(true),
      onCloseChangesetComposer: () => setNoteComposerOpen(false),
      revealNotesTick,
      revealPastTick,
    }),
    [
      partition,
      pastThreads,
      reviewActions,
      agentAttached,
      workingOn,
      queuedOn,
      composeHunkId,
      composeFilePath,
      noteComposerOpen,
      revealNotesTick,
      revealPastTick,
    ],
  )
  const openComments = useMemo(() => {
    let n = 0
    for (const t of activeThreads) if (isUnsent(t)) n++
    return n
  }, [activeThreads])

  const [movedPaths, setMovedPaths] = useState<ReadonlySet<string>>(new Set())

  // Only the reviewer's engagement makes a file "commented" for coverage — an
  // agent note the reviewer never touched must not read as their engagement.
  const commentedPaths = useMemo(() => {
    const paths = new Set<string>()
    for (const t of activeThreads) {
      if (!untouchedAgentVoice(t) && t.anchor.kind !== 'changeset') paths.add(t.anchor.path)
    }
    return paths
  }, [activeThreads])

  const coverage: Coverage = useMemo(() => {
    const unread = (data?.files ?? []).filter((f) => !isFileViewed(f, viewed))
    const changedFiles = unread.filter((f) => movedPaths.has(f.path)).map((f) => f.path)
    const changedSet = new Set(changedFiles)
    const excluded = new Set(filter.scope.excludedPaths)
    const rest = unread.filter((f) => !changedSet.has(f.path))
    return {
      viewedHunks: progress.viewed,
      totalHunks: progress.total,
      viewedFiles: fileProgress.viewed,
      totalFiles: fileProgress.total,
      changedFiles,
      commentedUnread: rest.filter((f) => commentedPaths.has(f.path)).map((f) => f.path),
      filteredOut: rest
        .filter((f) => !commentedPaths.has(f.path) && excluded.has(f.path))
        .map((f) => f.path),
      skippedFiles: rest
        .filter((f) => !commentedPaths.has(f.path) && !excluded.has(f.path))
        .map((f) => f.path),
    }
  }, [data, progress, fileProgress, viewed, movedPaths, commentedPaths, filter.scope.excludedPaths])

  const clearThreads = useCallback(async () => {
    await reviewApi.clear()
    await queryClient.invalidateQueries({ queryKey: ['review'] })
  }, [])

  // "Keep them": the landed offer goes away, the review stays. Fire-and-forget
  // with an optimistic drop — the card must leave on the click, not on the
  // round-trip.
  const dismissLanded = useCallback(() => {
    queryClient.setQueryData(['review'], (prev: typeof review) =>
      prev ? { ...prev, landed: undefined } : prev,
    )
    void reviewApi
      .dismissLanded()
      .then(() => queryClient.invalidateQueries({ queryKey: ['review'] }))
  }, [])

  const landedNotice = useMemo(() => {
    if (!review?.landed) return undefined
    return {
      sha: review.landed.sha,
      subject: review.landed.subject,
      threads: review.threads.length,
      onClear: clearThreads,
      onDismiss: dismissLanded,
    }
  }, [review, clearThreads, dismissLanded])

  // Departed threads are owed the same as any other: an answer you haven't read is
  // unread whether or not its file is still in the diff, and the rail's badge has
  // been counting them all along. Left out, "Still on you" went quiet on exactly the
  // threads with nowhere to render.
  const checkOff = useMemo(() => {
    const owed = (i: ThreadItem) => i.turn === 'yours' || i.turn === 'unanswered'
    return [...items.filter(owed), ...pastItems.filter(owed).map((i) => ({ ...i, gone: true }))]
  }, [items, pastItems])
  const refreshFinish = useCallback(async () => {
    await queryClient.invalidateQueries({ queryKey: ['review'] })
    await queryClient.invalidateQueries({ queryKey: ['finish-preview'] })
  }, [])
  const settleThread = useCallback(
    (threadId: string) => reviewApi.setState(threadId, 'resolved').then(refreshFinish),
    [refreshFinish],
  )
  const pushBackThread = useCallback(
    (threadId: string) => reviewApi.setState(threadId, 'open').then(refreshFinish),
    [refreshFinish],
  )

  const finishReview = useCallback(
    async (deliver: boolean, closing?: { verdict: ReviewVerdict; note: string }) => {
      const payload: Coverage = {
        ...coverage,
        ...(closing && closing.verdict !== 'comment' ? { verdict: closing.verdict } : {}),
        ...(closing && closing.note.trim() !== '' ? { note: closing.note.trim() } : {}),
      }
      const { prompt, delivered, presence: at } = await reviewApi.finish(payload, deliver)
      await queryClient.invalidateQueries({ queryKey: ['review'] })
      const handedOver = delivered || at !== 'waiting'
      if (deliver && handedOver && openComments > 0) setMonitorOpen(true)
      return { prompt, delivered: handedOver }
    },
    [coverage, openComments],
  )

  // Document-level listeners: the cursor always outruns a 7px handle, and
  // element-scoped capture proved unreliable mid-drag. While the drag lasts the
  // body forbids text selection, or it paints a selection across the rail.
  const commitRailWidth = useCallback((w: number) => {
    const next = clampRail(w)
    railWidthRef.current = next
    setRailWidth(next)
    localStorage.setItem('diffo:ui:railWidth', String(next))
  }, [])

  const beginRailResize = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      if (e.button !== 0) return // left-drag only; a right-click isn't a resize
      e.preventDefault()
      const startX = e.clientX
      const startW = railWidthRef.current
      let next = startW
      const move = (ev: PointerEvent) => {
        next = clampRail(startW + ev.clientX - startX)
        railWidthRef.current = next
        bodyRef.current?.style.setProperty('--rail-w', `${next}px`)
      }
      // End on pointerup AND pointercancel, and via the unmount teardown —
      // otherwise the document listeners and the body's no-select/cursor styles
      // leak and the rail keeps tracking a cursor with no button held.
      const end = () => {
        dragTeardown.current?.()
        dragTeardown.current = null
        setRailDragging(false)
        commitRailWidth(next)
      }
      dragTeardown.current = () => {
        document.removeEventListener('pointermove', move)
        document.removeEventListener('pointerup', end)
        document.removeEventListener('pointercancel', end)
        document.body.style.userSelect = ''
        document.body.style.cursor = ''
      }
      document.addEventListener('pointermove', move)
      document.addEventListener('pointerup', end)
      document.addEventListener('pointercancel', end)
      document.body.style.userSelect = 'none'
      document.body.style.cursor = 'col-resize'
      setRailDragging(true)
    },
    [commitRailWidth],
  )

  const resetRailWidth = useCallback(() => commitRailWidth(RAIL_DEFAULT), [commitRailWidth])

  const toggleNav = useCallback(() => setNavHidden((prev) => !prev), [])
  // Persist in an effect, not inside the setState updater — updaters must be pure
  // (StrictMode double-invokes them).
  useEffect(() => {
    localStorage.setItem('diffo:ui:navHidden', navHidden ? '1' : '0')
  }, [navHidden])

  // Reviewed files arrive folded, seeded once when the marks finish loading: the
  // marks persist across sessions and `collapsed` does not, so without this every
  // already-reviewed file sprang open on load.
  const collapseSeeded = useRef(false)
  useEffect(() => {
    if (collapseSeeded.current || !viewedLoaded || !data) return
    collapseSeeded.current = true
    const done = data.files.filter((f) => isFileViewed(f, viewed)).map((f) => f.path)
    if (done.length > 0) setCollapsed((prev) => new Set([...prev, ...done]))
  }, [viewedLoaded, data, viewed])

  const toggleCollapsed = useCallback((path: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }, [])

  /**
   * Where to stand after a file you just finished leaves the pane. With Hide
   * reviewed on, ticking a file removes it and everything below slides up by its
   * height. Measured before the removal, applied in the layout effect below, so no
   * intermediate frame is painted.
   *
   *   entirely above the fold — subtract its height; nothing on screen moves.
   *   containing the fold     — land where it began, so the next file's header
   *                             arrives exactly where the finished one's was.
   *   entirely below          — nothing shifts; leave the scroll be.
   */
  const landRef = useRef<number | null>(null)
  const rememberLanding = useCallback((path: string) => {
    const pane = document.querySelector<HTMLElement>('.reading-pane')
    const node = document.getElementById(fileAnchor(path))
    if (!pane || !node) return
    const fold = pane.getBoundingClientRect().top
    const rect = node.getBoundingClientRect()
    const top = rect.top - fold + pane.scrollTop
    if (rect.bottom <= fold) {
      landRef.current = pane.scrollTop - (rect.height + FILE_GAP)
    } else if (rect.top <= fold) {
      landRef.current = top
    }
  }, [])
  useLayoutEffect(() => {
    const target = landRef.current
    if (target === null) return
    landRef.current = null
    const pane = document.querySelector<HTMLElement>('.reading-pane')
    if (pane) pane.scrollTop = Math.max(0, target)
  })

  const toggleFileViewed = useCallback(
    (path: string) => {
      const file = data?.files.find((f) => f.path === path)
      if (!file) return
      const wasComplete = isFileViewed(file, viewed)
      if (!wasComplete && filter.hideReviewed) {
        rememberLanding(path)
        filter.unpin(path)
      }
      toggleFile(path)
      setCollapsed((prev) => {
        const next = new Set(prev)
        if (wasComplete) next.delete(path)
        else next.add(path)
        return next
      })
    },
    [data, toggleFile, viewed, filter.hideReviewed, filter.unpin, rememberLanding],
  )

  const pickFile = useCallback(
    (path: string) => {
      revealFile(path)
      setCollapsed((prev) => {
        if (!prev.has(path)) return prev
        const next = new Set(prev)
        next.delete(path)
        return next
      })
      requestAnimationFrame(() => {
        const node = document.getElementById(fileAnchor(path))
        if (node) glideTo(node, flashLanding)
      })
    },
    [revealFile],
  )

  const markFilesViewed = useCallback(
    (paths: string[]) => {
      markFiles(paths)
      for (const path of paths) filter.unpin(path)
      setCollapsed((prev) => new Set([...prev, ...paths]))
    },
    [markFiles, filter.unpin],
  )

  const clearFilesViewed = useCallback(
    (paths: string[]) => {
      clearFiles(paths)
      setCollapsed((prev) => {
        const next = new Set(prev)
        for (const path of paths) next.delete(path)
        return next
      })
    },
    [clearFiles],
  )

  const nextUnreviewed = useCallback(() => {
    const file = (data?.files ?? []).find((f) => !isFileViewed(f, viewed))
    if (!file) return
    revealFile(file.path)
    setCollapsed((prev) => {
      if (!prev.has(file.path)) return prev
      const next = new Set(prev)
      next.delete(file.path)
      return next
    })
    setSelectedId(file.hunks[0]?.id ?? null)
    setFocusPath(file.hunks.length === 0 ? file.path : null)
    requestAnimationFrame(() => {
      const node = document.getElementById(fileAnchor(file.path))
      if (node) glideTo(node, flashLanding)
    })
  }, [data, viewed, revealFile])

  const openThread = useCallback(
    (item: { threadId: string; path: string | null; gone?: boolean }) => {
      setOpenThreadId(item.threadId)
      // A thread whose file left the changeset has no file body to scroll to — it
      // renders in the pane's own section for the ones the diff left behind.
      if (item.gone) {
        setRevealPastTick((t) => t + 1)
      } else if (item.path) {
        revealFile(item.path)
        setCollapsed((prev) => {
          if (!prev.has(item.path!)) return prev
          const next = new Set(prev)
          next.delete(item.path!)
          return next
        })
      } else {
        setRevealNotesTick((t) => t + 1)
      }
      // The expanded body renders whenever React commits, so one frame is a race.
      // Retry across frames until the card exists, bounded so a deleted thread
      // can't spin.
      const seek = (attempts: number) => {
        const node = document.querySelector(`[data-thread-id="${item.threadId}"]`)
        if (node) {
          // Top, not centre: the thread you picked is the thing to read, and what
          // follows it — the rest of the conversation, the diff under it — is what
          // you read next. Centring pushes half of that below the fold. The card's
          // scroll-margin-top clears the pane bar and the file header (styles.css).
          glideTo(node, flashLanding)
          return
        }
        if (attempts > 0) requestAnimationFrame(() => seek(attempts - 1))
      }
      requestAnimationFrame(() => seek(30))
    },
    [revealFile],
  )

  // A notification click knows only the thread id — recover the pane target the
  // way the rail would have: active threads scroll to their card, departed ones
  // to the past section.
  const openThreadById = useCallback(
    (threadId: string) => {
      const item = items.find((i) => i.thread.id === threadId)
      if (item) {
        openThread({ threadId, path: item.path })
        return
      }
      const past = pastItems.find((i) => i.thread.id === threadId)
      if (past) openThread({ threadId, path: past.path, gone: true })
    },
    [items, pastItems, openThread],
  )

  const banner = useAgentNotifications({
    threads: review?.threads,
    onOpenThread: openThreadById,
  })

  const prevRef = useRef<Changeset | null>(null)
  const delta = useMemo(() => {
    if (!data) return EMPTY_DELTA
    const prev = prevRef.current
    if (prev && prev.version === data.version) return EMPTY_DELTA
    return computeDelta(prev, data, loadViewed(storageKey(data)))
  }, [data])
  // Advance the "previous version" pointer AFTER commit, not inside the memo — a
  // render-phase mutation is dropped by StrictMode's double invoke and is unsafe
  // under concurrent React.
  useEffect(() => {
    if (data) prevRef.current = data
  }, [data])

  useEffect(() => {
    if (!data || delta.changedViewedHunkIds.size === 0) return
    setMovedPaths((prev) => {
      const next = new Set(prev)
      for (const file of data.files) {
        if (file.hunks.some((h) => delta.changedViewedHunkIds.has(h.id))) next.add(file.path)
      }
      return next.size === prev.size ? prev : next
    })
  }, [data, delta])

  const hunkOrder = useMemo(
    () =>
      filter.files.flatMap((file) => file.hunks.map((hunk) => ({ id: hunk.id, path: file.path }))),
    [filter.files],
  )

  // A live update can delete the selected hunk out from under us.
  useEffect(() => {
    if (selectedId && !hunkOrder.some((h) => h.id === selectedId)) setSelectedId(null)
  }, [hunkOrder, selectedId])

  const selectedPath = hunkOrder.find((h) => h.id === selectedId)?.path ?? focusPath

  const moveSelection = useCallback(
    (step: 'next-hunk' | 'prev-hunk' | 'next-file' | 'prev-file') => {
      if (hunkOrder.length === 0) return
      const index = hunkOrder.findIndex((h) => h.id === selectedId)
      let target = 0
      if (index !== -1) {
        if (step === 'next-hunk') target = Math.min(index + 1, hunkOrder.length - 1)
        else if (step === 'prev-hunk') target = Math.max(index - 1, 0)
        else if (step === 'next-file') {
          const path = hunkOrder[index]!.path
          const next = hunkOrder.findIndex((h, i) => i > index && h.path !== path)
          target = next === -1 ? index : next
        } else {
          const path = hunkOrder[index]!.path
          const prevFile = [...hunkOrder.slice(0, index)].reverse().find((h) => h.path !== path)
          target = prevFile ? hunkOrder.findIndex((h) => h.path === prevFile.path) : index
        }
      }
      const { id, path } = hunkOrder[target]!
      setSelectedId(id)
      setFocusPath(null)
      revealFile(path)
      requestAnimationFrame(() => {
        document
          .querySelector(`[data-hunk-id="${id}"]`)
          ?.scrollIntoView({ behavior: 'instant', block: 'center' })
      })
    },
    [hunkOrder, selectedId, revealFile],
  )

  // biome-ignore lint/correctness/useExhaustiveDependencies: rebinding on hunkOrder is wanted
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || isTypingTarget(e.target)) return
      const action = actionForKey(e.key, e.shiftKey)
      if (!action) return
      e.preventDefault()
      if (action === 'toggle-viewed') {
        if (selectedPath) toggleFileViewed(selectedPath)
      } else if (action === 'comment') {
        if (selectedId) setComposeHunkId(selectedId)
      } else if (action === 'toggle-view-mode') {
        setViewMode((m) => (m === 'unified' ? 'split' : 'unified'))
      } else if (action === 'toggle-nav') {
        toggleNav()
      } else if (action === 'focus-search') {
        // The box lives on the rail's Files tab — summon both, so `/` works with
        // the rail collapsed or the Threads tab up. The tick lets Nav focus its
        // own input after the same commit that reveals it; a display:none input
        // swallows focus(), so focusing from here would be a race.
        setPanel('files')
        setNavHidden(false)
        setSearchFocusTick((t) => t + 1)
      } else if (action === 'next-unreviewed') {
        nextUnreviewed()
      } else if (action === 'shortcuts') {
        setShortcutsOpen((v) => !v)
      } else if (action === 'toggle-fold') {
        if (selectedPath) toggleCollapsed(selectedPath)
      } else if (action === 'hide-reviewed') {
        filter.setHideReviewed(!filter.hideReviewed)
      } else {
        moveSelection(action)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [
    moveSelection,
    selectedId,
    selectedPath,
    toggleFileViewed,
    hunkOrder,
    toggleNav,
    nextUnreviewed,
    toggleCollapsed,
    filter.hideReviewed,
    filter.setHideReviewed,
  ])

  if (isLoading) {
    return (
      <div className="center-note">
        <div className="shimmer" />
        <div className="shimmer shimmer-short" />
        Reading the changeset…
      </div>
    )
  }
  if (error) {
    return (
      <div className="center-note center-note-error">
        <IconSprite />
        <Icon name="alert" size="lg" />
        <h2>Diffo couldn't read this changeset</h2>
        <p>{(error as Error).message}</p>
        <button type="button" className="btn btn-primary" onClick={() => location.reload()}>
          Try again
        </button>
      </div>
    )
  }
  if (!data) return null
  return (
    <div className="layout">
      <Header
        changeset={data}
        agent={{
          presence,
          since: presenceSince,
          onInvite: () => setInviteOpen(true),
          batch: batchForBadge,
          monitorOpen,
          onOpenMonitor: setMonitorOpen,
          monitorPanel: (
            <Monitor
              stillTo={batch.stillTo}
              back={batch.back}
              onOpen={(item) => {
                setMonitorOpen(false)
                openThread({ threadId: item.thread.id, path: item.path })
              }}
              onClose={() => setMonitorOpen(false)}
            />
          ),
        }}
        review={{
          openComments,
          onFinishReview: () => setFinishOpen(true),
        }}
        settings={{
          theme,
          onSetTheme: setTheme,
          onShowShortcuts: () => setShortcutsOpen(true),
        }}
      />
      <div
        ref={bodyRef}
        className={`body${navHidden ? ' nav-hidden' : ''}${railDragging ? ' rail-dragging' : ''}`}
        style={{ '--rail-w': `${railWidthRef.current}px` } as CSSProperties}
      >
        <LeftPanel
          tab={panel}
          onSetTab={setPanel}
          fileCount={data.files.length}
          wantsYou={wantsYou}
          threadCount={liveThreads}
          settledCount={settledThreads}
          files={
            <Nav
              files={data.files}
              viewed={viewed}
              selectedPath={selectedPath}
              onPickFile={pickFile}
              onToggleFileViewed={toggleFileViewed}
              onMarkFiles={markFilesViewed}
              onClearFiles={clearFilesViewed}
              onAskFile={(path) => {
                // The composer renders inside the file body, so the file must be in
                // the rendering window first.
                revealFile(path)
                setComposeFilePath(path)
              }}
              threads={fileThreads}
              attention={fileAttention}
              changed={sinceLastReview.changed}
              query={filter.query}
              onQuery={filter.setQuery}
              focusTick={searchFocusTick}
              hideReviewed={filter.hideReviewed}
              onHideReviewed={filter.setHideReviewed}
              hideTests={filter.hideTests}
              onHideTests={filter.setHideTests}
              onlyChanged={onlyChanged}
              onOnlyChanged={setOnlyChanged}
            />
          }
          threads={
            <ThreadRail
              items={items}
              pastItems={pastItems}
              selectedThreadId={openThreadId}
              totalThreads={review?.threads.length ?? 0}
              onOpen={(item) =>
                openThread({
                  threadId: item.thread.id,
                  path: item.path,
                  gone: item.gone === true,
                })
              }
              onResolve={reviewActions.resolve}
              onReopen={reviewActions.reopen}
              onDelete={reviewActions.remove}
              onClearAll={() => setClearOpen(true)}
            />
          }
        />
        {/* biome-ignore lint/a11y/useSemanticElements: a splitter is role=separator with aria-valuenow; an hr element cannot be one */}
        <div
          className="rail-resize"
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize file list"
          aria-valuemin={RAIL_MIN}
          aria-valuemax={RAIL_MAX}
          aria-valuenow={railWidth}
          tabIndex={0}
          title="Drag to resize · double-click (or Home) to reset"
          onPointerDown={beginRailResize}
          onDoubleClick={resetRailWidth}
          onKeyDown={(e) => {
            if (e.key === 'ArrowLeft') {
              e.preventDefault()
              commitRailWidth(railWidthRef.current - 16)
            } else if (e.key === 'ArrowRight') {
              e.preventDefault()
              commitRailWidth(railWidthRef.current + 16)
            } else if (e.key === 'Home' || e.key === 'Enter') {
              e.preventDefault()
              resetRailWidth()
            }
          }}
        />
        <ReadingPane
          files={visibleFiles}
          delta={delta}
          landed={landedNotice}
          sinceReview={sinceLastReview.changedHunkIds}
          hasMore={visibleCount < filter.files.length}
          onLoadMore={loadMoreFiles}
          controls={{
            navHidden,
            onToggleNav: toggleNav,
            left: fileProgress.total - fileProgress.viewed,
            total: fileProgress.total,
            query: filter.query,
            onClearQuery: () => filter.setQuery(''),
            hiddenQuery: filter.hiddenQuery,
            hideReviewed: filter.hideReviewed,
            onHideReviewed: filter.setHideReviewed,
            hideTests: filter.hideTests,
            onHideTests: filter.setHideTests,
            testCount: filter.testCount,
            onlyChanged: filter.onlyChanged,
            onOnlyChanged: filter.setOnlyChanged,
            changedCount: filter.changedCount,
            hiddenTests: filter.hiddenTests,
            hiddenReviewed: filter.hiddenReviewed,
            hiddenUnchanged: filter.hiddenUnchanged,
            pinned: filter.pinned,
            onSweep: filter.unpin,
            onShowAll: filter.showAll,
            scopeLeft: filter.scope.left,
            scopeTotal: filter.scope.total,
            excludedTests: filter.scope.excludedTests,
            excludedUnchanged: filter.scope.excludedUnchanged,
            onIncludeExcluded: () => {
              if (filter.scope.excludedTests > 0) filter.setHideTests(false)
              if (filter.scope.excludedUnchanged > 0) setOnlyChanged(false)
            },
            onFinish: () => setFinishOpen(true),
            stats: data.stats,
            unsent: openComments,
            viewMode,
            onSetViewMode: setViewMode,
            allCollapsed: collapsed.size >= data.files.length && data.files.length > 0,
            onToggleCollapseAll: () =>
              setCollapsed((prev) =>
                prev.size >= data.files.length ? new Set() : new Set(data.files.map((f) => f.path)),
              ),
            onAddNote: () => setNoteComposerOpen((v) => !v),
          }}
          viewed={viewed}
          onToggleFileViewed={toggleFileViewed}
          selectedId={selectedId}
          onSelect={setSelectedId}
          viewMode={viewMode}
          collapsed={collapsed}
          onToggleCollapsed={toggleCollapsed}
          comments={comments}
        />
      </div>
      {finishOpen && (
        <FinishReview
          coverage={coverage}
          presence={presence}
          checkOff={checkOff}
          onResolve={settleThread}
          onReopen={pushBackThread}
          onFinish={finishReview}
          onInvite={() => {
            setFinishOpen(false)
            setInviteOpen(true)
          }}
          onClose={() => setFinishOpen(false)}
        />
      )}
      {clearOpen && (
        <ClearThreads
          total={review?.threads.length ?? 0}
          past={pastThreads.length}
          onClear={clearThreads}
          onClose={() => setClearOpen(false)}
        />
      )}
      <AgentBanner
        notices={banner.notices}
        onOpen={banner.open}
        onClear={banner.clear}
        onOpenMonitor={() => setMonitorOpen(true)}
      />
      {shortcutsOpen && <Shortcuts onClose={() => setShortcutsOpen(false)} />}
      {inviteOpen && (
        <InviteAgent
          presence={presence}
          reason={presenceReason}
          onClose={() => setInviteOpen(false)}
        />
      )}
    </div>
  )
}

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <IconSprite />
      <Review />
    </QueryClientProvider>
  )
}
