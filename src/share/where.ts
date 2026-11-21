import { parseRemoteUrl } from '../forge/target.js'
import type { ForgeClient } from '../forge/types.js'

/** How long a "no" is believed: the user may sign `gh` in while the review is open. */
export const SHARE_RECHECK_MS = 60_000

/**
 * Whether `diffo share` could post from this repo: its origin names a host `gh`
 * is signed in to — github.com, or a GitHub Enterprise host the user logged
 * into. A Bitbucket or GitLab origin, or no `gh` at all, is a "no", and Finish
 * does not offer to share. A "yes" is kept for the server's life; a "no" is
 * asked again after `SHARE_RECHECK_MS`. Never throws.
 */
export function shareCheck(
  originUrl: () => string | null,
  forge: Pick<ForgeClient, 'authStatus'>,
  now: () => number = Date.now,
): () => Promise<boolean> {
  let known: { ok: boolean; at: number } | null = null
  let inFlight: Promise<boolean> | null = null
  const ask = async (): Promise<boolean> => {
    const repo = parseRemoteUrl(originUrl() ?? '')
    if (!repo) return false
    return (await forge.authStatus(repo.host)).ok
  }
  return () => {
    if (known && (known.ok || now() - known.at < SHARE_RECHECK_MS)) {
      return Promise.resolve(known.ok)
    }
    inFlight ??= ask()
      .catch(() => false)
      .then((ok) => {
        known = { ok, at: now() }
        inFlight = null
        return ok
      })
    return inFlight
  }
}
