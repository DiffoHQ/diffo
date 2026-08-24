import { spawnSync } from 'node:child_process'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'

export interface SetupOutcome {
  client: string
  status: 'registered' | 'current' | 'absent' | 'manual' | 'failed'
  detail: string
}

/**
 * What a freshly registered client needs before diffo shows up in it. Skill
 * files are read per session, so those clients need no restart; Cursor scans
 * local plugins at startup and Reload Window is unreliable for it; VS Code
 * reads chat.pluginLocations on window load.
 */
export const postRegisterHint: Record<string, string> = {
  'claude-code': 'available in new agent sessions',
  'agents-dir': 'available in new agent sessions',
  cursor: 'restart Cursor to load it',
  vscode: 'reload the VS Code window to load it',
  copilot: 'available in new copilot sessions',
}

export interface SetupContext {
  packageRoot: string
  homeDir: string
  env?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
  run?: (
    command: string,
    args: string[],
  ) => { error?: Error; status: number | null; stdout: string; stderr: string }
}

function isDiffoSkill(content: string): boolean {
  const frontmatter = /^---\n([\s\S]*?)\n---/.exec(content)?.[1] ?? ''
  return /^name:\s*diffo\s*$/m.test(frontmatter)
}

function pluginName(packageRoot: string): string {
  try {
    const manifest = JSON.parse(readFileSync(join(packageRoot, 'plugin.json'), 'utf-8')) as {
      name?: string
    }
    if (typeof manifest.name === 'string' && manifest.name !== '') return manifest.name
  } catch {
    // fall through to the default
  }
  return 'diffo'
}

const collapse = (target: string, home: string) =>
  home && target.startsWith(home) ? `~${target.slice(home.length)}` : target

function packagedSkill(ctx: SetupContext): string {
  return readFileSync(join(ctx.packageRoot, 'skills', 'diffo', 'SKILL.md'), 'utf-8')
}

function installSkillCopy(ctx: SetupContext, client: string, targetDir: string): SetupOutcome {
  const home = ctx.homeDir
  const content = packagedSkill(ctx)
  const target = join(targetDir, 'SKILL.md')

  if (existsSync(target)) {
    const existing = readFileSync(target, 'utf-8')
    if (existing === content) {
      return { client, status: 'current', detail: collapse(target, home) }
    }
    if (!isDiffoSkill(existing)) {
      // Someone else's skill occupies the slot — report it, never clobber it.
      return {
        client,
        status: 'manual',
        detail: `a different skill lives at ${collapse(target, home)} — remove it and re-run \`diffo setup\``,
      }
    }
    writeFileSync(target, content)
    return { client, status: 'registered', detail: collapse(target, home) }
  }

  mkdirSync(targetDir, { recursive: true })
  writeFileSync(target, content)
  return { client, status: 'registered', detail: collapse(target, home) }
}

function registerSkillsDir(ctx: SetupContext): SetupOutcome {
  const home = ctx.homeDir
  const client = 'claude-code'
  if (!existsSync(join(home, '.claude'))) {
    return { client, status: 'absent', detail: 'no ~/.claude directory found' }
  }
  return installSkillCopy(ctx, client, join(home, '.claude', 'skills', 'diffo'))
}

/**
 * The cross-tool skills directory of the Agent Skills spec: Codex reads
 * `~/.agents/skills` as its user-level location, and Gemini CLI, Amp, Goose,
 * OpenCode and others follow the same convention. One copy covers them all.
 * `~/.codex` counts as presence too — Codex reads the directory without
 * creating it.
 */
function registerAgentsDir(ctx: SetupContext): SetupOutcome {
  const home = ctx.homeDir
  const client = 'agents-dir'
  if (!existsSync(join(home, '.agents')) && !existsSync(join(home, '.codex'))) {
    return { client, status: 'absent', detail: 'no ~/.agents (or ~/.codex) directory found' }
  }
  return installSkillCopy(ctx, client, join(home, '.agents', 'skills', 'diffo'))
}

/** The dev skill drives a source checkout; a shipped CLI must never replace it. */
const DEV_SKILL_MARKER = 'This is a DEV build'

/**
 * Freshen the file-copy skill installs. `npx -y @diffohq/diffo` resolves a current CLI
 * on every review, which makes the CLI the one component that is always fresh —
 * so it carries the installed skill forward, instead of every release waiting
 * on users to re-run `diffo setup`. Refresh only: it never installs anew, never
 * touches a skill that isn't ours, and never replaces a dev skill.
 */
export function refreshInstalledSkills(ctx: SetupContext): string[] {
  if ((ctx.env ?? process.env).ENV === 'development') return []
  let content: string
  try {
    content = packagedSkill(ctx)
  } catch {
    return []
  }
  const refreshed: string[] = []
  for (const target of [
    join(ctx.homeDir, '.claude', 'skills', 'diffo', 'SKILL.md'),
    join(ctx.homeDir, '.agents', 'skills', 'diffo', 'SKILL.md'),
  ]) {
    try {
      const existing = readFileSync(target, 'utf-8')
      if (existing === content) continue
      if (!isDiffoSkill(existing)) continue
      if (existing.includes(DEV_SKILL_MARKER)) continue
      writeFileSync(target, content)
      refreshed.push(target)
    } catch {
      // absent or unreadable — a refresh installs nothing
    }
  }
  return refreshed
}

function registerCursor(ctx: SetupContext): SetupOutcome {
  const home = ctx.homeDir
  const platform = ctx.platform ?? process.platform
  const client = 'cursor'
  if (!existsSync(join(home, '.cursor'))) {
    return { client, status: 'absent', detail: 'no ~/.cursor directory found' }
  }
  const localPlugins = join(home, '.cursor', 'plugins', 'local')
  const target = join(localPlugins, pluginName(ctx.packageRoot))

  // On Windows a directory symlink needs a privilege an ordinary account lacks; a
  // junction does not. Try the junction first there.
  const link = (to: string, at: string) =>
    symlinkSync(to, at, platform === 'win32' ? 'junction' : 'dir')

  let existing = null
  try {
    existing = lstatSync(target)
  } catch {
    // absent: fall through to a fresh link
  }

  if (existing && !existing.isSymbolicLink()) {
    return {
      client,
      status: 'manual',
      detail: `${collapse(target, home)} exists and is not a symlink — remove it and re-run \`diffo setup\``,
    }
  }
  if (existing) {
    if (resolve(readlinkSync(target)) === ctx.packageRoot) {
      return { client, status: 'current', detail: collapse(target, home) }
    }
    // Repair a stale link (the package moved — e.g. an npx cache eviction).
    const replacement = `${target}.${process.pid}.tmp`
    try {
      link(ctx.packageRoot, replacement)
      if (platform === 'win32') {
        // Windows cannot rename over an existing directory link.
        rmSync(target, { force: true })
      }
      renameSync(replacement, target)
    } catch (error) {
      rmSync(replacement, { force: true })
      return {
        client,
        status: 'manual',
        detail: `cannot link ${collapse(target, home)} (${(error as Error).message}) — link it to ${ctx.packageRoot} manually`,
      }
    }
    return { client, status: 'registered', detail: collapse(target, home) }
  }

  mkdirSync(localPlugins, { recursive: true })
  try {
    link(ctx.packageRoot, target)
  } catch (error) {
    return {
      client,
      status: 'manual',
      detail: `cannot link ${collapse(target, home)} (${(error as Error).message}) — link it to ${ctx.packageRoot} manually`,
    }
  }
  return { client, status: 'registered', detail: collapse(target, home) }
}

export function vsCodeSettingsFile(
  env: NodeJS.ProcessEnv,
  homeDir: string,
  platform: NodeJS.Platform,
): string {
  if (platform === 'win32') {
    return join(env.APPDATA || join(homeDir, 'AppData', 'Roaming'), 'Code', 'User', 'settings.json')
  }
  if (platform === 'darwin') {
    return join(homeDir, 'Library', 'Application Support', 'Code', 'User', 'settings.json')
  }
  return join(env.XDG_CONFIG_HOME || join(homeDir, '.config'), 'Code', 'User', 'settings.json')
}

export function updatePluginLocations(
  settings: Record<string, unknown>,
  packageRoot: string,
  name: string,
): [Record<string, unknown>, boolean] {
  const updated = structuredClone(settings)
  const existing = updated['chat.pluginLocations']
  const locations: Record<string, unknown> =
    existing && typeof existing === 'object' && !Array.isArray(existing)
      ? { ...(existing as Record<string, unknown>) }
      : {}
  let changed = false
  for (const key of Object.keys(locations)) {
    if (key === packageRoot) continue
    let stale = false
    try {
      const manifest = JSON.parse(readFileSync(join(key, 'plugin.json'), 'utf-8')) as {
        name?: string
      }
      stale = manifest.name === name
    } catch {
      stale = !existsSync(key) && basename(key) === name
    }
    if (stale) {
      delete locations[key]
      changed = true
    }
  }
  if (locations[packageRoot] !== true) {
    locations[packageRoot] = true
    changed = true
  }
  updated['chat.pluginLocations'] = locations
  return [updated, changed]
}

function registerVsCode(ctx: SetupContext): SetupOutcome {
  const home = ctx.homeDir
  const client = 'vscode'
  const settingsFile = vsCodeSettingsFile(
    ctx.env ?? process.env,
    home,
    ctx.platform ?? process.platform,
  )
  const hasFile = existsSync(settingsFile)
  if (!hasFile && !existsSync(dirname(settingsFile))) {
    return { client, status: 'absent', detail: 'no VS Code user configuration found' }
  }

  let settings: Record<string, unknown> = {}
  if (hasFile) {
    try {
      settings = JSON.parse(readFileSync(settingsFile, 'utf-8')) as Record<string, unknown>
    } catch {
      // VS Code settings may legally contain comments or trailing commas. Rewriting a
      // file we cannot faithfully parse would destroy the user's configuration.
      return {
        client,
        status: 'manual',
        detail: `add "chat.plugins.enabled": true and "chat.pluginLocations": {"${ctx.packageRoot}": true} to ${collapse(settingsFile, home)}`,
      }
    }
  }

  const [updated, locationsChanged] = updatePluginLocations(
    settings,
    ctx.packageRoot,
    pluginName(ctx.packageRoot),
  )
  // Locations do nothing while the plugins preview feature is off. Turn it on
  // only when unset — an explicit false is the user's call and stays.
  let changed = locationsChanged
  if (!('chat.plugins.enabled' in updated)) {
    updated['chat.plugins.enabled'] = true
    changed = true
  }
  if (!changed) return { client, status: 'current', detail: collapse(settingsFile, home) }
  try {
    writeFileSync(settingsFile, `${JSON.stringify(updated, null, 2)}\n`)
  } catch (error) {
    return { client, status: 'failed', detail: (error as Error).message }
  }
  return { client, status: 'registered', detail: collapse(settingsFile, home) }
}

function registerCopilot(ctx: SetupContext): SetupOutcome {
  const client = 'copilot'
  const run =
    ctx.run ??
    ((command: string, args: string[]) => spawnSync(command, args, { encoding: 'utf-8' }))
  const listed = run('copilot', [
    'plugins',
    'list',
    '--scope',
    'user',
    '--kind',
    'plugin',
    '--json',
  ])
  if (listed.error) {
    return { client, status: 'absent', detail: 'copilot CLI not found on PATH' }
  }
  const name = pluginName(ctx.packageRoot)
  if (listed.status === 0) {
    try {
      const parsed = JSON.parse(listed.stdout) as unknown
      const records = Array.isArray(parsed)
        ? parsed
        : Array.isArray((parsed as { plugins?: unknown[] })?.plugins)
          ? (parsed as { plugins: unknown[] }).plugins
          : []
      const ours = records.find(
        (r) =>
          typeof r === 'object' &&
          r !== null &&
          (r as { name?: string }).name === name &&
          resolve(
            String(
              (r as { source?: string; path?: string }).source ??
                (r as { path?: string }).path ??
                '',
            ),
          ) === ctx.packageRoot,
      )
      if (ours) return { client, status: 'current', detail: collapse(ctx.packageRoot, ctx.homeDir) }
    } catch {
      // unparseable list — fall through and let install decide
    }
  }
  const installed = run('copilot', ['plugin', 'install', ctx.packageRoot])
  if (installed.status !== 0) {
    const detail = String(installed.stderr || installed.stdout || `exit ${installed.status}`).trim()
    return { client, status: 'failed', detail: detail.split('\n')[0] ?? 'plugin install failed' }
  }
  return { client, status: 'registered', detail: 'copilot plugin install' }
}

export function runSetup(ctx: SetupContext): SetupOutcome[] {
  return [
    registerSkillsDir(ctx),
    registerAgentsDir(ctx),
    registerCursor(ctx),
    registerVsCode(ctx),
    registerCopilot(ctx),
  ]
}
