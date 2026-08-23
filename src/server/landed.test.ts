import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Anchor } from '../shared/review.js'
import { DiffoDb } from './db.js'
import { getCommitSubject, getHeadSha, isAncestor } from './git.js'
import { type LandedGit, maintainLanded } from './landed.js'
import { ReviewStore } from './review.js'

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const fn of cleanups.splice(0)) fn()
})

function tempRoot(prefix = 'diffo-landed-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

function makeStore(root: string): ReviewStore {
  const dbDir = `${root}-db`
  cleanups.push(() => rmSync(dbDir, { recursive: true, force: true }))
  return new ReviewStore(root, new DiffoDb(join(dbDir, 'diffo.db')), { kind: 'working-tree' })
}

const anchor: Anchor = { kind: 'hunk', hunkId: 'h1', path: 'src/a.ts', side: 'new', line: 3 }

/** A repo whose history the test scripts by hand: ancestry is a lookup, and a
 * sha that isn't listed answers null — "git couldn't say". */
function fakeGit(head: string | null, ancestry: Record<string, boolean | null> = {}): LandedGit {
  return {
    head: () => head,
    isAncestor: (ancestor, descendant) => ancestry[`${ancestor}..${descendant}`] ?? null,
    subject: (sha) => `subject of ${sha}`,
  }
}

describe('maintainLanded', () => {
  it('stamps when the diff empties because HEAD advanced past the base', () => {
    const store = makeStore(tempRoot())
    maintainLanded(store, true, fakeGit('base')) // work in flight: base recorded
    store.createThread(anchor, 'rename this', null)

    const outcome = maintainLanded(store, false, fakeGit('landing', { 'base..landing': true }))

    expect(outcome).toBe('stamped')
    expect(store.get().landed).toMatchObject({ sha: 'landing', subject: 'subject of landing' })
    // The base stays frozen under the marker — it is what makes an amend of the
    // landing commit still readable as "landed".
    expect(store.get().seenHead).toBe('base')
  })

  it('a stash empties the diff without moving HEAD — never stamps', () => {
    const store = makeStore(tempRoot())
    maintainLanded(store, true, fakeGit('base'))
    store.createThread(anchor, 'about stashed work', null)

    expect(maintainLanded(store, false, fakeGit('base'))).toBeNull()
    expect(store.get().landed).toBeUndefined()
  })

  it('an empty review has nothing to offer clearing — tracks the head instead', () => {
    const store = makeStore(tempRoot())
    maintainLanded(store, true, fakeGit('base'))

    expect(maintainLanded(store, false, fakeGit('landing', { 'base..landing': true }))).toBeNull()
    expect(store.get().landed).toBeUndefined()
    expect(store.get().seenHead).toBe('landing')
  })

  it('an amend rewrites the landing commit — the marker follows it in one pass', () => {
    const store = makeStore(tempRoot())
    maintainLanded(store, true, fakeGit('base'))
    store.createThread(anchor, 'still relevant', null)
    maintainLanded(store, false, fakeGit('landing', { 'base..landing': true }))

    const outcome = maintainLanded(
      store,
      false,
      fakeGit('amended', { 'landing..amended': false, 'base..amended': true }),
    )

    expect(outcome).toBe('stamped')
    expect(store.get().landed?.sha).toBe('amended')
  })

  it('a reset back to the base takes the work back — the marker goes, threads reattach', () => {
    const store = makeStore(tempRoot())
    maintainLanded(store, true, fakeGit('base'))
    store.createThread(anchor, 'coming back', null)
    maintainLanded(store, false, fakeGit('landing', { 'base..landing': true }))

    const outcome = maintainLanded(store, true, fakeGit('base', { 'landing..base': false }))

    expect(outcome).toBe('cleared')
    expect(store.get().landed).toBeUndefined()
    expect(store.get().threads).toHaveLength(1)
  })

  it('ambiguity neither stamps nor clears: git that cannot answer changes nothing', () => {
    const store = makeStore(tempRoot())
    maintainLanded(store, true, fakeGit('base'))
    store.createThread(anchor, 'thread', null)

    // isAncestor answers null (sha unknown, transient failure) — no stamp.
    expect(maintainLanded(store, false, fakeGit('landing'))).toBeNull()
    expect(store.get().landed).toBeUndefined()

    // And a marker already stamped survives the same ambiguity.
    maintainLanded(store, false, fakeGit('landing', { 'base..landing': true }))
    expect(store.get().landed?.sha).toBe('landing')
    expect(maintainLanded(store, false, fakeGit('elsewhere'))).toBeNull()
    expect(store.get().landed?.sha).toBe('landing')
  })

  it('no HEAD (a repo with no commits) does nothing at all', () => {
    const store = makeStore(tempRoot())
    store.createThread(anchor, 'thread', null)
    expect(maintainLanded(store, false, fakeGit(null))).toBeNull()
    expect(store.get().seenHead).toBeUndefined()
  })

  it('new work over an unanswered offer keeps the marker and re-bases seenHead', () => {
    const store = makeStore(tempRoot())
    maintainLanded(store, true, fakeGit('base'))
    store.createThread(anchor, 'old round', null)
    maintainLanded(store, false, fakeGit('landing', { 'base..landing': true }))

    // The agent starts the next round before the reviewer clears.
    expect(maintainLanded(store, true, fakeGit('landing', {}))).toBeNull()
    expect(store.get().landed?.sha).toBe('landing')
    expect(store.get().seenHead).toBe('landing')
  })

  it('a lastFinish alone (all threads resolved away) still deserves the offer', () => {
    const store = makeStore(tempRoot())
    maintainLanded(store, true, fakeGit('base'))
    store.recordFinish(['h1'], { viewedHunks: 1, totalHunks: 1, skippedFiles: [] })

    const outcome = maintainLanded(store, false, fakeGit('landing', { 'base..landing': true }))
    expect(outcome).toBe('stamped')
  })

  it('against a real repo: commit stamps, and the subject rides along', () => {
    const root = tempRoot('diffo-landed-git-')
    const git = (...args: string[]) =>
      execFileSync('git', args, { cwd: root, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] })
    git('init', '-b', 'main')
    git('config', 'user.email', 'test@example.com')
    git('config', 'user.name', 'Test')
    git('config', 'commit.gpgsign', 'false')
    writeFileSync(join(root, 'app.ts'), 'const a = 1\n')
    git('add', '-A')
    git('commit', '-m', 'seed')

    const store = makeStore(root)
    const realGit: LandedGit = {
      head: () => getHeadSha(root),
      isAncestor: (a, d) => isAncestor(root, a, d),
      subject: (sha) => getCommitSubject(root, sha),
    }

    writeFileSync(join(root, 'app.ts'), 'const a = 2\n')
    maintainLanded(store, true, realGit)
    store.createThread(anchor, 'why 2?', null)

    git('add', '-A')
    git('commit', '-m', 'the work lands')
    expect(maintainLanded(store, false, realGit)).toBe('stamped')
    expect(store.get().landed?.subject).toBe('the work lands')
    expect(store.get().landed?.sha).toBe(getHeadSha(root))

    // git reset --soft brings the exact hunks back: marker drops, threads intact.
    git('reset', '--soft', 'HEAD~1')
    expect(maintainLanded(store, true, realGit)).toBe('cleared')
    expect(store.get().landed).toBeUndefined()
    expect(store.get().threads).toHaveLength(1)
  })
})
