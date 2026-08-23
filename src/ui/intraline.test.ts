import { describe, expect, it } from 'vitest'
import type { DiffLine } from '../shared/types.js'
import { comparePair, intralineRanges, type Range, splitByRanges, tokenize } from './intraline.js'

function del(text: string): DiffLine {
  return { kind: 'del', oldNo: 1, newNo: null, text }
}
function add(text: string): DiffLine {
  return { kind: 'add', oldNo: null, newNo: 1, text }
}
function ctx(text: string): DiffLine {
  return { kind: 'context', oldNo: 1, newNo: 1, text }
}

function marked(line: DiffLine, ranges: Range[] | null | undefined) {
  return (ranges ?? []).map((r) => line.text.slice(r.start, r.end))
}

describe('tokenize', () => {
  it('keeps separators, so marks land on word boundaries', () => {
    expect(tokenize('foo(bar)')).toEqual(['foo', '(', 'bar', ')'])
    expect(tokenize('  a = 1')).toEqual(['  ', 'a', ' ', '=', ' ', '1'])
  })

  it('treats an identifier with $ and _ as one token', () => {
    expect(tokenize('_a$b1')).toEqual(['_a$b1'])
  })
})

describe('comparePair', () => {
  it('identical lines produce no marks', () => {
    const cmp = comparePair('const a = 1', 'const a = 1')!
    expect(cmp.similarity).toBe(1)
    expect(cmp.del).toEqual([])
    expect(cmp.add).toEqual([])
  })

  it('a one-word change marks one word on each side', () => {
    const cmp = comparePair('const total = 1', 'const count = 1')!
    expect(cmp.del.map((r) => 'const total = 1'.slice(r.start, r.end))).toEqual(['total'])
    expect(cmp.add.map((r) => 'const count = 1'.slice(r.start, r.end))).toEqual(['count'])
  })

  it('marks only the added argument, not the whole call', () => {
    const cmp = comparePair('run(a)', 'run(a, b)')!
    expect(cmp.del).toEqual([])
    expect(cmp.add.map((r) => 'run(a, b)'.slice(r.start, r.end))).toEqual([', b'])
  })

  it('bails out below the similarity floor — a wrong word-diff reads worse than none', () => {
    expect(comparePair('const a = 1', 'return renderTheEntirelyDifferentThing()')).toBeNull()
  })

  it('merges marks split by a tiny matched gap — one edit, not confetti', () => {
    const before = 'const pair = f(alpha, beta) + 1'
    const after = 'const pair = f(gamma, delta) + 1'
    const cmp = comparePair(before, after)!
    expect(cmp.add.map((r) => after.slice(r.start, r.end))).toEqual(['gamma, delta'])
    expect(cmp.del.map((r) => before.slice(r.start, r.end))).toEqual(['alpha, beta'])
  })

  it('drops the marks on a rewritten line — the row tint says it better', () => {
    const cmp = comparePair(
      '## Comment loop (first v2 feature — design agreed, open calls below pending)',
      '## Comment loop (design settled 2026-08-03; **built** — C1–C4 in plan.md)',
    )!
    expect(cmp.similarity).toBeGreaterThan(0.3)
    expect(cmp.del).toEqual([])
    expect(cmp.add).toEqual([])
  })

  it('bails out on a very long line', () => {
    const long = 'x'.repeat(500)
    expect(comparePair(long, `${long}y`)).toBeNull()
  })

  it('bails out on an empty side rather than marking everything', () => {
    expect(comparePair('', 'const a = 1')).toBeNull()
  })
})

describe('intralineRanges', () => {
  it('leaves context lines alone', () => {
    const lines = [ctx('const keep = true'), ctx('const also = true')]
    expect(intralineRanges(lines)).toEqual([null, null])
  })

  it('pairs an equal-length del-run to the add-run that follows it, positionally', () => {
    const lines = [
      del('const one = 1'),
      del('const two = 2'),
      add('const one = 11'),
      add('const two = 22'),
    ]
    const ranges = intralineRanges(lines)
    expect(marked(lines[2]!, ranges[2])).toEqual(['11'])
    expect(marked(lines[3]!, ranges[3])).toEqual(['22'])
  })

  it('unequal runs pair by similarity and leave the remainder unmarked', () => {
    const lines = [del('const alpha = 1'), add('const beta = 2'), add('const alpha = 3')]
    const ranges = intralineRanges(lines)
    expect(marked(lines[0]!, ranges[0])).toEqual(['1'])
    expect(marked(lines[2]!, ranges[2])).toEqual(['3'])
    expect(ranges[1]).toBeNull()
  })

  it('does not crash on a del-run with no additions after it', () => {
    const lines = [del('gone()'), del('also gone()'), ctx('stays()')]
    expect(intralineRanges(lines)).toEqual([null, null, null])
  })

  it('does not crash on additions with no deletions before them', () => {
    const lines = [ctx('stays()'), add('brand()'), add('new()')]
    expect(intralineRanges(lines)).toEqual([null, null, null])
  })

  it('handles several del/add runs in one hunk independently', () => {
    const lines = [del('a = 1'), add('a = 2'), ctx('between()'), del('b = 3'), add('b = 4')]
    const ranges = intralineRanges(lines)
    expect(marked(lines[1]!, ranges[1])).toEqual(['2'])
    expect(ranges[2]).toBeNull()
    expect(marked(lines[4]!, ranges[4])).toEqual(['4'])
  })

  it('gives up quietly on a huge unequal cross product instead of pairing 10,000 ways', () => {
    const lines = [
      ...Array.from({ length: 30 }, (_, i) => del(`line ${i}`)),
      ...Array.from({ length: 25 }, (_, i) => add(`line ${i} changed`)),
    ]
    expect(intralineRanges(lines).every((r) => r === null)).toBe(true)
  })
})

describe('splitByRanges', () => {
  it('passes a syntax token through untouched when nothing in it changed', () => {
    expect(splitByRanges('const', 0, [{ start: 6, end: 11 }])).toEqual([
      { text: 'const', changed: false },
    ])
  })

  it('splits a token that a range cuts through', () => {
    expect(splitByRanges('const total', 0, [{ start: 6, end: 11 }])).toEqual([
      { text: 'const ', changed: false },
      { text: 'total', changed: true },
    ])
  })

  it('handles a token starting mid-line, using its absolute offset', () => {
    expect(splitByRanges('total', 6, [{ start: 6, end: 11 }])).toEqual([
      { text: 'total', changed: true },
    ])
  })

  it('merges neighbouring pieces of the same kind', () => {
    const out = splitByRanges('abcd', 0, [
      { start: 0, end: 2 },
      { start: 2, end: 4 },
    ])
    expect(out).toEqual([{ text: 'abcd', changed: true }])
  })

  it('is a no-op with no ranges', () => {
    expect(splitByRanges('anything', 3, null)).toEqual([{ text: 'anything', changed: false }])
  })
})
