import { createHash } from 'node:crypto'
import type { DiffLine, FileChange, FileKind, FileStatus, Hunk } from '../shared/types.js'

const IMAGE_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.bmp',
  '.svg',
  '.ico',
  '.avif',
])

function isImagePath(path: string): boolean {
  const dot = path.lastIndexOf('.')
  return dot !== -1 && IMAGE_EXTENSIONS.has(path.slice(dot).toLowerCase())
}

/** Content-addressed hunk identity: the hash covers the file path and the changed
 * lines only — not line numbers, not context. Editing the hunk itself mints a new
 * id; the occurrence index separates identical hunks within one file. */
function hunkId(path: string, lines: DiffLine[], occurrence: number): string {
  const changed = lines
    .filter((l) => l.kind !== 'context')
    .map((l) => `${l.kind === 'add' ? '+' : '-'}${l.text}`)
    .join('\n')
  return createHash('sha256')
    .update(`${path}\0${changed}\0${occurrence}`)
    .digest('hex')
    .slice(0, 16)
}

interface SectionMeta {
  renamedFrom: string | null
  renamedTo: string | null
  binary: boolean
  symlink: boolean
}

function parseSectionMeta(section: string): SectionMeta {
  const renamedFrom = section.match(/^rename from (.+)$/m)?.[1] ?? null
  const renamedTo = section.match(/^rename to (.+)$/m)?.[1] ?? null
  const binary = /^Binary files .* differ$/m.test(section) || /^GIT binary patch$/m.test(section)
  const symlink =
    /^(?:new file|deleted file|new|old) mode 120000$/m.test(section) ||
    /^index [0-9a-f.]+ 120000$/m.test(section)
  return { renamedFrom, renamedTo, binary, symlink }
}

function splitSections(patch: string): string[] {
  if (!patch.trim()) return []
  const sections: string[] = []
  const lines = patch.split('\n')
  let current: string[] | null = null
  for (const line of lines) {
    if (line.startsWith('diff --git ')) {
      if (current) sections.push(current.join('\n'))
      current = [line]
    } else if (current) {
      current.push(line)
    }
  }
  if (current) sections.push(current.join('\n'))
  return sections
}

/**
 * `@@ -oldStart,oldCount +newStart,newCount @@ scope`. Both counts are optional in
 * the format and mean 1 when absent (`@@ -1 +1 @@`). The trailing scope is git's own
 * guess at what you are inside.
 */
const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/

interface RawHunk {
  oldStart: number
  newStart: number
  context: string | null
  lines: DiffLine[]
}

/**
 * Read one hunk body, starting at the line after its header. The declared counts
 * are authoritative: consume exactly that many old and new lines and stop, rather
 * than reading up to the next `@@` — git's own rule, and what keeps the blank line
 * every patch ends with out of the last hunk.
 */
function parseHunkBody(
  lines: string[],
  start: number,
  oldStart: number,
  newStart: number,
  oldCount: number,
  newCount: number,
): { lines: DiffLine[]; next: number } {
  const out: DiffLine[] = []
  let oldNo = oldStart
  let newNo = newStart
  let remainingOld = oldCount
  let remainingNew = newCount
  let i = start
  while (remainingOld > 0 || remainingNew > 0) {
    const line = lines[i]
    if (line === undefined) break
    // A next header or file ends this hunk even if the counts say otherwise — a hunk
    // one line short beats swallowing the section after it.
    if (line.startsWith('@@') || line.startsWith('diff --git ')) break
    i++
    // `\\ No newline at end of file` annotates the line above it, so it neither
    // renders nor spends the header's budget.
    if (line.startsWith('\\')) continue
    if (line.startsWith('+')) {
      out.push({ kind: 'add', oldNo: null, newNo: newNo++, text: line.slice(1) })
      remainingNew--
    } else if (line.startsWith('-')) {
      out.push({ kind: 'del', oldNo: oldNo++, newNo: null, text: line.slice(1) })
      remainingOld--
    } else {
      // A bare empty line is a blank context line: patches that have been through
      // trailing-whitespace stripping lose the leading space.
      out.push({ kind: 'context', oldNo: oldNo++, newNo: newNo++, text: line.slice(1) })
      remainingOld--
      remainingNew--
    }
  }
  return { lines: out, next: i }
}

function parseHunks(lines: string[]): RawHunk[] {
  const hunks: RawHunk[] = []
  let i = 0
  while (i < lines.length) {
    const header = lines[i]?.match(HUNK_HEADER)
    if (!header) {
      i++
      continue
    }
    const oldStart = Number(header[1])
    const newStart = Number(header[3])
    const body = parseHunkBody(
      lines,
      i + 1,
      oldStart,
      newStart,
      header[2] === undefined ? 1 : Number(header[2]),
      header[4] === undefined ? 1 : Number(header[4]),
    )
    const context = (header[5] ?? '').trim()
    hunks.push({ oldStart, newStart, context: context === '' ? null : context, lines: body.lines })
    i = body.next
  }
  return hunks
}

interface SectionPaths {
  from: string | null
  to: string | null
  isNew: boolean
  isDeleted: boolean
}

/**
 * `--- a/x` / `+++ b/x`, read only from the part of the section before the first
 * `@@`. That bound is load-bearing: inside a hunk body an added line starting with
 * `++` is spelled `+++ …`, so scanning the whole section would read file content as
 * a path header.
 */
function parseSectionPaths(section: string, lines: string[]): SectionPaths {
  let from: string | null = null
  let to: string | null = null
  for (const line of lines) {
    if (line.startsWith('@@')) break
    if (from === null && line.startsWith('--- ')) from = diffPath(line.slice(4))
    else if (to === null && line.startsWith('+++ ')) to = diffPath(line.slice(4))
  }
  return {
    from,
    to,
    // git states the mode line for an added/deleted file even when there is no
    // `/dev/null` side to read (an empty new file has no hunks at all).
    isNew: from === '/dev/null' || /^new file mode /m.test(section),
    isDeleted: to === '/dev/null' || /^deleted file mode /m.test(section),
  }
}

function diffPath(raw: string): string {
  const path = raw.split('\t', 1)[0] ?? raw
  return path === '/dev/null' ? path : stripAB(path)
}

export function parsePatch(patch: string): FileChange[] {
  const files: FileChange[] = []
  for (const section of splitSections(patch)) {
    const sectionLines = section.split('\n')
    const meta = parseSectionMeta(section)
    const paths = parseSectionPaths(section, sectionLines)

    let path: string
    let oldPath: string | null = null
    let status: FileStatus

    if (meta.renamedTo) {
      path = meta.renamedTo
      oldPath = meta.renamedFrom
      status = 'renamed'
    } else if (paths.isNew) {
      path = paths.to ?? headerPath(section)
      status = 'added'
    } else if (paths.isDeleted) {
      path = paths.from ?? headerPath(section)
      status = 'deleted'
    } else if (paths.to !== null && paths.to !== '/dev/null') {
      path = paths.to
      status = 'modified'
    } else {
      path = headerPath(section)
      status = 'modified'
    }

    const kind: FileKind = meta.symlink
      ? 'symlink'
      : meta.binary
        ? isImagePath(path)
          ? 'image'
          : 'binary'
        : isImagePath(path)
          ? 'image'
          : 'text'

    const seen = new Map<string, number>()
    /*
     * Only a patch that carries no text has no hunks — `meta.binary`, git's own
     * verdict, not a guess from the extension. An SVG is text: git diffs it as text,
     * and a file with no hunks has no Viewed checkbox, is skipped by the folder
     * roll-up and can never satisfy `isDone`. It is also markup that can carry
     * `<script>` and external references, which is what a review is for.
     */
    const hunks: Hunk[] = meta.binary
      ? []
      : parseHunks(sectionLines).map((hunk) => {
          const lines = hunk.lines
          const contentKey = lines
            .filter((l) => l.kind !== 'context')
            .map((l) => `${l.kind}:${l.text}`)
            .join('\n')
          const occurrence = seen.get(contentKey) ?? 0
          seen.set(contentKey, occurrence + 1)
          return {
            id: hunkId(path, lines, occurrence),
            path,
            oldStart: hunk.oldStart,
            newStart: hunk.newStart,
            lines,
            ...(hunk.context === null ? {} : { context: hunk.context }),
          }
        })

    files.push({ path, oldPath, status, kind, staged: false, hunks })
  }
  return files
}

function stripAB(p: string): string {
  return p.startsWith('b/') || p.startsWith('a/') ? p.slice(2) : p
}

function headerPath(section: string): string {
  const header = section.split('\n', 1)[0] ?? ''
  const match = header.match(/^diff --git a\/(.*) b\/(.*)$/)
  return match?.[2] ?? header.replace(/^diff --git /, '')
}
