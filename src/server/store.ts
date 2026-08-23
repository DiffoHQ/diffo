import { createHash } from 'node:crypto'
import type { Changeset, ChangesetSpec } from '../shared/types.js'
import { buildChangesetFromRaw } from './changeset.js'
import {
  getBranchName,
  getBranchNameAsync,
  getFullDiff,
  getFullDiffAsync,
  getStagedPaths,
  getStagedPathsAsync,
} from './git.js'

export class ChangesetStore {
  private version = 0
  private hash: string | null = null
  private changeset!: Changeset
  private listeners = new Set<(changeset: Changeset) => void>()

  constructor(
    private root: string,
    private spec: ChangesetSpec,
  ) {
    this.refreshSync()
  }

  async refresh(): Promise<boolean> {
    // One recompute at a time: two overlapping runs could publish the older tree's
    // answer last, and the watcher fires again regardless.
    this.inFlight ??= this.compute().finally(() => {
      this.inFlight = null
    })
    return this.inFlight
  }

  private inFlight: Promise<boolean> | null = null

  private async compute(): Promise<boolean> {
    const [raw, staged, branch] = await Promise.all([
      getFullDiffAsync(this.root, this.spec),
      getStagedPathsAsync(this.root),
      getBranchNameAsync(this.root),
    ])
    return this.apply(raw, staged, branch)
  }

  refreshSync(): boolean {
    return this.apply(
      getFullDiff(this.root, this.spec),
      getStagedPaths(this.root),
      getBranchName(this.root),
    )
  }

  private apply(raw: string, staged: Set<string>, branch: string): boolean {
    // Staged-ness is part of the model but invisible in `git diff HEAD`, so it must
    // be part of the change hash too.
    const stagedKey = [...staged].sort().join('\n')
    // So is the branch: switching between two branches whose diffs happen to match
    // is invisible in the raw output, and the review is scoped by branch.
    const newHash = createHash('sha256')
      .update(raw)
      .update('\0')
      .update(stagedKey)
      .update('\0')
      .update(branch)
      .digest('hex')
    if (newHash === this.hash) return false
    this.hash = newHash
    this.version++
    this.changeset = buildChangesetFromRaw(this.root, this.spec, raw, this.version)
    for (const listener of this.listeners) listener(this.changeset)
    return true
  }

  get(): Changeset {
    return this.changeset
  }

  subscribe(listener: (changeset: Changeset) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
}
