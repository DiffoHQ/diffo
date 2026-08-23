import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { buildChangeset } from './changeset.js'
import { getFullDiff, MissingBaseError, suggestedBase } from './git.js'

const SPEC = { kind: 'working-tree' } as const

const cleanups: string[] = []
afterEach(() => {
  for (const dir of cleanups.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tempRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'diffo-test-'))
  cleanups.push(dir)
  git(dir, 'init', '-b', 'main')
  git(dir, 'config', 'user.email', 'test@example.com')
  git(dir, 'config', 'user.name', 'Test')
  git(dir, 'config', 'commit.gpgsign', 'false')
  return dir
}

function git(dir: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd: dir,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

function write(dir: string, path: string, content: string | Buffer) {
  const full = join(dir, path)
  mkdirSync(join(full, '..'), { recursive: true })
  writeFileSync(full, content)
}

function commitAll(dir: string, message = 'commit') {
  git(dir, 'add', '-A')
  git(dir, 'commit', '-m', message)
}

describe('working-tree changeset (integration, real git)', () => {
  it('sees modified, added, deleted, renamed files in one changeset', () => {
    const repo = tempRepo()
    write(repo, 'modified.ts', 'a\nb\nc\n')
    write(repo, 'deleted.ts', 'gone\n')
    write(repo, 'renamed-old.ts', 'same content, long enough to be similar\nline2\nline3\n')
    commitAll(repo)

    write(repo, 'modified.ts', 'a\nB\nc\n')
    rmSync(join(repo, 'deleted.ts'))
    git(repo, 'mv', 'renamed-old.ts', 'renamed-new.ts')
    write(repo, 'added.ts', 'brand new\n')

    const cs = buildChangeset(repo, SPEC, 1)
    const byPath = Object.fromEntries(cs.files.map((f) => [f.path, f]))

    expect(byPath['modified.ts']).toMatchObject({ status: 'modified', kind: 'text' })
    expect(byPath['deleted.ts']).toMatchObject({ status: 'deleted' })
    expect(byPath['renamed-new.ts']).toMatchObject({ status: 'renamed', oldPath: 'renamed-old.ts' })
    expect(byPath['added.ts']).toMatchObject({ status: 'added' })
    expect(cs.stats.files).toBe(4)
  })

  it('combines staged, unstaged, and untracked changes', () => {
    const repo = tempRepo()
    write(repo, 'staged.ts', 'original\n')
    write(repo, 'unstaged.ts', 'original\n')
    commitAll(repo)

    write(repo, 'staged.ts', 'staged edit\n')
    git(repo, 'add', 'staged.ts')
    write(repo, 'unstaged.ts', 'unstaged edit\n')
    write(repo, 'untracked.ts', 'never added\n')

    const cs = buildChangeset(repo, SPEC, 1)
    const paths = cs.files.map((f) => f.path).sort()
    expect(paths).toEqual(['staged.ts', 'unstaged.ts', 'untracked.ts'])
    expect(cs.files.find((f) => f.path === 'untracked.ts')).toMatchObject({
      status: 'added',
      hunks: [{ lines: [{ kind: 'add', text: 'never added' }] }],
    })
  })

  it('handles binary and image files without hunks', () => {
    const repo = tempRepo()
    write(repo, 'keep.ts', 'x\n')
    commitAll(repo)
    write(repo, 'data.bin', Buffer.from([0, 1, 2, 255, 0, 42]))
    write(repo, 'logo.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0]))

    const cs = buildChangeset(repo, SPEC, 1)
    const byPath = Object.fromEntries(cs.files.map((f) => [f.path, f]))
    expect(byPath['data.bin']).toMatchObject({ kind: 'binary', hunks: [] })
    expect(byPath['logo.png']).toMatchObject({ kind: 'image', hunks: [] })
  })

  it('handles a committed binary file being modified', () => {
    const repo = tempRepo()
    write(repo, 'data.bin', Buffer.from([0, 1, 2]))
    commitAll(repo)
    write(repo, 'data.bin', Buffer.from([0, 9, 9, 9]))

    const cs = buildChangeset(repo, SPEC, 1)
    expect(cs.files[0]).toMatchObject({
      path: 'data.bin',
      kind: 'binary',
      status: 'modified',
      hunks: [],
    })
  })

  it('handles untracked symlinks as symlink kind', () => {
    const repo = tempRepo()
    write(repo, 'real.ts', 'x\n')
    commitAll(repo)
    symlinkSync('real.ts', join(repo, 'link'))

    const cs = buildChangeset(repo, SPEC, 1)
    const link = cs.files.find((f) => f.path === 'link')
    expect(link).toMatchObject({ kind: 'symlink', status: 'added' })
    expect(link?.hunks[0]?.lines[0]).toMatchObject({ kind: 'add', text: 'real.ts' })
  })

  it('empty repo (no HEAD): every file is untracked-added', () => {
    const repo = tempRepo()
    write(repo, 'first.ts', 'hello\n')

    const cs = buildChangeset(repo, SPEC, 1)
    expect(cs.files).toHaveLength(1)
    expect(cs.files[0]).toMatchObject({ path: 'first.ts', status: 'added' })
  })

  it('clean tree: empty changeset with zero stats', () => {
    const repo = tempRepo()
    write(repo, 'a.ts', 'x\n')
    commitAll(repo)

    const cs = buildChangeset(repo, SPEC, 1)
    expect(cs.files).toEqual([])
    expect(cs.stats).toEqual({ files: 0, additions: 0, deletions: 0 })
  })

  it('CRLF content survives the round trip', () => {
    const repo = tempRepo()
    write(repo, 'win.ts', 'one\r\ntwo\r\n')
    commitAll(repo)
    write(repo, 'win.ts', 'one\r\nTWO\r\n')

    const cs = buildChangeset(repo, SPEC, 1)
    const lines = cs.files[0]?.hunks[0]?.lines ?? []
    expect(lines.find((l) => l.kind === 'add')?.text).toBe('TWO\r')
  })

  it('untracked file without trailing newline keeps its content exact', () => {
    const repo = tempRepo()
    write(repo, 'seed.ts', 'x\n')
    commitAll(repo)
    write(repo, 'no-newline.ts', 'line1\nline2-no-eol')

    const cs = buildChangeset(repo, SPEC, 1)
    const file = cs.files.find((f) => f.path === 'no-newline.ts')
    const texts = file?.hunks[0]?.lines.map((l) => l.text)
    expect(texts).toEqual(['line1', 'line2-no-eol'])
  })

  it('reports the head-side line count for text files, null when there is no head to read', () => {
    const repo = tempRepo()
    write(repo, 'a.ts', '1\n2\n3\n')
    write(repo, 'gone.ts', 'x\n')
    commitAll(repo)
    write(repo, 'a.ts', '1\ntwo\n3\n4\n')
    write(repo, 'no-eol.ts', 'line1\nline2-no-eol')
    write(repo, 'data.bin', Buffer.from([0, 1, 2, 255, 0, 42]))
    rmSync(join(repo, 'gone.ts'))

    const cs = buildChangeset(repo, SPEC, 1)
    const byPath = Object.fromEntries(cs.files.map((f) => [f.path, f]))
    expect(byPath['a.ts']!.newLineCount).toBe(4)
    expect(byPath['no-eol.ts']!.newLineCount).toBe(2)
    expect(byPath['gone.ts']!.newLineCount).toBeNull()
    expect(byPath['data.bin']!.newLineCount).toBeNull()
  })

  it('stats count added and deleted lines across files', () => {
    const repo = tempRepo()
    write(repo, 'a.ts', '1\n2\n3\n')
    commitAll(repo)
    write(repo, 'a.ts', '1\ntwo\n3\n4\n')
    write(repo, 'b.ts', 'new\nfile\n')

    const cs = buildChangeset(repo, SPEC, 1)
    expect(cs.stats).toEqual({ files: 2, additions: 4, deletions: 1 })
  })
})

describe('branch changeset (integration, real git)', () => {
  it('diffs working tree against the merge-base, committed + uncommitted as one', () => {
    const repo = tempRepo()
    write(repo, 'shared.ts', 'base\n')
    commitAll(repo, 'base commit')

    git(repo, 'checkout', '-b', 'feature')
    write(repo, 'committed-on-branch.ts', 'committed work\n')
    commitAll(repo, 'branch work')
    write(repo, 'uncommitted.ts', 'wip\n')

    git(repo, 'checkout', 'main')
    write(repo, 'main-only.ts', 'main moved on\n')
    git(repo, 'add', 'main-only.ts')
    git(repo, 'commit', '-m', 'main advance')
    git(repo, 'checkout', 'feature')

    const cs = buildChangeset(repo, { kind: 'branch', base: 'main' }, 1)
    const paths = cs.files.map((f) => f.path).sort()
    expect(paths).toEqual(['committed-on-branch.ts', 'uncommitted.ts'])
  })

  it('missing base branch throws MissingBaseError', () => {
    const repo = tempRepo()
    write(repo, 'a.ts', 'x\n')
    commitAll(repo)
    expect(() => getFullDiff(repo, { kind: 'branch', base: 'nope' })).toThrow(MissingBaseError)
  })
})

describe('where you are (integration, real git)', () => {
  it('names the repo and branch, and null worktree in the main checkout', () => {
    const repo = tempRepo()
    write(repo, 'a.ts', 'x\n')
    commitAll(repo)
    const cs = buildChangeset(repo, { kind: 'working-tree' }, 1)
    expect(cs.repo.branch).toBe('main')
    expect(cs.repo.worktree).toBeNull()
  })

  it('a linked worktree names itself — the review is keyed by it', () => {
    const repo = tempRepo()
    write(repo, 'a.ts', 'x\n')
    commitAll(repo)
    const wt = join(repo, '..', `${basename(repo)}-wt`)
    cleanups.push(wt)
    git(repo, 'worktree', 'add', '-b', 'fix/scope', wt)
    write(wt, 'a.ts', 'y\n')

    const cs = buildChangeset(wt, { kind: 'working-tree' }, 1)
    expect(cs.repo.worktree).toBe(`${basename(repo)}-wt`)
    expect(cs.repo.branch).toBe('fix/scope')
    expect(buildChangeset(repo, { kind: 'working-tree' }, 1).files).toEqual([])
  })
})

describe('suggestedBase — the --base hint for a clean tree', () => {
  it('names the fork branch and counts the commits since it', () => {
    const repo = tempRepo()
    write(repo, 'a.ts', 'one\n')
    commitAll(repo, 'seed')
    git(repo, 'checkout', '-b', 'feature')
    write(repo, 'a.ts', 'two\n')
    commitAll(repo, 'first')
    write(repo, 'a.ts', 'three\n')
    commitAll(repo, 'second')
    expect(suggestedBase(repo)).toEqual({ base: 'main', commits: 2 })
  })

  it('offers nothing on the default branch itself', () => {
    const repo = tempRepo()
    write(repo, 'a.ts', 'one\n')
    commitAll(repo)
    expect(suggestedBase(repo)).toBeNull()
  })

  it('offers nothing when the branch has no commits of its own', () => {
    const repo = tempRepo()
    write(repo, 'a.ts', 'one\n')
    commitAll(repo)
    git(repo, 'checkout', '-b', 'feature')
    expect(suggestedBase(repo)).toBeNull()
  })

  it('falls back to master when there is no main', () => {
    const dir = mkdtempSync(join(tmpdir(), 'diffo-test-'))
    cleanups.push(dir)
    git(dir, 'init', '-b', 'master')
    git(dir, 'config', 'user.email', 'test@example.com')
    git(dir, 'config', 'user.name', 'Test')
    git(dir, 'config', 'commit.gpgsign', 'false')
    write(dir, 'a.ts', 'one\n')
    commitAll(dir)
    git(dir, 'checkout', '-b', 'feature')
    write(dir, 'a.ts', 'two\n')
    commitAll(dir)
    expect(suggestedBase(dir)).toEqual({ base: 'master', commits: 1 })
  })

  it('a repo with no history offers nothing', () => {
    expect(suggestedBase(tempRepo())).toBeNull()
  })
})
