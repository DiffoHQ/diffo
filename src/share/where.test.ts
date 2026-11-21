import { describe, expect, it, vi } from 'vitest'
import type { AuthStatus } from '../forge/types.js'
import { SHARE_RECHECK_MS, shareCheck } from './where.js'

const signedIn = (hosts: string[]) => ({
  authStatus: vi.fn(
    async (host: string): Promise<AuthStatus> =>
      hosts.includes(host) ? { ok: true, login: 'mira-k' } : { ok: false, message: 'no' },
  ),
})

describe('can this repo share its layers?', () => {
  it('yes for a GitHub origin gh is signed in to, ssh or https', async () => {
    const forge = signedIn(['github.com', 'git.acme.dev'])
    expect(await shareCheck(() => 'git@github.com:acme/widgets.git', forge)()).toBe(true)
    expect(await shareCheck(() => 'git@github.com-personal:acme/w.git', forge)()).toBe(true)
    expect(await shareCheck(() => 'https://git.acme.dev/acme/widgets', forge)()).toBe(true)
  })

  it('no for Bitbucket or GitLab, no origin, or gh signed out', async () => {
    const forge = signedIn(['github.com'])
    expect(await shareCheck(() => 'git@bitbucket.org:acme/widgets.git', forge)()).toBe(false)
    expect(await shareCheck(() => 'https://gitlab.com/acme/widgets.git', forge)()).toBe(false)
    expect(await shareCheck(() => null, forge)()).toBe(false)
    expect(await shareCheck(() => 'git@github.com:acme/w.git', signedIn([]))()).toBe(false)
  })

  it('asks gh once for a yes, and again for a no only after a while', async () => {
    const yes = signedIn(['github.com'])
    const check = shareCheck(() => 'git@github.com:acme/w.git', yes)
    await Promise.all([check(), check()])
    await check()
    expect(yes.authStatus).toHaveBeenCalledTimes(1)

    let t = 0
    const no = signedIn([])
    const later = shareCheck(
      () => 'git@github.com:acme/w.git',
      no,
      () => t,
    )
    await later()
    await later()
    expect(no.authStatus).toHaveBeenCalledTimes(1)
    t += SHARE_RECHECK_MS
    await later()
    expect(no.authStatus).toHaveBeenCalledTimes(2)
  })

  it('a gh that throws is a no, not a crash', async () => {
    const forge = { authStatus: vi.fn(async () => Promise.reject(new Error('boom'))) }
    expect(await shareCheck(() => 'git@github.com:acme/w.git', forge)()).toBe(false)
  })
})
