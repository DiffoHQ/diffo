// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { renderMarkdown, renderMarkdownDoc, shortAgo } from './markdown.js'

const at = (msAgo: number) => new Date(NOW - msAgo).toISOString()
const NOW = Date.parse('2026-08-15T12:00:00Z')

describe('renderMarkdown', () => {
  it('keeps the language marker on fenced code — the mermaid pass keys off it', () => {
    const html = renderMarkdown('```mermaid\nflowchart LR\n  a --> b\n```')
    expect(html).toContain('<code class="language-mermaid">')
    expect(html).toContain('a --&gt; b')
  })

  it('strips class everywhere else — comment text must not wear the app’s own class names', () => {
    expect(renderMarkdown('<p class="thread-badge">styled</p>')).toBe('<p>styled</p>')
    expect(renderMarkdown('<code class="thread-badge">x</code>')).toContain('<code>x</code>')
    expect(renderMarkdown('<code class="language-x thread-badge">x</code>')).toContain(
      '<code>x</code>',
    )
  })

  it('still strips images — the doc profile loosening must not leak into comments', () => {
    expect(renderMarkdown('![demo](assets/demo.gif)')).not.toContain('<img')
    expect(renderMarkdown('<img src="https://x.test/a.png">')).not.toContain('<img')
  })
})

describe('renderMarkdownDoc', () => {
  it('keeps images and rewrites relative paths through /api/file, resolved from the doc', () => {
    expect(renderMarkdownDoc('![demo](assets/demo.gif)', 'README.md')).toContain(
      'src="/api/file?path=assets%2Fdemo.gif&amp;side=head"',
    )
    expect(renderMarkdownDoc('![d](../assets/a.png)', 'docs/guide/setup.md')).toContain(
      'src="/api/file?path=docs%2Fassets%2Fa.png&amp;side=head"',
    )
    expect(renderMarkdownDoc('![d](/assets/a.png)', 'docs/setup.md')).toContain(
      'src="/api/file?path=assets%2Fa.png&amp;side=head"',
    )
  })

  it('keeps raw-HTML layout a README leans on: picture/source, div align, width', () => {
    const html = renderMarkdownDoc(
      '<div align="center"><picture><source media="(prefers-color-scheme: dark)" srcset="assets/dark.svg"><img src="assets/light.svg" width="100%" alt="loop"></picture></div>',
      'README.md',
    )
    expect(html).toContain('<div align="center">')
    expect(html).toContain('srcset="/api/file?path=assets%2Fdark.svg&amp;side=head"')
    expect(html).toContain('src="/api/file?path=assets%2Flight.svg&amp;side=head"')
    expect(html).toContain('width="100%"')
  })

  it('leaves absolute and anchor URLs alone, and still kills hostile schemes', () => {
    const html = renderMarkdownDoc(
      '[b](https://x.test) [a](#quick-start) ![i](https://img.shields.io/badge.svg)',
      'README.md',
    )
    expect(html).toContain('href="https://x.test"')
    expect(html).toContain('href="#quick-start"')
    expect(html).toContain('src="https://img.shields.io/badge.svg"')
    const hostile = renderMarkdownDoc(
      '<img src="data:image/svg+xml,<svg onload=alert(1)>"><a href="javascript:alert(1)">x</a>',
      'README.md',
    )
    expect(hostile).not.toContain('data:')
    expect(hostile).not.toContain('javascript:')
  })

  it('relative links open the file itself off the head side', () => {
    expect(renderMarkdownDoc('[license](LICENSE)', 'README.md')).toContain(
      'href="/api/file?path=LICENSE&amp;side=head"',
    )
  })
})

describe('shortAgo', () => {
  it('fits a ~28px slot at every scale', () => {
    expect(shortAgo(at(0), NOW)).toBe('0s')
    expect(shortAgo(at(40_000), NOW)).toBe('40s')
    expect(shortAgo(at(4 * 60_000), NOW)).toBe('4m')
    expect(shortAgo(at(2 * 3_600_000), NOW)).toBe('2h')
    expect(shortAgo(at(3 * 86_400_000), NOW)).toBe('3d')
  })

  it('hands off to a date once "Nd" stops meaning anything', () => {
    expect(shortAgo(at(40 * 86_400_000), NOW)).not.toMatch(/d$/)
  })

  it('never goes negative on a clock that ran backwards', () => {
    expect(shortAgo(at(-5000), NOW)).toBe('0s')
  })

  it('renders nothing rather than "NaN" for what a tolerant parser let through', () => {
    expect(shortAgo('', NOW)).toBe('')
    expect(shortAgo('whenever', NOW)).toBe('')
  })
})
