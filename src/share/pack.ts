import { createHash } from 'node:crypto'
import { gunzipSync, gzipSync } from 'node:zlib'
import { prUrl } from '../forge/target.js'
import type { ImportedComment, ImportedThread, PrRef } from '../forge/types.js'
import { type LayerInput, parseLayersInput } from '../shared/layers.js'
import {
  type Layer,
  type LayerFile,
  layerFileHighlight,
  layerFileNote,
  layerFilePath,
  layerFileRange,
  type SharedLayersFrom,
} from '../shared/review.js'

// A reading guide shared on a pull request (`diffo share`). The layers travel
// inside one PR comment: a readable outline anyone can open on GitHub, and the
// layers themselves in an HTML comment GitHub never renders. Opening the pull
// request in Diffo finds the comment and loads the layers, so a reviewer gets
// the outline without anyone running a server: GitHub is the storage, and
// GitHub's permissions decide who reads it.

const MARKER = 'diffo-pack:v1'
const PACK_RE = /<!-- diffo-pack:v1\s+([A-Za-z0-9+/=\s]+?)\s*-->/g

/** GitHub refuses a comment body past 65,536 characters. */
export const COMMENT_LIMIT = 65_536

/** A decoded pack can never be larger than this: a guard on what a comment
 * makes this process inflate. */
const MAX_INFLATED = 1024 * 1024

/** Who may hand a reviewer their layers: the pull request's author, the reviewer
 * themself, or someone GitHub says belongs to the repository. A drive-by
 * commenter on a public repository is none of these. */
const TRUSTED_ASSOCIATIONS = new Set(['OWNER', 'MEMBER', 'COLLABORATOR'])

export interface SharedPack {
  v: 1
  /** The head commit the layers' line ranges were written against. */
  sha: string
  postedAt: string
  layers: LayerInput[]
}

export interface FoundPack {
  layers: LayerInput[]
  from: SharedLayersFrom
}

/** The layers as the agent posts them: no server-minted ids. */
export function packOf(layers: readonly Layer[], sha: string, postedAt: string): SharedPack {
  return {
    v: 1,
    sha,
    postedAt,
    layers: layers.map(({ id: _id, ...rest }) => rest),
  }
}

export function encodePack(pack: SharedPack): string {
  return gzipSync(Buffer.from(JSON.stringify(pack), 'utf-8')).toString('base64')
}

/** The pack in a comment body, or null when there is none or it does not read. */
export function decodePack(body: string): SharedPack | null {
  const matches = [...body.matchAll(PACK_RE)]
  const last = matches.at(-1)?.[1]
  if (!last) return null
  let raw: unknown
  try {
    const inflated = gunzipSync(Buffer.from(last.replace(/\s+/g, ''), 'base64'), {
      maxOutputLength: MAX_INFLATED,
    })
    raw = JSON.parse(inflated.toString('utf-8'))
  } catch {
    return null
  }
  if (typeof raw !== 'object' || raw === null) return null
  const p = raw as Record<string, unknown>
  if (p.v !== 1) return null
  if (typeof p.sha !== 'string' || !/^[0-9a-f]{7,64}$/.test(p.sha)) return null
  if (typeof p.postedAt !== 'string' || Number.isNaN(Date.parse(p.postedAt))) return null
  const layers = parseLayersInput(p.layers)
  if (!layers.ok || layers.items.length === 0) return null
  return { v: 1, sha: p.sha, postedAt: p.postedAt, layers: layers.items }
}

export function isPackComment(body: string): boolean {
  return body.includes(`<!-- ${MARKER}`)
}

/** A guide this review loads as layers, so it is not shown again as a comment. */
export function isLoadablePackComment(
  c: ImportedComment,
  pr: { author: { login: string }; viewer: { login: string } },
): boolean {
  return isPackComment(c.body) && trusted(c, pr)
}

export function trusted(
  c: ImportedComment,
  pr: { author: { login: string }; viewer: { login: string } },
): boolean {
  const login = c.user.login.toLowerCase()
  return (
    login === pr.author.login.toLowerCase() ||
    login === pr.viewer.login.toLowerCase() ||
    TRUSTED_ASSOCIATIONS.has(c.association ?? '')
  )
}

/**
 * The newest reading guide on the pull request from someone trusted to give
 * one, or null. A guide from anyone else is ignored, never loaded: layers fold
 * files and say what a change is, which is exactly what a hostile commenter
 * would want to write for the reviewer.
 */
export function findSharedPack(
  threads: readonly ImportedThread[],
  pr: { author: { login: string }; viewer: { login: string } },
): FoundPack | null {
  let best: FoundPack | null = null
  for (const t of threads) {
    if (t.kind !== 'comment') continue
    const c = t.comments[0]
    if (!isPackComment(c.body) || !trusted(c, pr)) continue
    const pack = decodePack(c.body)
    if (!pack) continue
    if (best && best.from.postedAt >= pack.postedAt) continue
    best = {
      layers: pack.layers,
      from: {
        by: c.user.login,
        sha: pack.sha,
        commentId: c.id,
        postedAt: pack.postedAt,
        ...(c.url ? { url: c.url } : {}),
      },
    }
  }
  return best
}

/** The viewer's own guide comment on the pull request, to edit in place. */
export function ownPackComment(
  threads: readonly ImportedThread[],
  viewer: string,
): ImportedComment | null {
  const mine = threads
    .filter((t) => t.kind === 'comment')
    .map((t) => t.comments[0])
    .filter((c) => c.user.login.toLowerCase() === viewer.toLowerCase() && isPackComment(c.body))
  return mine.at(-1) ?? null
}

/** GitHub's anchor for a file in the pull request's Files tab. */
function fileAnchor(path: string): string {
  return `diff-${createHash('sha256').update(path).digest('hex')}`
}

function fileLink(ref: PrRef, file: LayerFile): string {
  const range = layerFileRange(file) ?? layerFileHighlight(file)[0] ?? null
  return `${prUrl(ref)}/files#${fileAnchor(layerFilePath(file))}${range ? `R${range.from}` : ''}`
}

function fileLine(ref: PrRef, file: LayerFile): string {
  const path = layerFilePath(file)
  const range = layerFileRange(file) ?? layerFileHighlight(file)[0] ?? null
  const lines = range
    ? range.from === range.to
      ? ` line ${range.from}`
      : ` lines ${range.from}–${range.to}`
    : ''
  const note = layerFileNote(file)
  return `- [\`${path}\`](${fileLink(ref, file)})${lines}${note ? ` · ${oneLine(note)}` : ''}`
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/** A title is the author's words, not markup: it must not open a tag, or close
 * the link it sits in. Code spans still render. */
function titleText(title: string): string {
  return oneLine(title)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/([[\]])/g, '\\$1')
}

function kindTag(layer: LayerInput): string {
  return layer.kind === 'mechanical' || layer.kind === 'background' ? ` · ${layer.kind}` : ''
}

function filesCount(layer: LayerInput): string {
  const n = layer.files.length
  return `${n} ${n === 1 ? 'file' : 'files'}`
}

/** What the reader pastes to their coding agent: the command, and the ask. */
export function agentPrompt(url: string): string {
  // Two short lines, so the block fits a comment's width without scrolling.
  return `Review this pull request with me, using its Diffo layers:\nnpx -y @diffohq/diffo ${url}`
}

/** The visible outline stops here; the rest is a line saying how many more. */
export const VISIBLE_LAYERS = 8

/** One line per layer, its title linking to where it starts in the Files tab. */
function outlineLine(ref: PrRef, layer: LayerInput, n: number): string {
  const first = layer.files[0]
  const title = titleText(layer.title)
  const linked = first ? `[${title}](${fileLink(ref, first)})` : title
  return `${n}. ${linked} · ${filesCount(layer)}${kindTag(layer)}`
}

/** A layer in full, inside the one collapsed block. */
function layerDetail(ref: PrRef, layer: LayerInput, n: number, compact: boolean): string {
  const out = [`**${n}. ${titleText(layer.title)}**`, '']
  if (!compact && layer.summary?.trim()) out.push(layer.summary.trim(), '')
  if (!compact && (layer.decisions?.length ?? 0) > 0) {
    out.push('Decisions:', '')
    for (const d of layer.decisions!) {
      out.push(`- ${oneLine(d.text)}${d.detail ? `: ${oneLine(d.detail)}` : ''}`)
    }
    // Two lists a blank line apart merge into one: the label keeps them apart.
    out.push('', 'Files:', '')
  }
  for (const f of layer.files) out.push(fileLine(ref, f))
  return out.join('\n')
}

/**
 * The comment body, small on purpose: it sits in someone else's pull request.
 * Visible are a one-line header, one line per layer and a one-line footer;
 * summaries, decisions and every file sit in a single collapsed block, and the
 * pack itself is an HTML comment GitHub never shows. When the full text would
 * not fit in one comment, the summaries go and the titles and files stay; past
 * that the guide is too large to share, and this throws.
 */
export function renderShareComment(ref: PrRef, pack: SharedPack): string {
  const url = prUrl(ref)
  const encoded = encodePack(pack)
  const count = pack.layers.length
  const close = pack.layers.filter((l) => l.kind !== 'mechanical' && l.kind !== 'background')
  const shown = pack.layers.slice(0, VISIBLE_LAYERS)
  const more = count - shown.length
  const build = (compact: boolean) =>
    [
      // One text style up here: bold at body size, no code chip.
      `**📖 Reading guide** · ${count} ${count === 1 ? 'layer' : 'layers'}${close.length < count ? `, ${close.length} to read closely` : ''}`,
      '',
      ...shown.map((l, i) => outlineLine(ref, l, i + 1)),
      ...(more > 0 ? ['', `…and ${more} more below.`] : []),
      '',
      `<details><summary>${compact ? 'Files per layer' : 'Summaries, decisions and files'}</summary>`,
      '',
      `Written for ${pack.sha.slice(0, 7)}.`,
      '',
      ...pack.layers.flatMap((l, i) => [layerDetail(ref, l, i + 1, compact), '']),
      '</details>',
      '',
      // A quote, not <sub>: GitHub greys it at body size, where <sub> shrinks
      // the text and drops it off the line. The prompt is a fence inside it:
      // GitHub gives a fence a copy button and leaves its URL alone (inline
      // code turns it into a "#N" link that copies as "#N").
      '> Review it layer by layer in [Diffo](https://github.com/DiffoHQ/diffo?utm_source=pr-guide): copy this into your coding agent (Claude Code, Codex, Cursor…)',
      '>',
      '> ```text',
      ...agentPrompt(url)
        .split('\n')
        .map((line) => `> ${line}`),
      '> ```',
      '',
      `<!-- ${MARKER}`,
      encoded,
      '-->',
      '',
    ].join('\n')
  const full = build(false)
  if (full.length <= COMMENT_LIMIT) return full
  const compact = build(true)
  if (compact.length <= COMMENT_LIMIT) return compact
  throw new Error(
    `the guide is too large for one GitHub comment (${compact.length} characters, the limit is ${COMMENT_LIMIT}); fewer layers or files per layer would fit`,
  )
}
