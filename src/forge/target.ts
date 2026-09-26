import type { PrRef } from './types.js'

// What `diffo <target>` means. A target is a branch to review against, or a
// pull request in one of four spellings. The CLI decides which; the skill only
// passes the reviewer's words through.

export type Target = { kind: 'branch'; base: string } | { kind: 'pr'; ref: PrRef }

export type TargetParse = { ok: true; target: Target } | { ok: false; error: string }

/** The repo a remote URL names, in the forms git actually writes. */
export function parseRemoteUrl(url: string): { host: string; owner: string; repo: string } | null {
  const trimmed = url.trim()
  // git@host:owner/repo(.git) — an ssh alias like `github.com-work` still means github.com.
  const scp = /^[\w.-]+@([\w.-]+):([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(trimmed)
  if (scp) return { host: canonicalHost(scp[1]!), owner: scp[2]!, repo: scp[3]! }
  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    return null
  }
  if (!['https:', 'http:', 'ssh:', 'git:'].includes(parsed.protocol)) return null
  const parts = parsed.pathname.split('/').filter(Boolean)
  if (parts.length < 2) return null
  const owner = parts[0]!
  const repo = parts[1]!.replace(/\.git$/, '')
  if (!owner || !repo) return null
  return { host: canonicalHost(parsed.hostname), owner, repo }
}

/** `github.com-personal` and friends are ssh config aliases for github.com. */
function canonicalHost(host: string): string {
  const lower = host.toLowerCase()
  return lower.startsWith('github.com') ? 'github.com' : lower
}

const PR_URL = /^https?:\/\/([^/]+)\/([^/]+)\/([^/]+)\/pull\/(\d+)(?:[/?#].*)?$/i
const OWNER_REPO_NUMBER = /^([\w.-]+)\/([\w.-]+)#(\d+)$/
const HASH_NUMBER = /^#?(\d+)$/

/**
 * `origin` is the URL of the cwd's `origin` remote, or null when there is none.
 * The short forms (`#482`, `482`, `owner/repo#482` without a host) resolve
 * against it; a full URL never needs it.
 */
export function parseTarget(raw: string, origin: string | null): TargetParse {
  const text = raw.trim()
  if (text === '') return { ok: false, error: 'the target is empty' }
  const url = PR_URL.exec(text)
  if (url) {
    const number = Number.parseInt(url[4]!, 10)
    return {
      ok: true,
      target: {
        kind: 'pr',
        ref: { host: url[1]!.toLowerCase(), owner: url[2]!, repo: url[3]!, number },
      },
    }
  }
  // Any other URL is a mistake, never a branch: `diffo https://github.com/o/r`
  // would otherwise quietly review the working tree.
  if (/^https?:\/\//i.test(text)) {
    return {
      ok: false,
      error: `'${text}' is a URL but not a pull request; pass a link like https://github.com/owner/repo/pull/482`,
    }
  }
  const remote = origin === null ? null : parseRemoteUrl(origin)
  const ownerRepo = OWNER_REPO_NUMBER.exec(text)
  if (ownerRepo) {
    return {
      ok: true,
      target: {
        kind: 'pr',
        ref: {
          host: remote?.host ?? 'github.com',
          owner: ownerRepo[1]!,
          repo: ownerRepo[2]!,
          number: Number.parseInt(ownerRepo[3]!, 10),
        },
      },
    }
  }
  const short = HASH_NUMBER.exec(text)
  if (short) {
    if (!remote) {
      return {
        ok: false,
        error: `'${text}' names a pull request by number, but this repo has no GitHub origin to look it up on; pass the full URL`,
      }
    }
    return {
      ok: true,
      target: { kind: 'pr', ref: { ...remote, number: Number.parseInt(short[1]!, 10) } },
    }
  }
  return { ok: true, target: { kind: 'branch', base: text } }
}

/** A target as a full URL, for logs and the header link. */
export function prUrl(ref: PrRef): string {
  return `https://${ref.host}/${ref.owner}/${ref.repo}/pull/${ref.number}`
}
