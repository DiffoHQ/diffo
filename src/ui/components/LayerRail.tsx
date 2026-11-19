import { useMemo, useRef, useState } from 'react'
import { AGENT_PICKS } from '../../shared/presets.js'
import type { ReviewThread } from '../../shared/review.js'
import type { FileChange } from '../../shared/types.js'
import type { LayersRequest } from '../api.js'
import { type LayerSection, useLayerSections } from '../layerSectionsPref.js'
import {
  entryMarks,
  entryViewed,
  layerLineStats,
  layerProgress,
  type ResolvedLayer,
  type ResolvedLayerFile,
} from '../layers.js'
import type { ThreadItem } from '../threads.js'
import { Confirm } from './Confirm.js'
import { Icon } from './Icon.js'
import { type LayersAskDraft, type LayersAskInput, LayersAskSheet, OWN_WORDS } from './LayersAsk.js'
import { MarkBox } from './MarkBox.js'
import { Menu, MenuItem, MenuSep } from './Menu.js'
import { FileTree, type FileTreeProps } from './Nav.js'

/**
 * The outline: one row per layer, a directory row without the folder icon. The
 * leading mark is the directory control — one click
 * marks every file in the layer read, same toggle, same mixed state. Counts sit
 * under the title rather than beside it, because at 264px a right-hand tally
 * truncated titles; the thread count is the one thing that stays on the right,
 * and only when it is non-zero. An opened layer shows its files as the Files
 * tab's own tree — folders that fold, roll-up marks and all — so a layer reads
 * as a place in the repo, not a flat list. The reading pane reads the layer in
 * the agent's order, or in the tree's: that is switched on the layer card
 * (see `reading` in ReadingPane.tsx), and the tree here is the map either way.
 */

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

/** The words under a layer with nothing to show: Hide tests emptied it, or
 * the changeset did — different reasons, and the row says which. Null when
 * the layer has files, and `SubLine` takes over. */
function emptyLine(layer: ResolvedLayer): string | null {
  if (layer.files.length > 0) return null
  const hidden = layer.hidden ?? 0
  if (hidden > 0) return `${plural(hidden, 'test')} hidden`
  return layer.missing.length === 0
    ? 'nothing here now'
    : `${plural(layer.missing.length, 'listed file')} not in the changeset`
}

/**
 * Files, size, and state — no hunk arithmetic, the bar is the progress. The
 * size is the one figure the file count alone cannot carry: `3 files` is a
 * lunch break or an afternoon, `3 files · +243 −5` says which. The figures
 * wear the diff's own colours, as they do in the pane bar and a file header.
 */
function SubLine({ layer, viewed }: { layer: ResolvedLayer; viewed: ReadonlySet<string> }) {
  const empty = emptyLine(layer)
  if (empty !== null) return <span>{empty}</span>
  const hidden = layer.hidden ?? 0
  const p = layerProgress(layer, viewed)
  const { additions, deletions } = layerLineStats(layer)
  const done = p.doneFiles === p.files ? ' · read' : ''
  const mech = layer.kind === 'mechanical' ? ' · mechanical' : ''
  const off = hidden > 0 ? ` · ${hidden} hidden` : ''
  // A file the step holds only part of: the count says so, and the row under
  // it says which part.
  const split = layer.files.filter((f) => f.partial).length
  const parts = split > 0 ? ` · ${split} split` : ''
  return (
    <span>
      {plural(p.files, 'file')}
      {(additions > 0 || deletions > 0) && (
        <>
          {' · '}
          {additions > 0 && <span className="stat-add">+{additions}</span>}
          {additions > 0 && deletions > 0 && ' '}
          {deletions > 0 && <span className="stat-del">−{deletions}</span>}
        </>
      )}
      {parts}
      {done}
      {mech}
      {off}
    </span>
  )
}

/** `2 of 5 hunks`: the part of a split file this layer reads. */
export function partLabel(entry: ResolvedLayerFile): string | undefined {
  if (!entry.partial) return undefined
  return `${entry.hunks.length} of ${entry.file.hunks.length} hunks`
}

function LayerRow({
  layer,
  index,
  current,
  open,
  onToggleOpen,
  viewed,
  threadCount,
  onPick,
  onMarkFiles,
  onClearFiles,
  label,
}: {
  layer: ResolvedLayer
  index: number
  current: boolean
  /** The file rows under it are shown. */
  open: boolean
  onToggleOpen: () => void
  viewed: ReadonlySet<string>
  threadCount: number
  onPick: (index: number) => void
  onMarkFiles?: (paths: string[], layer: ResolvedLayer) => void
  onClearFiles?: (paths: string[], layer: ResolvedLayer) => void
  /** What the row reads in place of the layer's title: the trailing layer
   * sits under a "Since your review" label and says what it holds. */
  label?: string
}) {
  const p = layerProgress(layer, viewed)
  const allDone = p.files > 0 && p.doneFiles === p.files
  const some = p.doneMarks > 0
  const markable = layer.files.filter((f) => !entryViewed(f, viewed)).map((f) => f.file.path)
  const paths = layer.files.map((f) => f.file.path)
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: the row's own pick button is the keyboard path; this only widens the mouse target to the whole row
    // biome-ignore lint/a11y/useKeyWithClickEvents: same — the pick button inside carries the keys
    <div
      className={`row row-layer${allDone ? ' row-done' : ''}${layer.derived ? ' row-layer-since' : ''}`}
      aria-current={current ? 'true' : undefined}
      data-layer={layer.id ?? 'since'}
      onClick={() => onPick(index)}
    >
      {/* biome-ignore lint/a11y/useSemanticElements: a native checkbox cannot express the roll-up's mixed state */}
      <button
        type="button"
        className="row-box"
        role="checkbox"
        aria-checked={allDone ? true : some ? 'mixed' : false}
        aria-label={
          allDone
            ? `Mark ${layer.title} not reviewed`
            : `Mark ${plural(markable.length, 'file')} in ${layer.title} reviewed`
        }
        data-tip={
          allDone
            ? `Mark ${plural(paths.length, 'file')} not reviewed`
            : `Mark ${plural(markable.length, 'file')} reviewed`
        }
        disabled={paths.length === 0 || (allDone ? !onClearFiles : !onMarkFiles)}
        onClick={(e) => {
          e.stopPropagation()
          if (allDone) onClearFiles?.(paths, layer)
          else onMarkFiles?.(markable, layer)
        }}
      >
        <MarkBox state={allDone ? true : some ? 'mixed' : false} />
      </button>
      {/* Title and count are one target: anywhere on them picks the layer. Only
          the mark and the fold chevron are their own controls. */}
      <button
        type="button"
        className="row-pick"
        title={layer.title}
        onClick={(e) => {
          // The row behind also picks; one pick per click.
          e.stopPropagation()
          onPick(index)
        }}
      >
        <span className="row-name">
          <span className="row-base">{label ?? layer.title}</span>
        </span>
        <span className="ch-sub">
          {/* The bar waits for the first mark: an empty track reads as
              something failing to render, not as 0%. */}
          {p.doneMarks > 0 && (
            <span className="prog-track" aria-hidden="true">
              <i
                style={{
                  width: `${p.marks === 0 ? 0 : Math.round((p.doneMarks / p.marks) * 100)}%`,
                }}
              />
            </span>
          )}
          <SubLine layer={layer} viewed={viewed} />
        </span>
      </button>
      <span className="row-right">
        {threadCount > 0 && (
          <span className="row-count" title={plural(threadCount, 'thread')}>
            <Icon name="chat" size="sm" />
            {threadCount}
          </span>
        )}
        {layer.files.length > 0 && (
          <button
            type="button"
            className={`row-act ch-fold chevron${open ? '' : ' chevron-shut'}`}
            aria-expanded={open}
            aria-label={`${open ? 'Hide' : 'Show'} the files in ${layer.title}`}
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

/** An opened layer's files, as the Files tab's tree. The layer's notes ride
 * along as the rows' tooltips; a file the layer holds part of says which part,
 * and its mark is that part's. */
function LayerFiles({
  layer,
  onToggleFileViewed,
  onMarkFiles,
  onClearFiles,
  ...tree
}: { layer: ResolvedLayer } & Omit<
  FileTreeProps,
  | 'files'
  | 'notes'
  | 'parts'
  | 'marksFor'
  | 'forceOpen'
  | 'onToggleFileViewed'
  | 'onMarkFiles'
  | 'onClearFiles'
> & {
    onToggleFileViewed?: (path: string, layer: ResolvedLayer) => void
    onMarkFiles?: (paths: string[], layer: ResolvedLayer) => void
    onClearFiles?: (paths: string[], layer: ResolvedLayer) => void
  }) {
  // `layer.files` is stable between resolutions of the outline, so the tree is
  // rebuilt only when the changeset (or the filter) moves under it.
  const files = useMemo(() => layer.files.map((f) => f.file), [layer.files])
  const notes = useMemo(
    () => new Map(layer.files.flatMap((f) => (f.note ? [[f.file.path, f.note] as const] : []))),
    [layer.files],
  )
  const parts = useMemo(
    () =>
      new Map(
        layer.files.flatMap((f) => {
          const label = partLabel(f)
          return label ? [[f.file.path, label] as const] : []
        }),
      ),
    [layer.files],
  )
  const marksFor = useMemo(() => {
    const byPath = new Map(layer.files.map((f) => [f.file.path, entryMarks(f)]))
    return (file: FileChange) => byPath.get(file.path) ?? []
  }, [layer.files])
  return (
    <FileTree
      files={files}
      notes={notes}
      parts={parts}
      marksFor={marksFor}
      onToggleFileViewed={
        onToggleFileViewed ? (path) => onToggleFileViewed(path, layer) : undefined
      }
      onMarkFiles={onMarkFiles ? (paths) => onMarkFiles(paths, layer) : undefined}
      onClearFiles={onClearFiles ? (paths) => onClearFiles(paths, layer) : undefined}
      {...tree}
    />
  )
}

/** Why a choice that needs the agent is inert. */
const NO_AGENT = 'No agent attached; invite one from the header'

export function LayerRail({
  layers,
  activeIndex,
  onPick,
  viewed,
  guide,
  description,
  overviewActive = false,
  onOpenGuide,
  threads,
  attention,
  changed,
  selectedPath,
  onPickFile,
  onToggleFileViewed,
  onMarkFiles,
  onClearFiles,
  onAskFile,
  onRefresh,
  request = null,
  preset,
  onOpenPresets,
  onRemove,
  presets,
  note,
  onAsk,
}: {
  layers: readonly ResolvedLayer[]
  activeIndex: number
  onPick: (index: number) => void
  viewed: ReadonlySet<string>
  /** The guide comment, the Overview behind the head's book — one outline, not two agent
   * artifacts in two places. Not markable: it is not code. */
  guide?: ReviewThread
  /** On a pull request, the description: the author's map of the change, which
   * makes an Overview with or without a guide. */
  description?: ReviewThread
  /** The reviewer is standing on the Overview: the pane shows the guide and the
   * other changeset threads instead of a layer's files. */
  overviewActive?: boolean
  onOpenGuide?: () => void
  threads?: Map<string, ReviewThread[]>
  attention?: Map<string, ThreadItem[]>
  changed?: ReadonlySet<string>
  selectedPath?: string | null
  onPickFile?: (path: string) => void
  /** Marks take the layer too: under a layer that holds part of a file, the
   * mark is that part's, not the whole file's. */
  onToggleFileViewed?: (path: string, layer: ResolvedLayer) => void
  onMarkFiles?: (paths: string[], layer: ResolvedLayer) => void
  onClearFiles?: (paths: string[], layer: ResolvedLayer) => void
  onAskFile?: (path: string) => void
  /** Ask the agent to re-outline the change as it stands now. Absent when no
   * agent is attached: the line in the head says so instead. */
  onRefresh?: () => void
  /** A re-outline is in flight — parked behind the agent's open threads, or in
   * its hands. The line says which, and cannot be clicked again. */
  request?: LayersRequest
  /** What the outline follows (see shared/presets.ts), for the head of the
   * rail: the preset's name is the title, and the line under it is its one
   * line on what the layers show and who picked it, with the agent's why on
   * hover. Absent when the outline follows no preset. */
  preset?: {
    id?: string
    name: string
    blurb: string
    /** The agent chose it for this post. */
    picked?: boolean
    /** The reviewer asked for it, and it is the one the agent suggested. */
    suggested?: boolean
    /** The agent's reason, for its pick or its suggestion. */
    why?: string
  }
  /** Open the Layers dialog from the head's "Change". Absent when there is
   * nothing to open it on. */
  onOpenPresets?: () => void
  /** Remove the outline from the review. Asked for in a dialog first. */
  onRemove?: () => unknown
  /** The presets that are on, for the head's menu. */
  presets?: readonly { id: string; name: string }[]
  /** What the reviewer asked of these layers for this change only: a line
   * under the head. With no preset it was the whole ask. */
  note?: string
  /** Ask for the layers again: by a preset, the agent's choice, or the
   * reviewer's own words, with a note for this change. Nothing in the rail
   * sends it directly; each way in opens the sheet, and its button asks.
   * Absent when no agent is attached: the menu's choices then say so. */
  onAsk?: (ask: LayersAskInput) => void
}) {
  const threadCount = (layer: ResolvedLayer) =>
    layer.files.reduce((n, f) => n + (threads?.get(f.file.path)?.length ?? 0), 0)
  // Files stay folded until the chevron opens them — the outline is the list of
  // steps, and a step's files are detail the reviewer asks for.
  const [opened, setOpened] = useState<ReadonlySet<string>>(new Set())
  const isOpen = (layer: ResolvedLayer) => opened.has(layer.id ?? 'since')
  const toggle = (layer: ResolvedLayer) =>
    setOpened((prev) => {
      const next = new Set(prev)
      const key = layer.id ?? 'since'
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  // Background layers sit in their own section under a rule: how the change
  // is done, for a reviewer who asked not to read how. Each keeps its index in
  // the outline, so picking one reads it like any other layer. The derived
  // trailing layer — what moved since the outline — comes last of all.
  const front = layers.flatMap((layer, index) =>
    layer.kind === 'background' || layer.derived ? [] : [{ layer, index }],
  )
  const background = layers.flatMap((layer, index) =>
    layer.kind === 'background' ? [{ layer, index }] : [],
  )
  const trailing = layers.flatMap((layer, index) =>
    layer.derived && layer.kind !== 'background' ? [{ layer, index }] : [],
  )
  const totals = (items: readonly { layer: ResolvedLayer }[]) =>
    items.reduce(
      (sum, { layer }) => {
        const s = layerLineStats(layer)
        return { additions: sum.additions + s.additions, deletions: sum.deletions + s.deletions }
      },
      { additions: 0, deletions: 0 },
    )
  // Sections exist once there is background to set apart; each folds from its
  // header row. A folded section the reviewer moves into shows their place;
  // a click on its header still folds it, until they move again.
  const sectioned = background.length > 0
  const [sectionsOpen, toggleSection] = useLayerSections()
  // The preset's line opens to what it does; shut by default, the rail's head is one line.
  const [aboutOpen, setAboutOpen] = useState(false)
  // The section the reviewer folded over their own place, and the layer they
  // were on: it lasts until they move to another layer.
  const [foldedOver, setFoldedOver] = useState<{ section: LayerSection; at: number } | null>(null)
  if (foldedOver && foldedOver.at !== activeIndex) setFoldedOver(null)
  const holdsPlace = (section: LayerSection) =>
    foldedOver?.section !== section &&
    (section === 'read' ? front : background).some(({ index }) => index === activeIndex)
  const readOpen = !sectioned || sectionsOpen.read || holdsPlace('read')
  const backgroundOpen = sectionsOpen.background || holdsPlace('background')
  const sectionRow = (
    section: LayerSection,
    name: string,
    items: readonly { layer: ResolvedLayer }[],
    open: boolean,
    title: string,
  ) => {
    const t = totals(items)
    return (
      <button
        type="button"
        className="lr-sec"
        aria-expanded={open}
        title={title}
        onClick={() => {
          // The header does what it shows: an open section folds, the
          // reviewer's place in it included; a folded one opens.
          if (open) {
            if (sectionsOpen[section]) toggleSection(section)
            setFoldedOver({ section, at: activeIndex })
          } else {
            setFoldedOver(null)
            toggleSection(section)
          }
        }}
      >
        {/* A quiet label on the rail's left edge, where the layers have
            their marks, with how many it holds; its lines and the fold sit at
            the right, where a layer has its own chevron. */}
        <span className="lr-sec-name">{name}</span>
        <span className="lr-sec-n">{items.length}</span>
        <span className="lr-sec-stat">
          {t.additions > 0 && <span className="stat-add">+{t.additions.toLocaleString()}</span>}
          {t.additions > 0 && t.deletions > 0 && ' '}
          {t.deletions > 0 && <span className="stat-del">−{t.deletions.toLocaleString()}</span>}
        </span>
        <Icon
          name="chev"
          size="sm"
          className={`chevron lr-sec-chev${open ? '' : ' chevron-shut'}`}
        />
      </button>
    )
  }
  // What the Overview opens, in a few words: the tip of its button.
  const overviewSub =
    description && guide
      ? 'the description, and the agent’s guide'
      : description
        ? 'the pull request description'
        : 'the agent’s guide'
  // Removing the outline asks first, in a dialog.
  const [removing, setRemoving] = useState(false)
  // Layering again is heavy, so every way in opens the sheet on a draft: the
  // choice just made, and the note these layers already carry.
  const [asking, setAsking] = useState<LayersAskDraft | null>(null)
  const ask = (pick: string) => setAsking({ pick, note: note ?? '' })
  // What "Layer again" opens on: the ask these layers answered.
  const standing = preset?.id
    ? preset.picked
      ? AGENT_PICKS
      : preset.id
    : note
      ? OWN_WORDS
      : AGENT_PICKS
  // The last ask sent from here, so "Ask again" over one that never came back
  // repeats it rather than falling back to the default.
  const lastAsk = useRef<LayersAskInput | null>(null)
  // The ask on its way is the light one: the status says "adding", not
  // "layering again".
  const [adding, setAdding] = useState(false)
  const send = (input: LayersAskInput) => {
    lastAsk.current = input
    setAdding(input.add === true)
    onAsk?.(input)
  }
  const renderLayer = (layer: ResolvedLayer, index: number) => {
    const current = index === activeIndex
    const open = isOpen(layer)
    return (
      <div key={layer.id ?? 'since'} className="ch-layer">
        <LayerRow
          label={layer.derived ? 'Not in any layer' : undefined}
          layer={layer}
          index={index}
          current={current}
          open={open}
          onToggleOpen={() => toggle(layer)}
          viewed={viewed}
          threadCount={threadCount(layer)}
          onPick={onPick}
          onMarkFiles={onMarkFiles}
          onClearFiles={onClearFiles}
        />
        {open && layer.files.length > 0 && (
          <div className="ch-files">
            <LayerFiles
              layer={layer}
              viewed={viewed}
              selectedPath={selectedPath}
              threads={threads}
              attention={attention}
              changed={changed}
              onPickFile={onPickFile}
              onToggleFileViewed={onToggleFileViewed}
              onMarkFiles={onMarkFiles}
              onClearFiles={onClearFiles}
              onAskFile={onAskFile}
            />
          </div>
        )}
      </div>
    )
  }
  // How far the reviewer is through what the preset puts first.
  const progress = front.reduce(
    (sum, { layer }) => {
      const p = layerProgress(layer, viewed)
      return { marks: sum.marks + p.marks, done: sum.done + p.doneMarks }
    },
    { marks: 0, done: 0 },
  )
  const inFlight = request === 'outlining' || request === 'queued'
  return (
    <>
      {/* The head: one row. What the layers follow is its title, and it opens
          to why: what the preset shows, who picked it, the reviewer's note.
          Changing it is "Layer again", behind the "more" beside it and in the
          line under the list. */}
      <div className="lr-head">
        <div className="lr-head-row">
          {preset || note ? (
            <button
              type="button"
              className="lr-preset"
              aria-expanded={aboutOpen}
              title={aboutOpen ? undefined : 'What these layers follow, and why'}
              onClick={() => setAboutOpen(!aboutOpen)}
            >
              <span className="lr-title-by">Layered by</span>
              <span className="lr-title">{preset ? preset.name : 'your instructions'}</span>
            </button>
          ) : (
            <span className="lr-title lr-title-plain">Layers</span>
          )}
          {/* The Overview is not a layer, so it is not a row of the list: a
              book in the head opens it, and stays lit while it is up. */}
          {(guide || description) && onOpenGuide && (
            <button
              type="button"
              className="btn btn-ghost btn-icon btn-sm lr-more lr-ov"
              aria-label="Overview"
              aria-current={overviewActive ? 'true' : undefined}
              title={`Overview: ${overviewSub}`}
              onClick={onOpenGuide}
            >
              <Icon name="book" size="sm" />
            </button>
          )}
          {(onAsk || onRemove || onOpenPresets) && (
            <Menu
              label="More for these layers"
              triggerClassName="btn btn-ghost btn-icon btn-sm lr-more"
            >
              {(close) => (
                <>
                  <MenuItem
                    disabled={!onAsk || inFlight}
                    title={
                      !onAsk
                        ? NO_AGENT
                        : inFlight
                          ? 'Already asked'
                          : 'The change moved on; a re-post keeps your place'
                    }
                    onClick={() => {
                      close()
                      ask(standing)
                    }}
                  >
                    Layer again
                  </MenuItem>
                  {onOpenPresets && (
                    <MenuItem
                      onClick={() => {
                        close()
                        onOpenPresets()
                      }}
                    >
                      Manage presets
                    </MenuItem>
                  )}
                  {onRemove && (
                    <>
                      <MenuSep />
                      <MenuItem
                        danger
                        onClick={() => {
                          close()
                          setRemoving(true)
                        }}
                      >
                        Remove layers
                      </MenuItem>
                    </>
                  )}
                </>
              )}
            </Menu>
          )}
          {/* The fold sits at the row's end, in the column the layers below
              have their own chevrons in. A second target for the mouse: the
              title is the control. */}
          {(preset || note) && (
            <button
              type="button"
              className="lr-head-chev"
              aria-hidden="true"
              tabIndex={-1}
              onClick={() => setAboutOpen(!aboutOpen)}
            >
              <Icon
                name="chev"
                size="sm"
                className={`chevron${aboutOpen ? '' : ' chevron-shut'}`}
              />
            </button>
          )}
        </div>
        {/* What the layers follow, in full, only when asked for: the head
            itself stays one line, whatever the reviewer's note runs to. */}
        {aboutOpen && (preset || note) && (
          <div className="lr-about">
            {preset && preset.blurb !== '' && (
              <p className="lr-about-blurb">
                {preset.blurb.charAt(0).toUpperCase() + preset.blurb.slice(1)}
                {/[.?!]$/.test(preset.blurb) ? '' : '.'}
              </p>
            )}
            {preset && (
              <p className="lr-about-by">
                {preset.picked || preset.suggested
                  ? `The agent ${preset.picked ? 'picked' : 'suggested'} it${preset.why ? `: ${preset.why}` : ''}.`
                  : 'You picked it.'}
              </p>
            )}
            {note && (
              <p className="lr-about-note">
                {preset && <span className="lr-note-cap">Your note: </span>}
                {note}
              </p>
            )}
          </div>
        )}
        {request !== null && (
          <div className="lr-status" aria-live="polite">
            {request === 'stalled' ? (
              <>
                No layers came back.
                {onRefresh && (
                  <button
                    type="button"
                    className="lr-link"
                    title="the agent took the request but never re-posted; its harness may have refused the command"
                    onClick={() =>
                      lastAsk.current && onAsk ? onAsk(lastAsk.current) : onRefresh?.()
                    }
                  >
                    Ask again
                  </button>
                )}
              </>
            ) : (
              <>
                <span className="ch-working" aria-hidden="true">
                  <i />
                  <i />
                  <i />
                </span>{' '}
                {request === 'outlining'
                  ? adding
                    ? 'Adding to the layers…'
                    : 'Layering again…'
                  : 'Asked · after the agent’s open threads'}
              </>
            )}
          </div>
        )}
        {/* The bar waits for the first mark, as a layer's does: an empty
            track reads as something that failed to draw. */}
        {progress.done > 0 && (
          <div
            className="lr-prog"
            role="progressbar"
            aria-label="Read so far, of the key changes"
            aria-valuemin={0}
            aria-valuemax={progress.marks}
            aria-valuenow={progress.done}
          >
            <i style={{ width: `${Math.round((progress.done / progress.marks) * 100)}%` }} />
          </div>
        )}
      </div>
      <div className="rail-scroll">
        {sectioned &&
          sectionRow(
            'read',
            'Key changes',
            front,
            readOpen,
            'The layers the preset puts first: read them closely.',
          )}
        {readOpen && front.map(({ layer, index }) => renderLayer(layer, index))}
        {sectioned &&
          sectionRow(
            'background',
            'Other changes',
            background,
            backgroundOpen,
            'How the change is done — implementation, tests, wiring — which the layers above already describe. Open one to check something.',
          )}
        {sectioned && backgroundOpen && (
          <div className="lr-bg">
            {background.map(({ layer, index }) => renderLayer(layer, index))}
          </div>
        )}
        {/* What moved since the outline: its own group, with the one action
            that answers it on the label. The light one: the agent places
            these in the layers there, which needs no sheet. A new split is
            "Layer again", in the head's menu. */}
        {trailing.length > 0 && (
          <div className="lr-sec lr-sec-since">
            <span className="lr-sec-name">Since your review</span>
            {onAsk && request === null && (
              <button
                type="button"
                className="lr-link lr-sec-act"
                title="The agent puts these in the layers you have; nothing else changes"
                onClick={() => send({ add: true })}
              >
                Add to layers
              </button>
            )}
          </div>
        )}
        {trailing.map(({ layer, index }) => renderLayer(layer, index))}
        {/* The way to different layers, where the reviewer ends up after
            reading down the list: the sheet, on the ask these layers answered. */}
        {onAsk && request === null && (
          <div className="lr-cta">
            <span className="lr-cta-q">Layers not quite right?</span>
            <button type="button" className="lr-link" onClick={() => ask(standing)}>
              Change the preset or tell the agent
            </button>
          </div>
        )}
      </div>
      {asking && onAsk && (
        <LayersAskSheet
          presets={presets ?? []}
          initial={asking}
          {...(onOpenPresets ? { onManagePresets: onOpenPresets } : {})}
          onAsk={send}
          onClose={() => setAsking(null)}
        />
      )}
      {removing && onRemove && (
        <Confirm
          title="Remove layers"
          action="Remove layers"
          onConfirm={onRemove}
          onClose={() => setRemoving(false)}
        >
          Your read marks and threads stay.
        </Confirm>
      )}
    </>
  )
}
