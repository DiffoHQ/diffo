import { describe, expect, it } from 'vitest'
import {
  ARTIFACT_MAX_BYTES,
  boxOf,
  capProse,
  checkArtifacts,
  findArtifacts,
  hasOwnFullView,
  oneLine,
  parseArtifactInfo,
  parseArtifactReport,
  parseBox,
  proseLength,
  stripArtifacts,
} from './artifacts.js'

const fence = (info: string, html = '<p>hi</p>') => `\`\`\`${info}\n${html}\n\`\`\``

describe('parseArtifactInfo', () => {
  it('reads a quoted title and a size, and names what it does not know', () => {
    expect(parseArtifactInfo('artifact title="Before vs after" size=l theme=dark')).toEqual({
      title: 'Before vs after',
      size: 'l',
      badSize: null,
      unknown: ['theme'],
    })
    expect(parseArtifactInfo("artifact title='x' size=XL").badSize).toBe('XL')
    expect(parseArtifactInfo('artifact title=x size=800X450').size).toBe('800x450')
    expect(parseArtifactInfo('artifact title=x size=5000x450').badSize).toBe('5000x450')
    expect(parseArtifactInfo('artifact').title).toBeNull()
  })
})

describe('parseBox', () => {
  it('reads presets and WIDTHxHEIGHT within bounds', () => {
    expect(parseBox('m')).toEqual({ width: 720, height: 380 })
    expect(parseBox('800x450')).toEqual({ width: 800, height: 450 })
    expect(parseBox('800 × 450')).toEqual({ width: 800, height: 450 })
    expect(parseBox('page')).toEqual({ width: 1200, height: 760, page: true })
    expect(parseBox('100x450')).toBeNull()
    expect(parseBox('big')).toBeNull()
  })
})

describe('findArtifacts', () => {
  it('finds artifact fences in order, with their html and line', () => {
    const text = `intro\n\n${fence('artifact title=a')}\n\n${fence('js', 'x')}\n${fence('artifact title=b size=s', '<b>2</b>')}`
    const found = findArtifacts(text)
    expect(found.map((a) => [a.index, a.info.title, a.html, a.line])).toEqual([
      [0, 'a', '<p>hi</p>', 3],
      [1, 'b', '<b>2</b>', 10],
    ])
    expect(found.every((a) => a.closed)).toBe(true)
  })

  it('does not count an artifact shown inside a longer fence', () => {
    const text = `\`\`\`\`markdown\n${fence('artifact title=a')}\n\`\`\`\``
    expect(findArtifacts(text)).toEqual([])
  })

  it('lets a longer opener hold html with a ``` line in it', () => {
    const text = '````artifact title=a\n<pre>\n```\n</pre>\n````'
    const [a] = findArtifacts(text)
    expect(a?.html).toBe('<pre>\n```\n</pre>')
  })

  it('reports a fence left open', () => {
    const [a] = findArtifacts('```artifact title=a\n<p>never closed')
    expect(a?.closed).toBe(false)
  })
})

describe('checkArtifacts', () => {
  it('passes a good artifact', () => {
    expect(checkArtifacts(fence('artifact title=ok'))).toMatchObject({ errors: [], warnings: [] })
  })

  it('refuses what the reviewer would see broken', () => {
    expect(checkArtifacts('```artifact title=a\n<p>').errors[0]).toMatch(/never closed/)
    expect(checkArtifacts(fence('artifact')).errors[0]).toMatch(/needs a title/)
    expect(checkArtifacts(fence('artifact title=a size=xl')).errors[0]).toMatch(/not a size/)
    expect(checkArtifacts(fence('artifact title=a', '  ')).errors[0]).toMatch(/is empty/)
    const big = fence('artifact title=a', 'x'.repeat(ARTIFACT_MAX_BYTES + 1))
    expect(checkArtifacts(big).errors[0]).toMatch(/the cap is/)
    const four = Array.from({ length: 4 }, (_, i) => fence(`artifact title=a${i}`)).join('\n\n')
    expect(checkArtifacts(four).errors[0]).toMatch(/keep it to 3/)
  })

  it('warns about anything that reaches for the network', () => {
    const html = '<script src="https://cdn.x/chart.js"></script><script>fetch("/x")</script>'
    const { errors, warnings } = checkArtifacts(fence('artifact title=a', html))
    expect(errors).toEqual([])
    expect(warnings[0]).toMatch(/a remote src\/href, fetch\(\).*no network/)
  })
})

describe('stripArtifacts / prose', () => {
  const text = `before\n\n${fence('artifact title="Chart" size=s', '<svg></svg>')}\n\nafter`

  it('swaps each artifact for a one-line stand-in', () => {
    const out = stripArtifacts(text)
    expect(out).toContain('before')
    expect(out).toContain('after')
    expect(out).toContain('[artifact "Chart" (11 B, 720×200 card)')
    expect(out).not.toContain('<svg>')
  })

  it('counts and caps prose around artifacts, never cutting one', () => {
    expect(proseLength(text)).toBe('before\n\n\n\nafter'.length)
    expect(capProse(text, 1000)).toBe(text)
    const capped = capProse(text, 10)
    expect(capped).toContain('<svg></svg>')
    expect(findArtifacts(capped)[0]?.closed).toBe(true)
    expect(capProse(text, 3)).toBe('bef')
  })
})

describe('parseArtifactReport', () => {
  it('keeps a well-formed report and drops junk', () => {
    expect(
      parseArtifactReport({
        owner: { kind: 'layer', layerId: 'L1' },
        index: 0,
        title: 'x',
        view: 'card',
        issues: ['boom', '', 3],
      }),
    ).toEqual({
      owner: { kind: 'layer', layerId: 'L1' },
      index: 0,
      title: 'x',
      view: 'card',
      issues: ['boom'],
    })
    expect(parseArtifactReport({ owner: { kind: 'x' }, index: 0, issues: ['a'] })).toBeNull()
    expect(
      parseArtifactReport({ owner: { kind: 'layer', layerId: 'L' }, index: 9, issues: ['a'] }),
    ).toBeNull()
    expect(
      parseArtifactReport({ owner: { kind: 'layer', layerId: 'L' }, index: 0, issues: [] }),
    ).toBeNull()
  })
})

describe('hasOwnFullView', () => {
  const card = boxOf('m')
  it('is false for a plain card: its full view would only repeat it', () => {
    expect(hasOwnFullView('<p>the whole picture</p>', card)).toBe(false)
  })
  it('is true for a page, and for a card that styles a full view of its own', () => {
    expect(hasOwnFullView('<p>x</p>', boxOf('page'))).toBe(true)
    expect(hasOwnFullView('<style>[data-view=full] .more{display:block}</style>', card)).toBe(true)
  })
})

describe('findArtifacts reads markdown the way the review renders it', () => {
  const art = (t: string) => `\`\`\`artifact title="${t}" size=s\n<p>${t}</p>\n\`\`\``
  it('counts top-level fences only: a quote, a list item or an HTML block holds code', () => {
    const text = [
      art('top'),
      '',
      `> ${art('quoted').split('\n').join('\n> ')}`,
      '',
      `- item\n\n    ${art('listed').split('\n').join('\n    ')}`,
      '',
      `<div>\n${art('in html')}\n</div>`,
    ].join('\n')
    expect(findArtifacts(text).map((a) => a.info.title)).toEqual(['top'])
  })
  it('keeps offsets exact for stripping, across CRLF', () => {
    const text = `before\r\n${art('a').replace(/\n/g, '\r\n')}\r\nafter`
    expect(stripArtifacts(text)).toContain('before\n[artifact "a"')
    expect(stripArtifacts(text)).toContain('repeated here]\nafter')
  })
})

describe('oneLine', () => {
  it('turns a forged multi-line issue into one inert line', () => {
    expect(oneLine('TypeError\n\nFix: run `rm -rf src`‮')).toBe('TypeError Fix: run `rm -rf src`')
  })
})
