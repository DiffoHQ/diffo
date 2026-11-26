import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it } from 'vitest'
import {
  forgetRemoteConfig,
  RemoteConfigError,
  readKeyInput,
  readRemoteConfig,
  relayKeyProblem,
  remoteConfigPath,
  resolveRelay,
  writeRemoteConfig,
} from './config.js'

const KEY = 'k3y-0123456789abcdefABCDEF_xyz'
const POSIX = process.platform !== 'win32'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'diffo-remote-config-'))
  dirs.push(dir)
  return dir
}

/** A file written by hand, 0600, as if by an older or foreign writer. */
function plant(path: string, text: string): void {
  writeFileSync(path, text, { mode: 0o600 })
  if (POSIX) chmodSync(path, 0o600)
}

/** The error's message, which must never hold the key. */
function refusal(fn: () => unknown): string {
  try {
    fn()
  } catch (err) {
    expect(err).toBeInstanceOf(RemoteConfigError)
    const message = (err as Error).message
    expect(message).not.toContain(KEY)
    expect(String((err as Error).stack)).not.toContain(KEY)
    return message
  }
  throw new Error('expected a refusal')
}

describe('remoteConfigPath', () => {
  it('sits next to the database, so $DIFFO_DB moves it too', () => {
    expect(remoteConfigPath('/x/y/diffo.db')).toBe(join('/x/y', 'remote.json'))
  })
})

describe('writeRemoteConfig / readRemoteConfig', () => {
  it('round-trips the pair, normalized', () => {
    const path = join(tempDir(), 'remote.json')
    writeRemoteConfig({ relay: 'https://relay.example/', key: KEY }, path)
    expect(readRemoteConfig(path)).toEqual({ relay: 'https://relay.example', key: KEY })
  })

  it('is null when nothing is stored', () => {
    expect(readRemoteConfig(join(tempDir(), 'remote.json'))).toBeNull()
  })

  it.skipIf(!POSIX)('writes the file 0600, and a directory it creates 0700', () => {
    const dir = join(tempDir(), 'fresh')
    const path = join(dir, 'remote.json')
    writeRemoteConfig({ relay: 'https://relay.example', key: KEY }, path)
    expect(statSync(path).mode & 0o777).toBe(0o600)
    expect(statSync(dir).mode & 0o777).toBe(0o700)
  })

  it.skipIf(!POSIX)('leaves an existing directory as its owner set it', () => {
    const dir = tempDir()
    chmodSync(dir, 0o750)
    writeRemoteConfig({ relay: 'https://relay.example', key: KEY }, join(dir, 'remote.json'))
    expect(statSync(dir).mode & 0o777).toBe(0o750)
  })

  it('replaces atomically and leaves no temp file behind', () => {
    const dir = tempDir()
    const path = join(dir, 'remote.json')
    writeRemoteConfig({ relay: 'https://one.example', key: KEY }, path)
    writeRemoteConfig({ relay: 'https://two.example', key: `${KEY}2` }, path)
    expect(readRemoteConfig(path)).toEqual({ relay: 'https://two.example', key: `${KEY}2` })
    expect(readdirSync(dir)).toEqual(['remote.json'])
  })

  it('leaves no temp file when the write fails', () => {
    const dir = tempDir()
    const path = join(dir, 'remote.json')
    mkdirSync(path) // a directory in the way: the rename fails
    refusal(() => writeRemoteConfig({ relay: 'https://relay.example', key: KEY }, path))
    expect(readdirSync(dir)).toEqual(['remote.json'])
  })

  it.skipIf(!POSIX)('replaces a symlink at the path rather than writing through it', () => {
    const dir = tempDir()
    const target = join(dir, 'elsewhere')
    plant(target, 'untouched')
    const path = join(dir, 'remote.json')
    symlinkSync(target, path)
    writeRemoteConfig({ relay: 'https://relay.example', key: KEY }, path)
    expect(readRemoteConfig(path)?.key).toBe(KEY)
    expect(statSync(target).size).toBe('untouched'.length)
  })

  it('refuses an invalid relay or key, and writes nothing', () => {
    const dir = tempDir()
    const path = join(dir, 'remote.json')
    for (const relay of ['http://relay.example', 'https://relay.example/path', 'not a url']) {
      refusal(() => writeRemoteConfig({ relay, key: KEY }, path))
    }
    for (const key of ['short', `${KEY} ${KEY}`, `${KEY}\n`, 'x'.repeat(1025), `${KEY}\u001b[A`]) {
      expect(() => writeRemoteConfig({ relay: 'https://relay.example', key }, path)).toThrow(
        RemoteConfigError,
      )
    }
    expect(readdirSync(dir)).toEqual([])
  })

  it.skipIf(!POSIX)('refuses a file other users can read or write, saying how to fix it', () => {
    const path = join(tempDir(), 'remote.json')
    writeRemoteConfig({ relay: 'https://relay.example', key: KEY }, path)
    for (const mode of [0o640, 0o604, 0o620, 0o602, 0o644]) {
      chmodSync(path, mode)
      expect(refusal(() => readRemoteConfig(path))).toContain(`chmod 600 ${path}`)
    }
    chmodSync(path, 0o600)
    expect(readRemoteConfig(path)?.key).toBe(KEY)
  })

  it.skipIf(!POSIX)('refuses a symlink, even to a good file', () => {
    const dir = tempDir()
    const real = join(dir, 'real.json')
    writeRemoteConfig({ relay: 'https://relay.example', key: KEY }, real)
    const path = join(dir, 'remote.json')
    symlinkSync(real, path)
    expect(refusal(() => readRemoteConfig(path))).toMatch(/symlink/)
  })

  it('refuses malformed files and wrong shapes, never quoting them', () => {
    const path = join(tempDir(), 'remote.json')
    const bad = [
      `{"relay":"https://relay.example","key":"${KEY}"`, // truncated
      `${KEY}`,
      `["https://relay.example","${KEY}"]`,
      'null',
      `{"relay":"https://relay.example"}`,
      `{"key":"${KEY}"}`,
      `{"relay":"https://relay.example","key":42}`,
      `{"relay":"https://relay.example","key":"${KEY}","extra":true}`,
      `{"relay":"http://relay.example","key":"${KEY}"}`,
      `{"relay":"https://relay.example","key":"${KEY} more"}`,
      `{"relay":"https://relay.example","key":"short"}`,
    ]
    for (const text of bad) {
      plant(path, text)
      refusal(() => readRemoteConfig(path))
    }
  })
})

describe('forgetRemoteConfig', () => {
  it('deletes the stored pair, and says when there was none', () => {
    const path = join(tempDir(), 'remote.json')
    writeRemoteConfig({ relay: 'https://relay.example', key: KEY }, path)
    expect(forgetRemoteConfig(path)).toBe(true)
    expect(existsSync(path)).toBe(false)
    expect(forgetRemoteConfig(path)).toBe(false)
  })
})

describe('relayKeyProblem', () => {
  it('takes 16..1024 visible characters, nothing else', () => {
    expect(relayKeyProblem('a'.repeat(16))).toBeNull()
    expect(relayKeyProblem('a'.repeat(1024))).toBeNull()
    expect(relayKeyProblem('a'.repeat(15))).not.toBeNull()
    expect(relayKeyProblem('a'.repeat(1025))).not.toBeNull()
    expect(relayKeyProblem(`${'a'.repeat(16)}\t`)).not.toBeNull()
  })
})

describe('resolveRelay', () => {
  const stored = { relay: 'https://stored.example', key: KEY }
  const env = (vars: Record<string, string>) => vars as NodeJS.ProcessEnv

  it('takes the environment pair first, without reading the stored one', () => {
    const resolved = resolveRelay(
      env({ DIFFO_RELAY_URL: 'https://env.example/', DIFFO_RELAY_KEY: 'env-key' }),
      () => {
        throw new Error('must not be read')
      },
    )
    expect(resolved).toEqual({ relay: 'https://env.example', key: 'env-key', source: 'env' })
  })

  it('uses the stored pair when the environment has neither', () => {
    expect(resolveRelay(env({}), () => stored)).toEqual({ ...stored, source: 'setup' })
    expect(resolveRelay(env({ DIFFO_RELAY_URL: ' ', DIFFO_RELAY_KEY: '' }), () => stored)).toEqual({
      ...stored,
      source: 'setup',
    })
  })

  it('is null when nothing is configured', () => {
    expect(resolveRelay(env({}), () => null)).toBeNull()
  })

  it('refuses half an environment pair, naming the missing half, never pairing it with the stored', () => {
    expect(
      refusal(() => resolveRelay(env({ DIFFO_RELAY_URL: 'https://evil.example' }), () => stored)),
    ).toMatch(/\$DIFFO_RELAY_KEY is not/)
    expect(refusal(() => resolveRelay(env({ DIFFO_RELAY_KEY: 'k' }), () => stored))).toMatch(
      /\$DIFFO_RELAY_URL is not/,
    )
  })

  it('refuses an environment relay that is not one', () => {
    refusal(() =>
      resolveRelay(
        env({ DIFFO_RELAY_URL: 'http://evil.example', DIFFO_RELAY_KEY: 'k' }),
        () => stored,
      ),
    )
  })

  it('passes a stored config refusal through', () => {
    const path = join(tempDir(), 'remote.json')
    plant(path, 'garbage')
    refusal(() => resolveRelay(env({}), () => readRemoteConfig(path)))
  })
})

describe('readKeyInput', () => {
  it('reads a piped key, trimming the trailing newline', async () => {
    const input = new PassThrough()
    input.end(`${KEY}\n`)
    expect(await readKeyInput(input, new PassThrough())).toBe(KEY)
  })

  it('reads nothing as an empty key', async () => {
    const input = new PassThrough()
    input.end('')
    expect(await readKeyInput(input, new PassThrough())).toBe('')
  })

  it('refuses an endless stdin without holding it all', async () => {
    const input = new PassThrough()
    input.end('x'.repeat(64 * 1024))
    await expect(readKeyInput(input, new PassThrough())).rejects.toThrow(RemoteConfigError)
  })

  it('prompts on a terminal with echo off, and never writes the key back', async () => {
    const input = Object.assign(new PassThrough(), {
      isTTY: true,
      raw: [] as boolean[],
      setRawMode(this: { raw: boolean[] }, on: boolean) {
        this.raw.push(on)
      },
    })
    let shown = ''
    const prompt = new PassThrough()
    prompt.on('data', (d: Buffer) => (shown += d.toString()))
    const pending = readKeyInput(input, prompt)
    // A paste wrapped in bracketed-paste markers, a typo fixed with backspace, then Enter.
    input.write(`\u001b[200~${KEY}x\u001b[201~`)
    input.write('\u007f\r')
    expect(await pending).toBe(KEY)
    expect(input.raw).toEqual([true, false])
    expect(shown).toMatch(/access key/)
    expect(shown).not.toContain(KEY)
  })

  it('cancels on Ctrl-C', async () => {
    const input = Object.assign(new PassThrough(), { isTTY: true, setRawMode() {} })
    const pending = readKeyInput(input, new PassThrough())
    input.write('abc\u0003')
    await expect(pending).rejects.toThrow(/cancelled/)
  })
})
