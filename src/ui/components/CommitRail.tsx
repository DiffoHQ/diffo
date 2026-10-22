import { useState } from 'react'
import type { ReviewThread } from '../../shared/review.js'
import { type CommitInfo, type FileChange, UNCOMMITTED } from '../../shared/types.js'
import { fileMarks, isFileViewed } from '../fileMarks.js'
import { timeAgo } from '../markdown.js'
import { Icon } from './Icon.js'
import { MarkBox } from './MarkBox.js'
import { FileTree, type FileTreeProps } from './Nav.js'

/**
 * The changeset as it was written: one row per commit, oldest first, read the
 * way the Layers tab reads an outline. The leading mark is the commit's
 * roll-up — every file in *its own* diff — and marks are hunk-keyed, so a hunk
 * no later commit touched is the same mark here and on the Files tab.
 */

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

export interface CommitProgress {
  files: number
  doneFiles: number
  marks: number
  doneMarks: number
}

export function commitProgress(
  files: readonly FileChange[],
  viewed: ReadonlySet<string>,
): CommitProgress {
  let marks = 0
  let doneMarks = 0
  let doneFiles = 0
  for (const file of files) {
    const own = fileMarks(file)
    marks += own.length
    doneMarks += own.filter((m) => viewed.has(m)).length
    if (isFileViewed(file, viewed)) doneFiles++
  }
  return { files: files.length, doneFiles, marks, doneMarks }
}

function CommitRow({
  commit,
  files,
  current,
  open,
  onToggleOpen,
  viewed,
  threadCount,
  onPick,
  onMarkFiles,
  onClearFiles,
}: {
  commit: CommitInfo
  /** The commit's own diff; undefined while it loads. */
  files: readonly FileChange[] | undefined
  current: boolean
  open: boolean
  onToggleOpen: () => void
  viewed: ReadonlySet<string>
  threadCount: number
  onPick: () => void
  onMarkFiles?: (files: readonly FileChange[]) => void
  onClearFiles?: (files: readonly FileChange[]) => void
}) {
  const p = files ? commitProgress(files, viewed) : null
  const allDone = p !== null && p.files > 0 && p.doneFiles === p.files
  const some = p !== null && p.doneMarks > 0
  const markable = (files ?? []).filter((f) => !isFileViewed(f, viewed))
  const pending = commit.sha === UNCOMMITTED
  const { additions, deletions } = commit.stats
  const who = [commit.short, commit.author, commit.at ? timeAgo(commit.at) : null]
    .filter(Boolean)
    .join(' · ')
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: the row's own pick button is the keyboard path; this only widens the mouse target to the whole row
    // biome-ignore lint/a11y/useKeyWithClickEvents: same — the pick button inside carries the keys
    <div
      className={`row row-layer row-commit${allDone ? ' row-done' : ''}${pending ? ' row-layer-since' : ''}`}
      aria-current={current ? 'true' : undefined}
      data-commit={commit.sha}
      onClick={onPick}
    >
      {/* biome-ignore lint/a11y/useSemanticElements: a native checkbox cannot express the roll-up's mixed state */}
      <button
        type="button"
        className="row-box"
        role="checkbox"
        aria-checked={allDone ? true : some ? 'mixed' : false}
        aria-label={
          allDone
            ? `Mark ${commit.subject} not reviewed`
            : `Mark ${plural(markable.length, 'file')} in ${commit.subject} reviewed`
        }
        data-tip={allDone ? 'Mark commit not reviewed' : 'Mark commit reviewed'}
        disabled={!files || files.length === 0 || (allDone ? !onClearFiles : !onMarkFiles)}
        onClick={(e) => {
          e.stopPropagation()
          if (!files) return
          if (allDone) onClearFiles?.(files)
          else onMarkFiles?.(markable)
        }}
      >
        <MarkBox state={allDone ? true : some ? 'mixed' : false} />
      </button>
      <button
        type="button"
        className="row-pick"
        title={commit.body ? `${commit.subject}\n\n${commit.body}` : commit.subject}
        onClick={(e) => {
          e.stopPropagation()
          onPick()
        }}
      >
        <span className="row-name">
          <span className="row-base">{commit.subject}</span>
        </span>
        <span className="ch-sub">
          {p !== null && p.doneMarks > 0 && (
            <span className="prog-track" aria-hidden="true">
              <i
                style={{
                  width: `${p.marks === 0 ? 0 : Math.round((p.doneMarks / p.marks) * 100)}%`,
                }}
              />
            </span>
          )}
          <span>
            {who && (
              <>
                <span className="commit-who">{who}</span>
                {' · '}
              </>
            )}
            {plural(commit.stats.files, 'file')}
            {(additions > 0 || deletions > 0) && (
              <>
                {' · '}
                {additions > 0 && <span className="stat-add">+{additions}</span>}
                {additions > 0 && deletions > 0 && ' '}
                {deletions > 0 && <span className="stat-del">−{deletions}</span>}
              </>
            )}
            {allDone ? ' · read' : ''}
          </span>
        </span>
      </button>
      <span className="row-right">
        {threadCount > 0 && (
          <span className="row-count" title={plural(threadCount, 'thread')}>
            <Icon name="chat" size="sm" />
            {threadCount}
          </span>
        )}
        {files && files.length > 0 && (
          <button
            type="button"
            className={`row-act ch-fold chevron${open ? '' : ' chevron-shut'}`}
            aria-expanded={open}
            aria-label={`${open ? 'Hide' : 'Show'} the files in ${commit.subject}`}
            data-tip={open ? 'Hide files' : 'Show files'}
            onClick={(e) => {
              e.stopPropagation()
              onToggleOpen()
            }}
          >
            <Icon name="chev" size="sm" />
          </button>
        )}
      </span>
    </div>
  )
}

export function CommitRail({
  commits,
  filesBySha,
  activeSha,
  onPick,
  viewed,
  threads,
  onMarkCommitFiles,
  onClearCommitFiles,
  loading = false,
  error,
  ...tree
}: {
  commits: readonly CommitInfo[]
  filesBySha: ReadonlyMap<string, FileChange[]>
  activeSha: string | null
  onPick: (sha: string) => void
  viewed: ReadonlySet<string>
  /** Threads by the path they are on; a row counts the ones on its files. */
  threads?: Map<string, ReviewThread[]>
  onMarkCommitFiles?: (files: readonly FileChange[]) => void
  onClearCommitFiles?: (files: readonly FileChange[]) => void
  loading?: boolean
  error?: string
} & Omit<FileTreeProps, 'files' | 'notes' | 'forceOpen' | 'viewed' | 'threads'>) {
  const [opened, setOpened] = useState<ReadonlySet<string>>(new Set())
  const toggle = (sha: string) =>
    setOpened((prev) => {
      const next = new Set(prev)
      if (next.has(sha)) next.delete(sha)
      else next.add(sha)
      return next
    })
  const threadCount = (files: readonly FileChange[] | undefined) =>
    (files ?? []).reduce((n, f) => n + (threads?.get(f.path)?.length ?? 0), 0)

  if (error) return <div className="rail-empty">{error}</div>
  if (commits.length === 0) {
    return (
      <div className="rail-scroll">
        <div className="rail-empty">
          {loading
            ? 'reading the commits…'
            : 'No commits to step through — this review is of uncommitted changes. Open one against a branch to read it commit by commit.'}
        </div>
      </div>
    )
  }
  return (
    <div className="rail-scroll">
      {commits.map((commit) => {
        const files = filesBySha.get(commit.sha)
        const open = opened.has(commit.sha)
        const pending = commit.sha === UNCOMMITTED
        return (
          <div key={commit.sha} className="ch-layer">
            {pending && <div className="rail-rule" />}
            <CommitRow
              commit={commit}
              files={files}
              current={commit.sha === activeSha}
              open={open}
              onToggleOpen={() => toggle(commit.sha)}
              viewed={viewed}
              threadCount={threadCount(files)}
              onPick={() => onPick(commit.sha)}
              onMarkFiles={onMarkCommitFiles}
              onClearFiles={onClearCommitFiles}
            />
            {open && files && files.length > 0 && (
              <div className="ch-files">
                <FileTree
                  files={files}
                  viewed={viewed}
                  {...tree}
                  threads={threads}
                  selectedPath={commit.sha === activeSha ? tree.selectedPath : null}
                  onPickFile={
                    tree.onPickFile
                      ? (path) => {
                          if (commit.sha !== activeSha) onPick(commit.sha)
                          tree.onPickFile?.(path)
                        }
                      : undefined
                  }
                  onToggleFileViewed={
                    tree.onToggleFileViewed && commit.sha === activeSha
                      ? tree.onToggleFileViewed
                      : undefined
                  }
                  onMarkFiles={
                    onMarkCommitFiles
                      ? (paths) => onMarkCommitFiles(files.filter((f) => paths.includes(f.path)))
                      : undefined
                  }
                  onClearFiles={
                    onClearCommitFiles
                      ? (paths) => onClearCommitFiles(files.filter((f) => paths.includes(f.path)))
                      : undefined
                  }
                />
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}
