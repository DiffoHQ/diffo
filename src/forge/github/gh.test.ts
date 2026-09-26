import { describe, expect, it } from 'vitest'
import type { PrRef } from '../types.js'
import { GhClient, type GhExec } from './gh.js'
import { COMMENTS_QUERY, PR_QUERY, REVIEWS_QUERY, THREADS_QUERY } from './queries.js'

// The client over a scripted `gh`: every call is an argv, every answer a page.
// What matters here is that a connection past its first hundred is read to the
// end — a pending review or a comment on page two is not optional.

const REF: PrRef = { host: 'github.com', owner: 'acme', repo: 'widgets', number: 482 }

const who = { login: 'jonas', avatarUrl: '' }

function page(nodes: unknown[], endCursor: string | null) {
  return {
    pageInfo: { hasNextPage: endCursor !== null, endCursor },
    nodes,
  }
}

/** A `gh` that answers by query text and cursor, and records what it was asked. */
function scriptedGh() {
  const asked: { query: string; cursor: string | null }[] = []
  const reviews = {
    first: page(
      [
        {
          id: 'R1',
          state: 'APPROVED',
          submittedAt: '2026-09-20T10:00:00Z',
          body: 'lgtm',
          author: who,
        },
      ],
      'r1',
    ),
    r1: page(
      [
        {
          id: 'R2',
          state: 'PENDING',
          submittedAt: null,
          body: '',
          author: { login: 'me', avatarUrl: '' },
        },
      ],
      null,
    ),
  }
  const comments = {
    first: page([{ id: 'IC1', body: 'one', createdAt: '2026-09-20T11:00:00Z', author: who }], 'c1'),
    c1: page([{ id: 'IC2', body: 'two', createdAt: '2026-09-20T12:00:00Z', author: who }], null),
  }
  const exec: GhExec = async (args) => {
    const query = args[args.indexOf('-f') + 1]!.replace(/^query=/, '')
    const cursorArg = args.find((a, i) => args[i - 1] === '-f' && a.startsWith('cursor='))
    const cursor = cursorArg ? cursorArg.slice('cursor='.length) : null
    asked.push({ query, cursor })
    const pr = (over: Record<string, unknown>) => ({ data: { repository: { pullRequest: over } } })
    if (query === PR_QUERY) {
      return JSON.stringify({
        data: {
          viewer: { login: 'me' },
          repository: {
            pullRequest: {
              id: 'PR_1',
              number: 482,
              title: 't',
              body: '',
              url: 'https://github.com/acme/widgets/pull/482',
              isDraft: false,
              state: 'OPEN',
              merged: false,
              author: who,
              baseRefName: 'main',
              baseRefOid: 'b'.repeat(40),
              headRefName: 'f',
              headRefOid: 'h'.repeat(40),
              commits: { totalCount: 0, nodes: [] },
              reviews: reviews.first,
              comments: comments.first,
            },
          },
        },
      })
    }
    if (query === REVIEWS_QUERY) return JSON.stringify(pr({ reviews: reviews[cursor as 'r1'] }))
    if (query === COMMENTS_QUERY) return JSON.stringify(pr({ comments: comments[cursor as 'c1'] }))
    if (query === THREADS_QUERY) return JSON.stringify(pr({ reviewThreads: page([], null) }))
    throw new Error(`unscripted query: ${query.slice(0, 40)}`)
  }
  return { exec, asked }
}

describe('GhClient pagination', () => {
  it('getPr reads every page of reviews: a pending review on page two is found', async () => {
    const { exec, asked } = scriptedGh()
    const pr = await new GhClient(exec).getPr(REF)
    expect(pr.viewer.pendingReviewId).toBe('R2')
    expect(pr.approvals).toBe(1)
    expect(pr.reviews.map((r) => r.id)).toEqual(['R1'])
    expect(asked.map((a) => [a.query === REVIEWS_QUERY ? 'reviews' : 'pr', a.cursor])).toEqual([
      ['pr', null],
      ['reviews', 'r1'],
    ])
  })

  it('fetchPr reads the pull request once for both the PR block and the conversation', async () => {
    const { exec, asked } = scriptedGh()
    const { pr, threads } = await new GhClient(exec).fetchPr(REF)
    expect(pr.viewer.pendingReviewId).toBe('R2')
    expect(threads.map((t) => `${t.kind}:${t.id}`)).toEqual([
      'review:R1',
      'comment:IC1',
      'comment:IC2',
    ])
    const name = (q: string) =>
      q === PR_QUERY
        ? 'pr'
        : q === REVIEWS_QUERY
          ? 'reviews'
          : q === COMMENTS_QUERY
            ? 'comments'
            : 'threads'
    expect(asked.map((a) => name(a.query))).toEqual(['pr', 'reviews', 'comments', 'threads'])
  })

  it('listThreads reads every page of reviews and comments', async () => {
    const { exec, asked } = scriptedGh()
    const threads = await new GhClient(exec).listThreads(REF)
    expect(threads.map((t) => `${t.kind}:${t.id}`)).toEqual([
      'review:R1',
      'comment:IC1',
      'comment:IC2',
    ])
    expect(asked.filter((a) => a.query === COMMENTS_QUERY).map((a) => a.cursor)).toEqual(['c1'])
  })
})
