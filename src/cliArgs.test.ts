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
      remote: false,
      foreground: false,
      explicitPr: false,
    })
  })

  it('--remote opens the relay tunnel too, and never names the relay itself', () => {
    expect(parseCliArgs(['--remote'])).toMatchObject({ kind: 'run', remote: true })
    expect(parseCliArgs(['main', '--remote', '--no-open'])).toMatchObject({
      kind: 'run',
      spec: { kind: 'branch', base: 'main' },
      remote: true,
      open: false,
    })
    // A relay on an agent's command line could redirect the tunnel, and the key.
    expect(parseCliArgs(['--remote', '--relay', 'https://r.example'])).toMatchObject({
      kind: 'error',
    })
    expect(parseCliArgs(['--relay', 'https://r.example'])).toMatchObject({ kind: 'error' })
  })

  it('diffo remote: setup, off, forget; nothing else is a remote command', () => {
    expect(parseCliArgs(['remote', 'off'])).toEqual({ kind: 'remote', action: 'off' })
    expect(parseCliArgs(['remote', 'forget'])).toEqual({ kind: 'remote', action: 'forget' })
    expect(parseCliArgs(['remote', 'setup', '--relay', 'https://r.example'])).toEqual({
      kind: 'remote',
      action: 'setup',
      relay: 'https://r.example',
    })
    expect(parseCliArgs(['remote', 'setup', '--check'])).toEqual({
      kind: 'remote',
      action: 'check',
    })
    expect(parseCliArgs(['remote', '--help'])).toEqual({ kind: 'help', topic: 'remote' })
    expect(parseCliArgs(['remote', 'setup', '--help'])).toEqual({ kind: 'help', topic: 'remote' })
    for (const argv of [
      ['remote'],
      ['remote', 'on'],
      ['remote', 'off', 'now'],
      ['remote', '--key', 'x'],
      ['remote', 'setup'],
      ['remote', 'setup', '--relay', ''],
      ['remote', 'setup', '--relay', 'https://r.example', '--key', 'x'],
      ['remote', 'setup', '--relay', 'https://r.example', 'extra'],
      ['remote', 'setup', '--check', '--relay', 'https://r.example'],
      ['remote', 'off', '--relay', 'https://r.example'],
      ['remote', 'forget', '--check'],
      ['remote', '--check'],
    ]) {
      expect(parseCliArgs(argv)).toMatchObject({ kind: 'error' })
    }
  })

  it('lists the remote commands on their own help page', () => {
    const page = helpFor('remote')
    for (const verb of ['setup --relay <url>', 'off', 'forget']) {
      expect(page).toMatch(new RegExp(`^  ${verb.replace(/[<>]/g, '.')}\\s`, 'm'))
    }
  })

  it('never takes the relay key as a flag', () => {
    expect(parseCliArgs(['--remote', '--key', 'secret'])).toMatchObject({ kind: 'error' })
    expect(parseCliArgs(['--remote', '--relay-key', 'secret'])).toMatchObject({ kind: 'error' })
  })

  it('keeps remote mode to one beta line in the help', () => {
    const help = HELP_TEXT
    const lines = help.split('\n').filter((l) => /remote|relay/i.test(l))
    expect(lines).toEqual([expect.stringMatching(/^\s+--remote\s+\(beta\)/)])
    expect(helpFor('agent')).not.toMatch(/remote|relay/i)
    expect(helpFor('pr')).not.toMatch(/remote|relay/i)
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

  it('reply takes --ask, as a whole answer; the other verbs refuse it', () => {
    expect(parseCliArgs(['reply', 't-1', '--ask', '-m', 'public or internal?'])).toMatchObject({
      kind: 'reply',
      ask: true,
    })
    expect(parseCliArgs(['reply', 't-1', '--as', 'codex', '--ask', '-m', 'x'])).toMatchObject({
      kind: 'reply',
      ask: true,
      as: 'codex',
    })
    expect(parseCliArgs(['reply', 't-1', '--ask', '--more', '-m', 'x'])).toMatchObject({
      kind: 'error',
    })
    expect(parseCliArgs(['comment', 'a.ts', '--ask', '-m', 'x'])).toMatchObject({ kind: 'error' })
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
      remote: false,
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
      remote: false,
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

  it("a word near a reviewer agent's verb is still a branch", () => {
    for (const word of [
      'review',
      'reviews',
      'reviewed',
      'reviewers',
      'roles',
      'rule',
      'core',
      'rate',
      'jobs',
      'chats',
      'joins',
    ]) {
      expect(parseCliArgs([word])).toMatchObject({ kind: 'run', target: word })
    }
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
        remote: false,
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
      source: { kind: 'suggest', reason: null, preset: null },
    })
    expect(parseCliArgs(['layers'])).toMatchObject({ kind: 'error' })
    expect(parseCliArgs(['layers', '--json', '[]', '--stdin'])).toMatchObject({ kind: 'error' })
    expect(parseCliArgs(['layers', '--suggest', '--stdin'])).toMatchObject({ kind: 'error' })
  })

  it('--suggest takes one optional reason, cut to one line', () => {
    expect(parseCliArgs(['layers', '--suggest', 'the parser explains the rest\nmore'])).toEqual({
      kind: 'layers',
      source: { kind: 'suggest', reason: 'the parser explains the rest', preset: null },
    })
    expect(parseCliArgs(['layers', '--suggest', ''])).toMatchObject({
      source: { kind: 'suggest', reason: null, preset: null },
    })
    expect(parseCliArgs(['layers', '--suggest', 'a', 'b'])).toMatchObject({ kind: 'error' })
  })

  it('--suggest may name the preset that fits; a post never takes --preset', () => {
    expect(
      parseCliArgs(['layers', '--suggest', 'mostly plumbing', '--preset', 'importance']),
    ).toEqual({
      kind: 'layers',
      source: { kind: 'suggest', reason: 'mostly plumbing', preset: 'importance' },
    })
    expect(parseCliArgs(['layers', '--suggest', '--preset', ' '])).toMatchObject({
      source: { kind: 'suggest', reason: null, preset: null },
    })
    expect(parseCliArgs(['layers', '--json', '[]', '--preset', 'importance'])).toMatchObject({
      kind: 'error',
      message: expect.stringContaining('--preset goes with --suggest'),
    })
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

  it('help agent starts the poll before the guide, and teaches layers after both', () => {
    const page = helpFor('agent')
    const listen = page.indexOf('2. Listen')
    const guide = page.indexOf('3. Guide')
    const layers = page.indexOf('4. Layers')
    expect(listen).toBeGreaterThan(-1)
    expect(guide).toBeGreaterThan(listen)
    expect(layers).toBeGreaterThan(guide)
    // The poll is the one step with no later surface: it starts in the open's
    // own response, and an open review with nobody polling is named as broken.
    expect(page).toMatch(/in this same response, right after sharing the URL/)
    expect(page).toMatch(/An open review with no attended poll is a broken state/)
    expect(page).toContain('diffo layers --suggest')
    expect(page).toContain("diffo layers --json '<post>'")
  })
})

describe('parseCliArgs — preset', () => {
  it('list, show, update (fields inline or piped, with a message) and reply', () => {
    expect(parseCliArgs(['preset', 'list'])).toEqual({ kind: 'preset', action: { kind: 'list' } })
    expect(parseCliArgs(['preset', 'show', 'a1'])).toEqual({
      kind: 'preset',
      action: { kind: 'show', id: 'a1' },
    })
    expect(
      parseCliArgs(['preset', 'update', 'a1', '--json', '{"name":"A"}', '-m', 'Renamed']),
    ).toEqual({
      kind: 'preset',
      action: {
        kind: 'update',
        id: 'a1',
        source: { kind: 'json', text: '{"name":"A"}' },
        message: 'Renamed',
      },
    })
    expect(parseCliArgs(['preset', 'update', 'a1', '--stdin'])).toEqual({
      kind: 'preset',
      action: { kind: 'update', id: 'a1', source: { kind: 'stdin' }, message: null },
    })
    expect(parseCliArgs(['preset', 'reply', 'a1', '--message', 'Sure?'])).toEqual({
      kind: 'preset',
      action: { kind: 'reply', id: 'a1', message: 'Sure?' },
    })
    expect(parseCliArgs(['preset'])).toMatchObject({ kind: 'error', message: /list, show/ })
    expect(parseCliArgs(['preset', 'list', 'a1'])).toMatchObject({ kind: 'error' })
    expect(parseCliArgs(['preset', 'show'])).toMatchObject({
      kind: 'error',
      message: /needs the preset/,
    })
    expect(parseCliArgs(['preset', 'update', 'a1'])).toMatchObject({
      kind: 'error',
      message: /exactly one/,
    })
    expect(parseCliArgs(['preset', 'update', 'a1', '--json', ' '])).toMatchObject({
      kind: 'error',
      message: /needs/,
    })
    expect(parseCliArgs(['preset', 'nope', 'a1'])).toMatchObject({ kind: 'error' })
    expect(parseCliArgs(['preset', '--help'])).toEqual({ kind: 'help', topic: 'preset' })
    expect(helpFor('preset')).toContain('diffo preset update <id>')
    expect(helpFor('agent')).toContain('diffo preset update')
  })
})

describe('parseCliArgs — role', () => {
  it('reads like preset: list, show, update (inline or piped, with a message) and reply', () => {
    expect(parseCliArgs(['role', 'list'])).toEqual({ kind: 'role', action: { kind: 'list' } })
    expect(parseCliArgs(['role', 'show', 'perf'])).toEqual({
      kind: 'role',
      action: { kind: 'show', id: 'perf' },
    })
    expect(
      parseCliArgs(['role', 'update', 'perf', '--json', '{"focus":"x"}', '-m', 'Tighter']),
    ).toEqual({
      kind: 'role',
      action: {
        kind: 'update',
        id: 'perf',
        source: { kind: 'json', text: '{"focus":"x"}' },
        message: 'Tighter',
      },
    })
    expect(parseCliArgs(['role', 'update', 'perf', '--stdin'])).toEqual({
      kind: 'role',
      action: { kind: 'update', id: 'perf', source: { kind: 'stdin' }, message: null },
    })
    expect(parseCliArgs(['role', 'reply', 'draft-0a1b2c3d', '-m', 'Memory too?'])).toEqual({
      kind: 'role',
      action: { kind: 'reply', id: 'draft-0a1b2c3d', message: 'Memory too?' },
    })
    expect(parseCliArgs(['role'])).toMatchObject({ kind: 'error', message: /^role takes list/ })
    expect(parseCliArgs(['role', 'show'])).toMatchObject({
      kind: 'error',
      message: /needs the role's id/,
    })
    expect(parseCliArgs(['role', 'update', 'perf', '--json', ' '])).toMatchObject({
      kind: 'error',
      message: /diffo help role/,
    })
    expect(parseCliArgs(['role', '--help'])).toEqual({ kind: 'help', topic: 'role' })
    expect(parseCliArgs(['help', 'role'])).toEqual({ kind: 'help', topic: 'role' })
    expect(helpFor('role')).toContain('diffo role update <id>')
    expect(helpFor('agent')).toContain('diffo role update')
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

describe('parseCliArgs — share', () => {
  it('shares this review, a named pull request, or prints the comment with --dry-run', () => {
    expect(parseCliArgs(['share'])).toEqual({ kind: 'share', dryRun: false })
    expect(parseCliArgs(['share', '#482', '--dry-run'])).toEqual({
      kind: 'share',
      target: '#482',
      dryRun: true,
    })
    expect(parseCliArgs(['share', '--help'])).toEqual({ kind: 'help', topic: 'share' })
    expect(parseCliArgs(['share', '1', '2'])).toMatchObject({ kind: 'error' })
    expect(helpFor('share')).toContain('diffo share [<pull request>] [--dry-run]')
  })
})

describe('parseCliArgs — reviewer agents', () => {
  it('join takes a role, a name, or both, and nothing else', () => {
    expect(parseCliArgs(['join', '--as', 'codex'])).toEqual({ kind: 'join', as: 'codex' })
    expect(parseCliArgs(['join', '--as', 'Codex'])).toEqual({ kind: 'join', as: 'codex' })
    expect(parseCliArgs(['join', '--role', 'Security'])).toEqual({ kind: 'join', role: 'security' })
    expect(parseCliArgs(['join', '--role', 'tests', '--as', 'codex'])).toEqual({
      kind: 'join',
      as: 'codex',
      role: 'tests',
    })
    expect(parseCliArgs(['join', '--role', 'two words'])).toMatchObject({
      kind: 'error',
      message: expect.stringMatching(/^--role: /),
    })
    expect(parseCliArgs(['comment', '--as', 'codex', '--role', 'tests', '-m', 'x'])).toEqual({
      kind: 'error',
      message: "'comment' takes no --role",
    })
    expect(parseCliArgs(['join'])).toMatchObject({
      kind: 'error',
      message: expect.stringContaining('diffo join --role <id>'),
    })
    expect(parseCliArgs(['join', 'codex', '--as', 'codex']).kind).toBe('error')
    expect(parseCliArgs(['join', '--as', 'codex', '-m', 'hi']).kind).toBe('error')
  })

  it('refuses a name the review would refuse, before anything is sent', () => {
    for (const bad of [
      'agent',
      'you',
      'reviewer',
      'author',
      'github',
      'two words',
      'x'.repeat(25),
    ]) {
      expect(parseCliArgs(['join', '--as', bad]), bad).toMatchObject({
        kind: 'error',
        message: expect.stringMatching(/^--as: /),
      })
    }
  })

  it('--as rides comment, reply and poll; without it they are the author agent’s', () => {
    expect(
      parseCliArgs(['comment', 'src/a.ts', '--line', '4', '--as', 'codex', '-m', 'x']),
    ).toEqual({
      kind: 'comment',
      file: 'src/a.ts',
      line: 4,
      message: 'x',
      suggestReply: null,
      prComment: null,
      as: 'codex',
    })
    expect(parseCliArgs(['reply', 't-1', '--as', 'codex', '-m', 'x'])).toMatchObject({
      kind: 'reply',
      threadId: 't-1',
      as: 'codex',
    })
    expect(parseCliArgs(['poll', '--as', 'codex'])).toEqual({
      kind: 'poll',
      title: null,
      as: 'codex',
    })
    expect(parseCliArgs(['poll'])).toEqual({ kind: 'poll', title: null })
    expect(parseCliArgs(['reply', 't-1', '-m', 'x'])).not.toHaveProperty('as')
  })

  it('what belongs to the author agent is refused with --as', () => {
    for (const argv of [
      ['reply', 't-1', '--as', 'codex', '-m', 'x', '--more'],
      ['reply', 't-1', '--as', 'codex', '-m', 'x', '--suggest-reply', 'yes'],
      ['comment', '--as', 'codex', '-m', 'x', '--pr-comment', 'y'],
      ['poll', '--as', 'codex', '--title', 'retries'],
    ]) {
      expect(parseCliArgs(argv), argv.join(' ')).toMatchObject({
        kind: 'error',
        message: expect.stringContaining("is the author agent's"),
      })
    }
    for (const verb of ['end', 'status', 'stop', 'setup']) {
      expect(parseCliArgs([verb, '--as', 'codex'])).toEqual({
        kind: 'error',
        message: `'${verb}' takes no --as`,
      })
    }
  })

  it('progress is a reviewer agent’s status line: its name and a few words', () => {
    expect(
      parseCliArgs(['progress', '--as', 'Codex', '--message', ' reading the routes ']),
    ).toEqual({
      kind: 'progress',
      as: 'codex',
      text: 'reading the routes',
    })
    // The words after the verb work too.
    expect(parseCliArgs(['progress', '--as', 'codex', 'running', 'the tests'])).toEqual({
      kind: 'progress',
      as: 'codex',
      text: 'running the tests',
    })
    expect(parseCliArgs(['progress', '--message', 'x'])).toMatchObject({
      kind: 'error',
      message: expect.stringContaining('progress needs your reviewer name'),
    })
    expect(parseCliArgs(['progress', '--as', 'codex'])).toMatchObject({
      kind: 'error',
      message: expect.stringContaining('progress needs a line'),
    })
    expect(parseCliArgs(['progress', '--as', 'agent', '-m', 'x']).kind).toBe('error')
    expect(parseCliArgs(['progress', '--help'])).toEqual({ kind: 'help', topic: 'progress' })
  })

  it('diff reads the change under a reviewer name: every file, or the ones named', () => {
    expect(parseCliArgs(['diff', '--as', 'kit'])).toEqual({ kind: 'diff', as: 'kit', files: [] })
    expect(parseCliArgs(['diff', '--as', 'kit', 'a.ts', 'src/b.ts'])).toEqual({
      kind: 'diff',
      as: 'kit',
      files: ['a.ts', 'src/b.ts'],
    })
    expect(parseCliArgs(['diff', 'a.ts'])).toMatchObject({
      kind: 'error',
      message: expect.stringContaining('diff needs your reviewer name'),
    })
    expect(parseCliArgs(['diff', '--help'])).toEqual({ kind: 'help', topic: 'diff' })
  })

  it('covered is the reviewer’s word on what it skipped, none when it read it all', () => {
    expect(parseCliArgs(['covered', '--as', 'kit'])).toEqual({
      kind: 'covered',
      as: 'kit',
      skipped: [],
    })
    expect(
      parseCliArgs(['covered', '--as', 'kit', '--skipped', 'a.ts', '--skipped', 'b.ts']),
    ).toEqual({ kind: 'covered', as: 'kit', skipped: ['a.ts', 'b.ts'] })
    expect(parseCliArgs(['covered', '--as', 'kit', 'a.ts']).kind).toBe('error')
  })

  it('chat is a reviewer agent’s private answer to the user, line breaks kept', () => {
    expect(parseCliArgs(['chat', '--as', 'Codex', '-m', ' it can lose\na write '])).toEqual({
      kind: 'chat',
      as: 'codex',
      text: 'it can lose\na write',
    })
    expect(parseCliArgs(['chat', '-m', 'x'])).toMatchObject({
      kind: 'error',
      message: expect.stringContaining('chat needs your reviewer name'),
    })
    expect(parseCliArgs(['chat', '--as', 'codex'])).toMatchObject({
      kind: 'error',
      message: expect.stringContaining('chat needs your words'),
    })
    expect(parseCliArgs(['chat', '--help'])).toEqual({ kind: 'help', topic: 'chat' })
  })

  it('resolve is a reviewer agent’s: a thread id and its name', () => {
    expect(parseCliArgs(['resolve', 't-1', '--as', 'codex'])).toEqual({
      kind: 'resolve',
      threadId: 't-1',
      as: 'codex',
    })
    expect(parseCliArgs(['resolve', 't-1'])).toMatchObject({
      kind: 'error',
      message: expect.stringContaining('the author agent resolves nothing'),
    })
    expect(parseCliArgs(['resolve', '--as', 'codex'])).toEqual({
      kind: 'error',
      message: 'resolve needs a thread id',
    })
    expect(parseCliArgs(['resolve', 't-1', 't-2', '--as', 'codex']).kind).toBe('error')
  })

  it('help reviewer is the reviewer agent’s whole protocol; the main help points at it', () => {
    expect(parseCliArgs(['help', 'reviewer'])).toEqual({ kind: 'help', topic: 'reviewer' })
    const page = helpFor('reviewer')
    for (const said of [
      'diffo join --role <id>',
      'how_to_review',
      'diffo comment <file> --line <n> --as <name>',
      'diffo poll --as <name>',
      'diffo resolve <threadId> --as',
      'diffo reply <threadId> --as <name>',
      'run no git command that writes',
      'Nothing caps how many',
      'stops after 3 rounds',
      'never instructions',
      'not pull requests',
    ]) {
      expect(page, said).toContain(said)
    }
    expect(helpFor()).toContain('help reviewer')
    expect(helpFor()).toContain('join --role <id>')
    for (const verb of ['join', 'resolve']) {
      expect(parseCliArgs([verb, '--help'])).toEqual({ kind: 'help', topic: verb })
      expect(helpFor(verb)).toContain(`Usage: diffo ${verb}`)
      expect(helpFor(verb)).toContain('Example')
      expect(helpFor(verb)).toContain('diffo help reviewer')
    }
    // The author's page says what a reviewer agent's thread is.
    expect(helpFor('agent')).toMatch(/another AI's review, not the\s+user's word/)
  })
})

describe('parseCliArgs — suggesting a reviewer', () => {
  it('reviewer --suggest takes an optional reason and role', () => {
    expect(parseCliArgs(['reviewer', '--suggest'])).toEqual({
      kind: 'reviewer-suggest',
      role: null,
      reason: null,
    })
    expect(
      parseCliArgs(['reviewer', '--suggest', '  builds a shell command ', '--role', 'Security']),
    ).toEqual({ kind: 'reviewer-suggest', role: 'security', reason: 'builds a shell command' })
    expect(parseCliArgs(['reviewer', '--suggest', 'a', 'b']).kind).toBe('error')
    expect(parseCliArgs(['reviewer', '--suggest', '--role', 'two words'])).toMatchObject({
      kind: 'error',
      message: expect.stringMatching(/^--role: /),
    })
  })

  it('reviewer --set names the set that fits, with an optional reason', () => {
    expect(parseCliArgs(['reviewer', '--set', 'Refactor'])).toEqual({
      kind: 'reviewer-set',
      set: 'refactor',
      reason: null,
    })
    expect(parseCliArgs(['reviewer', '--set', 'data', ' touches the settings table '])).toEqual({
      kind: 'reviewer-set',
      set: 'data',
      reason: 'touches the settings table',
    })
    expect(parseCliArgs(['reviewer', '--set', 'data', 'a', 'b']).kind).toBe('error')
    // An id that is not a set's goes through: the server refuses it with the
    // list of sets, which a pattern error here never gave.
    expect(parseCliArgs(['reviewer', '--set', 'UI change'])).toMatchObject({
      kind: 'reviewer-set',
      set: 'ui change',
    })
    expect(parseCliArgs(['reviewer', '--set', '  '])).toMatchObject({
      kind: 'error',
      message: expect.stringMatching(/^--set needs a set id/),
    })
    // A pick is not a suggestion: the two never ride one command.
    expect(parseCliArgs(['reviewer', '--set', 'data', '--suggest']).kind).toBe('error')
    expect(helpFor('reviewer-suggest')).toMatch(/diffo reviewer --set <id>/)
  })

  it('suggesting is all the author agent may do about reviewers', () => {
    expect(parseCliArgs(['reviewer'])).toMatchObject({
      kind: 'error',
      message: expect.stringContaining('only the user starts one'),
    })
    expect(parseCliArgs(['reviewer', '--help'])).toEqual({
      kind: 'help',
      topic: 'reviewer-suggest',
    })
    const page = helpFor('reviewer-suggest')
    expect(page).toContain('Usage: diffo reviewer --suggest')
    expect(page).toMatch(/You never\s+start one on your own/)
    // `help reviewer` stays the reviewer agent's protocol, not this verb's page.
    expect(helpFor('reviewer')).toContain("the reviewer agent's whole protocol")
    expect(helpFor()).toContain('reviewer --suggest')
    const agent = helpFor('agent')
    expect(agent).toMatch(/A reviewer agent is the user's to bring in, never yours/)
    expect(agent).toContain('diffo reviewer --suggest')
    expect(agent).toContain('"kind": "reviewers"')
  })
})
