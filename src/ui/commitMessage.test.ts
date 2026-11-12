import { describe, expect, it } from 'vitest'
import { commitMessageLines, type ReviewThread } from '../shared/review.js'
import { fromMessageLine, messageHunk, onMessageLine } from './commitMessage.js'

const sha = 'a'.repeat(40)
const commit = { kind: 'commit', sha, subject: 'shout two' } as const

describe('the commit message as a hunk', () => {
  it('numbers the lines the way git log prints them', () => {
    expect(commitMessageLines({ subject: 'shout two' })).toEqual(['shout two'])
    const lines = commitMessageLines({ subject: 'shout two', body: 'Why.\nMore.' })
    expect(lines).toEqual(['shout two', '', 'Why.', 'More.'])
    expect(messageHunk(sha, lines).lines.map((l) => l.newNo)).toEqual([1, 2, 3, 4])
  })

  it('round-trips a line range between the commit anchor and the hunk', () => {
    const hunk = messageHunk(sha, ['shout two', '', 'Why.'])
    const thread = { id: 't', anchor: { ...commit, line: 1, endLine: 3 } } as ReviewThread
    const placed = onMessageLine(thread, hunk)
    expect(placed.anchor).toEqual({
      kind: 'hunk',
      hunkId: hunk.id,
      path: hunk.path,
      side: 'new',
      line: 1,
      endLine: 3,
    })
    if (placed.anchor.kind !== 'hunk') throw new Error('not placed on a line')
    expect(fromMessageLine(placed.anchor, commit)).toEqual({ ...commit, line: 1, endLine: 3 })
  })

  it('leaves a whole-message thread alone', () => {
    const thread = { id: 't', anchor: commit } as ReviewThread
    expect(onMessageLine(thread, messageHunk(sha, ['shout two']))).toBe(thread)
  })
})
