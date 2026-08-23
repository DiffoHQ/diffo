import type { Changeset } from '../shared/types.js'

/**
 * Viewed-hunk state, per repo + spec, in localStorage. Content-addressed hunk ids
 * make this survive live refreshes for free: an unchanged hunk keeps its mark, an
 * edited one rotates its id and honestly loses it.
 *
 * Keyed on the worktree **path**, like the review — keying on the basename meant
 * `~/work/api` and `~/personal/api` shared one bucket. `legacyStorageKey` reads the
 * old bucket once so nobody's reading position is lost to the fix.
 */
export function storageKey(changeset: Pick<Changeset, 'repo' | 'spec'>): string {
  return `diffo:viewed:${changeset.repo.path}:${specKey(changeset)}`
}

export function legacyStorageKey(changeset: Pick<Changeset, 'repo' | 'spec'>): string {
  return `diffo:viewed:${changeset.repo.name}:${specKey(changeset)}`
}

function specKey(changeset: Pick<Changeset, 'spec'>): string {
  return changeset.spec.kind === 'working-tree' ? 'working-tree' : `branch:${changeset.spec.base}`
}

export function loadViewed(key: string): Set<string> {
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return new Set()
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? new Set(parsed.filter((x) => typeof x === 'string')) : new Set()
  } catch {
    return new Set()
  }
}

export function saveViewed(key: string, viewed: ReadonlySet<string>): void {
  try {
    localStorage.setItem(key, JSON.stringify([...viewed]))
  } catch {
    // localStorage full or unavailable — viewed state is best-effort
  }
}
