import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { failureReason } from './failureReason.js'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** The error a real child process throws, so the shapes are Node's own. */
function thrown(run: () => unknown): unknown {
  try {
    run()
  } catch (err) {
    return err
  }
  throw new Error('expected a throw')
}

describe('failureReason', () => {
  it('names a failed git command by its subcommand', () => {
    const dir = mkdtempSync(join(tmpdir(), 'diffo-reason-'))
    dirs.push(dir)
    const fetch = thrown(() =>
      execFileSync('git', ['fetch', '--quiet', 'nowhere'], { cwd: dir, stdio: 'pipe' }),
    )
    expect(failureReason(fetch)).toBe('fetch')
    expect(failureReason(new Error('Command failed: git worktree add -B x /p HEAD'))).toBe(
      'git_worktree',
    )
    expect(failureReason(new Error('Command failed: git reset --hard x'))).toBe('git_reset')
    expect(failureReason(new Error('Command failed: git rev-parse HEAD'))).toBe('git')
  })

  it('tells output too large for the buffer, a timed-out fetch and missing git apart', () => {
    expect(
      failureReason(
        Object.assign(new Error('spawnSync git ENOBUFS'), {
          code: 'ENOBUFS',
          path: 'git',
          spawnargs: ['diff'],
        }),
      ),
    ).toBe('too_large')
    expect(
      failureReason(Object.assign(new Error('x'), { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' })),
    ).toBe('too_large')
    expect(failureReason('changeset refresh failed: stdout maxBuffer length exceeded')).toBe(
      'too_large',
    )
    expect(
      failureReason(
        Object.assign(new Error('spawnSync git ETIMEDOUT'), {
          code: 'ETIMEDOUT',
          path: 'git',
          spawnargs: ['fetch', '--quiet', 'origin'],
        }),
      ),
    ).toBe('fetch_timeout')
    expect(
      failureReason(
        Object.assign(new Error('spawnSync git ENOENT'), { code: 'ENOENT', path: 'git' }),
      ),
    ).toBe('git_missing')
  })

  it("reads Diffo's own errors and the OS's", () => {
    expect(failureReason(new Error('no such table: worktrees'))).toBe('db')
    expect(failureReason(new Error('database is locked'))).toBe('db')
    expect(
      failureReason(new Error("no remote points at github.com/a/b, the pull request's repo")),
    ).toBe('no_remote')
    expect(failureReason(new Error('/p exists but is not a worktree; remove it'))).toBe(
      'dir_exists',
    )
    expect(failureReason(new Error("could not fetch pull request #12's head"))).toBe('head_missing')
    expect(failureReason(new Error('a diffo server … would not step aside; stop it'))).toBe('stuck')
    expect(
      failureReason(
        Object.assign(new Error('EMFILE: too many open files, watch'), { code: 'EMFILE' }),
      ),
    ).toBe('files')
    expect(
      failureReason(Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' })),
    ).toBe('permission')
  })

  it('falls back to other, and never echoes the text', () => {
    expect(failureReason(new Error('/Users/sam/secret-repo: something odd'))).toBe('other')
    expect(failureReason(undefined)).toBe('other')
    expect(failureReason(42)).toBe('other')
  })
})
