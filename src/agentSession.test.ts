import { describe, expect, it } from 'vitest'
import { type AncestorRow, pickSessionAncestor, readAncestors } from './agentSession.js'

const OWN = { script: '/Users/dev/proj/src/cli.ts', args: ['poll'] }

const CLAUDE_CODE: AncestorRow[] = [
  {
    pid: 93214,
    ppid: 26288,
    command:
      '/bin/zsh -c source /Users/dev/.claude/shell-snapshots/snapshot-zsh-123.sh 2>/dev/null || true && tsx src/cli.ts poll',
  },
  {
    pid: 26288,
    ppid: 26287,
    command:
      '/Users/dev/Library/Application Support/Claude/claude-code/2.1.222/claude.app/Contents/MacOS/claude --output-format stream-json',
  },
  {
    pid: 26287,
    ppid: 43528,
    command: '/Applications/Claude.app/Contents/Helpers/disclaimer …/MacOS/claude',
  },
  { pid: 43528, ppid: 1, command: '/Applications/Claude.app/Contents/MacOS/Claude' },
]

describe('pickSessionAncestor', () => {
  it('picks the nearest harness process, not the shell that mentions .claude in its args', () => {
    expect(pickSessionAncestor(CLAUDE_CODE, OWN)).toBe(26288)
  })

  it('a plain terminal run has no session: shells skipped, no harness matched', () => {
    expect(
      pickSessionAncestor([
        { pid: 10, ppid: 20, command: '-zsh' },
        { pid: 20, ppid: 1, command: '/Applications/iTerm.app/Contents/MacOS/iTerm2' },
      ]),
    ).toBeNull()
  })

  it('recognises other harnesses by command', () => {
    expect(
      pickSessionAncestor([
        { pid: 5, ppid: 6, command: '/bin/bash -c npx diffo poll' },
        { pid: 6, ppid: 1, command: '/Applications/Cursor.app/Contents/MacOS/Cursor Helper' },
      ]),
    ).toBe(6)
  })

  it('skips the wrapper that runs the CLI, even when its path carries a harness word', () => {
    // A dev checkout under `.claude/worktrees/…`, run through tsx: the tsx
    // process carries the script path, dies with the poll, and is not the session.
    const own = {
      script: '/Users/dev/proj/.claude/worktrees/wt-1/src/cli.ts',
      args: ['poll'],
    }
    expect(
      pickSessionAncestor(
        [
          {
            pid: 3,
            ppid: 4,
            command:
              'node /Users/dev/proj/node_modules/tsx/dist/cli.mjs /Users/dev/proj/.claude/worktrees/wt-1/src/cli.ts poll',
          },
          { pid: 4, ppid: 5, command: '/bin/zsh -c cd /Users/dev/proj && tsx …' },
          { pid: 5, ppid: 1, command: '/Applications/Claude.app/Contents/MacOS/claude' },
        ],
        own,
      ),
    ).toBe(5)
    // The same wrapper with a relative script path.
    expect(
      pickSessionAncestor(
        [
          {
            pid: 3,
            ppid: 5,
            command: 'node node_modules/.bin/../tsx/dist/cli.mjs ./src/cli.ts poll',
          },
          { pid: 5, ppid: 1, command: '/Applications/Claude.app/Contents/MacOS/claude' },
        ],
        own,
      ),
    ).toBe(5)
  })

  it('skips npx and pnpm dlx, and still finds a harness installed from npm', () => {
    const own = { script: '/tmp/_npx/abc/node_modules/@diffohq/diffo/dist/cli.js', args: ['poll'] }
    expect(
      pickSessionAncestor(
        [
          { pid: 3, ppid: 4, command: 'npm exec -y @diffohq/diffo poll' },
          { pid: 4, ppid: 5, command: '/bin/sh -c npx -y @diffohq/diffo poll' },
          {
            pid: 5,
            ppid: 1,
            command: 'node /opt/homebrew/lib/node_modules/@anthropic-ai/claude-code/cli.js',
          },
        ],
        own,
      ),
    ).toBe(5)
  })

  it('a harness word inside another word is not a harness', () => {
    expect(
      pickSessionAncestor(
        [
          { pid: 3, ppid: 4, command: 'node /Users/sam/example/tool.js' },
          { pid: 4, ppid: 1, command: '/Applications/iTerm.app/Contents/MacOS/iTerm2' },
        ],
        { script: '/x/cli.js', args: [] },
      ),
    ).toBeNull()
  })

  it('never matches inside a shell row, whatever its arguments say', () => {
    expect(
      pickSessionAncestor([
        { pid: 7, ppid: 1, command: '/bin/zsh -c /Users/dev/.claude/hooks/claude-hook.sh' },
      ]),
    ).toBeNull()
  })
})

describe('readAncestors', () => {
  const table = new Map(CLAUDE_CODE.map((row) => [row.pid, row]))

  it('walks to init and stops', () => {
    const rows = readAncestors(93214, (pid) => table.get(pid) ?? null)
    expect(rows.map((r) => r.pid)).toEqual([93214, 26288, 26287, 43528])
  })

  it('a missing row ends the walk instead of throwing', () => {
    const rows = readAncestors(26287, (pid) => (pid === 26287 ? (table.get(pid) ?? null) : null))
    expect(rows).toHaveLength(1)
  })

  it('a self-parenting row cannot loop forever', () => {
    const rows = readAncestors(9, () => ({ pid: 9, ppid: 9, command: 'weird' }))
    expect(rows).toHaveLength(1)
  })
})
