import type { FileChange } from '../shared/types.js'

/** Changed lines past which a file's diff is stubbed instead of rendered. */
export const LARGE_DIFF_LINES = 400

/**
 * Files nobody reads line by line: lockfiles, minified bundles, source maps,
 * snapshots. Same idea as GitHub's linguist-generated collapse, kept to the
 * common cases a heuristic can know without configuration.
 */
const GENERATED = [
  /(^|\/)pnpm-lock\.yaml$/,
  /(^|\/)package-lock\.json$/,
  /(^|\/)npm-shrinkwrap\.json$/,
  /(^|\/)yarn\.lock$/,
  /(^|\/)bun\.lockb?$/,
  /(^|\/)Cargo\.lock$/,
  /(^|\/)Gemfile\.lock$/,
  /(^|\/)composer\.lock$/,
  /(^|\/)go\.sum$/,
  /(^|\/)poetry\.lock$/,
  /(^|\/)uv\.lock$/,
  /\.min\.(js|css)$/,
  /\.(js|css)\.map$/,
  /\.snap$/,
]

export function changedLineCount(file: FileChange): number {
  let n = 0
  for (const hunk of file.hunks) {
    for (const line of hunk.lines) if (line.kind !== 'context') n++
  }
  return n
}

export type StubReason = 'generated' | 'large'

/**
 * Why a file's diff should render as a click-to-load stub, or null to render it.
 * The data is cheap — the hunks are already in memory — what's being deferred is
 * the DOM and the syntax highlighting.
 */
export function stubReason(file: FileChange): StubReason | null {
  // Binary, image and hunkless files have their own stubs already.
  if (file.hunks.length === 0) return null
  if (GENERATED.some((re) => re.test(file.path))) return 'generated'
  return changedLineCount(file) > LARGE_DIFF_LINES ? 'large' : null
}
