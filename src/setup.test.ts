import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import {
  postRegisterHint,
  refreshInstalledSkills,
  runSetup,
  type SetupContext,
  updatePluginLocations,
  vsCodeSettingsFile,
} from './setup.js'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const fn of cleanups.splice(0)) fn()
})

function fakeHome(): string {
  const dir = mkdtempSync(join(tmpdir(), 'diffo-setup-'))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

const noCopilot: SetupContext['run'] = () => ({
  error: new Error('ENOENT'),
  status: null,
  stdout: '',
  stderr: '',
})

function ctx(home: string, over: Partial<SetupContext> = {}): SetupContext {
  return {
    packageRoot: repoRoot,
    homeDir: home,
    env: {},
    platform: 'darwin',
    run: noCopilot,
    ...over,
  }
}

const byClient = (outcomes: ReturnType<typeof runSetup>) =>
  Object.fromEntries(outcomes.map((o) => [o.client, o]))

const skillTarget = (home: string) => join(home, '.claude', 'skills', 'diffo', 'SKILL.md')

describe('runSetup', () => {
  it('reports every client absent on a bare machine, and fails nothing', () => {
    const outcomes = runSetup(ctx(fakeHome()))
    expect(outcomes).toHaveLength(5)
    expect(outcomes.every((o) => o.status === 'absent')).toBe(true)
  })

  it('every client has a post-register hint for the CLI to print', () => {
    for (const outcome of runSetup(ctx(fakeHome()))) {
      expect(postRegisterHint[outcome.client], outcome.client).toBeTruthy()
    }
  })

  it('one client failing to register never blocks the others', () => {
    const home = fakeHome()
    mkdirSync(join(home, '.claude'), { recursive: true })
    mkdirSync(join(home, '.cursor', 'plugins', 'local', 'diffo'), { recursive: true })
    const rows = byClient(runSetup(ctx(home)))
    expect(rows.cursor!.status).toBe('manual')
    expect(rows['claude-code']!.status).toBe('registered')
  })
})

describe('skills directory (claude-code row)', () => {
  it('copies the packaged skill in, and is idempotent', () => {
    const home = fakeHome()
    mkdirSync(join(home, '.claude'), { recursive: true })
    expect(byClient(runSetup(ctx(home)))['claude-code']!.status).toBe('registered')
    expect(readFileSync(skillTarget(home), 'utf-8')).toBe(
      readFileSync(join(repoRoot, 'skills', 'diffo', 'SKILL.md'), 'utf-8'),
    )
    expect(byClient(runSetup(ctx(home)))['claude-code']!.status).toBe('current')
  })

  it('repairs a stale copy from an older version', () => {
    const home = fakeHome()
    mkdirSync(dirname(skillTarget(home)), { recursive: true })
    writeFileSync(skillTarget(home), '---\nname: diffo\ndescription: old\n---\n\nold body\n')
    expect(byClient(runSetup(ctx(home)))['claude-code']!.status).toBe('registered')
    expect(readFileSync(skillTarget(home), 'utf-8')).toContain('## The protocol lives in the CLI')
  })

  it("refuses to clobber a skill it doesn't own", () => {
    const home = fakeHome()
    mkdirSync(dirname(skillTarget(home)), { recursive: true })
    const foreign = '---\nname: diffo-fork\ndescription: not ours\n---\n\nsomething else\n'
    writeFileSync(skillTarget(home), foreign)
    const row = byClient(runSetup(ctx(home)))['claude-code']!
    expect(row.status).toBe('manual')
    expect(row.detail).toContain('different skill')
    expect(readFileSync(skillTarget(home), 'utf-8')).toBe(foreign)
  })
})

describe('agents directory row (the cross-tool skills dir)', () => {
  const agentsTarget = (home: string) => join(home, '.agents', 'skills', 'diffo', 'SKILL.md')

  it('copies the skill into an existing ~/.agents, idempotently', () => {
    const home = fakeHome()
    mkdirSync(join(home, '.agents'), { recursive: true })
    expect(byClient(runSetup(ctx(home)))['agents-dir']!.status).toBe('registered')
    expect(readFileSync(agentsTarget(home), 'utf-8')).toBe(
      readFileSync(join(repoRoot, 'skills', 'diffo', 'SKILL.md'), 'utf-8'),
    )
    expect(byClient(runSetup(ctx(home)))['agents-dir']!.status).toBe('current')
  })

  it('a ~/.codex install counts as presence — codex reads ~/.agents without creating it', () => {
    const home = fakeHome()
    mkdirSync(join(home, '.codex'), { recursive: true })
    expect(byClient(runSetup(ctx(home)))['agents-dir']!.status).toBe('registered')
    expect(readFileSync(agentsTarget(home), 'utf-8')).toContain('## The protocol lives in the CLI')
  })

  it("refuses to clobber a skill it doesn't own", () => {
    const home = fakeHome()
    mkdirSync(dirname(agentsTarget(home)), { recursive: true })
    const foreign = '---\nname: diffo-fork\ndescription: not ours\n---\n\nsomething else\n'
    writeFileSync(agentsTarget(home), foreign)
    expect(byClient(runSetup(ctx(home)))['agents-dir']!.status).toBe('manual')
    expect(readFileSync(agentsTarget(home), 'utf-8')).toBe(foreign)
  })
})

describe('refreshInstalledSkills — the CLI keeps installed copies fresh', () => {
  const stale = '---\nname: diffo\ndescription: old\n---\n\nold body\n'

  it('rewrites stale copies in both skill directories and reports their paths', () => {
    const home = fakeHome()
    for (const dir of ['.claude', '.agents']) {
      mkdirSync(join(home, dir, 'skills', 'diffo'), { recursive: true })
      writeFileSync(join(home, dir, 'skills', 'diffo', 'SKILL.md'), stale)
    }
    const refreshed = refreshInstalledSkills(ctx(home))
    expect(refreshed).toHaveLength(2)
    for (const dir of ['.claude', '.agents']) {
      expect(readFileSync(join(home, dir, 'skills', 'diffo', 'SKILL.md'), 'utf-8')).toContain(
        '## The protocol lives in the CLI',
      )
    }
  })

  it('is a no-op when copies are current', () => {
    const home = fakeHome()
    mkdirSync(join(home, '.claude'), { recursive: true })
    runSetup(ctx(home))
    expect(refreshInstalledSkills(ctx(home))).toEqual([])
  })

  it('never installs where nothing is installed', () => {
    const home = fakeHome()
    expect(refreshInstalledSkills(ctx(home))).toEqual([])
    expect(existsSync(join(home, '.claude'))).toBe(false)
    expect(existsSync(join(home, '.agents'))).toBe(false)
  })

  it('never touches a foreign skill or a dev skill', () => {
    const home = fakeHome()
    const foreign = '---\nname: diffo-fork\ndescription: not ours\n---\n\nsomething else\n'
    const dev =
      '---\nname: diffo\ndescription: dev\n---\n\nThis is a DEV build, run from a checkout\n'
    mkdirSync(join(home, '.claude', 'skills', 'diffo'), { recursive: true })
    mkdirSync(join(home, '.agents', 'skills', 'diffo'), { recursive: true })
    writeFileSync(join(home, '.claude', 'skills', 'diffo', 'SKILL.md'), foreign)
    writeFileSync(join(home, '.agents', 'skills', 'diffo', 'SKILL.md'), dev)
    expect(refreshInstalledSkills(ctx(home))).toEqual([])
    expect(readFileSync(join(home, '.claude', 'skills', 'diffo', 'SKILL.md'), 'utf-8')).toBe(
      foreign,
    )
    expect(readFileSync(join(home, '.agents', 'skills', 'diffo', 'SKILL.md'), 'utf-8')).toBe(dev)
  })

  it('a dev-build CLI refreshes nothing at all', () => {
    const home = fakeHome()
    mkdirSync(join(home, '.claude', 'skills', 'diffo'), { recursive: true })
    writeFileSync(join(home, '.claude', 'skills', 'diffo', 'SKILL.md'), stale)
    expect(refreshInstalledSkills(ctx(home, { env: { ENV: 'development' } }))).toEqual([])
  })
})

describe('cursor row (plugin symlink)', () => {
  const link = (home: string) => join(home, '.cursor', 'plugins', 'local', 'diffo')

  it('links the package root into ~/.cursor/plugins/local, idempotently', () => {
    const home = fakeHome()
    mkdirSync(join(home, '.cursor'), { recursive: true })
    expect(byClient(runSetup(ctx(home))).cursor!.status).toBe('registered')
    expect(resolve(readlinkSync(link(home)))).toBe(repoRoot)
    expect(byClient(runSetup(ctx(home))).cursor!.status).toBe('current')
  })

  it('repairs a link left pointing at an evicted install', () => {
    const home = fakeHome()
    mkdirSync(dirname(link(home)), { recursive: true })
    const stale = join(home, 'gone-install')
    mkdirSync(stale)
    symlinkSync(stale, link(home), 'dir')
    expect(byClient(runSetup(ctx(home))).cursor!.status).toBe('registered')
    expect(resolve(readlinkSync(link(home)))).toBe(repoRoot)
  })

  it('never replaces a real directory in its slot', () => {
    const home = fakeHome()
    mkdirSync(link(home), { recursive: true })
    const row = byClient(runSetup(ctx(home))).cursor!
    expect(row.status).toBe('manual')
    expect(row.detail).toContain('not a symlink')
  })
})

describe('vscode row (chat.pluginLocations)', () => {
  const settingsFile = (home: string) => vsCodeSettingsFile({}, home, 'darwin')

  it('adds the entry to existing settings and preserves the rest', () => {
    const home = fakeHome()
    mkdirSync(dirname(settingsFile(home)), { recursive: true })
    writeFileSync(settingsFile(home), JSON.stringify({ 'editor.fontSize': 14 }))
    expect(byClient(runSetup(ctx(home))).vscode!.status).toBe('registered')
    const settings = JSON.parse(readFileSync(settingsFile(home), 'utf-8'))
    expect(settings['editor.fontSize']).toBe(14)
    expect(settings['chat.pluginLocations']).toEqual({ [repoRoot]: true })
    expect(byClient(runSetup(ctx(home))).vscode!.status).toBe('current')
  })

  it('turns the plugins preview feature on when unset — locations do nothing without it', () => {
    const home = fakeHome()
    mkdirSync(dirname(settingsFile(home)), { recursive: true })
    writeFileSync(settingsFile(home), JSON.stringify({}))
    expect(byClient(runSetup(ctx(home))).vscode!.status).toBe('registered')
    expect(JSON.parse(readFileSync(settingsFile(home), 'utf-8'))['chat.plugins.enabled']).toBe(true)
  })

  it("never overrides the user's explicit chat.plugins.enabled: false", () => {
    const home = fakeHome()
    mkdirSync(dirname(settingsFile(home)), { recursive: true })
    writeFileSync(settingsFile(home), JSON.stringify({ 'chat.plugins.enabled': false }))
    expect(byClient(runSetup(ctx(home))).vscode!.status).toBe('registered')
    expect(JSON.parse(readFileSync(settingsFile(home), 'utf-8'))['chat.plugins.enabled']).toBe(
      false,
    )
  })

  it('bails to manual on settings it cannot faithfully parse (comments are legal there)', () => {
    const home = fakeHome()
    mkdirSync(dirname(settingsFile(home)), { recursive: true })
    writeFileSync(settingsFile(home), '{\n  // a comment\n  "editor.fontSize": 14,\n}\n')
    const row = byClient(runSetup(ctx(home))).vscode!
    expect(row.status).toBe('manual')
    expect(row.detail).toContain('chat.pluginLocations')
    expect(readFileSync(settingsFile(home), 'utf-8')).toContain('// a comment')
  })

  it('updatePluginLocations drops only OUR stale entries, never a stranger', () => {
    const dead = '/gone/diffo'
    const stranger = '/some/other-plugin'
    const [updated, changed] = updatePluginLocations(
      { 'chat.pluginLocations': { [dead]: true, [stranger]: true } },
      '/new/diffo',
      'diffo',
    )
    expect(changed).toBe(true)
    const locations = updated['chat.pluginLocations'] as Record<string, unknown>
    expect(locations[dead]).toBeUndefined()
    expect(locations[stranger]).toBe(true)
    expect(locations['/new/diffo']).toBe(true)
  })
})

describe('copilot row (plugin install)', () => {
  it('registers through the copilot CLI when present', () => {
    const home = fakeHome()
    const calls: string[][] = []
    const run: SetupContext['run'] = (_cmd, args) => {
      calls.push(args)
      if (args[0] === 'plugins') return { status: 0, stdout: '[]', stderr: '' }
      return { status: 0, stdout: 'installed', stderr: '' }
    }
    const row = byClient(runSetup(ctx(home, { run }))).copilot!
    expect(row.status).toBe('registered')
    expect(calls.at(-1)).toEqual(['plugin', 'install', repoRoot])
  })

  it('is current when the installed plugin already points at this root', () => {
    const home = fakeHome()
    const run: SetupContext['run'] = (_cmd, args) =>
      args[0] === 'plugins'
        ? { status: 0, stdout: JSON.stringify([{ name: 'diffo', source: repoRoot }]), stderr: '' }
        : { status: 1, stdout: '', stderr: 'should not install' }
    expect(byClient(runSetup(ctx(home, { run }))).copilot!.status).toBe('current')
  })

  it('reports a failed install as failed, with the first error line', () => {
    const home = fakeHome()
    const run: SetupContext['run'] = (_cmd, args) =>
      args[0] === 'plugins'
        ? { status: 0, stdout: '[]', stderr: '' }
        : { status: 1, stdout: '', stderr: 'boom: no network\nmore detail' }
    const row = byClient(runSetup(ctx(home, { run }))).copilot!
    expect(row.status).toBe('failed')
    expect(row.detail).toBe('boom: no network')
  })
})
