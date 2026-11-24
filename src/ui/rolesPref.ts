import type { RoleMessage, RoleThread } from '../shared/roles.js'
import { type ConversationThreadState, useConversationThread } from './conversationThread.js'

/**
 * The conversations about reviewer roles (see shared/roles.ts), as the
 * Reviewer agents page shows them: the twin of `usePresetThread`. The agent
 * makes and edits roles through the CLI and writes in these conversations;
 * the events stream says so (`roles`), and every hook here re-reads on
 * `notifyRolesChanged`. The roles themselves are a react-query read
 * (`useReviewerRoles`), which the same event invalidates.
 */

const changeListeners = new Set<() => void>()

/** The server said the roles or their conversations moved: re-read. */
export function notifyRolesChanged(): void {
  for (const listener of changeListeners) listener()
}

function onRolesChanged(listener: () => void): () => void {
  changeListeners.add(listener)
  return () => {
    changeListeners.delete(listener)
  }
}

/** A key for a new role's conversation: the role has no id until the agent
 * names it from the role's name. */
export function mintDraftRoleKey(): string {
  const bytes = new Uint8Array(4)
  crypto.getRandomValues(bytes)
  return `draft-${[...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')}`
}

/** A role's conversation with the agent, kept current from the stream. */
export type RoleThreadState = ConversationThreadState<RoleThread, RoleMessage>

export function useRoleThread(key: string): RoleThreadState {
  return useConversationThread<RoleThread, RoleMessage>(
    `/api/reviewer/roles/${encodeURIComponent(key)}`,
    () => ({ messages: [] }),
    onRolesChanged,
  )
}
