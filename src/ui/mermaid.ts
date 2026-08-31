import DOMPurify from 'dompurify'

/**
 * Diagrams in comments. The agent writes a ```mermaid fence like any other
 * markdown; renderMarkdown lets it through as a plain code block, and this pass
 * upgrades those blocks to inline SVG after the HTML is in the DOM.
 *
 * Two renderers, one pass. beautiful-mermaid draws the common types
 * (flowchart, sequence, state, class, ER, xychart) — its SVG is themed with
 * Diffo's own CSS variables, so a diagram follows a light/dark switch live
 * without re-rendering. Everything it can't parse — the rarer types (pie,
 * gantt, gitGraph, …) and any flowchart feature outside its subset — falls
 * back to stock mermaid, themed once at render time like before.
 *
 * Neither renderer ever receives HTML — only the fence's text content — and
 * both SVG outputs go back through DOMPurify before insertion, so the markdown
 * sanitiser stays the single trust boundary. Both libraries load lazily, on
 * the first comment that actually contains a diagram.
 */

type MermaidApi = typeof import('mermaid').default
type BeautifulApi = typeof import('beautiful-mermaid')

let loadingBeautiful: Promise<BeautifulApi> | null = null
let loadingMermaid: Promise<MermaidApi> | null = null
let loadedTheme: string | null = null
let seq = 0

/** A private DOMPurify, so no hook anyone hangs on the default instance can
 * reach in here — both renderers' SVG is nothing but shapes plus a stylesheet. */
const svgPurify = DOMPurify()

/** The diagram types beautiful-mermaid renders, by header keyword. Covers
 * `graph`/`flowchart`, `stateDiagram(-v2)`, and `xychart-beta` via prefix. */
const BEAUTIFUL_HEADER =
  /^(graph|flowchart|stateDiagram|sequenceDiagram|classDiagram|erDiagram|xychart)\b/

function beautifulSupports(source: string): boolean {
  for (const raw of source.split('\n')) {
    const line = raw.trim()
    if (line === '' || line.startsWith('%%')) continue
    return BEAUTIFUL_HEADER.test(line)
  }
  return false
}

/** Diffo's tokens, not a palette of our own: bg + fg alone put the renderer in
 * mono mode, and every derived shade is a color-mix() of these two variables —
 * so the SVG re-colors itself when the app's theme flips. */
const BEAUTIFUL_OPTIONS = {
  bg: 'var(--fill)',
  fg: 'var(--ink)',
  transparent: true,
  // Quoted single-family slot in the SVG's stylesheet; the unquoted
  // `system-ui` fallback the lib appends is what actually resolves.
  font: 'system-ui',
} as const

/** The lib hardwires a Google Fonts @import into the SVG's stylesheet. Diffo
 * is local-first — no page may phone home for a font — so cut it out; text
 * falls through to the system-ui fallback in the same rule. */
function stripFontImports(svg: string): string {
  return svg.replace(/@import url\([^)]*\);?/g, '')
}

async function loadBeautiful(): Promise<BeautifulApi> {
  if (!loadingBeautiful) {
    loadingBeautiful = import('beautiful-mermaid')
  }
  return loadingBeautiful
}

function wantedTheme(): 'dark' | 'neutral' {
  const forced = document.documentElement.getAttribute('data-theme')
  if (forced === 'dark') return 'dark'
  if (forced === 'light') return 'neutral'
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'neutral'
}

async function loadMermaid(): Promise<MermaidApi> {
  if (!loadingMermaid) {
    loadingMermaid = import('mermaid').then((m) => m.default)
  }
  const mermaid = await loadingMermaid
  const theme = wantedTheme()
  // Theme is fixed at initialize time; re-initialize when the app's theme moved
  // since the last render so new diagrams match the page they land on.
  if (loadedTheme !== theme) {
    loadedTheme = theme
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      theme,
      // Labels as real SVG <text>, not <foreignObject> HTML — the sanitiser
      // below strips foreignObject, and rightly so. And no shrink-to-fit:
      // a wide diagram scrolls inside its figure at readable size rather than
      // scaling its text away.
      htmlLabels: false,
      flowchart: { htmlLabels: false, useMaxWidth: false },
      sequence: { useMaxWidth: false },
      state: { useMaxWidth: false },
      er: { useMaxWidth: false },
      class: { useMaxWidth: false },
      pie: { useMaxWidth: false },
    })
  }
  return mermaid
}

/** Render one fence's source to SVG, or null when neither renderer takes it. */
async function renderDiagram(source: string): Promise<string | null> {
  if (beautifulSupports(source)) {
    try {
      const bm = await loadBeautiful()
      return stripFontImports(bm.renderMermaidSVG(source, BEAUTIFUL_OPTIONS))
    } catch {
      // Its parser covers a subset even of the types it claims — a flowchart
      // feature it doesn't know lands here. Stock mermaid gets the next try.
    }
  }
  try {
    const mermaid = await loadMermaid()
    await mermaid.parse(source)
    const { svg } = await mermaid.render(`diffo-mermaid-${++seq}`, source)
    return svg
  } catch {
    return null
  }
}

/** The blocks this pass upgrades: `<pre><code class="language-mermaid">`. */
function mermaidBlocks(root: HTMLElement): HTMLPreElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>('code.language-mermaid'))
    .map((code) => code.closest('pre'))
    .filter((pre): pre is HTMLPreElement => pre !== null && !pre.hasAttribute('data-mermaid-done'))
}

/**
 * Replace every mermaid fence under `root` with its rendered diagram. A fence
 * that fails to parse stays visible as code with a note — a bad diagram must
 * degrade to text, never to a broken comment. Safe to call repeatedly on the
 * same subtree; rendered figures no longer match the selector.
 */
export async function renderMermaidIn(root: HTMLElement | null): Promise<void> {
  if (!root || mermaidBlocks(root).length === 0) return
  for (const pre of mermaidBlocks(root)) {
    // The pass awaits between fences, and each upgrade is a DOM mutation that
    // makes the caller schedule another pass — so passes overlap, each holding
    // its own snapshot. Marking a fence claims it; a fence already marked
    // since this snapshot was taken belongs to another pass. Without this, a
    // failing fence (which stays in the DOM) collects one note per pass.
    if (pre.hasAttribute('data-mermaid-done')) continue
    pre.setAttribute('data-mermaid-done', '')
    const source = pre.textContent ?? ''
    const svg = await renderDiagram(source)
    // React may have re-rendered (or unmounted) while a renderer loaded.
    if (!pre.isConnected) continue
    if (svg === null) {
      const note = document.createElement('div')
      note.className = 'mermaid-broken'
      note.textContent = "diagram didn't parse — showing its source"
      pre.before(note)
      continue
    }
    const figure = document.createElement('div')
    figure.className = 'mermaid-figure'
    figure.innerHTML = svgPurify.sanitize(svg, {
      USE_PROFILES: { svg: true, svgFilters: true },
    })
    pre.replaceWith(figure)
  }
}
