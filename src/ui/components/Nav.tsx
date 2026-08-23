import { type ReactElement, useCallback, useMemo, useRef, useState } from 'react'
import type { ReviewThread } from '../../shared/review.js'
import type { FileChange, FileStatus } from '../../shared/types.js'
import { isFileViewed } from '../fileMarks.js'
import { fileAnchor, glideTo } from '../hooks.js'
import { isTestFile } from '../reviewFilter.js'
import type { ThreadItem } from '../threads.js'
import { Icon } from './Icon.js'
import { MarkBox } from './MarkBox.js'
import { Menu, MenuItem } from './Menu.js'

export type TreeDir = {
  kind: 'dir'
  name: string
  path: string
  children: TreeNode[]
}
export type TreeFile = { kind: 'file'; file: FileChange }
export type TreeNode = TreeDir | TreeFile

const basename = (path: string) => path.slice(path.lastIndexOf('/') + 1)

const STATUS_WORD: Record<FileStatus, string> = {
  added: 'new file',
  deleted: 'deleted',
  renamed: 'renamed',
  modified: 'edited',
}

export function buildTree(files: FileChange[]): TreeNode[] {
  type Draft = { dirs: Map<string, Draft>; files: FileChange[]; path: string }
  const root: Draft = { dirs: new Map(), files: [], path: '' }
  for (const file of files) {
    const segs = file.path.split('/')
    let node = root
    for (const seg of segs.slice(0, -1)) {
      let child = node.dirs.get(seg)
      if (!child) {
        child = { dirs: new Map(), files: [], path: node.path === '' ? seg : `${node.path}/${seg}` }
        node.dirs.set(seg, child)
      }
      node = child
    }
    node.files.push(file)
  }
  const finish = (draft: Draft): TreeNode[] => {
    const dirs: TreeDir[] = []
    for (const [name, child] of draft.dirs) {
      let dir: TreeDir = { kind: 'dir', name, path: child.path, children: finish(child) }
      for (;;) {
        const only = dir.children.length === 1 ? dir.children[0] : undefined
        if (only === undefined || only.kind !== 'dir') break
        dir = {
          kind: 'dir',
          name: `${dir.name}/${only.name}`,
          path: only.path,
          children: only.children,
        }
      }
      dirs.push(dir)
    }
    dirs.sort((a, b) => a.name.localeCompare(b.name))
    const leaves: TreeFile[] = draft.files
      .map((file) => ({ kind: 'file' as const, file }))
      .sort((a, b) => basename(a.file.path).localeCompare(basename(b.file.path)))
    return [...dirs, ...leaves]
  }
  return finish(root)
}

function filesUnder(node: TreeNode): FileChange[] {
  if (node.kind === 'file') return [node.file]
  return node.children.flatMap(filesUnder)
}

function FileRow({
  file,
  depth,
  done,
  current,
  threads,
  wantsYou = 0,
  changed = false,
  onPick,
  onToggleViewed,
  onAsk,
}: {
  file: FileChange
  depth: number
  done: boolean
  current: boolean
  threads?: ReviewThread[]
  wantsYou?: number
  changed?: boolean
  onPick?: () => void
  onToggleViewed?: () => void
  onAsk?: () => void
}) {
  const count = threads?.length ?? 0
  let additions = 0
  let deletions = 0
  for (const hunk of file.hunks) {
    for (const line of hunk.lines) {
      if (line.kind === 'add') additions++
      else if (line.kind === 'del') deletions++
    }
  }
  const stat =
    additions > 0 || deletions > 0
      ? ` · ${additions > 0 ? `+${additions}` : ''}${additions > 0 && deletions > 0 ? ' ' : ''}${deletions > 0 ? `−${deletions}` : ''}`
      : ''
  return (
    <div
      className={`row${done ? ' row-done' : ''}`}
      aria-current={current ? 'true' : undefined}
      data-path={file.path}
      style={{ paddingLeft: 12 + depth * 14 }}
    >
      {/* biome-ignore lint/a11y/useSemanticElements: shares the row-box treatment with the folder roll-up, which needs mixed */}
      <button
        type="button"
        className="row-box"
        role="checkbox"
        aria-checked={done}
        aria-label={`${done ? 'Mark not reviewed' : 'Mark reviewed'}: ${file.path}`}
        title={done ? 'Mark not reviewed' : 'Mark reviewed'}
        disabled={!onToggleViewed}
        onClick={onToggleViewed}
      >
        <MarkBox state={done} />
      </button>
      <button
        type="button"
        className="row-pick"
        title={`${file.path} · ${STATUS_WORD[file.status]}${done ? ' · read' : ''}${stat}`}
        onClick={() => {
          if (onPick) return onPick()
          const node = document.getElementById(fileAnchor(file.path))
          if (node) glideTo(node)
        }}
      >
        <span className="row-name">
          {file.status === 'added' && (
            <span className="row-st row-st-add" aria-hidden="true">
              +
            </span>
          )}
          {file.status === 'deleted' && (
            <span className="row-st row-st-del" aria-hidden="true">
              −
            </span>
          )}
          {file.status === 'renamed' && file.oldPath !== null && (
            <span className="row-was">{basename(file.oldPath)} →</span>
          )}
          <span className={`row-base${file.status === 'deleted' ? ' row-base-del' : ''}`}>
            {basename(file.path)}
          </span>
        </span>
      </button>
      <span className="row-right">
        {changed && (
          <span
            role="img"
            className="row-since row-since-changed"
            title="your agent rewrote this since you last finished a review"
            aria-label="changed since your last review"
          />
        )}
        <span className="row-passive">
          {wantsYou > 0 ? (
            <span
              className="row-count row-count-hot"
              title={`${wantsYou} of ${count} thread${count === 1 ? '' : 's'} needs you`}
            >
              <Icon name="chat" size="sm" />
              {wantsYou} needs you
            </span>
          ) : count > 0 ? (
            <span className="row-count" title={`${count} thread${count === 1 ? '' : 's'}`}>
              <Icon name="chat" size="sm" />
              {count}
            </span>
          ) : null}
        </span>
        <span className="row-acts">
          {onAsk && (
            <button
              type="button"
              className="row-act"
              title="Comment on this file"
              aria-label="Comment on this file"
              onClick={onAsk}
            >
              <Icon name="chat" size="sm" />
            </button>
          )}
        </span>
      </span>
    </div>
  )
}

export function Nav({
  files,
  viewed,
  selectedPath,
  onPickFile,
  onToggleFileViewed,
  onMarkFiles,
  onClearFiles,
  onAskFile,
  threads,
  attention,
  changed,
  hideReviewed = false,
  onHideReviewed,
  hideTests = false,
  onHideTests,
  onlyChanged = false,
  onOnlyChanged,
}: {
  files: FileChange[]
  viewed?: ReadonlySet<string>
  selectedPath?: string | null
  onPickFile?: (path: string) => void
  onToggleFileViewed?: (path: string) => void
  onMarkFiles?: (paths: string[]) => void
  onClearFiles?: (paths: string[]) => void
  onAskFile?: (path: string) => void
  threads?: Map<string, ReviewThread[]>
  attention?: Map<string, ThreadItem[]>
  changed?: ReadonlySet<string>
  hideReviewed?: boolean
  onHideReviewed?: (on: boolean) => void
  hideTests?: boolean
  onHideTests?: (on: boolean) => void
  onlyChanged?: boolean
  onOnlyChanged?: (on: boolean) => void
}) {
  const [query, setQuery] = useState('')
  const [shut, setShut] = useState<ReadonlySet<string>>(new Set())
  const searchRef = useRef<HTMLInputElement>(null)

  const isDone = useCallback((file: FileChange) => isFileViewed(file, viewed), [viewed])

  // The tally counts the whole changeset, not the filtered view — "12 left" must
  // stay honest while a filter narrows what's on screen.
  const left = files.filter((f) => !isDone(f)).length
  const testCount = files.filter((f) => isTestFile(f.path)).length
  const sinceCount = files.filter((f) => changed?.has(f.path) ?? false).length

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase()
    return files.filter(
      (f) =>
        (q === '' || f.path.toLowerCase().includes(q)) &&
        !(hideReviewed && isDone(f)) &&
        !(hideTests && isTestFile(f.path)) &&
        !(onlyChanged && !(changed?.has(f.path) ?? false)),
    )
  }, [files, query, hideReviewed, hideTests, onlyChanged, changed, isDone])

  const tree = useMemo(() => buildTree(visible), [visible])
  const filtering = query.trim() !== ''

  const fileRow = (file: FileChange, depth: number) => (
    <FileRow
      key={file.path}
      file={file}
      depth={depth}
      done={isDone(file)}
      current={selectedPath === file.path}
      threads={threads?.get(file.path)}
      wantsYou={(attention?.get(file.path) ?? []).filter((i) => i.turn === 'yours').length}
      changed={changed?.has(file.path) ?? false}
      onPick={onPickFile ? () => onPickFile(file.path) : undefined}
      onToggleViewed={onToggleFileViewed ? () => onToggleFileViewed(file.path) : undefined}
      onAsk={onAskFile ? () => onAskFile(file.path) : undefined}
    />
  )

  const dirRows = (dir: TreeDir, depth: number): ReactElement[] => {
    const inside = filesUnder(dir)
    const open = filtering || !shut.has(dir.path)
    // Every file under here can be owed — including the hunkless ones. Same cut as
    // `fileProgress`.
    const doneCount = inside.filter(isDone).length
    const allDone = inside.length > 0 && doneCount === inside.length
    const markable = inside.filter((f) => !isDone(f))
    const row = (
      <div
        key={`dir:${dir.path}`}
        className={`row row-dir${allDone ? ' row-done' : ''}`}
        style={{ paddingLeft: 12 + depth * 14 }}
      >
        {/* biome-ignore lint/a11y/useSemanticElements: a native checkbox cannot express the folder roll-up's mixed state */}
        <button
          type="button"
          className="row-box"
          role="checkbox"
          aria-checked={allDone ? true : doneCount > 0 ? 'mixed' : false}
          aria-label={
            allDone
              ? `Mark ${dir.name} not reviewed`
              : `Mark ${markable.length} file${markable.length === 1 ? '' : 's'} in ${dir.name} reviewed`
          }
          title={
            allDone
              ? `Mark ${inside.length} file${inside.length === 1 ? '' : 's'} not reviewed`
              : `Mark ${markable.length} file${markable.length === 1 ? '' : 's'} reviewed`
          }
          disabled={allDone ? !onClearFiles : !onMarkFiles}
          onClick={() => {
            if (allDone) onClearFiles?.(inside.map((f) => f.path))
            else onMarkFiles?.(markable.map((f) => f.path))
          }}
        >
          <MarkBox state={allDone ? true : doneCount > 0 ? 'mixed' : false} />
        </button>
        <button
          type="button"
          className="row-pick"
          title={dir.path}
          aria-expanded={open}
          onClick={() =>
            setShut((prev) => {
              const next = new Set(prev)
              if (open) next.add(dir.path)
              else next.delete(dir.path)
              return next
            })
          }
        >
          <span className="row-name">
            <span className={`chevron${open ? '' : ' chevron-shut'}`}>
              <Icon name="chev" size="sm" />
            </span>
            <span className="dir-ico">
              <Icon name="folder" size="sm" />
            </span>
            <span className="row-base">{dir.name}</span>
          </span>
        </button>
      </div>
    )
    return open ? [row, ...nodeRows(dir.children, depth + 1)] : [row]
  }

  const nodeRows = (nodes: TreeNode[], depth: number): ReactElement[] =>
    nodes.flatMap((node) =>
      node.kind === 'file' ? [fileRow(node.file, depth)] : dirRows(node, depth),
    )

  return (
    <>
      <div className="rail-search">
        <span className="sb">
          <Icon name="search" size="sm" />
          <input
            ref={searchRef}
            className="nav-search"
            type="search"
            placeholder="Filter files"
            aria-label="Filter files"
            title="Press / to jump here"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          {query !== '' && (
            <button
              type="button"
              className="sb-clear"
              title="Clear filter"
              aria-label="Clear filter"
              onClick={() => {
                setQuery('')
                searchRef.current?.focus()
              }}
            >
              <Icon name="x" size="sm" />
            </button>
          )}
        </span>
        {(onHideReviewed || onHideTests || onOnlyChanged) && (
          <Menu
            label="Filter options"
            icon="filter"
            triggerClassName={`btn btn-ghost btn-icon btn-sm${hideReviewed || hideTests || onlyChanged ? ' rail-filter-on' : ''}`}
          >
            {() => (
              <>
                {onHideReviewed && (
                  <MenuItem checked={hideReviewed} onClick={() => onHideReviewed(!hideReviewed)}>
                    Hide reviewed
                  </MenuItem>
                )}
                {onHideTests && (
                  <MenuItem checked={hideTests} onClick={() => onHideTests(!hideTests)}>
                    Hide tests <span className="menu-n">{testCount}</span>
                  </MenuItem>
                )}
                {onOnlyChanged && (sinceCount > 0 || onlyChanged) && (
                  <MenuItem checked={onlyChanged} onClick={() => onOnlyChanged(!onlyChanged)}>
                    Only since review <span className="menu-n">{sinceCount}</span>
                  </MenuItem>
                )}
              </>
            )}
          </Menu>
        )}
      </div>
      {files.length > 0 && (
        <div className="rail-tally">{left === 0 ? 'all reviewed' : `${left} left to review`}</div>
      )}

      <div className="rail-scroll">
        {nodeRows(tree, 0)}
        {visible.length === 0 && <div className="rail-empty">no files match</div>}
      </div>
    </>
  )
}
