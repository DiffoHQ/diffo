import { describe, expect, it } from 'vitest'
import { HELP_TEXT, helpFor, parseCliArgs } from './cliArgs.js'
import { GUIDE, GUIDE_CLASSDEFS, LAYERS } from './server/prompt.js'

describe('parseCliArgs', () => {
  it('defaults to working tree, auto port, open browser, background server', () => {
    expect(parseCliArgs([])).toEqual({
      kind: 'run',
      spec: { kind: 'working-tree' },
      port: undefined,
      open: true,
      foreground: false,
      explicitPr: false,
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
    expect(parseCliArgs(['poll'])).toEqual({ kind: 'poll', title: null })
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

  it('poll takes --title; the other verbs refuse it', () => {
    expect(parseCliArgs(['poll', '--title', 'tab titles from the agent'])).toEqual({
      kind: 'poll',
      title: 'tab titles from the agent',
    })
    // Whatever the agent sent becomes a tab name: one line, trimmed, capped.
    expect(parseCliArgs(['poll', '--title', '  two\n lines  '])).toMatchObject({
      title: 'two lines',
    })
    expect(parseCliArgs(['poll', '--title', 'x'.repeat(200)])).toMatchObject({
      title: `${'x'.repeat(39)}…`,
    })
    expect(parseCliArgs(['poll', '--title', '   '])).toMatchObject({ kind: 'error' })
    expect(parseCliArgs(['reply', 't-1', '--title', 'x', '-m', 'y'])).toMatchObject({
      kind: 'error',
    })
    expect(parseCliArgs(['end', '--title', 'x'])).toMatchObject({ kind: 'error' })
  })

  it('reply takes a thread id and a --message (or defers to stdin)', () => {
    expect(parseCliArgs(['reply', 't-1', '--message', 'done'])).toEqual({
      kind: 'reply',
      threadId: 't-1',
      message: 'done',
      more: false,
      suggestReply: null,
      prComment: null,
    })
    expect(parseCliArgs(['reply', 't-1', '-m', 'done'])).toMatchObject({ message: 'done' })
    expect(parseCliArgs(['reply', 't-1'])).toEqual({
      kind: 'reply',
      threadId: 't-1',
      message: null,
      more: false,
      suggestReply: null,
      prComment: null,
    })
    expect(parseCliArgs(['reply'])).toMatchObject({ kind: 'error' })
    expect(parseCliArgs(['reply', 't-1', 'oops'])).toMatchObject({ kind: 'error' })
  })

  it('reply takes --more; the other verbs refuse it', () => {
    expect(parseCliArgs(['reply', 't-1', '--more', '-m', 'digging in'])).toMatchObject({
      kind: 'reply',
      more: true,
    })
    expect(parseCliArgs(['comment', 'a.ts', '--more', '-m', 'x'])).toMatchObject({ kind: 'error' })
    expect(parseCliArgs(['poll', '--more'])).toMatchObject({ kind: 'error' })
  })

  it('reply and comment take --suggest-reply as one non-empty line; other verbs refuse it', () => {
    expect(
      parseCliArgs([
        'reply',
        't-1',
        '-m',
        'want me to extract it?',
        '--suggest-reply',
        'yes, extract it',
      ]),
    ).toMatchObject({ kind: 'reply', suggestReply: 'yes, extract it' })
    expect(
      parseCliArgs(['comment', 'a.ts', '-m', 'fold these?', '--suggest-reply', ' fold them ']),
    ).toMatchObject({ kind: 'comment', suggestReply: 'fold them' })
    expect(parseCliArgs(['comment', '-m', 'x', '--suggest-reply', '  '])).toMatchObject({
      kind: 'error',
    })
    expect(parseCliArgs(['reply', 't-1', '-m', 'x', '--suggest-reply', 'a\nb'])).toMatchObject({
      kind: 'error',
    })
    expect(parseCliArgs(['poll', '--suggest-reply', 'x'])).toMatchObject({ kind: 'error' })
    expect(parseCliArgs(['end', '--suggest-reply', 'x'])).toMatchObject({ kind: 'error' })
  })

  it('reply and comment take --pr-comment, multi-line and trimmed; other verbs refuse it', () => {
    expect(
      parseCliArgs([
        'reply',
        't-1',
        '-m',
        'you are right',
        '--pr-comment',
        ' Keep the streak?\n\n```suggestion\nx\n``` ',
      ]),
    ).toMatchObject({ kind: 'reply', prComment: 'Keep the streak?\n\n```suggestion\nx\n```' })
    expect(
      parseCliArgs([
        'comment',
        'a.ts',
        '--line',
        '3',
        '-m',
        'bug',
        '--pr-comment',
        'Loops forever on 0',
      ]),
    ).toMatchObject({
      kind: 'comment',
      prComment: 'Loops forever on 0',
    })
    expect(parseCliArgs(['reply', 't-1', '-m', 'x'])).toMatchObject({
      kind: 'reply',
      prComment: null,
    })
    expect(parseCliArgs(['reply', 't-1', '-m', 'x', '--pr-comment', '  '])).toMatchObject({
      kind: 'error',
    })
    expect(parseCliArgs(['poll', '--pr-comment', 'x'])).toMatchObject({ kind: 'error' })
    expect(parseCliArgs(['layers', '--pr-comment', 'x'])).toMatchObject({ kind: 'error' })
  })

  it('comment anchors to a line, a file, or (no file) the changeset', () => {
    expect(parseCliArgs(['comment', 'src/a.ts', '--line', '12', '--message', 'name this'])).toEqual(
      {
        kind: 'comment',
        file: 'src/a.ts',
        line: 12,
        message: 'name this',
        suggestReply: null,
        prComment: null,
      },
    )
    expect(parseCliArgs(['comment', 'src/a.ts'])).toEqual({
      kind: 'comment',
      file: 'src/a.ts',
      line: null,
      message: null,
      suggestReply: null,
      prComment: null,
    })
    expect(parseCliArgs(['comment', '--message', 'read review.ts first'])).toEqual({
      kind: 'comment',
      file: null,
      line: null,
      message: 'read review.ts first',
      suggestReply: null,
      prComment: null,
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

describe('parseCliArgs — a pull request of your own', () => {
  it('`diffo pr <target>` is the explicit PR review; a bare target is not', () => {
    expect(parseCliArgs(['acme/widgets#482'])).toMatchObject({ kind: 'run', explicitPr: false })
    expect(parseCliArgs(['https://github.com/o/r/pull/7', '--no-open'])).toMatchObject({
      kind: 'run',
      explicitPr: false,
      open: false,
    })
    expect(parseCliArgs(['pr', 'acme/widgets#482'])).toMatchObject({
      kind: 'run',
      target: 'acme/widgets#482',
      explicitPr: true,
    })
    expect(parseCliArgs(['pr', '482', '--no-open'])).toMatchObject({
      kind: 'run',
      target: '482',
      explicitPr: true,
      open: false,
    })
  })

  it('help says the explicit spelling answers the own-PR question', () => {
    expect(HELP_TEXT).toContain('a pull request of your own')
    expect(helpFor('pr')).toContain('branch review')
    expect(helpFor('pr')).toContain('diffo pr <PR>')
    expect(helpFor('agent')).toContain('branch review')
    expect(helpFor('agent')).toContain('PR review')
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
    for (const verb of ['poll', 'reply', 'comment', 'layers', 'end', 'setup', 'status', 'stop']) {
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
    for (const verb of ['poll', 'reply', 'comment', 'layers', 'end', 'setup', 'status', 'stop']) {
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
    // Codex backgrounds a long command and ends its turn; nothing wakes it
    // when the poll returns. The stance has to rule that out in so many words.
    expect(page).toContain('do not end your turn')
    expect(HELP_TEXT).toContain('help agent')
  })

  it('help agent hands the URL over before the guide, not after it', () => {
    const page = helpFor('agent')
    expect(page).toMatch(/share the printed URL instead, the moment it\s+prints/)
    expect(page).toMatch(/Right after sharing the URL, while the reviewer opens the page/)
    expect(page).not.toMatch(/Before sharing the URL/)
  })

  it('help agent teaches the guide as a map — no reading order, one screen, a legend', () => {
    const page = helpFor('agent')
    expect(page).toContain(GUIDE.what)
    expect(page).toContain(GUIDE.order)
    expect(page).toContain(GUIDE.budget)
    expect(page).toContain(GUIDE.legend)
    expect(page).toContain('diffo help guide')
  })

  it('help layers teaches what a summary is for, and diagrams', () => {
    const page = helpFor('layers')
    expect(page).toContain(LAYERS.summary)
    expect(page).toContain(LAYERS.diagram)
    // Decisions ride on the same page as the shape that carries them.
    expect(page).toContain(LAYERS.decisions)
    expect(page).toContain('"decisions"')
    for (const line of GUIDE_CLASSDEFS) expect(page).toContain(line)
    // help agent carries the same rules, so no surface teaches a thinner summary.
    const agent = helpFor('agent')
    expect(agent).toContain(LAYERS.summary)
    expect(agent).toContain(LAYERS.diagram)
  })

  it('help guide is a topic of its own, with the classDef lines and one example', () => {
    expect(parseCliArgs(['help', 'guide'])).toEqual({ kind: 'help', topic: 'guide' })
    const page = helpFor('guide')
    for (const line of GUIDE_CLASSDEFS) expect(page).toContain(line)
    expect(page).toContain(':::new')
    expect(page).toContain(':::changed')
    // The example is one shape, not the shape — the page says so.
    expect(page).toMatch(/not THE shape/)
    // Every rule the doctrine carries reaches the page that shows the example.
    expect(page).toContain(GUIDE.when)
    expect(page).toContain(GUIDE.order)
    expect(page).toContain(GUIDE.stance)
    expect(page).toContain(GUIDE.update)
    expect(HELP_TEXT).toContain('help guide')
  })
})

describe('parseCliArgs — unknown commands', () => {
  it('suggests the nearest command for a typo', () => {
    expect(parseCliArgs(['staus'])).toMatchObject({
      kind: 'error',
      message: expect.stringContaining("Did you mean 'status'"),
    })
    expect(parseCliArgs(['pol'])).toMatchObject({
      kind: 'error',
      message: expect.stringContaining("Did you mean 'poll'"),
    })
    expect(parseCliArgs(['help', 'staus'])).toMatchObject({
      kind: 'error',
      message: expect.stringContaining("Did you mean 'status'"),
    })
  })

  it('a word that is not a typo of a command is a target — a branch to review against', () => {
    expect(parseCliArgs(['frobnicate'])).toMatchObject({
      kind: 'run',
      target: 'frobnicate',
      spec: { kind: 'branch', base: 'frobnicate' },
    })
  })

  it('a pull request reference is a target whatever it resembles', () => {
    for (const raw of [
      'https://github.com/acme/widgets/pull/482',
      'acme/widgets#482',
      '#482',
      '482',
    ]) {
      const result = parseCliArgs([raw, '--no-open'])
      expect(result).toMatchObject({
        kind: 'run',
        target: raw,
        spec: { kind: 'working-tree' },
        open: false,
      })
    }
    expect(parseCliArgs(['pr', 'acme/widgets#482'])).toMatchObject({
      kind: 'run',
      target: 'acme/widgets#482',
    })
    expect(parseCliArgs(['pr'])).toMatchObject({ kind: 'error' })
    // Any URL rides through as a target — never as a branch name — so the CLI
    // can refuse a non-PR one by name instead of reviewing the working tree.
    expect(parseCliArgs(['https://github.com/acme/widgets'])).toMatchObject({
      kind: 'run',
      target: 'https://github.com/acme/widgets',
      spec: { kind: 'working-tree' },
    })
  })

  it('the main help lists pr next to the other reviewer commands', () => {
    expect(HELP_TEXT).toMatch(/\n {2}pr <target> {8}Review a pull request/)
    expect(HELP_TEXT.indexOf('  pr <target>')).toBeLessThan(HELP_TEXT.indexOf('  status '))
  })

  it('a branch target and --base together is one branch too many', () => {
    expect(parseCliArgs(['main', '--base', 'dev'])).toMatchObject({ kind: 'error' })
  })

  it('clean takes --force and --all', () => {
    expect(parseCliArgs(['clean'])).toEqual({ kind: 'clean', force: false, all: false })
    expect(parseCliArgs(['clean', '--force', '--all'])).toEqual({
      kind: 'clean',
      force: true,
      all: true,
    })
  })
})

describe('parseCliArgs — layers', () => {
  it('takes exactly one source: --json, --stdin, or --suggest', () => {
    expect(parseCliArgs(['layers', '--json', '[{"title":"A","files":["a.ts"]}]'])).toEqual({
      kind: 'layers',
      source: { kind: 'json', text: '[{"title":"A","files":["a.ts"]}]' },
    })
    expect(parseCliArgs(['layers', '--stdin'])).toEqual({
      kind: 'layers',
      source: { kind: 'stdin' },
    })
    expect(parseCliArgs(['layers', '--suggest'])).toEqual({
      kind: 'layers',
      source: { kind: 'suggest', reason: null },
    })
    expect(parseCliArgs(['layers'])).toMatchObject({ kind: 'error' })
    expect(parseCliArgs(['layers', '--json', '[]', '--stdin'])).toMatchObject({ kind: 'error' })
    expect(parseCliArgs(['layers', '--suggest', '--stdin'])).toMatchObject({ kind: 'error' })
  })

  it('--suggest takes one optional reason, cut to one line', () => {
    expect(parseCliArgs(['layers', '--suggest', 'the parser explains the rest\nmore'])).toEqual({
      kind: 'layers',
      source: { kind: 'suggest', reason: 'the parser explains the rest' },
    })
    expect(parseCliArgs(['layers', '--suggest', ''])).toMatchObject({
      source: { kind: 'suggest', reason: null },
    })
    expect(parseCliArgs(['layers', '--suggest', 'a', 'b'])).toMatchObject({ kind: 'error' })
  })

  it('the payload never rides as a positional, and an empty --json is an error', () => {
    expect(parseCliArgs(['layers', '[]'])).toMatchObject({ kind: 'error' })
    expect(parseCliArgs(['layers', '--stdin', 'x'])).toMatchObject({ kind: 'error' })
    expect(parseCliArgs(['layers', '--json', '  '])).toMatchObject({ kind: 'error' })
  })

  it('the other verbs’ flags are refused here, and layers has a help page', () => {
    expect(parseCliArgs(['layers', '--message', 'x'])).toMatchObject({ kind: 'error' })
    expect(parseCliArgs(['layers', '--help'])).toEqual({ kind: 'help', topic: 'layers' })
    expect(parseCliArgs(['help', 'layers'])).toEqual({ kind: 'help', topic: 'layers' })
    const page = helpFor('layers')
    expect(page).toContain('--suggest')
    expect(page).toContain('--json')
    expect(page).toContain('--stdin')
    expect(page).toContain('mechanical')
    expect(HELP_TEXT).toContain('layers')
  })

  it('help agent teaches layers between the guide and the poll', () => {
    const page = helpFor('agent')
    const guide = page.indexOf('2. Guide')
    const layers = page.indexOf('3. Layers')
    const listen = page.indexOf('4. Listen')
    expect(guide).toBeGreaterThan(-1)
    expect(layers).toBeGreaterThan(guide)
    expect(listen).toBeGreaterThan(layers)
    expect(page).toContain('diffo layers --suggest')
    expect(page).toContain("diffo layers --json '<Layer[]>'")
  })
})

describe('parseCliArgs — telemetry', () => {
  it('defaults to status, and takes exactly one of status, on, off', () => {
    expect(parseCliArgs(['telemetry'])).toEqual({ kind: 'telemetry', action: 'status' })
    expect(parseCliArgs(['telemetry', 'status'])).toEqual({ kind: 'telemetry', action: 'status' })
    expect(parseCliArgs(['telemetry', 'off'])).toEqual({ kind: 'telemetry', action: 'off' })
    expect(parseCliArgs(['telemetry', 'on'])).toEqual({ kind: 'telemetry', action: 'on' })
    expect(parseCliArgs(['telemetry', 'maybe'])).toMatchObject({ kind: 'error' })
    expect(parseCliArgs(['telemetry', 'on', 'off'])).toMatchObject({ kind: 'error' })
    expect(parseCliArgs(['telemetry', '--json'])).toMatchObject({ kind: 'error' })
  })

  it('has help, and is a verb — never a branch', () => {
    expect(parseCliArgs(['telemetry', '--help'])).toEqual({ kind: 'help', topic: 'telemetry' })
    expect(parseCliArgs(['help', 'telemetry'])).toEqual({ kind: 'help', topic: 'telemetry' })
    expect(helpFor('telemetry')).toContain('DO_NOT_TRACK')
    expect(parseCliArgs(['telemetr'])).toMatchObject({ kind: 'error' })
  })
})
