import { describe, expect, it } from 'vitest'
import { HELP_TEXT, helpFor, parseCliArgs } from './cliArgs.js'

describe('parseCliArgs', () => {
  it('defaults to working tree, auto port, open browser, background server', () => {
    expect(parseCliArgs([])).toEqual({
      kind: 'run',
      spec: { kind: 'working-tree' },
      port: undefined,
      open: true,
      foreground: false,
    })
  })

  it('--foreground holds the server in this process', () => {
    expect(parseCliArgs(['--foreground'])).toMatchObject({ kind: 'run', foreground: true })
  })

  it('--base selects branch mode', () => {
    expect(parseCliArgs(['--base', 'main'])).toMatchObject({
      kind: 'run',
      spec: { kind: 'branch', base: 'main' },
    })
  })

  it('-p parses the port; garbage ports are errors', () => {
    expect(parseCliArgs(['-p', '4949'])).toMatchObject({ kind: 'run', port: 4949 })
    expect(parseCliArgs(['-p', 'banana'])).toMatchObject({ kind: 'error' })
    expect(parseCliArgs(['-p', '99999'])).toMatchObject({ kind: 'error' })
  })

  it('a port has to be a whole number — parseInt truncation is not parsing', () => {
    expect(parseCliArgs(['-p', '80.5'])).toMatchObject({ kind: 'error' })
    expect(parseCliArgs(['-p', '80abc'])).toMatchObject({ kind: 'error' })
    expect(parseCliArgs(['-p', '0x50'])).toMatchObject({ kind: 'error' })
    expect(parseCliArgs(['-p', '-80'])).toMatchObject({ kind: 'error' })
  })

  it('--no-open disables the browser', () => {
    expect(parseCliArgs(['--no-open'])).toMatchObject({ kind: 'run', open: false })
  })

  it('help and version take precedence', () => {
    expect(parseCliArgs(['--help'])).toEqual({ kind: 'help' })
    expect(parseCliArgs(['-v'])).toEqual({ kind: 'version' })
  })

  it('unknown flags are human errors, not stack traces', () => {
    const result = parseCliArgs(['--frobnicate'])
    expect(result.kind).toBe('error')
  })

  it('empty --base is an error', () => {
    expect(parseCliArgs(['--base', ''])).toMatchObject({ kind: 'error' })
  })

  it('a base git would refuse fails here, with a diffo error', () => {
    for (const base of ['-main', 'my branch', 'a..b', 'a@{1}', 'a:b', 'a?', 'a.lock', 'a/', 'a.']) {
      expect(parseCliArgs(['--base', base])).toMatchObject({ kind: 'error' })
    }
  })

  it('real-world base names pass', () => {
    for (const base of ['main', 'origin/main', 'v1.2.3', 'feature/foo.bar', 'release-2026.08']) {
      expect(parseCliArgs(['--base', base])).toMatchObject({
        kind: 'run',
        spec: { kind: 'branch', base },
      })
    }
  })
})

describe('parseCliArgs — agent verbs', () => {
  it('poll, end, setup, status, and stop take no arguments', () => {
    expect(parseCliArgs(['poll'])).toEqual({ kind: 'poll' })
    expect(parseCliArgs(['end'])).toEqual({ kind: 'end' })
    expect(parseCliArgs(['setup'])).toEqual({ kind: 'setup' })
    expect(parseCliArgs(['status'])).toEqual({ kind: 'status', json: false })
    expect(parseCliArgs(['stop'])).toEqual({ kind: 'stop' })
    expect(parseCliArgs(['poll', 'extra'])).toMatchObject({ kind: 'error' })
    expect(parseCliArgs(['end', 'extra'])).toMatchObject({ kind: 'error' })
    expect(parseCliArgs(['setup', 'hooks'])).toMatchObject({ kind: 'error' })
    expect(parseCliArgs(['status', 'extra'])).toMatchObject({ kind: 'error' })
    expect(parseCliArgs(['stop', '--message', 'x'])).toMatchObject({ kind: 'error' })
  })

  it('reply takes a thread id and a --message (or defers to stdin)', () => {
    expect(parseCliArgs(['reply', 't-1', '--message', 'done'])).toEqual({
      kind: 'reply',
      threadId: 't-1',
      message: 'done',
    })
    expect(parseCliArgs(['reply', 't-1', '-m', 'done'])).toMatchObject({ message: 'done' })
    expect(parseCliArgs(['reply', 't-1'])).toEqual({
      kind: 'reply',
      threadId: 't-1',
      message: null,
    })
    expect(parseCliArgs(['reply'])).toMatchObject({ kind: 'error' })
    expect(parseCliArgs(['reply', 't-1', 'oops'])).toMatchObject({ kind: 'error' })
  })

  it('comment anchors to a line, a file, or (no file) the changeset', () => {
    expect(parseCliArgs(['comment', 'src/a.ts', '--line', '12', '--message', 'name this'])).toEqual(
      {
        kind: 'comment',
        file: 'src/a.ts',
        line: 12,
        message: 'name this',
      },
    )
    expect(parseCliArgs(['comment', 'src/a.ts'])).toEqual({
      kind: 'comment',
      file: 'src/a.ts',
      line: null,
      message: null,
    })
    expect(parseCliArgs(['comment', '--message', 'read review.ts first'])).toEqual({
      kind: 'comment',
      file: null,
      line: null,
      message: 'read review.ts first',
    })
    // A line with no file has nothing to anchor to.
    expect(parseCliArgs(['comment', '--line', '3', '--message', 'x'])).toMatchObject({
      kind: 'error',
    })
    expect(parseCliArgs(['comment', 'a.ts', '--line', 'zero'])).toMatchObject({ kind: 'error' })
    expect(parseCliArgs(['comment', 'a.ts', '--line', '0'])).toMatchObject({ kind: 'error' })
    expect(parseCliArgs(['comment', 'a.ts', '--line', '3.5'])).toMatchObject({ kind: 'error' })
  })

  it('a verb-looking flag still parses as flags', () => {
    expect(parseCliArgs(['--help'])).toEqual({ kind: 'help' })
  })

  it('status takes --json; the other verbs refuse it', () => {
    expect(parseCliArgs(['status', '--json'])).toEqual({ kind: 'status', json: true })
    expect(parseCliArgs(['poll', '--json'])).toMatchObject({ kind: 'error' })
    expect(parseCliArgs(['reply', 't-1', '--json'])).toMatchObject({ kind: 'error' })
  })
})

describe('parseCliArgs — help is never an error', () => {
  it('the help command shows main or per-command help', () => {
    expect(parseCliArgs(['help'])).toEqual({ kind: 'help' })
    expect(parseCliArgs(['help', 'poll'])).toEqual({ kind: 'help', topic: 'poll' })
    expect(parseCliArgs(['help', 'help'])).toEqual({ kind: 'help' })
    expect(parseCliArgs(['help', 'poll', 'extra'])).toMatchObject({ kind: 'error' })
  })

  it('every verb answers --help / -h, whatever else is on the line', () => {
    for (const verb of ['poll', 'reply', 'comment', 'end', 'setup', 'status', 'stop']) {
      expect(parseCliArgs([verb, '--help'])).toEqual({ kind: 'help', topic: verb })
      expect(parseCliArgs([verb, '-h'])).toEqual({ kind: 'help', topic: verb })
    }
    // Even a line that would otherwise be invalid: help wins.
    expect(parseCliArgs(['reply', '--help'])).toEqual({ kind: 'help', topic: 'reply' })
    expect(parseCliArgs(['poll', 'extra', '--help'])).toEqual({ kind: 'help', topic: 'poll' })
  })

  it('helpFor returns the main help, or a per-command page with an example', () => {
    expect(helpFor()).toBe(HELP_TEXT)
    expect(helpFor('nonsense')).toBe(HELP_TEXT)
    for (const verb of ['poll', 'reply', 'comment', 'end', 'setup', 'status', 'stop']) {
      const page = helpFor(verb)
      expect(page).toContain(`diffo ${verb}`)
      expect(page).toContain('Usage:')
      expect(page).toContain('Example')
    }
  })

  it('help agent is the whole protocol on one page — the skill-less bootstrap', () => {
    expect(parseCliArgs(['help', 'agent'])).toEqual({ kind: 'help', topic: 'agent' })
    const page = helpFor('agent')
    for (const cmd of [
      'diffo --no-open',
      'diffo poll',
      'diffo reply',
      'diffo comment',
      'diffo end',
    ]) {
      expect(page).toContain(cmd)
    }
    expect(page).toContain('tracked background task')
    expect(HELP_TEXT).toContain('help agent')
  })
})

describe('parseCliArgs — unknown commands', () => {
  it('suggests the nearest command for a typo', () => {
    expect(parseCliArgs(['staus'])).toMatchObject({
      kind: 'error',
      message: expect.stringContaining("did you mean 'status'"),
    })
    expect(parseCliArgs(['pol'])).toMatchObject({
      kind: 'error',
      message: expect.stringContaining("did you mean 'poll'"),
    })
    expect(parseCliArgs(['help', 'staus'])).toMatchObject({
      kind: 'error',
      message: expect.stringContaining("did you mean 'status'"),
    })
  })

  it('names the unknown command without a far-fetched suggestion', () => {
    const result = parseCliArgs(['frobnicate'])
    expect(result).toMatchObject({ kind: 'error' })
    expect((result as { message: string }).message).toContain("unknown command 'frobnicate'")
    expect((result as { message: string }).message).not.toContain('did you mean')
  })
})
