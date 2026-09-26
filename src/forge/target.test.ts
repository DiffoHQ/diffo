import { describe, expect, it } from 'vitest'
import { parseRemoteUrl, parseTarget, prUrl } from './target.js'

const ORIGIN = 'git@github.com-personal:DiffoHQ/diffo.git'

describe('parseRemoteUrl', () => {
  it('reads scp-style ssh remotes and folds ssh aliases into github.com', () => {
    expect(parseRemoteUrl(ORIGIN)).toEqual({ host: 'github.com', owner: 'DiffoHQ', repo: 'diffo' })
    expect(parseRemoteUrl('git@github.com:acme/widgets.git')).toEqual({
      host: 'github.com',
      owner: 'acme',
      repo: 'widgets',
    })
  })

  it('reads https and ssh:// remotes, with or without .git', () => {
    expect(parseRemoteUrl('https://github.com/acme/widgets')).toEqual({
      host: 'github.com',
      owner: 'acme',
      repo: 'widgets',
    })
    expect(parseRemoteUrl('ssh://git@ghe.example.com/acme/widgets.git')).toEqual({
      host: 'ghe.example.com',
      owner: 'acme',
      repo: 'widgets',
    })
  })

  it('rejects things that are not a repo URL', () => {
    expect(parseRemoteUrl('/local/path')).toBeNull()
    expect(parseRemoteUrl('https://github.com/acme')).toBeNull()
  })
})

describe('parseTarget', () => {
  it('takes a full pull request URL, trailing paths included', () => {
    const parsed = parseTarget('https://github.com/acme/widgets/pull/482/files?diff=split', null)
    expect(parsed).toEqual({
      ok: true,
      target: {
        kind: 'pr',
        ref: { host: 'github.com', owner: 'acme', repo: 'widgets', number: 482 },
      },
    })
  })

  it('takes owner/repo#N, resolving the host from origin', () => {
    const parsed = parseTarget('acme/widgets#7', 'https://ghe.example.com/x/y.git')
    expect(parsed.ok && parsed.target.kind === 'pr' && parsed.target.ref).toEqual({
      host: 'ghe.example.com',
      owner: 'acme',
      repo: 'widgets',
      number: 7,
    })
  })

  it('takes #N and a bare number against origin', () => {
    for (const raw of ['#482', '482']) {
      const parsed = parseTarget(raw, ORIGIN)
      expect(parsed.ok && parsed.target.kind === 'pr' && parsed.target.ref).toEqual({
        host: 'github.com',
        owner: 'DiffoHQ',
        repo: 'diffo',
        number: 482,
      })
    }
  })

  it('refuses a bare number with no origin to resolve it on', () => {
    const parsed = parseTarget('482', null)
    expect(parsed.ok).toBe(false)
    if (!parsed.ok) expect(parsed.error).toMatch(/full URL/)
  })

  it('refuses a URL that is not a pull request rather than reviewing the working tree', () => {
    for (const raw of [
      'https://github.com/acme/widgets',
      'https://github.com/acme/widgets/issues/4',
    ]) {
      const parsed = parseTarget(raw, ORIGIN)
      expect(parsed.ok).toBe(false)
      if (!parsed.ok) expect(parsed.error).toMatch(/not a pull request.*\/pull\/482/)
    }
  })

  it('treats anything else as a branch', () => {
    expect(parseTarget('main', ORIGIN)).toEqual({
      ok: true,
      target: { kind: 'branch', base: 'main' },
    })
    expect(parseTarget('feature/x-1', null)).toEqual({
      ok: true,
      target: { kind: 'branch', base: 'feature/x-1' },
    })
  })

  it('builds the canonical URL back', () => {
    expect(prUrl({ host: 'github.com', owner: 'acme', repo: 'widgets', number: 482 })).toBe(
      'https://github.com/acme/widgets/pull/482',
    )
  })
})
