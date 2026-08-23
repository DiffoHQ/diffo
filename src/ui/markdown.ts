import DOMPurify from 'dompurify'
import { marked } from 'marked'

/**
 * Comment bodies render markdown, because agent replies *arrive* as markdown —
 * plain `pre-wrap` showed the reviewer raw `**bold**` and unrendered bullet lists.
 *
 * `marked` parses; DOMPurify is the trust boundary. A reply is written by a process
 * we spawned, but it is still text from outside the app landing in the DOM.
 */

marked.setOptions({
  gfm: true,
  breaks: true,
})

/** Exactly what a review comment needs, and nothing that can navigate or run. */
const ALLOWED_TAGS = [
  'p',
  'br',
  'hr',
  'strong',
  'em',
  'del',
  'code',
  'pre',
  'blockquote',
  'ul',
  'ol',
  'li',
  'a',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'table',
  'thead',
  'tbody',
  'tr',
  'th',
  'td',
]

/** A private instance for the hooks below. They must NOT ride the default
 * instance: mermaid sanitises its own SVG through that one, and the class
 * stripping would tear the classes out of diagrams mid-render. */
const purify = DOMPurify()

let hooked = false

function ensureHooks(): void {
  if (hooked) return
  hooked = true
  purify.addHook('afterSanitizeAttributes', (node) => {
    if (!(node instanceof Element)) return
    // Any link that survives sanitising leaves this page, and must not be able to
    // reach back into it through `window.opener`.
    if (node.tagName === 'A' && node.hasAttribute('href')) {
      node.setAttribute('target', '_blank')
      node.setAttribute('rel', 'noopener noreferrer')
    }
    // `class` is allowed through for exactly one purpose: marked's `language-*`
    // marker on fenced code, which the mermaid pass keys off. Anything else a
    // comment author writes could dress itself in this app's own class names.
    if (node.hasAttribute('class')) {
      const lang = /^language-[\w+-]+$/.exec(node.getAttribute('class') ?? '')
      if (node.tagName === 'CODE' && lang) node.setAttribute('class', lang[0])
      else node.removeAttribute('class')
    }
  })
}

export function renderMarkdown(text: string): string {
  ensureHooks()
  const html = marked.parse(text, { async: false })
  return purify.sanitize(html, {
    ALLOWED_TAGS,
    ALLOWED_ATTR: ['href', 'title', 'target', 'rel', 'class'],
    // http(s) and mailto only — no `javascript:`, no `data:` payloads.
    ALLOWED_URI_REGEXP: /^(?:https?:|mailto:|#)/i,
  })
}

/**
 * The document profile, for previewing a repo file (a README) rather than a
 * comment. A README carries what a comment must never need: images, raw-HTML
 * layout (<picture>, <div align>), and paths relative to the file itself. Those
 * relative paths are rewritten to the server's `/api/file` endpoint so they
 * resolve against the changeset, not this app's routes. The comment profile
 * above stays untouched — its trust boundary doesn't loosen because a
 * document's did.
 */
const DOC_TAGS = [...ALLOWED_TAGS, 'img', 'picture', 'source', 'div', 'span', 'details', 'summary']

const docPurify = DOMPurify()

/** Set for the duration of one renderMarkdownDoc call — the hook below has no
 * other way to know which file's directory relative paths resolve against. */
let docDir = ''

/** Repo-root path for `rel` as written in a file living in `dir` ('' = root). */
function resolveRepoPath(dir: string, rel: string): string {
  const clean = rel.split(/[?#]/, 1)[0] ?? ''
  const joined = clean.startsWith('/') ? clean.slice(1) : dir ? `${dir}/${clean}` : clean
  const out: string[] = []
  for (const part of joined.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') out.pop()
    else out.push(part)
  }
  return out.join('/')
}

function toFileUrl(rel: string): string {
  return `/api/file?path=${encodeURIComponent(resolveRepoPath(docDir, rel))}&side=head`
}

const HAS_SCHEME = /^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i
const SAFE_SCHEME = /^(?:https?:|mailto:|#)/i

let docHooked = false

function ensureDocHooks(): void {
  if (docHooked) return
  docHooked = true
  // The whole URL policy lives in this hook, which runs before DOMPurify's own
  // checks: relative → rewritten to `/api/file?…`; http(s)/mailto/anchor → kept;
  // any other scheme → the attribute dies here. It must die HERE because
  // DOMPurify waves `data:` through on image tags regardless of
  // ALLOWED_URI_REGEXP — and the regexp is left at its default, since DOMPurify
  // tests every attribute value against it, not just URLs ("center", "100%").
  docPurify.addHook('uponSanitizeAttribute', (_node, hookEvent) => {
    const { attrName, attrValue } = hookEvent
    if (attrName === 'src' || attrName === 'href') {
      if (!HAS_SCHEME.test(attrValue)) hookEvent.attrValue = toFileUrl(attrValue)
      else if (!SAFE_SCHEME.test(attrValue)) hookEvent.keepAttr = false
    } else if (attrName === 'srcset') {
      hookEvent.attrValue = attrValue
        .split(',')
        .map((entry) => {
          const [url, ...descriptor] = entry.trim().split(/\s+/)
          if (!url) return ''
          if (!HAS_SCHEME.test(url)) return [toFileUrl(url), ...descriptor].join(' ')
          if (SAFE_SCHEME.test(url)) return [url, ...descriptor].join(' ')
          return ''
        })
        .filter(Boolean)
        .join(', ')
    }
  })
  docPurify.addHook('afterSanitizeAttributes', (node) => {
    if (!(node instanceof Element)) return
    // Same exit hardening as comments: any surviving link leaves this page.
    if (node.tagName === 'A' && node.hasAttribute('href')) {
      node.setAttribute('target', '_blank')
      node.setAttribute('rel', 'noopener noreferrer')
    }
    if (node.hasAttribute('class')) {
      const lang = /^language-[\w+-]+$/.exec(node.getAttribute('class') ?? '')
      if (node.tagName === 'CODE' && lang) node.setAttribute('class', lang[0])
      else node.removeAttribute('class')
    }
  })
}

export function renderMarkdownDoc(text: string, path: string): string {
  ensureDocHooks()
  const cut = path.lastIndexOf('/')
  docDir = cut === -1 ? '' : path.slice(0, cut)
  const html = marked.parse(text, { async: false })
  return docPurify.sanitize(html, {
    ALLOWED_TAGS: DOC_TAGS,
    ALLOWED_ATTR: [
      'href',
      'title',
      'target',
      'rel',
      'class',
      'src',
      'srcset',
      'alt',
      'width',
      'height',
      'media',
      'align',
      'open',
    ],
  })
}

export function timeAgo(iso: string, now = Date.now()): string {
  if (!iso) return ''
  const at = Date.parse(iso)
  if (Number.isNaN(at)) return iso
  const seconds = Math.round((now - at) / 1000)
  if (seconds < 45) return 'just now'
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`
  const days = Math.round(hours / 24)
  if (days < 7) return `${days} day${days === 1 ? '' : 's'} ago`
  return new Date(at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

export function shortAgo(iso: string, now = Date.now()): string {
  if (!iso) return ''
  const at = Date.parse(iso)
  if (Number.isNaN(at)) return ''
  const seconds = Math.max(0, Math.round((now - at) / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h`
  const days = Math.round(hours / 24)
  if (days < 7) return `${days}d`
  return new Date(at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}
