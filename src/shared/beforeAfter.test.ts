import { describe, expect, it } from 'vitest'
import { parseBeforeAfterInput } from './beforeAfter.js'
import { showsBeforeAfter } from './review.js'

describe('parseBeforeAfterInput', () => {
  it('accepts a list of titled sections, trimmed', () => {
    expect(
      parseBeforeAfterInput([
        { title: ' Expired-token login ', before: '  500 on expiry\n', after: '401, then a retry' },
        { title: 'Session length', before: '24 hours', after: '2 idle hours' },
      ]),
    ).toEqual({
      ok: true,
      value: [
        { title: 'Expired-token login', before: '500 on expiry', after: '401, then a retry' },
        { title: 'Session length', before: '24 hours', after: '2 idle hours' },
      ],
    })
  })

  it('reads a lone object as one section, which may go untitled', () => {
    expect(parseBeforeAfterInput({ before: 'a', after: 'b' })).toEqual({
      ok: true,
      value: [{ before: 'a', after: 'b' }],
    })
    expect(parseBeforeAfterInput([{ before: 'a', after: 'b' }])).toEqual({
      ok: true,
      value: [{ before: 'a', after: 'b' }],
    })
  })

  it('needs a title on every section when there are several', () => {
    expect(
      parseBeforeAfterInput([
        { title: 'One', before: 'a', after: 'b' },
        { before: 'a', after: 'b' },
      ]),
    ).toEqual({
      ok: false,
      error:
        'section 2: needs a "title" naming the behaviour (every section does when there are several)',
    })
  })

  it('ignores fields it does not know', () => {
    const parsed = parseBeforeAfterInput({ before: 'a', after: 'b', postedAt: 'x' })
    expect(parsed).toEqual({ ok: true, value: [{ before: 'a', after: 'b' }] })
  })

  it('refuses anything but sections, and more than five', () => {
    for (const raw of [null, 'before', 3, [3]]) {
      expect(parseBeforeAfterInput(raw)).toEqual({
        ok: false,
        error: 'a before/after must be JSON: [{ "title": "…", "before": "…", "after": "…" }]',
      })
    }
    expect(parseBeforeAfterInput([])).toEqual({ ok: false, error: 'needs at least one section' })
    const six = Array.from({ length: 6 }, (_, i) => ({ title: `t${i}`, before: 'a', after: 'b' }))
    expect(parseBeforeAfterInput(six)).toEqual({ ok: false, error: 'at most 5 sections, got 6' })
  })

  it('names the missing or empty side', () => {
    expect(parseBeforeAfterInput({ after: 'b' })).toEqual({
      ok: false,
      error: 'needs a non-empty "before"',
    })
    expect(parseBeforeAfterInput({ before: 'a', after: '  ' })).toEqual({
      ok: false,
      error: 'needs a non-empty "after"',
    })
    expect(parseBeforeAfterInput({ before: 'a', after: 3 })).toEqual({
      ok: false,
      error: '"after" must be a markdown string',
    })
  })

  it('caps a side at 4000 characters', () => {
    const parsed = parseBeforeAfterInput({ before: 'x'.repeat(5000), after: 'b' })
    expect(parsed.ok && parsed.value[0]!.before.length).toBe(4000)
  })
})

describe('showsBeforeAfter', () => {
  const post = { sections: [{ before: 'a', after: 'b' }], postedAt: '2026-01-01T00:00:00.000Z' }

  it('follows the agent until the reviewer flips the toggle', () => {
    expect(showsBeforeAfter({})).toBe(false)
    expect(showsBeforeAfter({ beforeAfter: post })).toBe(true)
  })

  it('lets the reviewer overrule either way', () => {
    expect(showsBeforeAfter({ beforeAfter: post, beforeAfterToggle: false })).toBe(false)
    expect(showsBeforeAfter({ beforeAfterToggle: true })).toBe(true)
  })
})
