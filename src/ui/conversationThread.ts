import { useCallback, useEffect, useRef, useState } from 'react'

/** A conversation with the agent about one thing it writes (a preset, a
 * role), kept current from the events stream. */
export interface ConversationThreadState<T, M> {
  thread: T
  /** The reviewer's message: sent to the server, which parks it for the
   * agent's next poll. Resolves to the message, or null when refused. */
  send: (text: string) => Promise<M | null>
  /** A new conversation: the messages go, the thing stays. Resolves false
   * when the server refused or could not be reached. */
  clear: () => Promise<boolean>
}

/**
 * One conversation, read from `path` (`<path>/thread`, `<path>/messages`):
 * loaded when the key changes and whenever `subscribe` says the store moved,
 * with nothing shown from the last key meanwhile. A read that started before
 * a send answered never lands over it: every read and every send takes a
 * turn, and a read applies only while it is the latest. A null path is no
 * conversation yet.
 */
export function useConversationThread<T extends { messages: M[] }, M>(
  path: string | null,
  empty: () => T,
  subscribe: (load: () => void) => () => void,
  afterSend?: () => void,
): ConversationThreadState<T, M> {
  const [thread, setThread] = useState<T>(empty)
  const turn = useRef(0)
  // The latest of these, read when they are needed: they are made afresh
  // every render, and are no reason to reload.
  const own = useRef({ empty, subscribe, afterSend })
  own.current = { empty, subscribe, afterSend }
  useEffect(() => {
    if (path === null) return
    let cancelled = false
    setThread(own.current.empty())
    const load = () => {
      const mine = ++turn.current
      void fetchThread(path, own.current.empty()).then((next) => {
        if (!cancelled && mine === turn.current) setThread(next)
      })
    }
    load()
    const off = own.current.subscribe(load)
    return () => {
      cancelled = true
      off()
    }
  }, [path])
  const send = useCallback(
    async (text: string) => {
      if (path === null) return null
      try {
        const res = await fetch(`${path}/messages`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text }),
        })
        if (!res.ok) return null
        const body = (await res.json()) as { message: M; thread: T }
        turn.current++
        setThread(body.thread)
        own.current.afterSend?.()
        return body.message
      } catch {
        return null
      }
    },
    [path],
  )
  const clear = useCallback(async () => {
    if (path === null) return false
    try {
      const res = await fetch(`${path}/thread`, { method: 'DELETE' })
      if (!res.ok) return false
      turn.current++
      setThread(own.current.empty())
      return true
    } catch {
      return false
    }
  }, [path])
  return { thread, send, clear }
}

async function fetchThread<T>(path: string, empty: T): Promise<T> {
  try {
    const res = await fetch(`${path}/thread`)
    if (!res.ok) return empty
    const body = (await res.json()) as { thread?: T }
    return body?.thread ?? empty
  } catch {
    return empty
  }
}
