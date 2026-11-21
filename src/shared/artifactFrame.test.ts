import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { frameDoc, readFrameReport, STATIC_THEMES, THEME_TOKENS } from './artifactFrame.js'

/** The value styles.css gives each token in the block that opens with `selector {`. */
function tokens(css: string, selector: string): Map<string, string> {
  const at = css.indexOf(`${selector} {`)
  const body = css.slice(css.indexOf('{', at) + 1, css.indexOf('\n}', at))
  const out = new Map<string, string>()
  for (const m of body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g))
    if (!out.has(m[1]!)) out.set(m[1]!, m[2]!.replace(/\s+/g, ' ').trim())
  return out
}

describe('STATIC_THEMES', () => {
  const css = readFileSync(join(import.meta.dirname, '../ui/styles.css'), 'utf-8')
  it.each([
    ['light', ':root'],
    ['dark', ':root[data-theme="dark"]'],
  ] as const)(
    'match styles.css for %s, so the preview paints what the review does',
    (scheme, selector) => {
      const live = tokens(css, selector)
      const base = tokens(css, ':root')
      for (const name of THEME_TOKENS) {
        const want = live.get(name) ?? base.get(name)
        expect(STATIC_THEMES[scheme].vars[name], name).toBe(want)
      }
    },
  )
})

describe('readFrameReport', () => {
  it("reads the preview host's tally off <html> in a DOM dump, once the frame settled", () => {
    const tally = (ready: string) =>
      `<html data-diffo-report="{&quot;issues&quot;:[&quot;a &amp; b&quot;],&quot;height&quot;:120,&quot;width&quot;:720${ready}}">`
    expect(readFrameReport(tally(',&quot;ready&quot;:1'))).toEqual({
      issues: ['a & b'],
      height: 120,
      width: 720,
    })
    // Never settled: an endless loop, a script that blocks.
    expect(readFrameReport(tally(''))).toBeNull()
    expect(readFrameReport('<html>')).toBeNull()
  })

  it('stamps messages with the frame token, hides it, and removes WebRTC', () => {
    const doc = frameDoc('<p>x</p>', 'card', STATIC_THEMES.dark, { width: 720 }, 'abc123')
    expect(doc).toContain('T="abc123"')
    expect(doc).toContain('document.currentScript')
    expect(doc).toContain("'RTCPeerConnection'")
  })

  it('is what frameDoc boots with', () => {
    expect(frameDoc('<p>x</p>', 'card', STATIC_THEMES.dark)).toContain('data-diffo-report')
  })
})

describe('frameDoc boot', () => {
  it('forwards Escape: focus in the frame keeps keys from the full view that would close', () => {
    const doc = frameDoc('<p>x</p>', 'full', STATIC_THEMES.light, { width: 720 })
    expect(doc).toContain("e.key==='Escape'")
    expect(doc).toContain("post({type:'escape'})")
  })
})
