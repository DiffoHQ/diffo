import { randomUUID } from 'node:crypto'
import { parseReviewerName } from '../shared/review.js'
import {
  BUILT_IN_ROLES,
  CUSTOM_ROLES_MAX,
  findRole,
  isDraftRoleKey,
  normalizeRoleThreads,
  parseCustomRoles,
  parseRoleActivity,
  type ReviewerRole,
  ROLE_MESSAGE_MAX,
  ROLE_THREAD_MAX,
  type RoleActivity,
  type RoleChange,
  type RoleDraft,
  type RoleMessage,
  type RoleThread,
  type RoleThreads,
} from '../shared/roles.js'
import type { UiSettings } from './index.js'

/**
 * The reviewer's own roles and the conversations about roles, over the shared
 * settings store (see shared/roles.ts): the roles under `reviewerRoles`, each
 * conversation with the agent under `reviewerRoleThreads`, keyed by role id or
 * by a new role's draft key. Per human, not per repo, like the layers presets
 * (server/presets.ts), which this mirrors. Listeners hear every write, so the
 * events stream can tell an open Reviewer agents page to re-read.
 */

/** What an agent is told when it answers about a role that is gone. */
export const ROLE_DELETED =
  'the reviewer deleted this role before you answered: nothing was changed, and nothing is owed for it'

/** Drafts kept at once: a draft the agent never answered is left behind when
 * the reviewer moves on, and nothing else ever clears it. */
const DRAFTS_KEPT = 10

/**
 * A role saved before a built-in took its id loads as `my-<id>` (or
 * `my-<id>-2`, …, when the reviewer has that one too), with everything else
 * it says kept.
 */
function renameClashes(value: unknown[]): unknown[] {
  const builtIn = new Set(BUILT_IN_ROLES.map((r) => r.id))
  const taken = new Set([
    ...builtIn,
    ...value.flatMap((entry) => {
      const id = (entry as { id?: unknown } | null)?.id
      return typeof id === 'string' ? [id] : []
    }),
  ])
  return value.map((entry) => {
    if (typeof entry !== 'object' || entry === null) return entry
    const id = (entry as { id?: unknown }).id
    if (typeof id !== 'string' || !builtIn.has(id)) return entry
    const base = `my-${id}`.slice(0, 21)
    let next = base
    for (let n = 2; taken.has(next); n++) next = `${base}-${n}`
    taken.add(next)
    return { ...entry, id: next }
  })
}

/** Roles are read on every request: each problem is logged once. */
const reported = new Set<string>()
function report(message: string): void {
  if (reported.has(message)) return
  reported.add(message)
  console.error(`diffo: ${message}`)
}

/**
 * The saved roles, one by one: an entry that does not pass is dropped and
 * logged, never the whole list. Refusing the list would read as no roles at
 * all, and the next write would save that, erasing every one of them.
 */
function readRoles(raw: string): ReviewerRole[] {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    report('the saved reviewer roles are not JSON; none were loaded')
    return []
  }
  if (!Array.isArray(value)) return []
  const roles: ReviewerRole[] = []
  const seen = new Set<string>()
  for (const entry of renameClashes(value)) {
    const dropped = (why: string) =>
      report(
        `dropped saved reviewer role ${JSON.stringify((entry as { id?: unknown } | null)?.id ?? null)}: ${why}`,
      )
    const parsed = parseCustomRoles([entry])
    if (!parsed.ok) {
      dropped(parsed.error)
      continue
    }
    const role = parsed.roles[0]!
    if (seen.has(role.id)) {
      dropped('its id is taken')
      continue
    }
    if (roles.length >= CUSTOM_ROLES_MAX) {
      dropped(`past the ${CUSTOM_ROLES_MAX}-role limit`)
      continue
    }
    seen.add(role.id)
    roles.push(role)
  }
  return roles
}

/** A role id or draft key as it is stored: the name rule's form when it
 * passes (lowercase, trimmed), as given when it does not, for the caller to
 * refuse. */
export function roleKey(raw: string): string {
  const parsed = parseReviewerName(raw)
  return parsed.ok ? parsed.name : raw
}

export class RoleStore {
  private listeners = new Set<() => void>()

  constructor(private readonly store: UiSettings) {}

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private notify(): void {
    for (const listener of this.listeners) listener()
  }

  /** The reviewer's own roles. Read leniently (see `readRoles`): a bad
   * entry is dropped, never a review that fails to open. */
  roles(): ReviewerRole[] {
    const raw = this.store.get('reviewerRoles')
    return raw ? readRoles(raw) : []
  }

  /** Which roles are in the picker (see `RoleActivity`). */
  activity(): RoleActivity {
    try {
      return parseRoleActivity(JSON.parse(this.store.get('reviewerRolesActive') ?? '{}'))
    } catch {
      return { on: [], off: [] }
    }
  }

  /** The human moves a role into the picker, or back to the library. */
  setActive(id: string, active: boolean): void {
    const { on, off } = this.activity()
    const next: RoleActivity = {
      on: active ? [...on.filter((x) => x !== id), id] : on.filter((x) => x !== id),
      off: active ? off.filter((x) => x !== id) : [...off.filter((x) => x !== id), id],
    }
    this.store.set('reviewerRolesActive', JSON.stringify(next))
    this.notify()
  }

  find(id: string): ReviewerRole | undefined {
    return findRole(this.roles(), id)
  }

  /** Replaces the reviewer's own roles. A conversation is kept only with its
   * role: deleting a role deletes what was said about it. Drafts and the
   * built-ins' conversations are not a saved role's, and stay. */
  saveRoles(next: ReviewerRole[]): void {
    const kept = new Set(next.map((r) => r.id))
    const gone = this.roles()
      .map((r) => r.id)
      .filter((id) => !kept.has(id))
    this.store.set('reviewerRoles', JSON.stringify(next))
    // A deleted role stays deleted: an agent answering late about it must not
    // bring it back (see `upsert`). The newest hundred are remembered.
    const deleted = this.deleted().filter((id) => !kept.has(id))
    if (gone.length > 0 || deleted.length !== this.deleted().length) {
      this.store.set('reviewerRolesDeleted', JSON.stringify([...deleted, ...gone].slice(-100)))
    }
    const builtIn = new Set(BUILT_IN_ROLES.map((r) => r.id))
    const threads = this.threads()
    const orphans = Object.keys(threads).filter(
      (id) => !kept.has(id) && !builtIn.has(id) && !isDraftRoleKey(id),
    )
    if (orphans.length > 0) {
      for (const id of orphans) delete threads[id]
      this.writeThreads(threads)
    }
    this.notify()
  }

  private deleted(): string[] {
    try {
      const raw: unknown = JSON.parse(this.store.get('reviewerRolesDeleted') ?? '[]')
      return Array.isArray(raw) ? raw.filter((id): id is string => typeof id === 'string') : []
    } catch {
      return []
    }
  }

  /** The reviewer deleted this role: nothing may be said or changed about it
   * any more. */
  wasDeleted(id: string): boolean {
    return !this.find(id) && this.deleted().includes(id)
  }

  threads(): RoleThreads {
    return normalizeRoleThreads(this.store.get('reviewerRoleThreads'))
  }

  thread(key: string): RoleThread {
    return this.threads()[key] ?? { messages: [] }
  }

  private writeThreads(threads: RoleThreads): void {
    const drafts = Object.keys(threads)
      .filter(isDraftRoleKey)
      .sort((a, b) =>
        (threads[b]?.messages.at(-1)?.at ?? '').localeCompare(
          threads[a]?.messages.at(-1)?.at ?? '',
        ),
      )
    for (const key of drafts.slice(DRAFTS_KEPT)) delete threads[key]
    this.store.set('reviewerRoleThreads', JSON.stringify(threads))
  }

  /** A new conversation: the messages go, the role stays as it is. False
   * when there was nothing to clear. */
  clearThread(key: string): boolean {
    const threads = this.threads()
    if (!threads[key]) return false
    delete threads[key]
    this.writeThreads(threads)
    this.notify()
    return true
  }

  /**
   * The conversation that waits on the agent to make a role: a built-in's
   * (the agent cannot edit one, so it answers with a copy under an id of its
   * own) or a draft's (a new role, which has no id until the agent names it).
   * The reviewer spoke last there; the latest, when there is more than one.
   * The agent's answer is made under the new id, and has to reach the
   * conversation that asked for it.
   */
  waitingAsk(): string | undefined {
    const threads = this.threads()
    const builtIn = new Set(BUILT_IN_ROLES.map((r) => r.id))
    let found: { key: string; at: string } | undefined
    for (const [key, thread] of Object.entries(threads)) {
      if (!builtIn.has(key) && !isDraftRoleKey(key)) continue
      const last = thread.messages.at(-1)
      if (last?.author !== 'reviewer') continue
      if (!found || last.at > found.at) found = { key, at: last.at }
    }
    return found?.key
  }

  /** Appends a message to a conversation. The text is capped, and the
   * thread keeps its newest `ROLE_THREAD_MAX`. */
  addMessage(
    key: string,
    author: RoleMessage['author'],
    text: string,
    change?: RoleChange,
  ): RoleMessage {
    const message: RoleMessage = {
      id: randomUUID(),
      author,
      text: text.trim().slice(0, ROLE_MESSAGE_MAX),
      at: new Date().toISOString(),
      ...(change ? { change } : {}),
    }
    this.append(key, [message])
    return message
  }

  /** The messages carried over from a draft to the role it became: the
   * conversation goes on under the role, from where it was. */
  carryOver(from: string, to: string): void {
    const messages = this.thread(from).messages
    if (messages.length > 0) this.append(to, messages)
  }

  private append(key: string, added: RoleMessage[]): void {
    const threads = this.threads()
    const current = threads[key] ?? { messages: [] }
    const messages = [...current.messages, ...added].slice(-ROLE_THREAD_MAX)
    this.writeThreads({ ...threads, [key]: { messages } })
    this.notify()
  }

  /**
   * The agent's edit: the fields it sent replace the role's, and a role
   * nobody has yet is made from them (a name and a focus are required then).
   * A built-in is never written, and neither is a draft key: the agent makes
   * the role under an id of its own, from the role's name.
   */
  upsert(
    raw: string,
    patch: Partial<RoleDraft>,
  ): { ok: true; role: ReviewerRole; change: RoleChange } | { ok: false; error: string } {
    // An id is kept the way it reads back (lowercase, trimmed): one saved as
    // typed would come back as another, and the next edit would miss it.
    const id = roleKey(raw)
    const roles = this.roles()
    const current = findRole(roles, id)
    if (current?.builtIn) {
      return {
        ok: false,
        error: `"${id}" is built in and cannot be edited; make a copy under a new id, from the copy's name`,
      }
    }
    if (isDraftRoleKey(id)) {
      return {
        ok: false,
        error: `"${id}" names the conversation, not a role: make the role under an id from its name, such as "performance"`,
      }
    }
    const fields = Object.keys(patch) as RoleChange['fields']
    if (!current) {
      const name = parseReviewerName(id)
      if (!name.ok) return { ok: false, error: `role id: ${name.error}` }
      if (this.wasDeleted(id)) return { ok: false, error: ROLE_DELETED }
      if (patch.name === undefined || patch.focus === undefined) {
        return {
          ok: false,
          error: `no role "${id}" yet: a new one needs a "name" and a "focus"`,
        }
      }
      if (roles.length >= CUSTOM_ROLES_MAX) {
        return { ok: false, error: `the reviewer already has ${CUSTOM_ROLES_MAX} roles` }
      }
      const role: ReviewerRole = {
        id,
        name: patch.name,
        blurb: patch.blurb ?? '',
        focus: patch.focus,
      }
      this.saveRoles([...roles, role])
      return { ok: true, role, change: { fields, before: {}, created: true } }
    }
    const before: Partial<RoleDraft> = {}
    for (const f of fields) before[f] = current[f]
    const role: ReviewerRole = { ...current, ...patch }
    this.saveRoles(roles.map((r) => (r.id === id ? role : r)))
    return { ok: true, role, change: { fields, before } }
  }
}
