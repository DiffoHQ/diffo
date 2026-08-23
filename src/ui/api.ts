import { useQuery } from '@tanstack/react-query'
import type {
  Anchor,
  Coverage,
  OutgoingThread,
  ReviewState,
  ReviewThread,
  ThreadIntent,
} from '../shared/review.js'
import type { Changeset } from '../shared/types.js'

export type Presence = 'waiting' | 'listening' | 'working'

export type PresenceReason =
  | 'no-agent'
  | 'polling'
  | 'delivered'
  | 'stalled'
  | 'replied'
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
  install: { global: string; project: string }
  join: string
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

export interface FinishPreview {
  outgoing: OutgoingThread[]
  prompt: string
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
  createThread: (anchor: Anchor, text: string, intent?: ThreadIntent) =>
    post<ReviewThread>('/api/review/threads', { anchor, text, intent }),
  reply: (threadId: string, text: string, deliver = true) =>
    post<{ thread: ReviewThread } & DeliveryResult>(`/api/review/threads/${threadId}/messages`, {
      text,
      deliver,
    }),
  setState: (threadId: string, state: 'open' | 'resolved') =>
    post<ReviewThread>(`/api/review/threads/${threadId}/state`, { state }),
  send: (threadId: string) =>
    post<{ thread: ReviewThread; prompt: string } & DeliveryResult>(
      `/api/review/threads/${threadId}/send`,
    ),
  finish: (coverage: Coverage, deliver: boolean) =>
    post<{ threads: ReviewThread[]; prompt: string } & DeliveryResult>('/api/review/finish', {
      coverage,
      deliver,
    }),
  remove: (threadId: string) => del<{ removed: boolean }>(`/api/review/threads/${threadId}`),
  clear: () => del<{ removed: number }>('/api/review/threads'),
  dismissLanded: () => del<{ ok: boolean }>('/api/review/landed'),
}
