import { Lexer, type Tokens } from 'marked'
/**
 * Artifacts: a self-contained HTML page the agent writes inside ordinary
 * markdown, as a fenced block whose info string starts with `artifact`:
 *
 *     ```artifact title="Retry backoff, before vs after" size=m
 *     <!doctype html> … html, css, js, svg — all inline …
 *     ```
 *
 * The fence rides the text channel every surface already has — a guide, a
 * reply, a layer summary — so there is no new API and no new storage. The
 * reviewer's page upgrades it into a sandboxed frame (src/ui/artifacts.ts).
 *
 * This module is the one reading of that format, shared by the CLI (so the
 * agent hears about a broken fence before it leaves the machine), the server
 * (which trusts nothing over HTTP, caps layer prose without cutting a fence in
 * half, and keeps the HTML out of the prompts it replays to the agent) and the
 * UI (which reads title and size off the same info string).
 */

export const ARTIFACT_LANG = 'artifact'

export type ArtifactSize = 's' | 'm' | 'l'

/**
 * The card is a fixed box the agent designs for, in CSS px — like a slide.
 * The page lays out in exactly that box; Diffo scales it down to fit the
 * comment (never up, never reflowed), so what the agent previews is what the
 * reviewer sees at any width. The card still shrinks to shorter content. The
 * full view is the whole window instead (`data-view="full"`).
 */
export interface ArtifactBox {
  width: number
  height: number
  /** A page: designed for the whole window. The comment shows the top of it
   * as a live thumbnail; Open shows it full-window. */
  page?: true
}

/** The window a page is designed for — and the slice of it the thumbnail
 * shows. The page itself may run longer; the full view scrolls. */
export const PAGE_BOX: ArtifactBox = { width: 1200, height: 760, page: true }

export const ARTIFACT_BOXES: Record<ArtifactSize, ArtifactBox> = {
  s: { width: 720, height: 200 },
  m: { width: 720, height: 380 },
  l: { width: 720, height: 620 },
}

export const DEFAULT_ARTIFACT_SIZE: ArtifactSize = 'm'

/** A custom box, `WIDTHxHEIGHT`: wide enough to hold a layout, small enough
 * to sit in a review. */
export const BOX_LIMITS = { minWidth: 320, maxWidth: 1600, minHeight: 120, maxHeight: 1200 }

/** `s`, `m`, `l`, or `800x450` — the box, or null when it isn't one. */
export function parseBox(raw: string): ArtifactBox | null {
  const v = raw.trim().toLowerCase()
  if (v === 's' || v === 'm' || v === 'l') return ARTIFACT_BOXES[v]
  if (v === 'page') return PAGE_BOX
  const m = /^(\d{2,4})\s*[x×]\s*(\d{2,4})$/.exec(v)
  if (!m) return null
  const width = Number(m[1])
  const height = Number(m[2])
  const L = BOX_LIMITS
  if (width < L.minWidth || width > L.maxWidth || height < L.minHeight || height > L.maxHeight)
    return null
  return { width, height }
}

/** The box a fence asked for, or the default. */
export function boxOf(size: string | null | undefined): ArtifactBox {
  return (size ? parseBox(size) : null) ?? ARTIFACT_BOXES[DEFAULT_ARTIFACT_SIZE]
}

/**
 * Whether the full view shows something the card does not, before measuring:
 * a page (the card is only its thumbnail), or HTML that styles a
 * `data-view="full"` of its own. A card that does neither is the full view
 * already, unless its content runs past the box — that is measured.
 */
export function hasOwnFullView(html: string, box: ArtifactBox): boolean {
  return box.page === true || /data-view/.test(html)
}

export const SIZE_HELP = `page (a full page for the window, shown in the comment as a thumbnail), or a card: s (720×200), m (720×380, the default), l (720×620), or WIDTHxHEIGHT from ${BOX_LIMITS.minWidth}×${BOX_LIMITS.minHeight} to ${BOX_LIMITS.maxWidth}×${BOX_LIMITS.maxHeight}`

/** One artifact's HTML, hard. A chart or a mock is a few KB; this is the
 * backstop against an inlined dataset or a pasted library. */
export const ARTIFACT_MAX_BYTES = 256 * 1024

/** Per message or summary. One is the doctrine; three is the backstop. */
export const ARTIFACTS_PER_TEXT = 3

const TITLE_MAX = 120

/** Text that reaches a prompt or a label from a page: one line, no control
 * or direction-override characters. A browser's error message never needs a
 * line break, and a forged one must not open a fresh paragraph in the
 * agent's prompt or flip a title's reading order. */
export function oneLine(s: string): string {
  return (
    s
      // biome-ignore lint/suspicious/noControlCharactersInRegex: removing them is the point
      .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
  )
}

export interface ArtifactInfo {
  title: string | null
  /** `s`, `m`, `l` or `800x450`, as written (lower-cased); null when unset. */
  size: string | null
  /** The raw `size=` value when it was not a box. */
  badSize: string | null
  /** `key=value` pairs this format does not know. */
  unknown: string[]
}

/** True when a fence's info string opens an artifact: its first word is
 * exactly `artifact`. */
export function isArtifactInfo(info: string): boolean {
  return /^artifact(?:\s|$)/.test(info.trim())
}

/** Reads `title="…"` (or `'…'`, or a bare word) and `size=s|m|l` off an info
 * string. Everything else is reported, never guessed at. */
export function parseArtifactInfo(info: string): ArtifactInfo {
  const rest = info.trim().replace(/^artifact\b/, '')
  const out: ArtifactInfo = { title: null, size: null, badSize: null, unknown: [] }
  const pair = /([A-Za-z][\w-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|(\S+))/g
  for (const m of rest.matchAll(pair)) {
    const key = (m[1] ?? '').toLowerCase()
    const value = (m[2] ?? m[3] ?? m[4] ?? '').trim()
    if (key === 'title') {
      const t = oneLine(value)
      out.title = t === '' ? null : t.slice(0, TITLE_MAX)
    } else if (key === 'size') {
      if (parseBox(value))
        out.size = value.toLowerCase().replace(/\s|×/g, (c) => (c === '×' ? 'x' : ''))
      else out.badSize = value
    } else out.unknown.push(key)
  }
  return out
}

export interface FoundArtifact {
  /** 0-based, in text order — the identity a runtime report carries. */
  index: number
  info: ArtifactInfo
  html: string
  /** Byte length of `html` as UTF-8. */
  bytes: number
  /** 1-based line of the opening fence. */
  line: number
  closed: boolean
  /** Character offsets of the whole fence, opener through closer. */
  start: number
  end: number
}

/**
 * Every artifact in `text`, in order: the top-level fenced code blocks whose
 * info string opens with `artifact`. It reads the markdown with the same
 * parser the review renders it with (marked), so the CLI, the server and the
 * page agree on what is an artifact — a fence inside a list, a quote or an
 * HTML block is code on all three, and an artifact shown as an example inside
 * a ````markdown fence is not mistaken for a real one.
 */
export function findArtifacts(text: string): FoundArtifact[] {
  const src = normalizeNewlines(text)
  const found: FoundArtifact[] = []
  let cursor = 0
  for (const tok of Lexer.lex(src)) {
    const at = src.indexOf(tok.raw, cursor)
    if (at >= 0) cursor = at + tok.raw.length
    if (tok.type !== 'code' || at < 0) continue
    const code = tok as Tokens.Code
    const opener = /^ {0,3}(`{3,}|~{3,})/.exec(code.raw)
    if (!opener) continue // an indented code block, not a fence
    const info = code.lang ?? ''
    if (!isArtifactInfo(info)) continue
    const fence = opener[1] ?? '```'
    const body = code.raw.replace(/\n+$/, '')
    const lines = body.split('\n')
    const closer = new RegExp(`^ {0,3}\\${fence[0]}{${fence.length},}[ \\t]*$`)
    const closed = lines.length > 1 && closer.test(lines[lines.length - 1] ?? '')
    const line = src.slice(0, at).split('\n').length
    found.push(
      artifact(found.length, { info, line, start: at }, code.text, closed, at + body.length),
    )
  }
  return found
}

/** One newline convention, so offsets into the text mean the same to every
 * reader of it. */
export function normalizeNewlines(text: string): string {
  return text.replace(/\r\n?/g, '\n')
}

function artifact(
  index: number,
  open: { info: string; line: number; start: number },
  html: string,
  closed: boolean,
  end: number,
): FoundArtifact {
  return {
    index,
    info: parseArtifactInfo(open.info),
    html,
    bytes: new TextEncoder().encode(html).length,
    line: open.line,
    closed,
    start: open.start,
    end,
  }
}

/** Anything in an artifact that reaches for the network — the frame's
 * policy blocks it, so it would silently not load. */
const NETWORK: { re: RegExp; what: string }[] = [
  {
    re: /\b(?:src|href|action|poster|data)\s*=\s*["']?\s*(?:https?:)?\/\//i,
    what: 'a remote src/href',
  },
  { re: /url\(\s*["']?\s*(?:https?:)?\/\//i, what: 'a remote url() in CSS' },
  { re: /@import\b/i, what: 'a CSS @import' },
  { re: /\bfetch\s*\(/, what: 'fetch()' },
  { re: /\bXMLHttpRequest\b/, what: 'XMLHttpRequest' },
  { re: /\bnew\s+WebSocket\b/, what: 'a WebSocket' },
  { re: /\bimport\s*\(\s*["']/, what: 'a dynamic import()' },
  { re: /<script[^>]*\btype\s*=\s*["']?module/i, what: 'a module script (imports can’t load)' },
]

export interface ArtifactCheck {
  artifacts: FoundArtifact[]
  /** Refuse the post: the reviewer would see a broken card. */
  errors: string[]
  /** Post anyway, but tell the agent what will not work. */
  warnings: string[]
}

export function kb(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : `${Math.round(bytes / 102.4) / 10} KB`
}

function label(a: FoundArtifact): string {
  return a.info.title ? `artifact "${a.info.title}"` : `artifact ${a.index + 1} (line ${a.line})`
}

/** The preflight. Same messages on the CLI and the server, so the agent never
 * hears two voices for one mistake. */
export function checkArtifacts(text: string): ArtifactCheck {
  const artifacts = findArtifacts(text)
  const errors: string[] = []
  const warnings: string[] = []
  if (artifacts.length > ARTIFACTS_PER_TEXT) {
    errors.push(
      `${artifacts.length} artifacts in one text; keep it to ${ARTIFACTS_PER_TEXT} at most — one picture that carries the point beats several`,
    )
  }
  for (const a of artifacts) {
    const what = label(a)
    if (!a.closed) {
      errors.push(
        `${what} opened at line ${a.line} is never closed — end it with a fence line of its own (if the HTML itself has a \`\`\` line, open with \`\`\`\`artifact)`,
      )
      continue
    }
    if (a.info.title === null)
      errors.push(`${what} needs a title: \`\`\`artifact title="What it shows"`)
    if (a.info.badSize !== null)
      errors.push(`${what}: size=${a.info.badSize} is not a size; use ${SIZE_HELP}`)
    if (a.html.trim() === '') errors.push(`${what} is empty`)
    if (a.bytes > ARTIFACT_MAX_BYTES)
      errors.push(
        `${what} is ${kb(a.bytes)}; the cap is ${kb(ARTIFACT_MAX_BYTES)} — draw it, don't inline a dataset or a library`,
      )
    if (a.info.unknown.length > 0)
      warnings.push(
        `${what}: ignoring ${a.info.unknown.map((k) => `${k}=`).join(', ')} — only title= and size= are read`,
      )
    const reaches = NETWORK.filter((n) => n.re.test(a.html)).map((n) => n.what)
    if (reaches.length > 0)
      warnings.push(
        `${what} uses ${reaches.join(', ')}; the frame has no network, so it won't load — inline the data, CSS and script, or draw it with SVG`,
      )
  }
  return { artifacts, errors, warnings }
}

/** One line per artifact, for the CLI to print after a post. */
export function describeArtifact(a: FoundArtifact): string {
  const box = boxOf(a.info.size)
  const shape = box.page ? 'page' : `${box.width}×${box.height} card`
  return `artifact "${a.info.title ?? `#${a.index + 1}`}" (${kb(a.bytes)}, ${shape})`
}

/** The text with each closed artifact fence swapped for a one-line stand-in.
 * Prompts replay the agent's own messages back to it; the HTML is its own
 * output, already known, and kilobytes of it per round are pure cost. */
export function stripArtifacts(
  text: string,
  as: (a: FoundArtifact) => string = (a) =>
    `[${describeArtifact(a)} — rendered for the reviewer; its HTML is not repeated here]`,
): string {
  text = normalizeNewlines(text)
  const found = findArtifacts(text).filter((a) => a.closed)
  if (found.length === 0) return text
  let out = ''
  let at = 0
  for (const a of found) {
    out += text.slice(at, a.start)
    out += as(a)
    at = a.end
  }
  return out + text.slice(at)
}

/**
 * Layers on their way to someone else — a reading guide shared on a pull
 * request, or one read back from it. An artifact runs only for the reviewer
 * of the agent that drew it, so it never travels: a line naming it stays in
 * its place. Unclosed fences go too, as plain text.
 */
export function withoutArtifacts<T extends { summary?: string }>(layer: T): T {
  if (!layer.summary || findArtifacts(layer.summary).length === 0) return layer
  const named = stripArtifacts(layer.summary, (a) =>
    a.info.title ? `_(picture: ${a.info.title})_` : '_(picture)_',
  )
  return { ...layer, summary: named.replace(/^ {0,3}(`{3,}|~{3,})\s*artifact\b.*$/gm, '') }
}

/** Length of the prose around the artifacts — what a prose cap should count. */
export function proseLength(text: string): number {
  text = normalizeNewlines(text)
  const found = findArtifacts(text)
  let n = text.length
  for (const a of found) n -= a.end - a.start
  return n
}

/** `text` cut so its prose is at most `cap` characters, never cutting inside
 * an artifact fence: fences ride along whole and don't count. Their own caps
 * come from `checkArtifacts`. */
export function capProse(text: string, cap: number): string {
  text = normalizeNewlines(text)
  if (proseLength(text) <= cap) return text
  const found = findArtifacts(text)
  let out = ''
  let budget = cap
  let at = 0
  for (const a of found) {
    const prose = text.slice(at, a.start)
    if (prose.length >= budget) return (out + prose.slice(0, budget)).trimEnd()
    out += prose + text.slice(a.start, a.end)
    budget -= prose.length
    at = a.end
  }
  return (out + text.slice(at, at + budget)).trimEnd()
}

/** Who wrote the text an artifact sits in. Only the agent's artifacts are
 * reported back — only the agent can fix them. */
export type ArtifactOwner =
  | { kind: 'message'; threadId: string; messageId: string }
  | { kind: 'layer'; layerId: string }

/** What the reviewer's browser saw go wrong with one artifact. */
export interface ArtifactReport {
  owner: ArtifactOwner
  /** 0-based position among the artifacts of that one text. */
  index: number
  title: string
  view: 'card' | 'full'
  issues: string[]
}

export const REPORT_ISSUES_MAX = 8
export const REPORT_ISSUE_CHARS = 500

/** Untrusted JSON → a report, or null. Shape only; whether the owner exists
 * (and is the agent's) is the server's call. */
export function parseArtifactReport(raw: unknown): ArtifactReport | null {
  if (typeof raw !== 'object' || raw === null) return null
  const r = raw as Record<string, unknown>
  const o = r.owner as Record<string, unknown> | undefined
  let owner: ArtifactOwner | null = null
  if (o?.kind === 'message' && typeof o.threadId === 'string' && typeof o.messageId === 'string')
    owner = { kind: 'message', threadId: o.threadId, messageId: o.messageId }
  else if (o?.kind === 'layer' && typeof o.layerId === 'string')
    owner = { kind: 'layer', layerId: o.layerId }
  if (!owner) return null
  const index = r.index
  if (
    typeof index !== 'number' ||
    !Number.isInteger(index) ||
    index < 0 ||
    index >= ARTIFACTS_PER_TEXT
  )
    return null
  const title = typeof r.title === 'string' ? oneLine(r.title).slice(0, TITLE_MAX) : ''
  const view = r.view === 'full' ? 'full' : 'card'
  if (!Array.isArray(r.issues)) return null
  const issues = r.issues
    .filter((i): i is string => typeof i === 'string')
    .map((i) => oneLine(i).slice(0, REPORT_ISSUE_CHARS))
    .filter((i) => i !== '')
    .slice(0, REPORT_ISSUES_MAX)
  if (issues.length === 0) return null
  return { owner, index, title: title || `artifact ${index + 1}`, view, issues }
}
