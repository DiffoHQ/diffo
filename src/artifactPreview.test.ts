import { describe, expect, it } from 'vitest'
import { chromeCandidates, htmlTitle } from './artifactPreview.js'

describe('chromeCandidates', () => {
  it('puts DIFFO_CHROME first, then the platform browsers', () => {
    const mac = chromeCandidates('darwin', { DIFFO_CHROME: '/x/chrome' })
    expect(mac[0]).toBe('/x/chrome')
    expect(mac).toContain('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')
    const linux = chromeCandidates('linux', { PATH: '/usr/bin' })
    expect(linux).toContain('/usr/bin/chromium')
  })
})

describe('htmlTitle', () => {
  it('takes the page title, else the file name', () => {
    expect(htmlTitle('<title> Cache hits </title>', 'a.html')).toBe('Cache hits')
    expect(htmlTitle('<p>x</p>', '/tmp/flow-chart.html')).toBe('flow-chart')
  })
})
