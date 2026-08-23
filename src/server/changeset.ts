import { resolve } from 'node:path'
import type { Changeset, ChangesetSpec, FileChange } from '../shared/types.js'
import {
  getBranchName,
  getFullDiff,
  getHeadFileBytes,
  getRepoName,
  getStagedPaths,
  getWorktreeName,
} from './git.js'
import { parsePatch } from './parse.js'

function stats(files: FileChange[]) {
  let additions = 0
  let deletions = 0
  for (const file of files) {
    for (const hunk of file.hunks) {
      for (const line of hunk.lines) {
        if (line.kind === 'add') additions++
        else if (line.kind === 'del') deletions++
      }
    }
  }
  return { files: files.length, additions, deletions }
}

/** Head-side line count — what sizes the expandable gap after a file's last hunk. */
function headLineCount(root: string, file: FileChange): number | null {
  if (file.kind !== 'text' || file.status === 'deleted') return null
  const bytes = getHeadFileBytes(root, file.path)
  if (bytes === null) return null
  const text = bytes.toString('utf-8')
  if (text === '') return 0
  return text.split('\n').length - (text.endsWith('\n') ? 1 : 0)
}

export function buildChangesetFromRaw(
  root: string,
  spec: ChangesetSpec,
  rawDiff: string,
  version: number,
): Changeset {
  const staged = getStagedPaths(root)
  const files = parsePatch(rawDiff).map((file) => ({
    ...file,
    staged: staged.has(file.path) || (file.oldPath !== null && staged.has(file.oldPath)),
    newLineCount: headLineCount(root, file),
  }))
  return {
    version,
    spec,
    repo: {
      path: resolve(root),
      name: getRepoName(root),
      branch: getBranchName(root),
      worktree: getWorktreeName(root),
    },
    files,
    stats: stats(files),
  }
}

export function buildChangeset(root: string, spec: ChangesetSpec, version: number): Changeset {
  return buildChangesetFromRaw(root, spec, getFullDiff(root, spec), version)
}
