// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'

/* Stock mermaid is the fallback renderer, and the real thing doesn't survive
 * jsdom (no layout, no getBBox). The mock keeps the routing observable: a
 * fence that lands here parses iff its source carries the `parses` marker. */
const fallback = { parse: vi.fn(), render: vi.fn(), initialize: vi.fn() }
vi.mock('mermaid', () => ({ default: fallback }))

/* Real beautiful-mermaid, except a marker source throws: its parser is so
 * lenient that no natural input with a supported header rejects, and the
 * fall-back-on-throw branch still deserves a test. */
vi.mock('beautiful-mermaid', async (importOriginal) => {
  const real = await importOriginal<typeof import('beautiful-mermaid')>()
  return {
    ...real,
    renderMermaidSVG: (src: string, opts?: object) => {
      if (src.includes('FORCE-THROW')) throw new Error('unsupported construct')
      return real.renderMermaidSVG(src, opts)
    },
  }
})

import { layerLinkHref, refClickTarget } from './layers.js'
import { diagramRef, linkDiagramRefs, renderMermaidIn } from './mermaid.js'

// jsdom has no matchMedia; the fallback renderer's theme pick needs one, and
// the theme watcher subscribes to its change event.
window.matchMedia = ((query: string) =>
  ({
    matches: false,
    media: query,
    addEventListener: () => {},
  }) as unknown as MediaQueryList) as typeof window.matchMedia

fallback.parse.mockImplementation(async (source: string) => {
  if (!source.includes('parses')) throw new Error('parse error')
})
fallback.render.mockImplementation(async (id: string) => ({
  svg: `<svg data-renderer="mermaid" id="${id}"></svg>`,
}))

function fence(source: string): HTMLElement {
  const root = document.createElement('div')
  const pre = document.createElement('pre')
  const code = document.createElement('code')
  code.className = 'language-mermaid'
  code.textContent = source
  pre.append(code)
  root.append(pre)
  document.body.append(root)
  return root
}

beforeEach(() => {
  document.body.innerHTML = ''
  document.documentElement.removeAttribute('data-theme')
  vi.clearAllMocks()
})

describe('renderMermaidIn', () => {
  it('renders a flowchart through beautiful-mermaid, themed by CSS variables', async () => {
    const root = fence('flowchart LR\n  a[Agent] --> b[Reviewer]')
    await renderMermaidIn(root)
    const figure = root.querySelector('.mermaid-figure')
    expect(figure).not.toBeNull()
    const svg = figure?.innerHTML ?? ''
    expect(svg).toContain('<svg')
    expect(svg).toContain('var(--fill)')
    expect(svg).toContain('var(--ink)')
    expect(root.querySelector('pre')).toBeNull()
    expect(fallback.parse).not.toHaveBeenCalled()
  })

  it('strips the Google Fonts @import — no diagram phones home', async () => {
    const root = fence('graph TD\n  a --> b')
    await renderMermaidIn(root)
    const svg = root.querySelector('.mermaid-figure')?.innerHTML ?? ''
    expect(svg).not.toContain('@import')
    expect(svg).not.toContain('fonts.googleapis.com')
  })

  it('leading comment lines do not hide the diagram type', async () => {
    const root = fence('%% a note first\ngraph LR\n  a --> b')
    await renderMermaidIn(root)
    expect(root.querySelector('.mermaid-figure')).not.toBeNull()
    expect(fallback.parse).not.toHaveBeenCalled()
  })

  it('routes a type beautiful-mermaid lacks to stock mermaid', async () => {
    const root = fence('pie parses\n  "a": 1')
    await renderMermaidIn(root)
    const svg = root.querySelector('.mermaid-figure')?.innerHTML ?? ''
    expect(svg).toContain('data-renderer="mermaid"')
    expect(fallback.parse).toHaveBeenCalledTimes(1)
  })

  it('falls back to stock mermaid when beautiful-mermaid rejects a supported header', async () => {
    // A rejected fence must get the second renderer, not a broken note.
    const root = fence('flowchart LR\n  FORCE-THROW parses')
    await renderMermaidIn(root)
    const svg = root.querySelector('.mermaid-figure')?.innerHTML ?? ''
    expect(svg).toContain('data-renderer="mermaid"')
  })

  it('a fence neither renderer takes degrades to source with a note', async () => {
    const root = fence('gitGraph\n  nonsense')
    await renderMermaidIn(root)
    expect(root.querySelector('.mermaid-figure')).toBeNull()
    expect(root.querySelector('.mermaid-broken')).not.toBeNull()
    expect(root.querySelector('pre')?.textContent).toContain('nonsense')
  })

  it('overlapping passes note a broken fence exactly once', async () => {
    // Real usage: every upgrade mutates the DOM, and the caller's
    // MutationObserver schedules a fresh pass while the first is mid-await.
    const root = fence('graph LR\n  a --> b')
    const pre2 = document.createElement('pre')
    const code2 = document.createElement('code')
    code2.className = 'language-mermaid'
    code2.textContent = 'notadiagram\n  nonsense'
    pre2.append(code2)
    root.append(pre2)
    await Promise.all([renderMermaidIn(root), renderMermaidIn(root), renderMermaidIn(root)])
    expect(root.querySelectorAll('.mermaid-broken')).toHaveLength(1)
    expect(root.querySelectorAll('.mermaid-figure')).toHaveLength(1)
  })

  it('is idempotent — a second pass leaves the upgraded DOM alone', async () => {
    const root = fence('graph LR\n  a --> b')
    await renderMermaidIn(root)
    const first = root.innerHTML
    await renderMermaidIn(root)
    expect(root.innerHTML).toBe(first)
  })

  it('re-renders a stock-mermaid figure when the theme flips', async () => {
    // Stock mermaid bakes its palette in; the figure must be redrawn live, not
    // wait for a reload.
    const root = fence('pie parses\n  "a": 1')
    await renderMermaidIn(root)
    const figure = root.querySelector<HTMLElement>('.mermaid-figure')!
    const before = figure.innerHTML
    fallback.initialize.mockClear()
    document.documentElement.setAttribute('data-theme', 'dark')
    await vi.waitFor(() => expect(figure.innerHTML).not.toBe(before))
    expect(fallback.initialize).toHaveBeenCalledWith(expect.objectContaining({ theme: 'dark' }))
    expect(figure.innerHTML).toContain('data-renderer="mermaid"')
  })

  it('leaves a beautiful-mermaid figure alone on a theme flip — CSS retheming covers it', async () => {
    const root = fence('graph LR\n  a --> b')
    await renderMermaidIn(root)
    const figure = root.querySelector<HTMLElement>('.mermaid-figure')!
    expect(figure.dataset.mermaidSource).toBeUndefined()
    const before = figure.innerHTML
    document.documentElement.setAttribute('data-theme', 'dark')
    // MutationObserver delivery + any (wrong) re-render would land within a tick.
    await new Promise((r) => setTimeout(r, 20))
    expect(figure.innerHTML).toBe(before)
  })
})

describe('linkDiagramRefs — the map as navigation', () => {
  const known = ['src/ui/layers.ts', 'src/server/prompt.ts', 'src/a/util.ts', 'src/b/util.ts']

  it('reads a path or path:line out of a label, the way a summary code span is read', () => {
    expect(diagramRef('src/ui/layers.ts', known)).toEqual({ path: 'src/ui/layers.ts', line: null })
    expect(diagramRef('prompt.ts:183 · GUIDE', known)).toEqual({
      path: 'src/server/prompt.ts',
      line: 183,
    })
    expect(diagramRef('resolveLayers (layers.ts)', known)).toEqual({
      path: 'src/ui/layers.ts',
      line: null,
    })
    // An ambiguous basename, a function name, and a plain word resolve to nothing.
    expect(diagramRef('util.ts', known)).toBeNull()
    expect(diagramRef('withToolResultCap', known)).toBeNull()
    expect(diagramRef('SDK steps', known)).toBeNull()
  })

  it('tags the labels that name a file, leaves the rest, and is idempotent', async () => {
    const root = fence(
      'flowchart LR\n  a["src/ui/layers.ts:111<br/>resolveLayers"] --> b[SDK steps]\n  b --> c[prompt.ts]',
    )
    await renderMermaidIn(root)
    linkDiagramRefs(root, known)
    const tagged = Array.from(root.querySelectorAll('text[data-diffo-jump]'))
    expect(tagged.map((t) => t.getAttribute('data-diffo-jump'))).toEqual([
      layerLinkHref('src/ui/layers.ts', 111),
      layerLinkHref('src/server/prompt.ts', null),
    ])
    for (const t of tagged) {
      expect(t.classList.contains('diffo-ref')).toBe(true)
      expect(t.getAttribute('role')).toBe('link')
      expect(t.getAttribute('tabindex')).toBe('0')
    }
    const plain = root.querySelector('text[data-diffo-plain]')!
    expect(plain.textContent).toBe('SDK steps')
    const before = root.innerHTML
    linkDiagramRefs(root, known)
    expect(root.innerHTML).toBe(before)
  })

  it('is a no-op with no paths, no figure, or no root', async () => {
    const root = fence('flowchart LR\n  a[src/ui/layers.ts] --> b')
    await renderMermaidIn(root)
    linkDiagramRefs(root, [])
    expect(root.querySelector('[data-diffo-jump]')).toBeNull()
    const empty = document.createElement('div')
    empty.innerHTML = '<p>no diagram</p>'
    linkDiagramRefs(empty, known)
    expect(empty.innerHTML).toBe('<p>no diagram</p>')
    linkDiagramRefs(null, known)
  })

  it('a click resolves a prose link and a tagged diagram label alike', () => {
    document.body.innerHTML = `
      <div>
        <a href="${layerLinkHref('src/weekday.ts', 42)}"><code>weekday.ts:42</code></a>
        <svg><text data-diffo-jump="${layerLinkHref('src/dates.ts', null)}">src/dates.ts</text></svg>
        <a href="https://example.com">out</a>
        <span>plain</span>
      </div>`
    expect(refClickTarget(document.querySelector('code')!)).toEqual({
      path: 'src/weekday.ts',
      line: 42,
    })
    expect(refClickTarget(document.querySelector('text')!)).toEqual({
      path: 'src/dates.ts',
      line: null,
    })
    expect(refClickTarget(document.querySelector('a[href^="https"]')!)).toBeNull()
    expect(refClickTarget(document.querySelector('span')!)).toBeNull()
  })
})
