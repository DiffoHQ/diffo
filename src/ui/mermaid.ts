import DOMPurify from 'dompurify'

/**
 * Diagrams in comments. The agent writes a ```mermaid fence like any other
 * markdown; renderMarkdown lets it through as a plain code block, and this pass
 * upgrades those blocks to inline SVG after the HTML is in the DOM.
 *
 * Mermaid never receives HTML — only the fence's text content — and its SVG
 * output goes back through DOMPurify before insertion, so the markdown
 * sanitiser stays the single trust boundary. The library itself (~1.5 MB) loads
 * on the first comment that actually contains a diagram, not before.
 */

type MermaidApi = typeof import('mermaid').default

let loading: Promise<MermaidApi> | null = null
let loadedTheme: string | null = null
let seq = 0

/** A private DOMPurify, so no hook anyone hangs on the default instance can
 * reach in here — mermaid's SVG is nothing but classes plus a stylesheet. */
const svgPurify = DOMPurify()

function wantedTheme(): 'dark' | 'neutral' {
  const forced = document.documentElement.getAttribute('data-theme')
  if (forced === 'dark') return 'dark'
  if (forced === 'light') return 'neutral'
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'neutral'
}

async function loadMermaid(): Promise<MermaidApi> {
  if (!loading) {
    loading = import('mermaid').then((m) => m.default)
  }
  const mermaid = await loading
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
  const mermaid = await loadMermaid()
  for (const pre of mermaidBlocks(root)) {
    // React may have re-rendered (or unmounted) while the library loaded.
    if (!pre.isConnected) continue
    pre.setAttribute('data-mermaid-done', '')
    const source = pre.textContent ?? ''
    try {
      await mermaid.parse(source)
      const { svg } = await mermaid.render(`diffo-mermaid-${++seq}`, source)
      const figure = document.createElement('div')
      figure.className = 'mermaid-figure'
      figure.innerHTML = svgPurify.sanitize(svg, {
        USE_PROFILES: { svg: true, svgFilters: true },
      })
      pre.replaceWith(figure)
    } catch {
      if (!pre.isConnected) continue
      const note = document.createElement('div')
      note.className = 'mermaid-broken'
      note.textContent = "diagram didn't parse — showing its source"
      pre.before(note)
    }
  }
}
