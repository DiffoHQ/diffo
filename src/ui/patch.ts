/**
 * How to read the lines of a patch file (`.patch`, `.diff`) so each line's code
 * can be highlighted in the language of the file the patch targets.
 *
 * A review only sees a slice of the patch — a hunk of it — so the target is taken
 * from the headers in view, falling back to the patch's own name
 * (`foo.cc.patch` targets a `.cc`).
 */

/**
 * A contiguous stretch of one target file, by line index into the patch. `old`
 * holds context and deleted lines, `new` context and added lines: each is
 * highlighted as its own stream, so a deleted line opening a comment does not
 * swallow the added lines after it. Lines in no run are headers, hunk markers
 * or prose, and keep the diff grammar.
 */
export interface PatchRun {
  lang: string
  old: number[]
  new: number[]
}

const META = [
  'diff ',
  'index ',
  'Index: ',
  '@@',
  '====',
  'new file mode',
  'deleted file mode',
  'old mode',
  'new mode',
  'similarity index',
  'dissimilarity index',
  'rename from',
  'rename to',
  'copy from',
  'copy to',
  'Binary files',
  'GIT binary patch',
  '\\',
]

/** `patches/foo.cc.patch` → `patches/foo.cc`; null when nothing names a target. */
export function targetFromPatchName(path: string): string | null {
  const match = /^(.*\.[^./]+)\.(patch|diff)$/i.exec(path)
  return match ? match[1]! : null
}

/** The path a `---`/`+++`/`diff --git`/`Index:` header names, or null for `/dev/null`. */
function headerPath(raw: string): string | null {
  let path = raw.split('\t')[0]!.trim()
  if (path.startsWith('"') && path.endsWith('"')) path = path.slice(1, -1)
  if (path === '/dev/null' || path === '') return null
  return path.replace(/^[ab]\//, '')
}

/**
 * The target a header line names: a path, null for `/dev/null`, or undefined
 * when the line is not a header.
 */
function headerTarget(lines: string[], i: number): string | null | undefined {
  const line = lines[i]!
  // `--- x` is a header only beside its `+++ y`; alone it is a deleted line
  // that began with `--` (an SQL or Lua comment, a YAML separator).
  if (line.startsWith('--- ') && lines[i + 1]?.startsWith('+++ ')) return headerPath(line.slice(4))
  if (line.startsWith('+++ ') && lines[i - 1]?.startsWith('--- ')) return headerPath(line.slice(4))
  if (line.startsWith('diff --git ')) return / b\/(.+)$/.exec(line)?.[1] ?? null
  if (line.startsWith('Index: ')) return headerPath(line.slice(7))
  return undefined
}

/** A line of the target file behind its marker, rather than a header or prose. */
function isCodeLine(line: string): boolean {
  if (META.some((m) => line.startsWith(m))) return false
  const first = line[0]
  return line === '' || first === ' ' || first === '+' || (first === '-' && line !== '-- ')
}

export function patchRuns(
  lines: string[],
  fallbackLang: string | null,
  langFor: (path: string) => string | null,
): PatchRun[] {
  const runs: PatchRun[] = []
  let lang = fallbackLang
  let run: PatchRun | null = null
  for (const [i, line] of lines.entries()) {
    const target = headerTarget(lines, i)
    if (target) lang = langFor(target)
    if (target !== undefined || !isCodeLine(line)) {
      run = null
      continue
    }
    if (!lang) continue
    if (!run) {
      run = { lang, old: [], new: [] }
      runs.push(run)
    }
    if (line[0] !== '+') run.old.push(i)
    if (line[0] !== '-') run.new.push(i)
  }
  return runs
}
