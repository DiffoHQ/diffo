import { execFileSync } from 'node:child_process'

export interface AncestorRow {
  pid: number
  ppid: number
  command: string
}

/** A row whose leading token is a shell is never the session. Tested on the FIRST
 * token only: under Claude Code the transient `zsh -c` carries
 * `~/.claude/shell-snapshots/…` in its arguments, which would match HARNESS. */
const SHELL = /^-?(?:\/[^ ]*\/)?(?:sh|bash|zsh|fish|dash|ksh|csh|tcsh)(?:\s|$)/

/** The coding agents whose processes the ancestor walk recognises. Also the
 * vocabulary of the `agent` field in usage data, so a name never travels unless
 * it is on this list. */
export const HARNESS_NAMES = [
  'claude',
  'cursor',
  'codex',
  'copilot',
  'windsurf',
  'zed',
  'aider',
  'goose',
  'cline',
  'amp',
] as const
export type HarnessName = (typeof HARNESS_NAMES)[number]

/** A harness name at the start of a path segment or token, never inside a word:
 * `/Users/sam/example/` must not read as `amp`. */
const HARNESS = new RegExp(`(?:^|[/\\s@_.-])(${HARNESS_NAMES.join('|')})`, 'i')

/** How this CLI was started: enough to recognise the processes that only exist
 * to run it (a `tsx` or `node` wrapper, `npx`, `pnpm dlx`). They sit between the
 * CLI and the harness, die with the CLI, and carry its arguments — so a repo
 * path with a harness word in it (`.claude/worktrees/…`) would make one of them
 * pass for the session, and the server would then see the session die the
 * moment `diffo poll` returned. */
export interface OwnInvocation {
  script: string
  args: string[]
}

function ownInvocation(): OwnInvocation {
  return { script: process.argv[1] ?? '', args: process.argv.slice(2) }
}

const PACKAGE = /@diffohq\/diffo(?:[@\s]|$)/

function isOwnLauncher(command: string, own: OwnInvocation): boolean {
  if (PACKAGE.test(command)) return true
  if (own.script === '') return false
  // With arguments, the wrapper ends in the script's basename plus the same
  // arguments, whatever path form it used. Without, only the exact script path
  // is safe: a bare `cli.js` would also match a harness installed from npm.
  const base = own.script.slice(own.script.lastIndexOf('/') + 1)
  const tail = own.args.length > 0 ? `${base} ${own.args.join(' ')}` : own.script
  return command === tail || command.endsWith(` ${tail}`) || command.endsWith(`/${tail}`)
}

function pickSession(
  ancestors: AncestorRow[],
  own: OwnInvocation,
): { pid: number; harness: HarnessName } | null {
  for (const row of ancestors) {
    const command = row.command.trim()
    if (SHELL.test(command)) continue
    if (isOwnLauncher(command, own)) continue
    const match = HARNESS.exec(command)
    if (match) return { pid: row.pid, harness: match[1]!.toLowerCase() as HarnessName }
  }
  return null
}

export function pickSessionAncestor(
  ancestors: AncestorRow[],
  own: OwnInvocation = ownInvocation(),
): number | null {
  return pickSession(ancestors, own)?.pid ?? null
}

/** Which agent the session is, by the same walk that finds it. */
export function pickSessionHarness(
  ancestors: AncestorRow[],
  own: OwnInvocation = ownInvocation(),
): HarnessName | null {
  return pickSession(ancestors, own)?.harness ?? null
}

function readRow(pid: number): AncestorRow | null {
  try {
    const ppid = Number.parseInt(
      execFileSync('ps', ['-o', 'ppid=', '-p', String(pid)], { encoding: 'utf-8' }).trim(),
      10,
    )
    const command = execFileSync('ps', ['-o', 'command=', '-p', String(pid)], {
      encoding: 'utf-8',
    }).trim()
    if (!Number.isFinite(ppid) || command === '') return null
    return { pid, ppid, command }
  } catch {
    return null
  }
}

export function readAncestors(
  startPid: number,
  rowFor: (pid: number) => AncestorRow | null = readRow,
  maxDepth = 12,
): AncestorRow[] {
  const rows: AncestorRow[] = []
  let pid = startPid
  for (let depth = 0; depth < maxDepth && pid > 1; depth++) {
    const row = rowFor(pid)
    if (!row) break
    rows.push(row)
    if (row.ppid === pid) break
    pid = row.ppid
  }
  return rows
}

export function detectSessionPid(): number | null {
  if (process.platform === 'win32') return null
  try {
    return pickSessionAncestor(readAncestors(process.ppid))
  } catch {
    return null
  }
}

/** The agent this CLI runs under, or null from a plain terminal (and on Windows,
 * where the walk is not available). Only ever a name from HARNESS_NAMES. */
export function detectHarness(): HarnessName | null {
  if (process.platform === 'win32') return null
  try {
    return pickSessionHarness(readAncestors(process.ppid))
  } catch {
    return null
  }
}
