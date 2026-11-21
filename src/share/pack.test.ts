import { describe, expect, it } from 'vitest'
import { fixturePr } from '../forge/fixture.js'
import type { ImportedComment, ImportedThread, PrRef } from '../forge/types.js'
import type { LayerInput } from '../shared/layers.js'
import {
  COMMENT_LIMIT,
  decodePack,
  findSharedPack,
  isLoadablePackComment,
  ownPackComment,
  packOf,
  renderShareComment,
  type SharedPack,
  VISIBLE_LAYERS,
} from './pack.js'

const REF: PrRef = { host: 'github.com', owner: 'acme', repo: 'widgets', number: 482 }
const SHA = 'abc1234def5678abc1234def5678abc1234def56'

const LAYERS: LayerInput[] = [
  {
    title: 'Retry delay gets <jitter>',
    summary: 'Full jitter on every retry.\n\n```mermaid\nflowchart LR\n  a --> b\n```',
    files: [{ path: 'src/retry.ts:10-24', note: 'the delay itself' }, 'src/retry.test.ts'],
    decisions: [{ text: 'Full jitter, not equal', detail: 'Spreads a thundering herd best.' }],
  },
  { title: 'Callers follow', kind: 'mechanical', files: ['src/upload.ts'] },
]

const pack = (over: Partial<SharedPack> = {}): SharedPack => ({
  v: 1,
  sha: SHA,
  postedAt: '2026-11-20T10:00:00.000Z',
  layers: LAYERS,
  ...over,
})

function comment(
  id: string,
  login: string,
  body: string,
  association?: string,
): ImportedThread & { kind: 'comment' } {
  const c: ImportedComment = {
    id,
    user: { login, avatarUrl: '' },
    body,
    at: '2026-11-20T10:00:00Z',
    url: `https://github.com/acme/widgets/pull/482#issuecomment-${id}`,
    ...(association ? { association } : {}),
  }
  return { kind: 'comment', id, comments: [c] }
}

const pr = fixturePr()

describe('a shared reading guide', () => {
  it('round-trips: the comment carries the layers, and they read back the same', () => {
    const body = renderShareComment(REF, pack())
    expect(decodePack(body)).toEqual(pack())
  })

  it('reads on GitHub without Diffo: an outline up front, the rest folded away', () => {
    const body = renderShareComment(REF, pack())
    expect(body).toMatch(/^\*\*📖 Reading guide\*\* · 2 layers, 1 to read closely$/m)
    expect(body).toContain('Written for abc1234.')
    // A title is text: it cannot open a tag. Each one links to where its layer starts.
    expect(body).toMatch(
      /^1\. \[Retry delay gets &lt;jitter&gt;\]\(https:\/\/github\.com\/acme\/widgets\/pull\/482\/files#diff-[0-9a-f]{64}R10\) · 2 files$/m,
    )
    expect(body).toMatch(/^2\. \[Callers follow\]\(.+\) · 1 file · mechanical$/m)
    // Summaries, decisions and files sit in one collapsed block.
    const folded = body.slice(body.indexOf('<details>'))
    expect(folded).toContain('```mermaid')
    expect(folded).toContain('Full jitter, not equal: Spreads a thundering herd best.\n\nFiles:')
    expect(folded).toMatch(
      /\[`src\/retry\.ts`\]\(https:\/\/github\.com\/acme\/widgets\/pull\/482\/files#diff-[0-9a-f]{64}R10\) lines 10–24 · the delay itself/,
    )
    // The agent prompt is a fenced block: GitHub gives it a copy button and
    // does not shorten the URL to "#482" inside it.
    expect(body).toContain(
      '> ```text\n> Review this pull request with me, using its Diffo layers:\n> npx -y @diffohq/diffo https://github.com/acme/widgets/pull/482\n> ```',
    )
    expect(body).toContain('utm_source=pr-guide')
  })

  it('stays short in the conversation: a header, one line a layer, a footer', () => {
    const many: LayerInput[] = Array.from({ length: 12 }, (_, i) => ({
      title: `Layer ${i + 1}`,
      summary: 'A long summary.\n\nWith paragraphs.',
      files: [`src/f${i}.ts`, `src/g${i}.ts`],
    }))
    const body = renderShareComment(REF, pack({ layers: many }))
    const visible = body
      .replace(/<details>[\s\S]*?<\/details>/, '')
      .replace(/<!--[\s\S]*?-->/, '')
      .split('\n')
      .filter((l) => l.trim() !== '')
    // Header, eight layers, the "more" line, and the quoted footer with its prompt.
    expect(visible).toHaveLength(1 + VISIBLE_LAYERS + 1 + 6)
    expect(body).toContain('…and 4 more below.')
    expect(body).toContain('**12. Layer 12**')
  })

  it('a title cannot break its link, and its code spans still render', () => {
    const body = renderShareComment(
      REF,
      pack({ layers: [{ title: 'The `delay` [helper]', files: ['a.ts'] }] }),
    )
    expect(body).toMatch(/^1\. \[The `delay` \\\[helper\\\]\]\(/m)
  })

  it('drops the summaries before refusing a guide too large for one comment', () => {
    const long = 'word '.repeat(4000)
    const many: LayerInput[] = Array.from({ length: 20 }, (_, i) => ({
      title: `Layer ${i}`,
      summary: long,
      files: [`src/f${i}.ts`],
    }))
    const body = renderShareComment(REF, pack({ layers: many }))
    expect(body.length).toBeLessThanOrEqual(COMMENT_LIMIT)
    expect(body).not.toContain(long)
    expect(decodePack(body)?.layers).toHaveLength(20)
  })

  it('ignores a pack that does not decode or does not validate', () => {
    expect(decodePack('no pack here')).toBeNull()
    expect(decodePack('<!-- diffo-pack:v1\nnot-base64!!\n-->')).toBeNull()
    const noLayers = renderShareComment(REF, pack()).replace(
      /<!-- diffo-pack:v1\n[^\n]+/,
      `<!-- diffo-pack:v1\n${Buffer.from('{"v":1}').toString('base64')}`,
    )
    expect(decodePack(noLayers)).toBeNull()
  })

  it('packs the layers without the ids the server minted', () => {
    const packed = packOf(
      [{ id: 'x1', title: 'One', files: ['a.ts'] }],
      SHA,
      '2026-11-20T10:00:00.000Z',
    )
    expect(packed.layers).toEqual([{ title: 'One', files: ['a.ts'] }])
  })
})

describe('whose guide is loaded', () => {
  const body = renderShareComment(REF, pack())

  it("loads the PR author's guide, the reader's own, and a member's or collaborator's", () => {
    expect(findSharedPack([comment('A', 'mira-k', body)], pr)?.from.by).toBe('mira-k')
    expect(findSharedPack([comment('B', 'reviewer-x', body)], pr)?.from.by).toBe('reviewer-x')
    expect(findSharedPack([comment('C', 'lead', body, 'MEMBER')], pr)?.from.by).toBe('lead')
    expect(findSharedPack([comment('D', 'pal', body, 'COLLABORATOR')], pr)?.from.by).toBe('pal')
  })

  it('never loads a drive-by commenter’s guide, and leaves it in the conversation', () => {
    const stranger = comment('E', 'stranger', body, 'NONE')
    expect(findSharedPack([stranger], pr)).toBeNull()
    expect(isLoadablePackComment(stranger.comments[0], pr)).toBe(false)
  })

  it('takes the newest guide, by when it was made', () => {
    const older = renderShareComment(REF, pack({ postedAt: '2026-11-19T10:00:00.000Z' }))
    const found = findSharedPack(
      [comment('new', 'mira-k', body), comment('old', 'lead', older, 'OWNER')],
      pr,
    )
    expect(found?.from).toMatchObject({
      by: 'mira-k',
      commentId: 'new',
      sha: SHA,
      postedAt: '2026-11-20T10:00:00.000Z',
    })
  })

  it("finds the viewer's own guide to edit in place, never someone else's", () => {
    const threads = [comment('A', 'mira-k', body), comment('B', 'reviewer-x', 'just a comment')]
    expect(ownPackComment(threads, 'mira-k')?.id).toBe('A')
    expect(ownPackComment(threads, 'reviewer-x')).toBeNull()
  })
})
