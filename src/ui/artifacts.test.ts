import { describe, expect, it } from 'vitest'
import { CSP, frameDoc, layerOwner, messageOwner, parseOwner, SANDBOX } from './artifacts.js'

const theme = { scheme: 'dark' as const, vars: { '--ink': '#eee', '--paper': '#111' } }

describe('frameDoc', () => {
  it('puts the policy first, before any of the agent html can run', () => {
    const doc = frameDoc(
      '<!DOCTYPE html><html><body><script>x()</script></body></html>',
      'card',
      theme,
    )
    expect(doc.startsWith('<!doctype html><html data-view="card" data-theme="dark"><head>')).toBe(
      true,
    )
    const policy = doc.indexOf('Content-Security-Policy')
    expect(policy).toBeGreaterThan(0)
    expect(policy).toBeLessThan(doc.indexOf('x()'))
    // The agent's doctype is dropped so ours stays first (standards mode).
    expect(doc.match(/<!doctype/gi)).toHaveLength(1)
  })

  it('carries the theme tokens and the view', () => {
    const doc = frameDoc('<p>a</p>', 'full', theme)
    expect(doc).toContain('--ink:#eee')
    expect(doc).toContain('color-scheme:dark')
    expect(doc).toContain('data-view="full"')
  })

  it("centres a card's full view at its box width, and leaves a page the window", () => {
    expect(frameDoc('<p>a</p>', 'full', theme, { width: 720 })).toContain(
      ':where(html[data-view=full]) body{max-width:720px',
    )
    expect(frameDoc('<p>a</p>', 'full', theme, { width: 1200, page: true })).not.toContain(
      'max-width:1200px',
    )
  })

  it('allows no network and no same-origin access', () => {
    expect(CSP).toContain("default-src 'none'")
    expect(CSP).toContain("connect-src 'none'")
    expect(CSP).not.toMatch(/https?:/)
    expect(SANDBOX).toBe('allow-scripts')
  })
})

describe('owners', () => {
  it('round-trips through the string the memoised Markdown carries', () => {
    expect(parseOwner(messageOwner('t-1', 'm-2'))).toEqual({
      kind: 'message',
      threadId: 't-1',
      messageId: 'm-2',
    })
    expect(parseOwner(layerOwner('L1'))).toEqual({ kind: 'layer', layerId: 'L1' })
    expect(parseOwner(undefined)).toBeNull()
  })
})
