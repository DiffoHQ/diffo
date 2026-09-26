import { githubPosition } from '../../forge/github/map.js'
import type { ForgeClient, PrRef, ReviewDraftComment, ReviewEvent } from '../../forge/types.js'
import {
  describeAnchor,
  isDraft,
  isPublic,
  type ReviewMessage,
  type ReviewThread,
  unpostedReplies,
} from '../../shared/review.js'
import type { FileChange, PrInfo } from '../../shared/types.js'
import type { ReviewStore } from '../review.js'

// Finish's second leg: what the reviewer drafted for GitHub, and posting it.
// Nothing leaves the machine before this runs, and every accepted item is
// recorded before the next one is sent, so a failure midway never posts twice.

export const REVIEW_EVENTS: readonly ReviewEvent[] = ['COMMENT', 'APPROVE', 'REQUEST_CHANGES']

export interface PublicDraft {
  thread: ReviewThread
  text: string
  /** Null for a changeset-level draft: it posts as a conversation comment. */
  position: ReviewDraftComment | null
  /** The anchored line is not in GitHub's diff, so this posts on the file. */
  downgraded: boolean
}

export interface PublicReply {
  thread: ReviewThread
  messages: ReviewMessage[]
}

export interface PublicResolve {
  thread: ReviewThread
  resolve: boolean
}

export interface PublicLeg {
  drafts: PublicDraft[]
  replies: PublicReply[]
  resolves: PublicResolve[]
}

export function planPublicLeg(
  threads: readonly ReviewThread[],
  files: readonly FileChange[],
): PublicLeg {
  const drafts: PublicDraft[] = []
  const replies: PublicReply[] = []
  const resolves: PublicResolve[] = []
  for (const thread of threads) {
    if (!isPublic(thread)) continue
    if (isDraft(thread)) {
      const text = thread.messages
        .filter((m) => m.author === 'reviewer')
        .map((m) => m.text)
        .join('\n\n')
      if (text.trim() === '') continue
      const placed = githubPosition(thread.anchor, text, files)
      drafts.push({
        thread,
        text,
        position: placed?.draft ?? null,
        downgraded: placed?.downgraded ?? false,
      })
      continue
    }
    const owed = unpostedReplies(thread)
    if (owed.length > 0) replies.push({ thread, messages: owed })
    if (thread.queued?.resolve) resolves.push({ thread, resolve: true })
    else if (thread.queued?.unresolve) resolves.push({ thread, resolve: false })
  }
  return { drafts, replies, resolves }
}

export function legIsEmpty(leg: PublicLeg): boolean {
  return leg.drafts.length === 0 && leg.replies.length === 0 && leg.resolves.length === 0
}

/** The dialog's rows: what will post, in words. */
export function describeLeg(leg: PublicLeg) {
  return {
    drafts: leg.drafts.map((d) => ({
      id: d.thread.id,
      anchor: describeAnchor(d.thread.anchor),
      text: d.text,
      downgraded: d.downgraded,
      conversation: d.position === null,
    })),
    replies: leg.replies.map((r) => ({
      id: r.thread.id,
      anchor: describeAnchor(r.thread.anchor),
      count: r.messages.length,
      text: r.messages.map((m) => m.text).join('\n\n'),
    })),
    resolves: leg.resolves.map((r) => ({
      id: r.thread.id,
      anchor: describeAnchor(r.thread.anchor),
      resolve: r.resolve,
    })),
  }
}

export interface PublicLegOutcome {
  /** Drafts and replies GitHub accepted this run. */
  posted: number
  resolved: number
  submitted: boolean
  reviewId: string | null
  url?: string
  /** The first failure, if any. Whatever posted before it is recorded. */
  failed?: { step: string; message: string }
}

export interface PublicLegDeps {
  forge: ForgeClient
  ref: PrRef
  review: ReviewStore
}

/**
 * Post the leg in GitHub's order: a pending review to hold the line comments,
 * the comments, the replies, the resolves, then the submit. Idempotent across
 * retries: each accepted item is written to the review before the next call,
 * and the pending review id is kept so a retry adds to it instead of opening a
 * second one. `event` null means the reviewer had nothing public to submit and
 * only the agent leg ran — this function is then not called at all.
 */
export async function runPublicLeg(
  deps: PublicLegDeps,
  leg: PublicLeg,
  event: ReviewEvent,
  body: string,
): Promise<PublicLegOutcome> {
  const { forge, ref, review } = deps
  const outcome: PublicLegOutcome = { posted: 0, resolved: 0, submitted: false, reviewId: null }
  const fail = (step: string, err: unknown): PublicLegOutcome => ({
    ...outcome,
    failed: { step, message: err instanceof Error ? err.message : String(err) },
  })
  // GitHub's word on the pending review is the only one that counts: the id
  // kept from a failed run is dead once the reviewer submitted or discarded
  // that review on github.com, and the puller's last poll may predate the
  // review a retry opened seconds ago. So ask now, and drop what is stale.
  let pr: PrInfo
  try {
    pr = await forge.getPr(ref)
  } catch (err) {
    return fail('reading the pull request', err)
  }
  const me = { login: pr.viewer.login, avatarUrl: '' }
  const state = review.get().pr ?? { submissions: [] }
  let reviewId = pr.viewer.pendingReviewId ?? null
  // A pending review holds line comments and inline replies until the submit,
  // and carries the verdict and the body. Conversation comments and resolves
  // need none — and GitHub refuses to submit a review with nothing in it, so a
  // leg of only those, with a plain Comment and no body, opens no review and
  // submits none. One GitHub already holds is submitted whatever the leg.
  const needsReview =
    leg.drafts.some((d) => d.position !== null) ||
    leg.replies.some((r) => r.thread.github?.kind === 'inline') ||
    body.trim() !== '' ||
    event !== 'COMMENT'
  try {
    if (reviewId === null && needsReview) {
      reviewId = await forge.createPendingReview(ref, pr.nodeId, pr.head.sha)
    }
    if (reviewId !== null && reviewId !== state.pendingReviewId) {
      review.setPr({ ...state, pendingReviewId: reviewId })
    }
  } catch (err) {
    return fail('opening the pending review', err)
  }
  outcome.reviewId = reviewId

  for (const draft of leg.drafts) {
    // The draft posted every reviewer message as one comment, so the thread
    // keeps one message from here on: what GitHub holds, under its id. Left as
    // several, the next import would read the joined body as an edit of the
    // first and show the rest twice — or, unstamped, post them again as replies.
    const mine = draft.thread.messages.filter((m) => m.author === 'reviewer')
    const posted = (id: string, url?: string) => ({
      messages: Object.fromEntries(
        mine.map((m) => [m.id, { id, user: me, ...(url ? { url } : {}) }]),
      ),
      ...(mine.length > 1 ? { collapse: draft.text } : {}),
    })
    try {
      if (draft.position === null) {
        const { commentId, url } = await forge.addPrComment(ref, pr.nodeId, draft.text)
        review.markPosted([
          {
            threadId: draft.thread.id,
            github: {
              threadId: commentId,
              kind: 'comment',
              resolved: false,
              outdated: false,
              ...(url ? { url } : {}),
            },
            ...posted(commentId, url),
          },
        ])
      } else {
        // A positioned draft is what `needsReview` opened the review for.
        if (reviewId === null) throw new Error('no pending review to hold the comment')
        const { threadId, commentId, url } = await forge.addReviewThread(
          ref,
          reviewId,
          draft.position,
        )
        review.markPosted([
          {
            threadId: draft.thread.id,
            github: {
              threadId,
              kind: 'inline',
              resolved: false,
              outdated: false,
              line: draft.position.line ?? null,
              startLine: draft.position.startLine ?? null,
              side: draft.position.side ?? 'RIGHT',
              ...(url ? { url } : {}),
            },
            ...posted(commentId, url),
          },
        ])
      }
      outcome.posted++
    } catch (err) {
      return fail(`posting the comment on ${describeAnchor(draft.thread.anchor)}`, err)
    }
  }

  for (const reply of leg.replies) {
    const gh = reply.thread.github!
    for (const message of reply.messages) {
      try {
        const posted =
          gh.kind === 'inline'
            ? await forge.replyToThread(ref, reviewId, gh.threadId, message.text)
            : await forge.addPrComment(ref, pr.nodeId, message.text)
        review.markPosted([
          {
            threadId: reply.thread.id,
            messages: {
              [message.id]: {
                id: posted.commentId,
                user: me,
                ...(posted.url ? { url: posted.url } : {}),
              },
            },
          },
        ])
        outcome.posted++
      } catch (err) {
        return fail(`replying on ${describeAnchor(reply.thread.anchor)}`, err)
      }
    }
  }

  for (const item of leg.resolves) {
    const gh = item.thread.github!
    // Only an inline thread can be resolved on GitHub; a queue entry on any
    // other kind (an older build's) is settled locally and cleared.
    if (gh.kind !== 'inline') {
      review.markPosted([{ threadId: item.thread.id, resolveDone: true }])
      continue
    }
    try {
      await forge.setThreadResolved(ref, gh.threadId, item.resolve)
      review.markPosted([
        { threadId: item.thread.id, github: { ...gh, resolved: item.resolve }, resolveDone: true },
      ])
      outcome.resolved++
    } catch (err) {
      return fail(
        `${item.resolve ? 'resolving' : 'reopening'} ${describeAnchor(item.thread.anchor)}`,
        err,
      )
    }
  }

  // Nothing for a review to carry (see `needsReview`): the resolves above were
  // the whole leg, and they are done.
  if (reviewId === null) return outcome
  try {
    const { url } = await forge.submitReview(ref, reviewId, event, body)
    const current = review.get().pr ?? { submissions: [] }
    const { pendingReviewId: _done, ...rest } = current
    review.setPr({
      ...rest,
      submissions: [
        ...current.submissions,
        { at: new Date().toISOString(), event, reviewId, comments: outcome.posted },
      ],
    })
    outcome.submitted = true
    if (url) outcome.url = url
  } catch (err) {
    return fail('submitting the review', err)
  }
  return outcome
}
