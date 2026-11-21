import {
  type ArtifactView,
  CSP,
  frameDoc,
  LEFT_PAGE_DOC,
  LEFT_PAGE_ISSUE,
  LEGEND,
  newFrameToken,
  SANDBOX,
  THEME_TOKENS,
  type Theme,
} from '../shared/artifactFrame.js'
import { type ArtifactBox, type ArtifactOwner, boxOf, hasOwnFullView } from '../shared/artifacts.js'
import { ARTIFACT_MARK } from './markdown.js'

/**
 * Artifacts in the review: an ```artifact fence (see src/shared/artifacts.ts)
 * upgraded, after the markdown is in the DOM, into a card holding a sandboxed
 * frame — the same post-render pass mermaid gets.
 *
 * The trust boundary is the frame, not a sanitiser: the agent's HTML runs, so
 * it runs where it can reach nothing.
 *  - `sandbox="allow-scripts"` and nothing else: an opaque origin, so no
 *    cookies, no storage, no reach into this page, no popups, no navigation of
 *    the top window, no forms. Its requests carry `Origin: null`, which the
 *    server's Origin guard already refuses.
 *  - A CSP meta, first thing in the document (src/shared/artifactFrame.ts):
 *    no network at all.
 *
 * The frame talks back by postMessage only — its height, its errors — and only
 * messages whose source is a frame this module made are read.
 */

export type { ArtifactOwner, ArtifactView }
export { CSP, frameDoc, newFrameToken, SANDBOX }

// An owner (shared/artifacts.ts) travels to <Markdown> encoded as one string,
// so the memoised component keeps comparing primitive props.

export function messageOwner(threadId: string, messageId: string): string {
  return `message:${threadId}:${messageId}`
}

export function layerOwner(layerId: string): string {
  return `layer:${layerId}`
}

export function parseOwner(key: string | undefined): ArtifactOwner | null {
  if (!key) return null
  const [kind, a, b] = key.split(':')
  if (kind === 'message' && a && b) return { kind: 'message', threadId: a, messageId: b }
  if (kind === 'layer' && a) return { kind: 'layer', layerId: a }
  return null
}

function isDark(): boolean {
  const set = document.documentElement.getAttribute('data-theme')
  if (set === 'dark') return true
  if (set === 'light') return false
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false
}

/** The live token values off <html>, resolved — a frame can't read our CSS. */
export function currentTheme(): Theme {
  const style = getComputedStyle(document.documentElement)
  const vars: Record<string, string> = { ...LEGEND }
  for (const name of THEME_TOKENS) {
    const v = style.getPropertyValue(name).trim()
    if (v) vars[name] = v
  }
  return { scheme: isDark() ? 'dark' : 'light', vars }
}

// ---------------------------------------------------------------------------
// Live frames: one registry, one message listener, one theme watcher.

interface Live {
  frame: HTMLIFrameElement
  /** The secret its document was built with: only messages carrying it are read. */
  token: string
  owner: ArtifactOwner | null
  index: number
  title: string
  view: ArtifactView
  onSize?: (height: number) => void
  onIssue?: (text: string) => void
  /** Escape pressed inside the frame: a keydown there never reaches the page. */
  onEscape?: () => void
  synced?: boolean
  /** Loads seen: the first is its own page, any later one a navigation. */
  loads?: number
  stopped?: boolean
}

const live = new Set<Live>()
let listening = false

function prune(): void {
  for (const l of live) if (!l.frame.isConnected) live.delete(l)
}

function onMessage(e: MessageEvent): void {
  const data = e.data as {
    diffoArtifact?: number
    t?: string
    type?: string
    height?: number
    text?: string
  }
  if (data?.diffoArtifact !== 1 || typeof data.t !== 'string') return
  for (const l of live) {
    // The token proves the page Diffo built sent it — a page the frame
    // navigated to never learns it. The source must still be that frame,
    // unless the sending document is already gone (its 'leaving' word).
    if (data.t !== l.token) continue
    if (e.source !== null && e.source !== l.frame.contentWindow) return
    if (l.stopped) return
    // Its page is unloading: a navigation is under way (a page being taken
    // off the screen sends it too, and is no longer connected by then).
    if (data.type === 'leaving') {
      if (l.frame.isConnected) stopFrame(l)
      return
    }
    // A frame's document was built with the theme of its moment; the first
    // word from it is the cue to bring it up to date with this one.
    if (!l.synced) {
      l.synced = true
      sendTheme(l)
    }
    if (data.type === 'size' && typeof data.height === 'number') l.onSize?.(data.height)
    if (data.type === 'escape') l.onEscape?.()
    if (data.type === 'issue' && typeof data.text === 'string') {
      l.onIssue?.(data.text)
      report(l, data.text)
    }
    return
  }
}

function sendTheme(l: Live, theme: Theme = currentTheme()): void {
  l.frame.contentWindow?.postMessage({ diffoTheme: 1, scheme: theme.scheme, vars: theme.vars }, '*')
}

function pushTheme(): void {
  prune()
  if (live.size === 0) return
  const theme = currentTheme()
  for (const l of live) sendTheme(l, theme)
}

/** After the flip settles: the attribute lands before every style that keys
 * off it has, and a frame mid-load can miss the first message. */
function onThemeChange(): void {
  pushTheme()
  setTimeout(pushTheme, 120)
}

function ensureListening(): void {
  if (listening) return
  listening = true
  window.addEventListener('message', onMessage)
  // No event exists for an attribute; the same watch mermaid uses.
  new MutationObserver(onThemeChange).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['data-theme'],
  })
  window.matchMedia?.('(prefers-color-scheme: dark)').addEventListener?.('change', onThemeChange)
}

/**
 * The page navigated itself — a redirect, a meta refresh. The sandbox allows
 * that and no policy forbids it, so the host ends it: the frame gets a page of
 * Diffo's saying so, and whatever it went to is gone. Its first request has
 * already left; nothing after it does.
 */
function stopFrame(l: Live): void {
  if (l.stopped) return
  l.stopped = true
  l.frame.srcdoc = LEFT_PAGE_DOC
  l.onIssue?.(LEFT_PAGE_ISSUE)
  report(l, LEFT_PAGE_ISSUE)
}

/** Track a frame this module (or the full view) made. Returns the untrack. */
export function registerFrame(entry: Live): () => void {
  ensureListening()
  live.add(entry)
  const { frame } = entry
  // A second load is a navigation that slipped past the 'leaving' word.
  const onLoad = () => {
    entry.loads = (entry.loads ?? 0) + 1
    if (entry.loads >= 2) stopFrame(entry)
  }
  frame.addEventListener('load', onLoad)
  return () => {
    frame.removeEventListener('load', onLoad)
    live.delete(entry)
  }
}

// ---------------------------------------------------------------------------
// Reporting: an agent's artifact that breaks in the reviewer's browser is
// news for the agent, batched per artifact and sent once per distinct issue.

const reported = new Set<string>()
/** Issues reported per artifact, ever: a page that throws in a loop is one
 * report, not a flood. */
const perArtifact = new Map<string, number>()
const ISSUES_PER_ARTIFACT = 8
const pending = new Map<
  string,
  { owner: ArtifactOwner; index: number; title: string; view: ArtifactView; issues: string[] }
>()
let flushTimer: ReturnType<typeof setTimeout> | null = null

function report(l: Live, text: string): void {
  if (!l.owner) return
  const key = `${JSON.stringify(l.owner)}#${l.index}`
  const once = `${key}|${text}`
  if (reported.has(once)) return
  const count = perArtifact.get(key) ?? 0
  if (count >= ISSUES_PER_ARTIFACT) return
  perArtifact.set(key, count + 1)
  reported.add(once)
  const entry = pending.get(key) ?? {
    owner: l.owner,
    index: l.index,
    title: l.title,
    view: l.view,
    issues: [],
  }
  entry.issues.push(text)
  pending.set(key, entry)
  // A fixed delay from the first issue, never pushed back by later ones, so
  // one noisy card can't hold every other card's report.
  flushTimer ??= setTimeout(flush, 1500)
}

function flush(): void {
  flushTimer = null
  const batch = [...pending.values()]
  pending.clear()
  for (const b of batch) {
    void fetch('/api/review/artifacts/issues', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(b),
    }).catch(() => {})
  }
}

// ---------------------------------------------------------------------------
// The card.

export interface ArtifactOpenDetail {
  title: string
  html: string
  box: ArtifactBox
  owner: ArtifactOwner | null
  index: number
}

export const OPEN_EVENT = 'diffo:artifact-open'

let lazy: IntersectionObserver | null = null
const mounts = new WeakMap<Element, () => void>()

function whenNear(el: Element, mount: () => void): void {
  if (typeof IntersectionObserver === 'undefined') {
    mount()
    return
  }
  lazy ??= new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue
        lazy?.unobserve(e.target)
        mounts.get(e.target)?.()
        mounts.delete(e.target)
      }
    },
    { rootMargin: '600px 0px' },
  )
  mounts.set(el, mount)
  lazy.observe(el)
}

/** How tall a page's thumbnail may stand in the comment. */
const THUMB_MAX_HEIGHT = 340

const ICON = (name: string) =>
  `<svg class="icon" width="13" height="13" aria-hidden="true" focusable="false"><use href="#i-${name}"></use></svg>`

function buildCard(pre: HTMLElement, index: number, owner: ArtifactOwner | null): HTMLElement {
  const title = pre.getAttribute('data-artifact-title') || 'Artifact'
  const box = boxOf(pre.getAttribute('data-artifact-size'))
  const html = pre.querySelector('code')?.textContent ?? ''

  const card = document.createElement('div')
  card.className = 'artifact-card'

  const head = document.createElement('div')
  head.className = 'artifact-head'
  const name = document.createElement('span')
  name.className = 'artifact-title'
  name.textContent = title
  const tag = document.createElement('span')
  tag.className = 'artifact-tag'
  const kind = box.page ? 'page' : null
  tag.textContent = [kind, owner ? 'drawn by the agent' : kind ? null : 'artifact']
    .filter(Boolean)
    .join(' · ')
  const open = document.createElement('button')
  open.type = 'button'
  open.className = 'artifact-open'
  open.innerHTML = `${ICON('expand')}<span>Open</span>`
  open.setAttribute('aria-label', `Open “${title}” full size`)
  // Open only where the full view shows more: the page behind a thumbnail,
  // the agent's own [data-view=full], or content past the box (measured
  // below). A card that is the whole picture gets no button to the same one.
  const ownFull = hasOwnFullView(html, box)
  open.hidden = !ownFull
  head.append(name, tag, open)

  // The stage is as wide as the comment; the frame inside it is the agent's
  // box at its own size, scaled down to fit (never up) and centred. Height
  // follows the content, up to the box.
  const stage = document.createElement('div')
  stage.className = 'artifact-stage'
  let content = box.height
  let scale = 1
  const layout = (frame?: HTMLIFrameElement) => {
    const avail = stage.clientWidth || box.width
    const shown = Math.max(48, Math.min(box.height, content))
    // A page is a thumbnail: the top of it, small enough to stay a preview.
    scale = Math.min(1, avail / box.width, box.page ? THUMB_MAX_HEIGHT / shown : 1)
    stage.style.height = `${Math.round(shown * scale)}px`
    if (frame) {
      frame.style.transform = scale === 1 ? '' : `scale(${scale})`
      frame.style.left = `${Math.max(0, (avail - box.width * scale) / 2)}px`
    }
  }
  stage.style.height = `${box.page ? THUMB_MAX_HEIGHT : box.height}px`
  if (box.page) {
    // The thumbnail is a picture of the page, not the page: one click anywhere
    // opens it, and nothing in it takes the pointer at a third of its size.
    stage.classList.add('artifact-thumb')
    const hit = document.createElement('button')
    hit.type = 'button'
    hit.className = 'artifact-thumb-open'
    hit.setAttribute('aria-label', `Open the page “${title}”`)
    stage.append(hit)
  }

  const issues = document.createElement('div')
  issues.className = 'artifact-issues'
  issues.hidden = true

  const more = document.createElement('button')
  more.type = 'button'
  more.className = 'artifact-more'
  more.textContent = box.page ? 'Open the whole page' : 'See all of it'
  more.hidden = true

  card.append(head, stage, more, issues)

  const detail: ArtifactOpenDetail = { title, html, box, owner, index }
  const fire = () => window.dispatchEvent(new CustomEvent(OPEN_EVENT, { detail }))
  open.addEventListener('click', fire)
  more.addEventListener('click', fire)
  stage.querySelector('.artifact-thumb-open')?.addEventListener('click', fire)

  const seen: string[] = []
  whenNear(stage, () => {
    const frame = document.createElement('iframe')
    frame.className = 'artifact-frame'
    frame.setAttribute('sandbox', SANDBOX)
    frame.setAttribute('title', title)
    frame.setAttribute('referrerpolicy', 'no-referrer')
    frame.style.width = `${box.width}px`
    frame.style.height = `${box.height}px`
    if (typeof ResizeObserver !== 'undefined')
      new ResizeObserver(() => layout(frame)).observe(stage)
    const token = newFrameToken()
    registerFrame({
      frame,
      token,
      owner,
      index,
      title,
      view: 'card',
      onSize: (h) => {
        content = h
        const fits = h <= box.height
        layout(frame)
        card.classList.toggle('artifact-overflows', !fits)
        more.hidden = fits
        open.hidden = !ownFull && fits
      },
      onIssue: (text) => {
        if (seen.length >= 3 || seen.includes(text)) return
        seen.push(text)
        issues.hidden = false
        issues.textContent = `${seen.length === 1 ? 'This artifact hit a problem' : 'Problems'}: ${seen.join(' · ')}${owner ? ' — your agent has been told.' : ''}`
      },
    })
    // A page has one view: the thumbnail is the page itself, scaled.
    frame.srcdoc = frameDoc(html, box.page ? 'full' : 'card', currentTheme(), box, token)
    stage.append(frame)
    layout(frame)
  })
  return card
}

/**
 * Upgrade every unclaimed artifact fence under `root`. Synchronous — there is
 * nothing to load — and idempotent: a fence is claimed by being replaced.
 */
export function renderArtifactsIn(root: HTMLElement, ownerKey: string): void {
  // Top-level fences only, and only <pre>s the markdown renderer itself
  // marked: a fence in a list or a quote, or a <pre data-artifact> typed as
  // raw HTML, stays code — exactly what `findArtifacts` counts, so every card
  // passed the checks the agent's post did, and its index is the agent's.
  const mine = `:scope > pre[data-artifact="${ARTIFACT_MARK}"]`
  const pres = Array.from(root.querySelectorAll<HTMLElement>(mine))
  if (pres.length === 0) return
  prune()
  const owner = parseOwner(ownerKey)
  const all = Array.from(root.querySelectorAll<HTMLElement>(`${mine}, :scope > .artifact-card`))
  for (const pre of pres) {
    if (!pre.isConnected) continue
    pre.replaceWith(buildCard(pre, all.indexOf(pre), owner))
  }
}
