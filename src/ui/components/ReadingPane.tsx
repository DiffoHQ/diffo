import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { type Anchor, isPublic, type LineRange, type ReviewThread } from '../../shared/review.js'
import type { DiffLine, FileChange, Hunk } from '../../shared/types.js'
import { copyText } from '../clipboard.js'
import { changedLineCount, type StubReason, stubReason } from '../diffStub.js'
import { isFileViewed } from '../fileMarks.js'
import {
  EXPAND_STEP,
  fileGaps,
  type Gap,
  type GapExpansion,
  gapRemaining,
  gapSize,
  materializeGap,
  NO_EXPANSION,
} from '../gaps.js'
import { fileAnchor } from '../hooks.js'
import type { LayerListKind } from '../layerListPref.js'
import type { LayerScopeKind } from '../layerScopePref.js'
import { linkPaths, type RefLinks, type ResolvedDecision, refClickTarget } from '../layers.js'
import { EMPTY_DELTA, type LiveDelta } from '../liveDelta.js'
import { usePr } from '../prMode.js'
import type { ThreadPartition } from '../reviewPlacement.js'
import { involves } from '../threads.js'
import { CommitMessage } from './CommitMessage.js'
import { Decisions } from './Decisions.js'
import { GapBand, type GapControls, HunkCard } from './HunkCard.js'
import { Icon } from './Icon.js'
import { ImageDiff } from './ImageDiff.js'
import { MarkBox } from './MarkBox.js'
import { Markdown } from './Markdown.js'
import { canPreviewMarkdown, MarkdownPreview } from './MarkdownPreview.js'
import { Menu, MenuItem } from './Menu.js'
import { PaneBar, type PaneLayer } from './PaneBar.js'
import { ReviewDone } from './ReviewDone.js'
import { type LandedNotice, ReviewLanded } from './ReviewLanded.js'
import { CommentBox, type ReviewActions, ThreadList } from './Threads.js'

export type ViewMode = 'unified' | 'split'

export interface PaneControls {
  navHidden?: boolean
  onToggleNav?: () => void
  left: number
  total: number
  hunksRead?: number
  hunksTotal?: number
  /** 1-based position of the selected hunk in reading order; 0 when none. */
  hunkAt?: number
  hunkCount?: number
  query: string
  onClearQuery: () => void
  hiddenQuery: number
  hideReviewed: boolean
  onHideReviewed: (on: boolean) => void
  hideTests: boolean
  onHideTests: (on: boolean) => void
  testCount: number
  onlyChanged: boolean
  onOnlyChanged: (on: boolean) => void
  changedCount: number
  hiddenTests: number
  hiddenReviewed: number
  hiddenUnchanged: number
  pinned: ReadonlySet<string>
  onSweep: (path: string) => void
  onShowAll: () => void
  onFinish?: () => void
  stats?: { additions: number; deletions: number }
  unsent?: number
  scopeLeft: number
  scopeTotal: number
  excludedTests: number
  excludedUnchanged: number
  onIncludeExcluded?: () => void
  viewMode: ViewMode
  onSetViewMode: (mode: ViewMode) => void
  allCollapsed: boolean
  onToggleCollapseAll: () => void
  /** The bar's account of the active layer, with its pager. */
  layer?: PaneLayer
}

/**
 * The active layer, as the pane reads it: a header card above the files, read
 * once and scrolled past — so navigation is not on it (see `PaneLayer`). The
 * pane shows this layer's files, all of them: the outline is the narrowing,
 * and the filters step aside while it is up.
 */
export interface LayerView {
  /** The stored layer id; null on the derived trailing layer, which has no
   * identity to comment on. */
  id: string | null
  /** Set on a commit's card: the commit whose message the card can turn into
   * commentable lines, `title` being its subject. */
  commit?: { sha: string; body: string }
  /** `Layer 3 of 6`, or the derived layer's own kicker. */
  kicker: string
  title: string
  /** The agent tagged it `mechanical`: a chip after the title; files fold. */
  mechanical: boolean
  summary?: string
  /** Listed paths the changeset lacks right now — named on the card, since no
   * file header below will. The files it has are the headers themselves. */
  missing: string[]
  /** How many listed files the changeset has right now, hidden ones included. */
  listed: number
  /** Of those, how many `Hide tests` is keeping off the pane. */
  hidden: number
  /** A `path` / `path:line` reference in the summary was clicked. */
  onJump: (path: string, line: number | null) => void
  /** Per-file notes for the file headers — the agent's, or a site count on a
   * mechanical layer. */
  notes: ReadonlyMap<string, string>
  /** What a summary reference may resolve to. */
  knownPaths: readonly string[]
  /** The agent's decisions for this step, under the summary. Absent when none. */
  decisions?: readonly ResolvedDecision[]
  /** The open decision card, owned above so `.` can drive it. */
  openDecision?: number | null
  onOpenDecision?: (index: number | null) => void
  /** The order the pane reads this layer's files in — the agent's, or by
   * folder — and the switch to the other. One pick for the whole review; the
   * card is where it shows because the card is where a layer starts. Absent
   * when there is nothing to order (one file or none). */
  reading?: { kind: LayerListKind; onPick: (kind: LayerListKind) => void }
  /** How much of the step's files shows — its lines, its hunks, or its
   * files whole — and the switch. Review-wide like `reading`, and a view
   * only. `unavailable` greys the picks that would show just what hunks does
   * in this step; the pane reads them as hunks. */
  scope?: {
    kind: LayerScopeKind
    unavailable: readonly LayerScopeKind[]
    onPick: (kind: LayerScopeKind) => void
  }
  /** The files this layer holds only part of, by path: which hunks read here,
   * and where each of the others reads. Absent when every file is whole. */
  parts?: ReadonlyMap<string, FilePart>
  /** Go to another layer — the step a folded run of hunks belongs to. */
  onGoLayer?: (index: number) => void
  /** The read marks of each file this layer reads only part of — some hunks,
   * or highlighted lines (`entryMarks`). The file's Viewed and dim are these. */
  marks?: ReadonlyMap<string, readonly string[]>
  /** The lines this layer is about, by path: the agent's highlights, or every
   * changed line of a file it highlighted nothing in. Lit only under the
   * "lines" pick. Absent when the layer highlights nothing. */
  highlights?: ReadonlyMap<string, readonly LineRange[]>
}

/** Where a hunk that is not this layer's reads instead. */
export interface ElsewhereStep {
  /** Index into the outline, for `onGoLayer`. */
  index: number
  title: string
  /** 1-based, or null for the derived trailing layer. */
  number: number | null
}

/**
 * A file the active layer holds part of. The pane shows `shown` and folds the
 * rest into one row per run, named for the step it reads in; the file's
 * Viewed, and its dim, are `shown`'s alone.
 */
export interface FilePart {
  shown: ReadonlySet<string>
  elsewhere: ReadonlyMap<string, ElsewhereStep>
}

function stepViewed(
  file: FileChange,
  part: FilePart | undefined,
  marks: readonly string[] | undefined,
  viewed: ReadonlySet<string> | undefined,
): boolean {
  const own = marks ?? (part ? [...part.shown] : undefined)
  if (own === undefined) return isFileViewed(file, viewed)
  return viewed !== undefined && own.every((m) => viewed.has(m))
}

const SCOPE_CHIPS: Record<LayerScopeKind, { label: string; tip: string }> = {
  highlights: {
    label: 'lines',
    tip: "This layer's hunks with the lines the agent highlighted lit and the rest dimmed; a file it highlighted nothing in lights throughout",
  },
  parts: {
    label: 'hunks',
    tip: "The hunks this layer changed, plain; a shared file's other hunks fold into a row naming their layer",
  },
  whole: {
    label: 'files',
    tip: "Every hunk of each file in this layer, other layers' hunks too, dimmed and tagged with their layer",
  },
}

/** Why a pick is greyed in this layer: it would show just what hunks does. */
const SCOPE_UNAVAILABLE: Partial<Record<LayerScopeKind, string>> = {
  highlights:
    'Not available in this layer: the agent highlighted no lines here, so there is nothing to light within its hunks',
  whole:
    'Not available in this layer: no file here has changes in other layers, so files shows the same as hunks',
}

const SCOPE_ORDER: readonly LayerScopeKind[] = ['highlights', 'parts', 'whole']

/** The pick the pane acts on: the reviewer's, unless this step greys it. */
function shownScope(scope: LayerView['scope']): LayerScopeKind {
  if (!scope) return 'parts'
  return scope.unavailable.includes(scope.kind) ? 'parts' : scope.kind
}

function ScopePick({ id, scope }: { id: string; scope: NonNullable<LayerView['scope']> }) {
  const live = shownScope(scope)
  return (
    <span className="ch-head-pick ch-head-scope">
      <span className="ch-head-order-cap" id={`ch-scope-${id}`}>
        Show this layer changed
      </span>
      <span className="src-seg ch-order-seg" role="radiogroup" aria-labelledby={`ch-scope-${id}`}>
        {SCOPE_ORDER.map((kind) => {
          // aria-disabled, not disabled: a disabled button gets no hover, and
          // the tooltip saying why is the point.
          const off = scope.unavailable.includes(kind)
          return (
            // biome-ignore lint/a11y/useSemanticElements: styled chips; a native radio cannot carry this treatment
            <button
              key={kind}
              type="button"
              role="radio"
              className="src-chip"
              aria-checked={kind === live}
              aria-disabled={off || undefined}
              data-tip={off ? SCOPE_UNAVAILABLE[kind] : SCOPE_CHIPS[kind].tip}
              onClick={off ? undefined : () => scope.onPick(kind)}
            >
              {SCOPE_CHIPS[kind].label}
            </button>
          )
        })}
      </span>
    </span>
  )
}

function stepName(step: ElsewhereStep): string {
  return step.number === null ? step.title : `step ${step.number} · ${step.title}`
}

/**
 * The row standing in for hunks that read in another step: one per run of
 * them, where they sit in the file. The count opens them in place; the step
 * name goes there. It wears the gap band's clothes because it is the same
 * idea — code that is here, folded — with a reason instead of a line count.
 */
function ElsewhereRow({
  count,
  step,
  open,
  onToggle,
  onGo,
}: {
  count: number
  step: ElsewhereStep
  open: boolean
  onToggle: () => void
  onGo?: () => void
}) {
  const where = stepName(step)
  return (
    <div className={`hunk-elsewhere${open ? ' hunk-elsewhere-open' : ''}`}>
      <button
        type="button"
        className="elsewhere-toggle"
        aria-expanded={open}
        title={open ? 'Fold them again' : 'Show them here, dimmed'}
        onClick={onToggle}
      >
        <span className={`chevron${open ? '' : ' chevron-shut'}`}>
          <Icon name="chev" size="sm" />
        </span>
        {count} {count === 1 ? 'hunk' : 'hunks'} in
      </button>
      {onGo ? (
        <button
          type="button"
          className="elsewhere-go"
          title={`Read them in ${where}`}
          onClick={onGo}
        >
          {where}
        </button>
      ) : (
        <span className="elsewhere-go">{where}</span>
      )}
    </div>
  )
}

type CardAnchor = Extract<Anchor, { kind: 'layer' } | { kind: 'commit' }>

function cardAnchor(layer: LayerView): CardAnchor | null {
  if (layer.commit !== undefined) {
    return { kind: 'commit', sha: layer.commit.sha, subject: layer.title }
  }
  if (layer.id === null) return null
  return { kind: 'layer', layerId: layer.id, title: layer.title }
}

function cardThreads(anchor: CardAnchor, partition: ThreadPartition | undefined): ReviewThread[] {
  const threads =
    anchor.kind === 'commit'
      ? partition?.byCommit.get(anchor.sha)
      : partition?.byLayer.get(anchor.layerId)
  return threads ?? []
}

function LayerHead({
  layer,
  filesShown,
  comments,
}: {
  layer: LayerView
  /** How many of the layer's files the pane is rendering under the card. */
  filesShown: number
  comments?: ReviewComments
}) {
  const summary = layer.summary ? linkPaths(layer.summary, layer.knownPaths) : null
  // A comment on the step itself — its order, its summary, the split — rather
  // than on a line in it. Only an outlined layer has an identity to hang one
  // on; the derived trailing layer is the UI's, not the agent's.
  const [composerOpen, setComposerOpen] = useState(false)
  // What the box cites: the decision the comment came from, shown as a block
  // above the words and sent ahead of them, so the agent knows which one is
  // meant. Nothing otherwise.
  const [cite, setCite] = useState<{ label: string; text: string } | null>(null)
  const headAnchor = cardAnchor(layer)
  const ownThreads = headAnchor ? cardThreads(headAnchor, comments?.partition) : []
  const onLine = (t: ReviewThread) => t.anchor.kind === 'commit' && t.anchor.line !== undefined
  const headThreads = ownThreads.filter((t) => !onLine(t))
  const lineThreads = ownThreads.filter(onLine)
  // A commit's message reads as Markdown until the reviewer reaches for its
  // lines. Once a thread is on a line the lines stay, or it would render nowhere.
  const [asLines, setAsLines] = useState(false)
  const linesOffered = layer.commit !== undefined && comments !== undefined
  const showLines = linesOffered && (asLines || lineThreads.length > 0)
  const toLines = (e: React.MouseEvent) => {
    if (!linesOffered || (e.target as Element).closest('a')) return
    if (window.getSelection()?.toString()) return
    setAsLines(true)
  }
  const onClick = (e: React.MouseEvent) => {
    const ref = refClickTarget(e.target as Element)
    if (!ref) {
      toLines(e)
      return
    }
    e.preventDefault()
    layer.onJump(ref.path, ref.line)
  }
  const emptied = filesShown === 0
  const hasDecisions = !!(layer.decisions && layer.decisions.length > 0 && layer.onOpenDecision)
  const hasAbout = (summary !== null && !showLines) || layer.missing.length > 0 || emptied
  const canComment = comments !== undefined && headAnchor !== null
  return (
    <section className="ch-head" aria-label={`${layer.kicker}: ${layer.title}`}>
      <div className="ch-head-top">
        <div className="ch-head-kicker">{layer.kicker}</div>
        {/* The one action on the card, in its corner: a comment on the step
            itself, which steps aside while the box is open below. A commit's
            message takes comments on its lines instead, and the corner turns
            them back into the formatted message. */}
        {showLines && lineThreads.length === 0 ? (
          <button
            type="button"
            className="btn btn-ghost btn-sm ch-head-ask"
            onClick={() => setAsLines(false)}
          >
            Show formatted
          </button>
        ) : (
          canComment &&
          !layer.commit &&
          !composerOpen && (
            <button
              type="button"
              className="btn btn-ghost btn-sm ch-head-ask"
              onClick={() => setComposerOpen(true)}
            >
              <Icon name="chat" size="sm" />
              Comment on this layer
            </button>
          )
        )}
      </div>
      {/* The title is the card: what this step IS, before anything about it. */}
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: commenting on a message's lines starts with the mouse, like a range drag in the gutter */}
      <h2
        className={linesOffered && !showLines ? 'ch-head-to-lines' : undefined}
        onClick={showLines ? undefined : toLines}
      >
        {layer.title}
        {layer.mechanical && (
          <span
            className="ch-kind"
            title="changes no behaviour; files are folded, expand one to check"
          >
            mechanical
          </span>
        )}
      </h2>
      {showLines && layer.commit && headAnchor?.kind === 'commit' && (
        <CommitMessage
          anchor={headAnchor}
          body={layer.commit.body}
          threads={ownThreads.filter(onLine)}
          comments={comments}
        />
      )}
      {(hasAbout || hasDecisions) && (
        <div className="ch-head-body">
          {hasAbout && (
            <div className="ch-head-about">
              {summary && !showLines && (
                // biome-ignore lint/a11y/noStaticElementInteractions: click delegation for the links inside rendered markdown
                // biome-ignore lint/a11y/useKeyWithClickEvents: the links themselves are focusable and keyboard-activated
                <div
                  className={linesOffered ? 'ch-head-to-lines' : undefined}
                  data-tip={linesOffered ? 'Click to comment on its lines' : undefined}
                  onClick={onClick}
                >
                  <Markdown
                    text={summary}
                    className="cmt-body markdown ch-summary"
                    paths={layer.knownPaths}
                  />
                </div>
              )}
              {layer.missing.length > 0 && (
                <div className="ch-head-files">
                  <span className="ch-head-missing">not in the changeset now:</span>
                  {layer.missing.map((path) => (
                    <span
                      key={path}
                      className="ch-chip ch-chip-done"
                      title={`${path}, not in the changeset now`}
                    >
                      {path}
                    </span>
                  ))}
                </div>
              )}
              {emptied && layer.listed === 0 && (
                <div className="ch-head-empty">
                  Nothing this layer lists is in the changeset right now. Move on with{' '}
                  <span className="kbd">]</span>.
                </div>
              )}
              {emptied && layer.listed > 0 && layer.hidden === layer.listed && (
                // Every file here is a test, and Hide tests is on: say so, rather than
                // let a layer with files look like one without. The switch that undoes
                // it is on the bar above.
                <div className="ch-head-empty">
                  {layer.hidden === 1 ? 'The one file' : `All ${layer.hidden} files`} in this layer{' '}
                  {layer.hidden === 1 ? 'is a test' : 'are tests'}, hidden by <b>Hide tests</b> on
                  the bar. Move on with <span className="kbd">]</span>.
                </div>
              )}
            </div>
          )}
          {hasDecisions && (
            <Decisions
              decisions={layer.decisions!}
              open={layer.openDecision ?? null}
              onOpen={layer.onOpenDecision!}
              onJump={layer.onJump}
              onComment={
                canComment
                  ? (i) => {
                      setCite({ label: 'decision', text: layer.decisions![i]!.decision.text })
                      setComposerOpen(true)
                    }
                  : undefined
              }
            />
          )}
        </div>
      )}
      {/* The reviewer's two picks, one line: the order the files below come in,
          and how much of them shows. Each is a phrase — the words, then the
          choices as chips with the live one lit — so both states are in view
          and nothing needs decoding. Both picks are review-wide; here is
          where they are felt. The line wraps on a narrow pane. */}
      {(layer.reading || layer.scope) && !emptied && (
        <div className="ch-head-order">
          {layer.reading && (
            <span className="ch-head-pick">
              <span className="ch-head-order-cap" id={`ch-order-${layer.id ?? 'since'}`}>
                Read the files in
              </span>
              <span
                className="src-seg ch-order-seg"
                role="radiogroup"
                aria-labelledby={`ch-order-${layer.id ?? 'since'}`}
              >
                {/* biome-ignore lint/a11y/useSemanticElements: styled chips; a native radio cannot carry this treatment */}
                <button
                  type="button"
                  role="radio"
                  className="src-chip"
                  aria-checked={layer.reading.kind !== 'tree'}
                  data-tip="The order the agent outlined this layer in"
                  onClick={() => layer.reading!.onPick('order')}
                >
                  the agent’s order
                </button>
                {/* biome-ignore lint/a11y/useSemanticElements: styled chips; a native radio cannot carry this treatment */}
                <button
                  type="button"
                  role="radio"
                  className="src-chip"
                  aria-checked={layer.reading.kind === 'tree'}
                  data-tip="By folder, the way the Files tab lists them"
                  onClick={() => layer.reading!.onPick('tree')}
                >
                  folder order
                </button>
              </span>
            </span>
          )}
          {layer.scope && <ScopePick id={layer.id ?? 'since'} scope={layer.scope} />}
        </div>
      )}
      {/* The step's own conversation: only there when there is one, or one is
          being written — an empty footer would be a rule under nothing. */}
      {canComment && (headThreads.length > 0 || composerOpen) && (
        <div className="ch-head-threads">
          {headThreads.length > 0 && (
            <ThreadList
              threads={headThreads}
              actions={comments.actions}
              showContext
              agentConnected={comments.agentConnected}
              workingOn={comments.workingOn}
              queuedOn={comments.queuedOn}
              links={comments.links}
            />
          )}
          {composerOpen && (
            <CommentBox
              citing={cite ?? undefined}
              title="Comment on this layer"
              placeholder="Ask about this step, or say what should change in it…"
              scope={{ label: `layer “${layer.title}”`, canWiden: false }}
              // GitHub has no layers: on a pull request this is a private ask.
              fixedAudience="agent"
              agentConnected={comments.agentConnected}
              onSubmit={(text, _wide, intent) => {
                void comments.actions.create(headAnchor, text, intent)
                setComposerOpen(false)
                setCite(null)
              }}
              onSend={(text, _wide, intent) => {
                void comments.actions
                  .create(headAnchor, text, intent)
                  .then((t) => comments.actions.send(t.id))
                setComposerOpen(false)
                setCite(null)
              }}
              onCancel={() => {
                setComposerOpen(false)
                setCite(null)
              }}
            />
          )}
        </div>
      )}
    </section>
  )
}

export interface ReviewComments {
  partition: ThreadPartition
  /** Threads the changeset has left behind — their file is no longer in the diff, so
   * no file body can hold them. The pane keeps a section of its own for them; without
   * it the rail lists conversations that render nowhere and can't be read. */
  past?: ReviewThread[]
  actions: ReviewActions
  agentConnected?: boolean
  workingOn?: ReadonlySet<string>
  queuedOn?: ReadonlyMap<string, number>
  revealNotesTick?: number
  revealPastTick?: number
  /** The thread a reveal is for: one folded behind "more from others" on a pull
   * request has to be unfolded before it can be scrolled to. */
  revealThreadId?: string | null
  composeHunkId?: string | null
  onComposeHandled?: () => void
  composeFilePath?: string | null
  onComposeFileHandled?: () => void
  changesetComposerOpen?: boolean
  onOpenChangesetComposer?: () => void
  onCloseChangesetComposer?: () => void
  /** Turns file references in the changeset threads — the guide above all —
   * into jumps: the map of the change doubles as its navigation. */
  links?: RefLinks
}

export interface ReviewHandlers {
  viewed?: ReadonlySet<string>
  onToggleFileViewed?: (path: string) => void
  selectedId?: string | null
  onSelect?: (hunkId: string) => void
  viewMode?: ViewMode
  collapsed?: ReadonlySet<string>
  onToggleCollapsed?: (path: string) => void
  comments?: ReviewComments
}

const STATUS_WORD: Partial<Record<FileChange['status'], string>> = {
  added: 'added',
  deleted: 'deleted',
  renamed: 'renamed',
}

function FileHeader({
  file,
  viewed,
  collapsed = false,
  onToggle,
  commentCount = 0,
  sinceCount = 0,
  note,
  part,
  marks,
  whole = false,
  onToggleWhole,
  onComment,
  onToggleFileViewed,
}: {
  file: FileChange
  viewed?: ReadonlySet<string>
  collapsed?: boolean
  onToggle?: () => void
  commentCount?: number
  /** The layer holds part of this file: the chip says how much, Viewed marks
   * that part, and **Whole file** opens the rest. */
  part?: FilePart
  marks?: readonly string[]
  whole?: boolean
  onToggleWhole?: () => void
  /** Hunks the agent changed since the last Finish and still unread — said once
   * here, as a count; the hunks themselves carry only the bar. */
  sinceCount?: number
  /** Why this file is in its layer, in the agent's words — or, on a mechanical
   * layer, how many sites it holds. */
  note?: string
  onComment?: () => void
  onToggleFileViewed?: () => void
}) {
  const [copied, setCopied] = useState(false)
  const [previewOpen, setPreviewOpen] = useState(false)
  // A live update can collapse/remove this header before the flag times out.
  const copyTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => clearTimeout(copyTimer.current), [])
  let additions = 0
  let deletions = 0
  for (const hunk of file.hunks) {
    for (const line of hunk.lines) {
      if (line.kind === 'add') additions++
      else if (line.kind === 'del') deletions++
    }
  }
  const allViewed = stepViewed(file, part, marks, viewed)
  const cut = file.path.lastIndexOf('/')
  const statusWord = STATUS_WORD[file.status]
  const stop = (e: React.MouseEvent) => e.stopPropagation()

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: folding is also the chevron button inside
    // biome-ignore lint/a11y/useKeyWithClickEvents: folding is also the chevron button inside
    <div className="file-header" onClick={onToggle}>
      <button
        type="button"
        className={`file-chevron chevron${collapsed ? ' chevron-shut' : ''}`}
        aria-expanded={!collapsed}
        data-tip={`${collapsed ? 'Expand' : 'Collapse'} this file`}
        aria-label={`${collapsed ? 'Expand' : 'Collapse'} ${file.path}`}
      >
        <Icon name="chev" />
      </button>
      <span className="file-path">
        {file.status === 'renamed' && file.oldPath && (
          <>
            <span className="file-oldpath">{file.oldPath}</span>
            {' → '}
          </>
        )}
        {cut !== -1 && (
          <span className="file-dir">
            <bdi>{file.path.slice(0, cut + 1)}</bdi>
          </span>
        )}
        <span className="file-base">{file.path.slice(cut + 1)}</span>
      </span>
      {statusWord && <span className={`file-status file-status-${file.status}`}>{statusWord}</span>}
      {sinceCount > 0 && (
        <span className="file-since" title="since your last review; reading it settles it">
          the agent changed{' '}
          {sinceCount === file.hunks.length
            ? 'this'
            : `${sinceCount} ${sinceCount === 1 ? 'hunk' : 'hunks'}`}
        </span>
      )}
      {part && (
        <span
          className="file-part"
          title={`this step reads ${part.shown.size} of the file's ${file.hunks.length} hunks; the others belong to other steps`}
        >
          {part.shown.size} of {file.hunks.length} hunks
        </span>
      )}
      {note && (
        <span className="ch-file-note" title={note}>
          {note}
        </span>
      )}
      <button
        type="button"
        className="ghb file-copy"
        data-tip={copied ? 'Copied' : 'Copy path'}
        aria-label="Copy path"
        onClick={(e) => {
          stop(e)
          void copyText(file.path).then(() => {
            setCopied(true)
            clearTimeout(copyTimer.current)
            copyTimer.current = setTimeout(() => setCopied(false), 1500)
          })
        }}
      >
        <Icon name={copied ? 'check' : 'copy'} size="sm" />
      </button>
      <span className="grow" />
      {(additions > 0 || deletions > 0) && (
        <span className="dstat">
          {additions > 0 && <span className="stat-add">+{additions}</span>}
          {deletions > 0 && <span className="stat-del">−{deletions}</span>}
        </span>
      )}
      {part && onToggleWhole && (
        <button
          type="button"
          className="file-preview-btn file-whole"
          aria-pressed={whole}
          title={
            whole
              ? 'Back to this step’s hunks'
              : 'Show the whole file: every hunk, with all the lines between'
          }
          onClick={(e) => {
            stop(e)
            onToggleWhole()
          }}
        >
          <Icon name={whole ? 'fold' : 'unfold'} size="sm" />
          Whole file
        </button>
      )}
      {canPreviewMarkdown(file) && (
        <button
          type="button"
          className="file-preview-btn"
          title="Read this file rendered"
          aria-label={`Preview ${file.path} rendered`}
          onClick={(e) => {
            stop(e)
            setPreviewOpen(true)
          }}
        >
          <Icon name="book" size="sm" />
          Preview
        </button>
      )}
      {onToggleFileViewed && (
        <button
          type="button"
          className="file-viewed-toggle"
          aria-pressed={allViewed}
          title={part ? 'mark this step’s hunks read' : 'mark this whole file read'}
          onClick={(e) => {
            stop(e)
            onToggleFileViewed()
          }}
        >
          <MarkBox state={allViewed} />
          Viewed
        </button>
      )}
      {/* The bubble is a count, not a control: it appears once the file has threads
          and jumps to them. Starting one lives in the menu, and on every line. */}
      {onComment && commentCount > 0 && (
        <button
          type="button"
          className="ghb file-comment-btn"
          title={`${commentCount} ${commentCount === 1 ? 'thread' : 'threads'} on this file`}
          aria-label="Comment on this file"
          onClick={(e) => {
            stop(e)
            onComment()
          }}
        >
          <Icon name="chat" size="sm" />
          <span className="ghb-badge">{commentCount}</span>
        </button>
      )}
      {/* biome-ignore lint/a11y/noStaticElementInteractions: the handler only contains a mouse click */}
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: the handler only contains a mouse click */}
      <span onClick={stop}>
        <Menu label="More file actions" triggerClassName="ghb">
          {(close) => (
            <>
              {onComment && (
                <MenuItem
                  icon="chat"
                  onClick={() => {
                    close()
                    onComment()
                  }}
                >
                  Comment on this file
                </MenuItem>
              )}
              <MenuItem
                icon="copy"
                onClick={() => {
                  close()
                  void copyText(file.path)
                }}
              >
                Copy path
              </MenuItem>
              <MenuItem
                icon="fold"
                kbd="o"
                onClick={() => {
                  close()
                  onToggle?.()
                }}
              >
                {collapsed ? 'Expand file' : 'Collapse file'}
              </MenuItem>
            </>
          )}
        </Menu>
      </span>
      {previewOpen && (
        // The backdrop click that closes the modal must not also reach the
        // header's collapse toggle.
        // biome-ignore lint/a11y/noStaticElementInteractions: the handler only stops propagation
        // biome-ignore lint/a11y/useKeyWithClickEvents: the handler only stops propagation
        <span onClick={stop}>
          <MarkdownPreview path={file.path} onClose={() => setPreviewOpen(false)} />
        </span>
      )}
    </div>
  )
}

interface GapState {
  fingerprint: string
  /** Head-side file text, fetched once per file on the first expansion and shared
   * by every gap; a fingerprint change (any content edit) drops it. */
  headLines: string[] | null
  exp: Map<string, GapExpansion>
  failed: Set<string>
}

function freshGapState(fingerprint: string): GapState {
  return { fingerprint, headLines: null, exp: new Map(), failed: new Set() }
}

/**
 * The file owns expansion, not the hunk: a gap between two hunks is shared by both
 * cards, and the tail gap belongs to no hunk at all. Hunk ids are content-addressed,
 * so the fingerprint rotates on any edit and the expansions reset with it — same
 * reset semantics as everything else keyed by hunk id.
 */
function useGapExpansion(file: FileChange) {
  const gaps = useMemo(() => fileGaps(file), [file])
  const fingerprint = useMemo(
    () => `${file.newLineCount ?? ''}#${file.hunks.map((h) => h.id).join('\n')}`,
    [file],
  )
  const [state, setState] = useState<GapState>(() => freshGapState(fingerprint))
  // Render-phase reset (the sanctioned "derived state" pattern): React re-renders
  // before committing, so a stale expansion never reaches the screen.
  if (state.fingerprint !== fingerprint) setState(freshGapState(fingerprint))
  const live = state.fingerprint === fingerprint ? state : freshGapState(fingerprint)

  const expand = async (gap: Gap, dir: 'up' | 'down' | 'all') => {
    let headLines = live.headLines
    if (headLines === null) {
      try {
        // One commit's own diff reads the file as that commit had it; the full
        // diff and uncommitted edits read the working tree.
        const rev = file.rev ? `&rev=${encodeURIComponent(file.rev)}` : ''
        const res = await fetch(`/api/file?path=${encodeURIComponent(file.path)}&side=head${rev}`)
        if (!res.ok) throw new Error(`/api/file → ${res.status}`)
        const text = await res.text()
        headLines = text.endsWith('\n') ? text.slice(0, -1).split('\n') : text.split('\n')
      } catch {
        setState((prev) =>
          prev.fingerprint !== fingerprint
            ? prev
            : { ...prev, failed: new Set(prev.failed).add(gap.key) },
        )
        return
      }
    }
    const cur = live.exp.get(gap.key) ?? NO_EXPANSION
    const next: GapExpansion =
      dir === 'all'
        ? { fromTop: gapSize(gap), fromBottom: 0 }
        : dir === 'down'
          ? { ...cur, fromTop: cur.fromTop + EXPAND_STEP }
          : { ...cur, fromBottom: cur.fromBottom + EXPAND_STEP }
    // A live edit can have shortened the file past the gap — an expansion that
    // would reveal nothing new is reported, not silently swallowed.
    const before = materializeGap(headLines, gap, cur)
    const after = materializeGap(headLines, gap, next)
    const got = headLines
    if (after.top.length + after.bottom.length <= before.top.length + before.bottom.length) {
      setState((prev) =>
        prev.fingerprint !== fingerprint
          ? prev
          : { ...prev, headLines: got, failed: new Set(prev.failed).add(gap.key) },
      )
      return
    }
    setState((prev) => {
      if (prev.fingerprint !== fingerprint) return prev
      const failed = new Set(prev.failed)
      failed.delete(gap.key)
      return { ...prev, headLines: got, exp: new Map(prev.exp).set(gap.key, next), failed }
    })
  }

  const collapse = (gap: Gap) =>
    setState((prev) => {
      if (prev.fingerprint !== fingerprint) return prev
      const exp = new Map(prev.exp)
      exp.delete(gap.key)
      const failed = new Set(prev.failed)
      failed.delete(gap.key)
      return { ...prev, exp, failed }
    })

  // The whole file at once: one read of the head side, every gap fully open.
  const expandAll = async () => {
    if (gaps.length === 0) return
    let headLines = live.headLines
    if (headLines === null) {
      try {
        const rev = file.rev ? `&rev=${encodeURIComponent(file.rev)}` : ''
        const res = await fetch(`/api/file?path=${encodeURIComponent(file.path)}&side=head${rev}`)
        if (!res.ok) throw new Error(`/api/file → ${res.status}`)
        const text = await res.text()
        headLines = text.endsWith('\n') ? text.slice(0, -1).split('\n') : text.split('\n')
      } catch {
        return
      }
    }
    const got = headLines
    setState((prev) => {
      if (prev.fingerprint !== fingerprint) return prev
      const exp = new Map(prev.exp)
      for (const gap of gaps) exp.set(gap.key, { fromTop: gapSize(gap), fromBottom: 0 })
      return { ...prev, headLines: got, exp, failed: new Set() }
    })
  }
  const collapseAll = () =>
    setState((prev) =>
      prev.fingerprint !== fingerprint ? prev : { ...prev, exp: new Map(), failed: new Set() },
    )

  // Memoized against the state object: without this, every render would rebuild the
  // expanded-line arrays, and HunkCard's tokenizer effect would retrigger forever.
  const visible = useMemo(() => {
    const m = new Map<string, { top: DiffLine[]; bottom: DiffLine[]; merged: boolean }>()
    if (live.headLines === null) return m
    for (const gap of gaps) {
      const exp = live.exp.get(gap.key)
      if (exp) m.set(gap.key, materializeGap(live.headLines, gap, exp))
    }
    return m
  }, [gaps, live])

  const controlsFor = (gap: Gap): GapControls => {
    const exp = live.exp.get(gap.key) ?? NO_EXPANSION
    return {
      remaining: gapRemaining(gap, exp),
      canUp: gap.below !== null,
      canDown: gap.above !== null,
      expanded: exp.fromTop + exp.fromBottom > 0,
      merged: visible.get(gap.key)?.merged ?? false,
      failed: live.failed.has(gap.key),
      onUp: () => void expand(gap, 'up'),
      onDown: () => void expand(gap, 'down'),
      onAll: () => void expand(gap, 'all'),
      onCollapse: () => collapse(gap),
    }
  }

  return { gaps, visible, controlsFor, expandAll, collapseAll }
}

/** One run of consecutive hunks that read in the same other step. */
interface ForeignRun {
  /** The first hunk's id: rotates with an edit, like every hunk-keyed state. */
  key: string
  step: ElsewhereStep
  hunks: Hunk[]
}

/**
 * The file's hunks that are not this layer's, grouped into runs: consecutive
 * hunks that belong to the same step fold into one row, so a file with its
 * middle in another step shows one row, not one per hunk.
 */
function foreignRuns(file: FileChange, part: FilePart): ForeignRun[] {
  const runs: ForeignRun[] = []
  let current: ForeignRun | null = null
  for (const hunk of file.hunks) {
    const step = part.elsewhere.get(hunk.id)
    if (!step) {
      current = null
      continue
    }
    if (current && current.step.index === step.index) current.hunks.push(hunk)
    else {
      current = { key: hunk.id, step, hunks: [hunk] }
      runs.push(current)
    }
  }
  return runs
}

export function FileBody({
  file,
  delta,
  sinceReview,
  handlers,
  composerOpen = false,
  onCloseComposer,
  stub = null,
  onLoadDiff,
  part,
  marks,
  whole = false,
  allHunks = false,
  onGoLayer,
  highlight,
}: {
  file: FileChange
  delta: LiveDelta
  sinceReview?: ReadonlySet<string>
  handlers: ReviewHandlers
  composerOpen?: boolean
  onCloseComposer?: () => void
  /** Render a click-to-load stub instead of the diff (large / generated file). */
  stub?: StubReason | null
  onLoadDiff?: () => void
  /** The layer holds part of this file: show those hunks, fold the rest. */
  part?: FilePart
  marks?: readonly string[]
  /** The reviewer asked for the whole file: every hunk, every gap open. */
  whole?: boolean
  /** Every hunk, other layers' too, shown in place and tagged; gaps stay as
   * they are. The layer card's "files". */
  allHunks?: boolean
  onGoLayer?: (index: number) => void
  highlight?: readonly LineRange[]
}) {
  // Deleted files have no head side to read context from; everything else expands.
  const expandable = file.status !== 'deleted' && file.kind === 'text'
  const { gaps, visible, controlsFor, expandAll, collapseAll } = useGapExpansion(file)
  // Runs of other steps' hunks the reviewer opened in place, by the id of the
  // first hunk in the run. An edit rotates the ids, and the run folds again.
  const [openRuns, setOpenRuns] = useState<ReadonlySet<string>>(new Set())
  const selectedId = handlers.selectedId
  // A jump into a folded run — a thread, a decision, a `path:line` — opens it:
  // the landing must be on screen.
  useEffect(() => {
    if (!part || selectedId == null || !part.elsewhere.has(selectedId)) return
    const runs = foreignRuns(file, part)
    const run = runs.find((r) => r.hunks.some((h) => h.id === selectedId))
    if (run && !openRuns.has(run.key)) setOpenRuns((prev) => new Set(prev).add(run.key))
  }, [part, selectedId, file, openRuns])
  // Whole file: open every gap on the way in, fold them on the way out. Only
  // on the change, so the reviewer's own expansions are left alone otherwise.
  const wholeWas = useRef(whole)
  useEffect(() => {
    if (wholeWas.current === whole) return
    wholeWas.current = whole
    if (whole) void expandAll()
    else collapseAll()
  })
  const comments = handlers.comments
  const fileThreads = comments?.partition.byFile.get(file.path) ?? []
  const base = file.path.slice(file.path.lastIndexOf('/') + 1)
  const fileAnchorFor = (wide: boolean) =>
    wide ? ({ kind: 'changeset' } as const) : ({ kind: 'file', path: file.path } as const)
  const fileSection = comments && (fileThreads.length > 0 || composerOpen) && (
    <div className="file-threads">
      <ThreadList
        threads={fileThreads}
        actions={comments.actions}
        showContext
        agentConnected={comments.agentConnected}
        workingOn={comments.workingOn}
        queuedOn={comments.queuedOn}
      />
      {composerOpen && (
        <CommentBox
          title={`Comment on ${base}`}
          placeholder="Leave a comment…"
          scope={{ label: base, canWiden: true }}
          agentConnected={comments.agentConnected}
          onSubmit={(text, wide, intent, audience) => {
            void (audience
              ? comments.actions.create(fileAnchorFor(wide), text, intent, { audience })
              : comments.actions.create(fileAnchorFor(wide), text, intent))
            onCloseComposer?.()
          }}
          onSend={(text, wide, intent) => {
            void comments.actions
              .create(fileAnchorFor(wide), text, intent)
              .then((t) => comments.actions.send(t.id))
            onCloseComposer?.()
          }}
          onCancel={() => onCloseComposer?.()}
        />
      )}
    </div>
  )
  if (stub !== null) {
    return (
      <>
        {fileSection}
        <div className="file-stub file-stub-large">
          <span>
            {stub === 'generated'
              ? 'Generated file, not rendered by default.'
              : `Large diff (${changedLineCount(file)} changed lines), not rendered by default.`}
          </span>
          <button type="button" className="btn btn-ghost btn-sm" onClick={onLoadDiff}>
            Load diff
          </button>
        </div>
      </>
    )
  }
  if (file.kind === 'image' && file.hunks.length === 0) {
    return (
      <>
        {fileSection}
        <ImageDiff file={file} />
      </>
    )
  }
  if (file.kind === 'binary') {
    return (
      <>
        {fileSection}
        <div className="file-stub">binary file changed</div>
      </>
    )
  }
  if (file.hunks.length === 0) {
    return (
      <>
        {fileSection}
        <div className="file-stub">
          {file.status === 'renamed' ? 'renamed, no content changes' : 'no content changes'}
        </div>
      </>
    )
  }
  // The dim is a file-level verdict, not a hunk-level one. While anything in the
  // file is still unread — a fresh round from the agent, or a first pass mid-file —
  // the ticked hunks around it are the context the unread ones are judged by, so
  // everything renders at full strength. Only a settled file fades. Under a
  // layer that holds part of the file, "the file" is that part.
  const fileViewed = stepViewed(file, part, marks, handlers.viewed)
  const runs = part ? foreignRuns(file, part) : []
  const runByFirst = new Map(runs.map((r) => [r.hunks[0]!.id, r]))
  const inRun = new Set(runs.flatMap((r) => r.hunks.slice(1).map((h) => h.id)))
  // A gap sits between two hunks: its band lives on the boundary of the hunk below
  // it, its expand-down lines glue to the tail of the hunk above it.
  const gapAboveHunk = new Map<number, Gap>()
  const gapBelowHunk = new Map<number, Gap>()
  for (const gap of gaps) {
    if (gap.below !== null) gapAboveHunk.set(gap.below, gap)
    if (gap.above !== null) gapBelowHunk.set(gap.above, gap)
  }
  const tailGap = gaps.find((g) => g.below === null)
  return (
    <>
      {fileSection}
      {file.kind === 'image' && <ImageDiff file={file} />}
      {file.hunks.map((hunk: Hunk, i: number) => {
        const above = expandable ? gapAboveHunk.get(i) : undefined
        const below = expandable ? gapBelowHunk.get(i) : undefined
        // Another step's hunk: folded into its run's row, or shown dimmed
        // under it once the row is open (always, for the whole file).
        const foreign = part?.elsewhere.get(hunk.id)
        const run = runByFirst.get(hunk.id)
        const open = whole || allHunks || (run !== undefined && openRuns.has(run.key))
        if (foreign && !open) {
          if (!run) return null
          return (
            <ElsewhereRow
              key={`run:${run.key}`}
              count={run.hunks.length}
              step={run.step}
              open={false}
              onToggle={() => setOpenRuns((prev) => new Set(prev).add(run.key))}
              onGo={onGoLayer ? () => onGoLayer(run.step.index) : undefined}
            />
          )
        }
        if (foreign && inRun.has(hunk.id) && !whole && !open) return null
        const card = (
          <HunkCard
            key={hunk.id}
            hunk={hunk}
            fresh={delta.freshHunkIds.has(hunk.id)}
            changedSinceReview={sinceReview?.has(hunk.id) ?? false}
            changedSinceViewed={delta.changedViewedHunkIds.has(hunk.id)}
            viewed={foreign ? (handlers.viewed?.has(hunk.id) ?? false) : fileViewed}
            selected={handlers.selectedId === hunk.id}
            onSelect={handlers.onSelect}
            viewMode={handlers.viewMode ?? 'unified'}
            linesAbove={above && visible.get(above.key)?.bottom}
            linesBelow={below && visible.get(below.key)?.top}
            gapAbove={above ? controlsFor(above) : null}
            threads={comments?.partition.byHunk.get(hunk.id)}
            reviewActions={comments?.actions}
            agentConnected={comments?.agentConnected}
            workingOn={comments?.workingOn}
            queuedOn={comments?.queuedOn}
            composeRequested={comments?.composeHunkId === hunk.id}
            onComposeHandled={comments?.onComposeHandled}
            highlight={foreign ? undefined : highlight}
          />
        )
        if (!foreign) return card
        // The first hunk of an open run carries the row that folds it again;
        // the rest of the run follows with its own tag.
        const owner = run ?? runs.find((r) => r.hunks.some((h) => h.id === hunk.id))
        return (
          <div
            key={`${hunk.id}:elsewhere`}
            className="hunk-elsewhere-body"
            data-step={foreign.index}
          >
            {run && !whole && !allHunks && owner && (
              <ElsewhereRow
                count={run.hunks.length}
                step={run.step}
                open
                onToggle={() =>
                  setOpenRuns((prev) => {
                    const next = new Set(prev)
                    next.delete(run.key)
                    return next
                  })
                }
                onGo={onGoLayer ? () => onGoLayer(run.step.index) : undefined}
              />
            )}
            {(whole || allHunks || !run) && (
              <div className="elsewhere-tag" title="this hunk reads in another step">
                {onGoLayer ? (
                  <button
                    type="button"
                    className="elsewhere-go"
                    onClick={() => onGoLayer(foreign.index)}
                  >
                    {stepName(foreign)}
                  </button>
                ) : (
                  <span className="elsewhere-go">{stepName(foreign)}</span>
                )}
              </div>
            )}
            {card}
          </div>
        )
      })}
      {expandable && tailGap && <GapBand gap={controlsFor(tailGap)} />}
    </>
  )
}

export function ReadingPane({
  files,
  delta = EMPTY_DELTA,
  sinceReview,
  hasMore = false,
  onLoadMore,
  controls,
  landed,
  layer,
  overview = false,
  ...handlers
}: {
  files: FileChange[]
  delta?: LiveDelta
  sinceReview?: ReadonlySet<string>
  hasMore?: boolean
  onLoadMore?: () => void
  controls?: PaneControls
  /** The previous review landed in a commit — offer the fresh start. */
  landed?: LandedNotice
  /** Layer mode: `files` is the active layer's, and this card heads them. */
  layer?: LayerView
  /** Layer mode, standing on the Overview: the pane is the changeset threads —
   * the guide first — and nothing else. */
  overview?: boolean
} & ReviewHandlers) {
  const [fileComposerFor, setFileComposerFor] = useState<string | null>(null)
  const [doneDismissed, setDoneDismissed] = useState(false)
  // Files whose stubbed diff the reviewer asked to see. Selection also opens a
  // stub durably: keyboard navigation must never land on a hunk with no DOM.
  const [diffLoaded, setDiffLoaded] = useState<ReadonlySet<string>>(new Set())
  // Files the reviewer opened whole under a layer that holds part of them.
  // Session state: a layer change is a new place, and the fold is the default.
  const [wholeFiles, setWholeFiles] = useState<ReadonlySet<string>>(new Set())
  const layerId = layer?.id
  // biome-ignore lint/correctness/useExhaustiveDependencies: the layer change is the trigger
  useEffect(() => setWholeFiles(new Set()), [layerId])
  const selectedId = handlers.selectedId
  useEffect(() => {
    if (!selectedId) return
    const hit = files.find((f) => f.hunks.some((h) => h.id === selectedId))
    if (hit && stubReason(hit) !== null) {
      setDiffLoaded((prev) => (prev.has(hit.path) ? prev : new Set(prev).add(hit.path)))
    }
  }, [selectedId, files])
  // Auto-load: when the end sentinel drifts within a screen of the viewport, ask
  // for the next batch. The observer is recreated per batch because observe()
  // reports the initial state — so a sentinel still inside the margin keeps
  // loading, which also fills a viewport taller than the first batch.
  const paneRef = useRef<HTMLDivElement>(null)
  const sentinelRef = useRef<HTMLDivElement>(null)
  // biome-ignore lint/correctness/useExhaustiveDependencies: recreating it per batch is the point
  useEffect(() => {
    if (!hasMore || !onLoadMore) return
    // No IntersectionObserver (jsdom, ancient browsers): render everything rather
    // than strand the tail of the changeset behind a dead sentinel.
    if (typeof IntersectionObserver === 'undefined') {
      onLoadMore()
      return
    }
    const node = sentinelRef.current
    if (!node) return
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) onLoadMore()
      },
      { root: paneRef.current, rootMargin: '1200px 0px' },
    )
    observer.observe(node)
    return () => observer.disconnect()
  }, [hasMore, onLoadMore, files.length])

  /**
   * The sweep — how a file you *jumped* to stops being an exception. A pin is how
   * a rail click or `n` lands on a file the filters are hiding, and that exemption
   * has to end, or every file you ever visited accumulates as an exception to a
   * filter that is still switched on.
   *
   * So a pinned file gives its exemption up once it is both read and scrolled out
   * of sight above — off-screen, with the height it took corrected out of the
   * scroll so the frame the reviewer is looking at does not move by a pixel.
   *
   * The listener is installed once and reads through a ref: `files`, `controls`
   * and `handlers.viewed` all change identity on most renders.
   */
  const sweepRef = useRef({ files, controls, viewed: handlers.viewed })
  sweepRef.current = { files, controls, viewed: handlers.viewed }
  // Height that left above the viewport, owed back to scrollTop on the commit that
  // actually removes it.
  const sweepDebt = useRef(0)
  useEffect(() => {
    const pane = paneRef.current
    if (!pane) return
    let frame = 0
    const check = () => {
      frame = 0
      const { files, controls, viewed } = sweepRef.current
      if (!controls?.hideReviewed || controls.pinned.size === 0) return
      const bar = pane.querySelector('.pane-bar')
      const edge = (bar ?? pane).getBoundingClientRect().bottom
      for (const file of files) {
        if (!controls.pinned.has(file.path)) continue
        if (!isFileViewed(file, viewed)) continue
        const node = document.getElementById(fileAnchor(file.path))
        if (!node) continue
        const rect = node.getBoundingClientRect()
        if (rect.bottom >= edge) continue
        sweepDebt.current += rect.height + (parseFloat(getComputedStyle(node).marginBottom) || 0)
        controls.onSweep(file.path)
      }
    }
    // Cancel-and-reschedule rather than skip-if-pending: a pending callback that
    // never runs — a backgrounded tab stops firing rAF — would leave a skip-guard
    // latched on and kill the sweep for the rest of the session.
    const onScroll = () => {
      if (frame !== 0) cancelAnimationFrame(frame)
      frame = requestAnimationFrame(check)
    }
    pane.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      pane.removeEventListener('scroll', onScroll)
      if (frame !== 0) cancelAnimationFrame(frame)
    }
  }, [])

  // Paid back before the browser paints, so the removal is never a visible jump.
  // No-ops unless the sweep just took something.
  useLayoutEffect(() => {
    const pane = paneRef.current
    if (!pane || sweepDebt.current === 0) return
    pane.scrollTop -= sweepDebt.current
    sweepDebt.current = 0
  })
  const askedFor = handlers.comments?.composeFilePath ?? null
  // biome-ignore lint/correctness/useExhaustiveDependencies: only a new request may open a file
  useEffect(() => {
    if (!askedFor) return
    if (handlers.collapsed?.has(askedFor)) handlers.onToggleCollapsed?.(askedFor)
    setFileComposerFor(askedFor)
    handlers.comments?.onComposeFileHandled?.()
  }, [askedFor])
  // Open by default: agent heads-ups and unanswered questions must not hide
  // behind a count the way the old "N changeset notes" fold did. In layer mode
  // the strip starts folded instead — the guide is row 0 of the outline, one
  // click away, and the layer's own card is what the pane should lead with.
  // The default is derived, not stored: layers arrive after the first render,
  // and a reviewer's own click is the only thing that should outlast that.
  const [notesChoice, setNotesChoice] = useState<boolean | null>(null)
  const notesOpen = notesChoice ?? layer === undefined
  const setNotesOpen = setNotesChoice
  const comments = handlers.comments
  const revealTick = comments?.revealNotesTick ?? 0
  useEffect(() => {
    if (revealTick > 0) setNotesOpen(true)
  }, [revealTick])
  // On the Overview the strip IS the pane, so it cannot fold; on a layer it is
  // not shown at all — the guide is one click away as row 0 of the outline.
  const notesExpanded = overview || notesOpen || comments?.changesetComposerOpen === true
  const stripShown = overview || layer === undefined
  const [pastOpen, setPastOpen] = useState(false)
  const pastTick = comments?.revealPastTick ?? 0
  useEffect(() => {
    if (pastTick > 0) setPastOpen(true)
  }, [pastTick])

  const pr = usePr()
  const noteCount = comments?.partition.changeset.length ?? 0
  // On a pull request the strip leads with what is yours: the description, the
  // private threads, and the GitHub threads you are part of. The rest of the
  // conversation — bots, mostly — waits behind one line, the rail's rule.
  const login = pr?.viewer.login ?? null
  const changesetThreads = comments?.partition.changeset
  const { lead, others } = useMemo(() => {
    const all = changesetThreads ?? []
    if (!pr) return { lead: all, others: [] as ReviewThread[] }
    const mine = (t: ReviewThread) =>
      t.github?.kind === 'description' || !isPublic(t) || involves(t, login)
    return { lead: all.filter(mine), others: all.filter((t) => !mine(t)) }
  }, [changesetThreads, pr, login])
  const [othersOpen, setOthersOpen] = useState(false)
  const revealId = comments?.revealThreadId ?? null
  useEffect(() => {
    if (revealTick > 0 && revealId !== null && others.some((t) => t.id === revealId)) {
      setOthersOpen(true)
    }
  }, [revealTick, revealId, others])
  const changesetSection = comments &&
    stripShown &&
    (noteCount > 0 || comments.changesetComposerOpen || overview) && (
      <section className="changeset-strip">
        <button
          type="button"
          className="strip-head"
          onClick={() => setNotesOpen(!notesOpen)}
          aria-expanded={notesExpanded}
        >
          <span className={`file-chevron chevron${notesExpanded ? '' : ' chevron-shut'}`}>
            <Icon name="chev" />
          </span>
          {pr ? 'On the pull request' : 'On the changeset'}
          <span className="strip-n">{noteCount}</span>
        </button>
        {notesExpanded && (
          <div className="strip-body">
            <ThreadList
              threads={lead}
              actions={comments.actions}
              showContext
              agentConnected={comments.agentConnected}
              workingOn={comments.workingOn}
              queuedOn={comments.queuedOn}
              links={comments.links}
            />
            {others.length > 0 && (
              <button
                type="button"
                className="strip-more"
                aria-expanded={othersOpen}
                onClick={() => setOthersOpen(!othersOpen)}
              >
                {othersOpen ? 'Only mine' : `${others.length} more from others`}
              </button>
            )}
            {othersOpen && others.length > 0 && (
              <ThreadList
                threads={others}
                actions={comments.actions}
                showContext
                agentConnected={comments.agentConnected}
                workingOn={comments.workingOn}
                queuedOn={comments.queuedOn}
                links={comments.links}
              />
            )}
            {comments.changesetComposerOpen ? (
              <CommentBox
                title="Note on the whole changeset"
                placeholder="Leave a note…"
                scope={{ label: 'the whole changeset', canWiden: false }}
                agentConnected={comments.agentConnected}
                onSubmit={(text, _wide, intent, audience) => {
                  void (audience
                    ? comments.actions.create({ kind: 'changeset' }, text, intent, { audience })
                    : comments.actions.create({ kind: 'changeset' }, text, intent))
                  comments.onCloseChangesetComposer?.()
                }}
                onSend={(text, _wide, intent) => {
                  void comments.actions
                    .create({ kind: 'changeset' }, text, intent)
                    .then((t) => comments.actions.send(t.id))
                  comments.onCloseChangesetComposer?.()
                }}
                onCancel={() => comments.onCloseChangesetComposer?.()}
              />
            ) : (
              comments.onOpenChangesetComposer && (
                <button
                  type="button"
                  className="strip-add"
                  onClick={comments.onOpenChangesetComposer}
                >
                  {pr ? '+ Comment on the pull request' : '+ Note on the changeset'}
                </button>
              )
            )}
          </div>
        )}
      </section>
    )

  const past = comments?.past ?? []
  // Two ways here: the file or hunk left the changeset, or GitHub marked the
  // line outdated while the file stayed. The hint says which, or both.
  const outdated = past.filter((t) => t.github?.outdated === true).length
  const onLayers = past.filter((t) => t.anchor.kind === 'layer').length
  const pastWhy =
    onLayers === past.length
      ? `The layer ${past.length === 1 ? 'this hangs' : 'these hang'} off left the outline: the agent re-posted without ${past.length === 1 ? 'its' : 'their'} title.`
      : outdated === past.length
        ? `${past.length === 1 ? 'This one is' : 'These are'} outdated on GitHub: the line ${past.length === 1 ? 'it hangs' : 'they hang'} off left the diff, though the file is still in it.`
        : outdated > 0
          ? `The file or change these hang off is no longer in the diff: reverted, deleted, or stashed; ${outdated} ${outdated === 1 ? 'is' : 'are'} outdated on GitHub instead, the line left the diff.`
          : 'The file or change these hang off is no longer in the diff: reverted, deleted, or stashed.'
  const pastSection = comments && past.length > 0 && (
    <section className="file-section past-threads">
      <button
        type="button"
        className="file-header notes-header"
        onClick={() => setPastOpen((v) => !v)}
        aria-expanded={pastOpen}
      >
        <span className={`file-chevron chevron${pastOpen ? '' : ' chevron-shut'}`}>
          <Icon name="chev" />
        </span>
        <span className="file-path">
          {past.length === 1 ? '1 thread' : `${past.length} threads`} whose{' '}
          {onLayers === past.length ? 'layer left the outline' : 'code left the changeset'}
        </span>
      </button>
      {pastOpen && (
        <div className="file-threads">
          <div className="past-hint">
            {pastWhy} The conversation is intact
            {onLayers === past.length
              ? '.'
              : ', and the snapshot inside each one is the code you commented on.'}
          </div>
          <ThreadList
            threads={past}
            actions={comments.actions}
            showContext
            gone
            agentConnected={comments.agentConnected}
            workingOn={comments.workingOn}
            queuedOn={comments.queuedOn}
          />
        </div>
      )}
    </section>
  )

  const total = controls?.total ?? 0
  const emptyChangeset = files.length === 0 && total === 0
  const allHidden = files.length === 0 && total > 0
  const scopeDone = controls !== undefined && controls.scopeTotal > 0 && controls.scopeLeft === 0
  useEffect(() => {
    if (scopeDone) setDoneDismissed(false)
  }, [scopeDone])
  const hiddenCount =
    (controls?.hiddenTests ?? 0) +
    (controls?.hiddenReviewed ?? 0) +
    (controls?.hiddenUnchanged ?? 0) +
    (controls?.hiddenQuery ?? 0)

  const done = controls && (
    <ReviewDone
      read={controls.total - controls.left}
      total={controls.total}
      excludedTests={controls.excludedTests}
      excludedUnchanged={controls.excludedUnchanged}
      stats={controls.stats}
      unsent={controls.unsent}
      onFinish={controls.onFinish}
      onIncludeExcluded={controls.onIncludeExcluded}
      onDismiss={() => setDoneDismissed(true)}
      shape={allHidden ? 'full' : 'docked'}
    />
  )

  // The layer card's Show pick, as this layer can honour it: "lines" lights
  // each file's highlighted lines, "files" shows every hunk of the file,
  // other layers' too, in place.
  const scope = shownScope(layer?.scope)
  const body = overview ? null : emptyChangeset ? (
    landed ? (
      <ReviewLanded {...landed} shape="full" />
    ) : (
      <div className="empty-state">
        <Icon name="book" size="lg" />
        <h2>Nothing to review</h2>
        <p>
          The working tree is clean. Diffo is watching; start your agent and changes appear here as
          they land.
        </p>
      </div>
    )
  ) : layer && files.length === 0 ? (
    // A layer whose files all left the changeset says so on its own card, and
    // next/prev skip it — the generic empty state would lose the reader's place.
    <LayerHead key={layer.commit?.sha} layer={layer} filesShown={0} comments={comments} />
  ) : allHidden && scopeDone ? (
    done
  ) : allHidden && controls ? (
    <div className="empty-state">
      <Icon name="filter" size="lg" />
      <h2>
        {controls.left} {controls.left === 1 ? 'file' : 'files'} still to review
      </h2>
      <p>
        {controls.hiddenQuery === 0
          ? "They're hidden by the switches on the bar above."
          : controls.hiddenTests + controls.hiddenReviewed + controls.hiddenUnchanged === 0
            ? `None of them match “${controls.query.trim()}”.`
            : `They're hidden by “${controls.query.trim()}” and the switches on the bar above.`}
      </p>
      <div className="empty-acts">
        <button type="button" className="btn btn-ghost" onClick={controls.onShowAll}>
          Show all files
        </button>
      </div>
    </div>
  ) : (
    <>
      {layer && (
        <LayerHead
          key={layer.commit?.sha}
          layer={layer}
          filesShown={files.length}
          comments={comments}
        />
      )}
      {files.map((file) => {
        const isCollapsed = handlers.collapsed?.has(file.path) ?? false
        const fileThreadCount = comments?.partition.byFile.get(file.path)?.length ?? 0
        const hunkThreadCount =
          comments === undefined
            ? 0
            : file.hunks.reduce((n, h) => n + (comments.partition.byHunk.get(h.id)?.length ?? 0), 0)
        // A stub steps aside the moment the file is part of the conversation:
        // loaded by hand, selected by navigation, or carrying hunk threads.
        const selectedIn = selectedId != null && file.hunks.some((h) => h.id === selectedId)
        const stub =
          diffLoaded.has(file.path) || selectedIn || hunkThreadCount > 0 ? null : stubReason(file)
        const sinceCount =
          sinceReview === undefined
            ? 0
            : file.hunks.reduce((n, h) => n + (sinceReview.has(h.id) ? 1 : 0), 0)
        const part = layer?.parts?.get(file.path)
        const marks = layer?.marks?.get(file.path)
        const whole = part !== undefined && wholeFiles.has(file.path)
        return (
          <section
            key={file.path}
            id={fileAnchor(file.path)}
            className={`file-section${isCollapsed ? ' file-section-collapsed' : ''}${part ? ' file-section-part' : ''}`}
          >
            <FileHeader
              file={file}
              viewed={handlers.viewed}
              collapsed={isCollapsed}
              onToggle={() => handlers.onToggleCollapsed?.(file.path)}
              commentCount={fileThreadCount + hunkThreadCount}
              sinceCount={sinceCount}
              note={layer?.notes.get(file.path)}
              part={part}
              marks={marks}
              whole={whole}
              onToggleWhole={
                part
                  ? () =>
                      setWholeFiles((prev) => {
                        const next = new Set(prev)
                        if (next.has(file.path)) next.delete(file.path)
                        else next.add(file.path)
                        return next
                      })
                  : undefined
              }
              onToggleFileViewed={
                handlers.onToggleFileViewed
                  ? () => handlers.onToggleFileViewed!(file.path)
                  : undefined
              }
              onComment={
                comments
                  ? () => {
                      if (isCollapsed) handlers.onToggleCollapsed?.(file.path)
                      setFileComposerFor((f) => (f === file.path ? null : file.path))
                    }
                  : undefined
              }
            />
            {!isCollapsed && (
              <FileBody
                file={file}
                delta={delta}
                sinceReview={sinceReview}
                handlers={handlers}
                composerOpen={fileComposerFor === file.path}
                onCloseComposer={() => setFileComposerFor(null)}
                stub={stub}
                onLoadDiff={() => setDiffLoaded((prev) => new Set(prev).add(file.path))}
                part={part}
                marks={marks}
                whole={whole}
                allHunks={scope === 'whole'}
                onGoLayer={layer?.onGoLayer}
                highlight={scope === 'highlights' ? layer?.highlights?.get(file.path) : undefined}
              />
            )}
          </section>
        )
      })}
      {hasMore && (
        <div ref={sentinelRef} className="load-more" aria-hidden="true">
          <div className="shimmer" />
          <div className="shimmer shimmer-short" />
        </div>
      )}
      {controls && hiddenCount > 0 && (
        <div className="pane-hidden">
          <span className="pane-hidden-said">
            <Icon name="eye-off" size="sm" />
            {[
              controls.hiddenQuery > 0
                ? `${controls.hiddenQuery} not matching “${controls.query.trim()}”`
                : null,
              controls.hiddenUnchanged > 0 ? `${controls.hiddenUnchanged} unchanged` : null,
              controls.hiddenTests > 0
                ? `${controls.hiddenTests} test${controls.hiddenTests === 1 ? '' : 's'}`
                : null,
              controls.hiddenReviewed > 0 ? `${controls.hiddenReviewed} reviewed` : null,
            ]
              .filter(Boolean)
              .join(', ')}{' '}
            hidden
          </span>
          <button type="button" className="btn btn-ghost btn-sm" onClick={controls.onShowAll}>
            Show all files
          </button>
        </div>
      )}
    </>
  )

  return (
    <div className={`reading-pane${controls ? ' reading-pane-barred' : ''}`} ref={paneRef}>
      {controls && (
        <PaneBar
          navHidden={controls.navHidden}
          onToggleNav={controls.onToggleNav}
          left={controls.left}
          total={controls.total}
          hunksRead={controls.hunksRead}
          hunksTotal={controls.hunksTotal}
          hunkAt={controls.hunkAt}
          hunkCount={controls.hunkCount}
          query={controls.query}
          onClearQuery={controls.onClearQuery}
          hideReviewed={controls.hideReviewed}
          onHideReviewed={controls.onHideReviewed}
          hideTests={controls.hideTests}
          onHideTests={controls.onHideTests}
          testCount={controls.testCount}
          onlyChanged={controls.onlyChanged}
          onOnlyChanged={controls.onOnlyChanged}
          changedCount={controls.changedCount}
          viewMode={controls.viewMode}
          onSetViewMode={controls.onSetViewMode}
          allCollapsed={controls.allCollapsed}
          onToggleCollapseAll={controls.onToggleCollapseAll}
          stats={controls.stats}
          layer={controls.layer}
        />
      )}
      <div className="reading-col">
        {/* Above even the changeset notes: the stale guide sits in there, and this
            banner is the reason it reads stale. */}
        {landed && !emptyChangeset && <ReviewLanded {...landed} shape="docked" />}
        {changesetSection}
        {pastSection}
        {body}
      </div>
      {scopeDone && !allHidden && !doneDismissed && done}
    </div>
  )
}
