import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { ReviewThread } from '../shared/review.js'
import { UNCOMMITTED } from '../shared/types.js'
import { getCommitChangeset, listCommits } from './commits.js'
import { DiffoDb } from './db.js'
import { MissingBaseError } from './git.js'
import { createApp } from './index.js'
import { ReviewStore } from './review.js'
import { ChangesetStore } from './store.js'

const cleanups: string[] = []
afterEach(() => {
  for (const dir of cleanups.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function git(dir: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd: dir,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

function tempRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'diffo-commits-'))
  cleanups.push(dir)
  git(dir, 'init', '-b', 'main')
  git(dir, 'config', 'user.email', 'test@example.com')
  git(dir, 'config', 'user.name', 'Test')
  git(dir, 'config', 'commit.gpgsign', 'false')
  return dir
}

function write(dir: string, path: string, content: string) {
  const full = join(dir, path)
  mkdirSync(join(full, '..'), { recursive: true })
  writeFileSync(full, content)
}

function commitAll(dir: string, message: string) {
  git(dir, 'add', '-A')
  git(dir, 'commit', '-m', message)
}

const BRANCH = { kind: 'branch', base: 'main' } as const

/** main has one commit; `feature` adds two on top of it. */
function featureRepo(): string {
  const repo = tempRepo()
  write(repo, 'a.ts', 'one\ntwo\nthree\n')
  commitAll(repo, 'base')
  git(repo, 'checkout', '-b', 'feature')
  write(repo, 'a.ts', 'one\nTWO\nthree\n')
  commitAll(repo, 'shout two\n\nBecause it matters.')
  write(repo, 'b.ts', 'new\n')
  commitAll(repo, 'add b')
  return repo
}

describe('listCommits', () => {
  it('lists the branch commits oldest first, with their own stats', async () => {
    const repo = featureRepo()
    const { commits } = await listCommits(repo, BRANCH)
    expect(commits.map((c) => c.subject)).toEqual(['shout two', 'add b'])
    expect(commits[0]).toMatchObject({
      body: 'Because it matters.',
      author: 'Test',
      stats: { files: 1, additions: 1, deletions: 1 },
    })
    expect(commits[1]!.stats).toEqual({ files: 1, additions: 1, deletions: 0 })
  })

  it('adds the uncommitted edits as a last entry, untracked files included', async () => {
    const repo = featureRepo()
    write(repo, 'a.ts', 'one\nTWO\n3\n')
    write(repo, 'c.ts', 'fresh\n')
    const { commits } = await listCommits(repo, BRANCH)
    const last = commits.at(-1)!
    expect(last.sha).toBe(UNCOMMITTED)
    expect(last.stats.files).toBe(2)
  })

  it('has nothing to list for a working-tree review', async () => {
    const repo = featureRepo()
    expect(await listCommits(repo, { kind: 'working-tree' })).toEqual({ commits: [] })
  })

  it('reports a missing base the way the changeset does', async () => {
    const repo = featureRepo()
    await expect(listCommits(repo, { kind: 'branch', base: 'nope' })).rejects.toBeInstanceOf(
      MissingBaseError,
    )
  })
})

describe('getCommitChangeset', () => {
  it('returns only that commit’s diff, not the cumulative one', async () => {
    const repo = featureRepo()
    const { commits } = await listCommits(repo, BRANCH)
    const first = await getCommitChangeset(repo, BRANCH, commits[0]!.sha)
    expect(first?.files.map((f) => f.path)).toEqual(['a.ts'])
    const second = await getCommitChangeset(repo, BRANCH, commits[1]!.sha)
    expect(second?.files.map((f) => [f.path, f.status])).toEqual([['b.ts', 'added']])
  })

  it('refuses a commit outside the changeset', async () => {
    const repo = featureRepo()
    const base = git(repo, 'rev-parse', 'main').trim()
    expect(await getCommitChangeset(repo, BRANCH, base)).toBeNull()
    expect(await getCommitChangeset(repo, BRANCH, '--output=/tmp/x')).toBeNull()
  })

  it('serves the uncommitted entry on a branch review only', async () => {
    const repo = featureRepo()
    write(repo, 'a.ts', 'changed\n')
    const pending = await getCommitChangeset(repo, BRANCH, UNCOMMITTED)
    expect(pending?.files.map((f) => f.path)).toEqual(['a.ts'])
    expect(await getCommitChangeset(repo, { kind: 'working-tree' }, UNCOMMITTED)).toBeNull()
  })
})

describe('a comment made on a commit', () => {
  it('freezes the code from that commit when the full diff no longer has the hunk', async () => {
    const repo = featureRepo()
    // A later commit rewrites the line the first one changed, so the first
    // commit's hunk exists only in its own diff.
    write(repo, 'a.ts', 'one\nTWO!\nthree\n')
    commitAll(repo, 'louder')
    const dbDir = `${repo}-db`
    cleanups.push(dbDir)
    const store = new ChangesetStore(repo, BRANCH)
    const review = new ReviewStore(repo, new DiffoDb(join(dbDir, 'diffo.db')), BRANCH)
    const app = createApp({ root: repo, spec: BRANCH, clientDir: '/nope' }, store, review)

    const { commits } = await listCommits(repo, BRANCH)
    const first = (await getCommitChangeset(repo, BRANCH, commits[0]!.sha))!
    const hunk = first.files[0]!.hunks[0]!
    expect(store.get().files.some((f) => f.hunks.some((h) => h.id === hunk.id))).toBe(false)

    const create = (body: object) =>
      app.request('/api/review/threads', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          anchor: { kind: 'hunk', hunkId: hunk.id, path: 'a.ts', side: 'new', line: 2 },
          text: 'why shout?',
          ...body,
        }),
      })
    const withCommit = (await (await create({ commit: commits[0]!.sha })).json()) as ReviewThread
    expect(withCommit.codeContext).toContain('+TWO')
    expect(withCommit.codeContext).not.toContain('TWO!')
    expect(withCommit.anchor).toMatchObject({ commit: commits[0]!.sha })
    const without = (await (await create({})).json()) as ReviewThread
    expect(without.codeContext).toBeNull()
  })

  it('renumbers the line into the full diff when a later commit grew the file above it', async () => {
    const repo = tempRepo()
    const lines = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`)
    write(repo, 'a.ts', `${lines.join('\n')}\n`)
    commitAll(repo, 'base')
    git(repo, 'checkout', '-b', 'feature')
    lines[14] = 'LINE 15'
    write(repo, 'a.ts', `${lines.join('\n')}\n`)
    commitAll(repo, 'shout fifteen')
    write(repo, 'a.ts', `zero\nzero\n${lines.join('\n')}\n`)
    commitAll(repo, 'prepend two')
    const dbDir = `${repo}-db`
    cleanups.push(dbDir)
    const store = new ChangesetStore(repo, BRANCH)
    const review = new ReviewStore(repo, new DiffoDb(join(dbDir, 'diffo.db')), BRANCH)
    const app = createApp({ root: repo, spec: BRANCH, clientDir: '/nope' }, store, review)

    const { commits } = await listCommits(repo, BRANCH)
    const first = (await getCommitChangeset(repo, BRANCH, commits[0]!.sha))!
    const hunk = first.files[0]!.hunks[0]!
    // The same hunk, by content, sits two lines lower in the full diff.
    expect(store.get().files[0]!.hunks.map((h) => h.id)).toContain(hunk.id)

    const res = await app.request('/api/review/threads', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        anchor: { kind: 'hunk', hunkId: hunk.id, path: 'a.ts', side: 'new', line: 15 },
        text: 'why shout?',
        commit: commits[0]!.sha,
      }),
    })
    const thread = (await res.json()) as ReviewThread
    expect(thread.anchor).toMatchObject({ kind: 'hunk', hunkId: hunk.id, line: 17 })
    expect(thread.anchor).not.toHaveProperty('commit')
    expect(thread.codeContext).toContain('+LINE 15')
  })
})

describe('a commit’s files', () => {
  it('carry the sha, and /api/file reads the file as that commit had it', async () => {
    const repo = featureRepo()
    write(repo, 'a.ts', 'one\nTWO!\nthree\n')
    commitAll(repo, 'louder')
    const dbDir = `${repo}-db`
    cleanups.push(dbDir)
    const store = new ChangesetStore(repo, BRANCH)
    const review = new ReviewStore(repo, new DiffoDb(join(dbDir, 'diffo.db')), BRANCH)
    const app = createApp({ root: repo, spec: BRANCH, clientDir: '/nope' }, store, review)

    const { commits } = await listCommits(repo, BRANCH)
    const first = (await getCommitChangeset(repo, BRANCH, commits[0]!.sha))!
    expect(first.files[0]!.rev).toBe(commits[0]!.sha)
    const at = (q: string) => app.request(`/api/file?path=a.ts&side=head${q}`)
    expect(await (await at(`&rev=${commits[0]!.sha}`)).text()).toBe('one\nTWO\nthree\n')
    expect(await (await at('')).text()).toBe('one\nTWO!\nthree\n')
    expect((await at(`&rev=${git(repo, 'rev-parse', 'main').trim()}`)).status).toBe(404)
    expect((await app.request(`/api/file?path=a.ts&side=base&rev=${commits[0]!.sha}`)).status).toBe(
      400,
    )
  })
})
