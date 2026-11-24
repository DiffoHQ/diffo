/**
 * The conversations the human has with the author agent about something it
 * writes for them (a layers preset, a reviewer role): one shape, one lenient
 * reader. Each kind says which keys and fields are its own.
 */

/** One message in such a conversation, and the edit it carried, if any. */
export interface ConversationMessage<F extends string, C extends object = object> {
  id: string
  author: 'reviewer' | 'agent'
  text: string
  at: string
  change?: ConversationChange<F> & C
}

/** What an agent's message changed: the fields it set, their values before
 * (for undo; empty when it made the thing), and whether it made it. */
export interface ConversationChange<F extends string> {
  fields: F[]
  before: Partial<Record<F, string>>
  created?: boolean
}

/** A stored message, read leniently: null when it is not one. `extra` reads
 * what a kind adds to a change. */
export function normalizeConversationMessage<F extends string, C extends object = object>(
  raw: unknown,
  fields: readonly F[],
  extra?: (change: Record<string, unknown>) => C,
): ConversationMessage<F, C> | null {
  if (typeof raw !== 'object' || raw === null) return null
  const m = raw as Record<string, unknown>
  if (typeof m.id !== 'string' || m.id === '') return null
  if (m.author !== 'reviewer' && m.author !== 'agent') return null
  if (typeof m.text !== 'string' || typeof m.at !== 'string') return null
  const message: ConversationMessage<F, C> = { id: m.id, author: m.author, text: m.text, at: m.at }
  const c = m.change as Record<string, unknown> | undefined
  if (typeof c === 'object' && c !== null && Array.isArray(c.fields)) {
    const set = c.fields.filter((f): f is F => (fields as readonly string[]).includes(f as string))
    const beforeRaw = (typeof c.before === 'object' && c.before !== null ? c.before : {}) as Record<
      string,
      unknown
    >
    const before: Partial<Record<F, string>> = {}
    for (const f of fields) {
      if (typeof beforeRaw[f] === 'string') before[f] = beforeRaw[f] as string
    }
    message.change = {
      fields: set,
      before,
      ...(c.created === true ? { created: true } : {}),
      ...(extra ? extra(c) : ({} as C)),
    } as ConversationChange<F> & C
  }
  return message
}

/**
 * The stored conversations, keyed, read leniently: a bad key, thread or
 * message is dropped alone, and a thread left with no messages goes.
 */
export function normalizeConversations<M, T>(
  value: unknown,
  isKey: (key: string) => boolean,
  message: (raw: unknown) => M | null,
  thread: (key: string, messages: M[]) => T,
): Record<string, T> {
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value)
    } catch {
      return {}
    }
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {}
  const out: Record<string, T> = {}
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!isKey(key)) continue
    const t = raw as { messages?: unknown } | null
    if (typeof t !== 'object' || t === null || !Array.isArray(t.messages)) continue
    const messages = t.messages.flatMap((m) => {
      const read = message(m)
      return read ? [read] : []
    })
    if (messages.length > 0) out[key] = thread(key, messages)
  }
  return out
}
