import type { ReviewState } from '../shared/review.js'
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
 * - The commit can also go unwitnessed: it lands and the next round starts
 *   while no server watches, so no recompute ever sees the empty diff. The
 *   evidence survives anyway — HEAD advanced past `seenHead` AND every hunk
 *   the review pointed at (thread anchors, the last finish) is gone from the
 *   current changeset. Both together stamp even over a non-empty diff; either
 *   alone does not (an unrelated commit leaves the reviewed hunks in place, an
 *   agent rewriting every hunk between recomputes leaves HEAD at `seenHead`).
 *   A review that never anchored to a hunk has no such evidence and waits for
 *   the witnessed path.
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
  currentHunkIds: ReadonlySet<string>,
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
    (!hasFiles || reviewedHunksAllLanded(state, currentHunkIds)) &&
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

/** The unwitnessed-landing evidence: the review pointed at hunks, and none of
 * them survive in the current changeset. Vacuous truth deliberately fails —
 * a review of only file- and changeset-anchored threads names no hunks, so it
 * cannot testify that they landed. */
function reviewedHunksAllLanded(state: ReviewState, currentHunkIds: ReadonlySet<string>): boolean {
  const referenced = new Set<string>()
  for (const thread of state.threads) {
    if (thread.anchor.kind === 'hunk') referenced.add(thread.anchor.hunkId)
  }
  for (const id of state.lastFinish?.hunkIds ?? []) referenced.add(id)
  if (referenced.size === 0) return false
  for (const id of referenced) if (currentHunkIds.has(id)) return false
  return true
}
