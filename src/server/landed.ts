import type { ReviewStore } from './review.js'

/** The git questions landed-detection asks, injectable so the logic is testable
 * without a repo. `isAncestor` may answer null — "couldn't say". */
export interface LandedGit {
  head(): string | null
  isAncestor(ancestor: string, descendant: string): boolean | null
  subject(sha: string): string
}

/**
 * Keep the review's landed marker true to the repo. Called on every changeset
 * recompute (and once at startup, which is what catches a commit made while no
 * server ran):
 *
 * - The diff emptied while HEAD advanced past `seenHead` → the changeset was
 *   committed. Stamp `landed` — the UI's cue to offer a fresh start. A stash
 *   empties the diff without moving HEAD, so it never stamps; a branch switch
 *   is rescoped to its own review before this runs.
 * - A landed commit that left HEAD's history (reset, or an amend rewriting it)
 *   drops the marker — and an amend re-stamps in the same pass, because
 *   `seenHead` is still the pre-landing base and IS an ancestor of the
 *   rewritten commit.
 * - Everything here is metadata. Threads are never touched: only the reviewer
 *   clears a review, this just tells them when they can.
 *
 * `seenHead` advances only while the diff has files (tracking the base the
 * outstanding work sits on) or the review is empty (nothing to land). While an
 * empty diff hangs over a non-empty review it stays frozen at the base — the
 * fixed point that makes "amended" and "reset back" distinguishable above.
 */
export function maintainLanded(
  review: ReviewStore,
  hasFiles: boolean,
  git: LandedGit,
): 'stamped' | 'cleared' | null {
  const head = git.head()
  if (head === null) return null
  const state = review.get()
  const reviewEmpty = state.threads.length === 0 && !state.lastFinish
  let outcome: 'stamped' | 'cleared' | null = null

  if (state.landed && state.landed.sha !== head) {
    // Ambiguity keeps the marker: clearing on a git hiccup loses the offer.
    if (git.isAncestor(state.landed.sha, head) === false) {
      review.clearLanded()
      outcome = 'cleared'
    }
  }

  if (
    !review.get().landed &&
    !hasFiles &&
    !reviewEmpty &&
    state.seenHead !== undefined &&
    state.seenHead !== head &&
    // Ambiguity never stamps: a marker invented on a git hiccup is a false offer.
    git.isAncestor(state.seenHead, head) === true
  ) {
    review.markLanded({ sha: head, subject: git.subject(head), at: new Date().toISOString() })
    outcome = 'stamped'
  }

  if (hasFiles || reviewEmpty) review.noteHead(head)
  return outcome
}
