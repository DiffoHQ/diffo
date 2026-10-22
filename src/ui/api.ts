import { useQueries, useQuery } from '@tanstack/react-query'
import { useMemo, useRef } from 'react'
import type { ReviewEvent } from '../forge/types.js'
import type {
  Anchor,
  Audience,
  Coverage,
  OutgoingThread,
  ReviewState,
  ReviewThread,
  ThreadIntent,
} from '../shared/review.js'
import {
  type Changeset,
  type CommitChangeset,
  type CommitsResponse,
  type FileChange,
  UNCOMMITTED,
} from '../shared/types.js'

export type { ReviewEvent }

export type Presence = 'waiting' | 'listening' | 'working'

/** The reviewer's layers request, as the presence stream reports it: parked
 * for the next poll, in the agent's hands, or none. Mirrors the server's type. */
export type LayersRequest = 'queued' | 'outlining' | null

/** The reviewer's before/after request, the same way. Mirrors the server's type. */
export type BeforeAfterRequest = 'queued' | 'writing' | null

export type PresenceReason =
  | 'no-agent'
  | 'arriving'
  | 'polling'
  | 'delivered'
  | 'stalled'
  | 'replied'
  | 'repolling'
  | 'ended'
  | 'disconnected'

export function useChangeset() {
  return useQuery<Changeset>({
    queryKey: ['changeset'],
    queryFn: async () => {
      const res = await fetch('/api/changeset')
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null
        throw new Error(body?.error ?? `server error (${res.status})`)
      }
      return res.json() as Promise<Changeset>
    },
  })
}

/** The changeset's commits. Keyed on the changeset version, so a new commit,
 * an amend or a rebase re-lists them on the same live tick that redraws the diff. */
export function useCommits(version: number | undefined, enabled: boolean) {
  return useQuery<CommitsResponse>({
    queryKey: ['commits', version],
    enabled: enabled && version !== undefined,
    placeholderData: (prev) => prev,
    queryFn: async () => handle<CommitsResponse>(await fetch('/api/commits')),
  })
}

/**
 * Every listed commit's own diff, by sha — the rail's marks and progress need
 * each commit's files, not just the open one's. A sha names immutable content,
 * so it is fetched once; only the uncommitted entry follows the live version.
 */
export function useCommitDiffs(
  shas: readonly string[],
  version: number | undefined,
): ReadonlyMap<string, FileChange[]> {
  const results = useQueries({
    queries: shas.map((sha) => ({
      queryKey: ['commit', sha, sha === UNCOMMITTED ? version : null],
      staleTime: sha === UNCOMMITTED ? 0 : Number.POSITIVE_INFINITY,
      placeholderData: (prev: CommitChangeset | undefined) => prev,
      queryFn: async () =>
        handle<CommitChangeset>(await fetch(`/api/commits/${encodeURIComponent(sha)}`)),
    })),
  })
  // `useQueries` hands back a fresh array every render; the map is rebuilt
  // only when some commit's data actually landed.
  const stamp = results.map((r) => `${r.data?.sha ?? ''}@${r.dataUpdatedAt}`).join(' ')
  const resultsRef = useRef(results)
  resultsRef.current = results
  // biome-ignore lint/correctness/useExhaustiveDependencies: the stamp is the change signal
  return useMemo(() => {
    const map = new Map<string, FileChange[]>()
    for (const r of resultsRef.current) if (r.data) map.set(r.data.sha, r.data.files)
    return map
  }, [stamp])
}

export function useReview() {
  return useQuery<ReviewState>({
    queryKey: ['review'],
    queryFn: async () => {
      const res = await fetch('/api/review')
      if (!res.ok) throw new Error(`review unavailable (${res.status})`)
      return res.json() as Promise<ReviewState>
    },
  })
}

async function handle<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const err = (await res.json().catch(() => null)) as { error?: string } | null
    throw new Error(err?.error ?? `server error (${res.status})`)
  }
  return res.json() as Promise<T>
}

async function post<T>(path: string, body?: unknown): Promise<T> {
  return handle<T>(
    await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  )
}

async function patch<T>(path: string, body: unknown): Promise<T> {
  return handle<T>(
    await fetch(path, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  )
}

async function del<T>(path: string): Promise<T> {
  return handle<T>(await fetch(path, { method: 'DELETE' }))
}

/** `delivered` = a live poll took it right now; `presence` = the agent's state when
 * the request landed. `presence === 'waiting'` is the copy-as-prompt fallback
 * signal. */
export interface DeliveryResult {
  delivered: boolean
  presence: Presence
}

export interface Invite {
  ask: string
}

export function useInvite(enabled: boolean) {
  return useQuery<Invite>({
    queryKey: ['invite'],
    enabled,
    queryFn: async () => {
      const res = await fetch('/api/agent/invite')
      if (!res.ok) throw new Error(`invite unavailable (${res.status})`)
      return res.json() as Promise<Invite>
    },
  })
}

/** What Finish will post to GitHub, in words — present only on a pull request. */
export interface PublicPreview {
  drafts: {
    id: string
    anchor: string
    text: string
    downgraded: boolean
    conversation: boolean
    /** The agent wrote the first version of this draft. */
    fromAgent?: { edited: boolean }
  }[]
  replies: { id: string; anchor: string; count: number; text: string }[]
  resolves: { id: string; anchor: string; resolve: boolean }[]
  /** Suggested comments from the agent the reviewer has not decided on. They
   * stay private; the dialog says so. */
  undecidedSuggestions?: number
  canApprove: boolean
  pendingReview: boolean
}

export interface FinishPreview {
  outgoing: OutgoingThread[]
  prompt: string
  public?: PublicPreview
}

/** How the GitHub leg went: what posted, and where it stopped if it did. */
export interface PublicOutcome {
  posted: number
  resolved: number
  submitted: boolean
  reviewId: string | null
  url?: string
  failed?: { step: string; message: string }
}

export interface CreateThreadOptions {
  audience?: Audience
  parentId?: string
  /** A public draft made from the agent's suggestion: the private thread and
   * message it came from. The server stamps the suggestion as added. */
  origin?: { threadId: string; messageId: string }
  /** The commit whose diff the comment was made on, when reading by commit:
   * its hunk may exist only there, and the server snapshots the code from it. */
  commit?: string
}

export function useFinishPreview(enabled: boolean, coverage: Coverage) {
  return useQuery<FinishPreview>({
    queryKey: ['finish-preview', coverage],
    enabled,
    staleTime: 0,
    gcTime: 0,
    queryFn: () => post<FinishPreview>('/api/review/finish/preview', { coverage }),
  })
}

export const reviewApi = {
  createThread: (
    anchor: Anchor,
    text: string,
    intent?: ThreadIntent,
    options?: CreateThreadOptions,
  ) => post<ReviewThread>('/api/review/threads', { anchor, text, intent, ...options }),
  reply: (threadId: string, text: string, deliver = true) =>
    post<{ thread: ReviewThread } & DeliveryResult>(`/api/review/threads/${threadId}/messages`, {
      text,
      deliver,
    }),
  /** Rewrite one of the reviewer's messages. The server decides whether that is
   * a fix in place or a rewind that cuts what came after it. */
  editMessage: (threadId: string, messageId: string, text: string, deliver = true) =>
    patch<{ thread: ReviewThread } & DeliveryResult>(
      `/api/review/threads/${threadId}/messages/${messageId}`,
      { text, deliver },
    ),
  setState: (threadId: string, state: 'open' | 'resolved') =>
    post<ReviewThread>(`/api/review/threads/${threadId}/state`, { state }),
  /** Pass on a suggested PR comment, or take that back; the thread stays open. */
  dismissPrComment: (threadId: string, messageId: string) =>
    post<ReviewThread>(`/api/review/threads/${threadId}/messages/${messageId}/pr-comment`, {
      outcome: 'dismissed',
    }),
  restorePrComment: (threadId: string, messageId: string) =>
    post<ReviewThread>(`/api/review/threads/${threadId}/messages/${messageId}/pr-comment`, {
      outcome: 'restored',
    }),
  send: (threadId: string) =>
    post<{ thread: ReviewThread; prompt: string } & DeliveryResult>(
      `/api/review/threads/${threadId}/send`,
    ),
  finish: (coverage: Coverage, deliver: boolean, event?: ReviewEvent) =>
    post<{ threads: ReviewThread[]; prompt: string; public?: PublicOutcome } & DeliveryResult>(
      '/api/review/finish',
      { coverage, deliver, ...(event ? { event } : {}) },
    ),
  remove: (threadId: string) => del<{ removed: boolean }>(`/api/review/threads/${threadId}`),
  clear: () => del<{ removed: number }>('/api/review/threads'),
  /** Outline, or refresh: the click rides to the agent's next poll. */
  requestLayers: () => post<{ ok: boolean }>('/api/review/layers/request'),
  /** The reviewer's behaviour-change toggle. On with no before/after, it asks the agent
   * for one at its next poll. */
  setBeforeAfter: (on: boolean) => post<{ ok: boolean }>('/api/review/before-after/toggle', { on }),
  dismissLanded: () => del<{ ok: boolean }>('/api/review/landed'),
}
