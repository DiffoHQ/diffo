import type {
  ChangesetSpec,
  CommitChangeset,
  CommitInfo,
  CommitsResponse,
  FileChange,
} from '../shared/types.js'
import { UNCOMMITTED } from '../shared/types.js'
import { getCommitDiffAsync, getFullDiffAsync, listCommitsAsync } from './git.js'
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

/** A commit's diff has no working-tree file to size a trailing gap from, so
 * `newLineCount` stays unknown and that gap is simply not offered. */
const commitFiles = (raw: string): FileChange[] =>
  parsePatch(raw).map((file) => ({ ...file, staged: false, newLineCount: null }))

const uncommittedFiles = async (root: string): Promise<FileChange[]> =>
  commitFiles(await getFullDiffAsync(root, { kind: 'working-tree' }))

/**
 * The changeset's commits, oldest first. A branch review's diff runs from the
 * merge-base to the *working tree*, so edits not yet committed are part of what
 * is under review: they follow the commits as one more entry, when there are any.
 */
export async function listCommits(root: string, spec: ChangesetSpec): Promise<CommitsResponse> {
  const raw = await listCommitsAsync(root, spec)
  if (raw.length === 0) return { commits: [] }
  const commits: CommitInfo[] = raw.map((c) => ({
    sha: c.sha,
    short: c.short,
    subject: c.subject,
    body: c.body,
    author: c.author,
    at: c.at,
    stats: c.stats,
  }))
  const pending = await uncommittedFiles(root)
  if (pending.length > 0) {
    commits.push({
      sha: UNCOMMITTED,
      short: '',
      subject: 'Uncommitted changes',
      body: '',
      author: null,
      at: null,
      stats: stats(pending),
    })
  }
  return { commits }
}

/**
 * One listed commit's own diff. The sha must be one `listCommits` returns: the
 * route never hands git a ref the reviewer typed, only one it already listed.
 * Null when it is not in the changeset.
 */
export async function getCommitChangeset(
  root: string,
  spec: ChangesetSpec,
  sha: string,
): Promise<CommitChangeset | null> {
  if (sha === UNCOMMITTED) {
    if (spec.kind !== 'branch') return null
    return { sha, files: await uncommittedFiles(root) }
  }
  const listed = await listCommitsAsync(root, spec)
  if (!listed.some((c) => c.sha === sha)) return null
  return { sha, files: commitFiles(await getCommitDiffAsync(root, sha)) }
}
