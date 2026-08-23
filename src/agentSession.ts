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

const HARNESS = /claude|cursor|codex|copilot|windsurf|zed|aider|goose|cline|amp/i

export function pickSessionAncestor(ancestors: AncestorRow[]): number | null {
  for (const row of ancestors) {
    const command = row.command.trim()
    if (SHELL.test(command)) continue
    if (HARNESS.test(command)) return row.pid
  }
  return null
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
