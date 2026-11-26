/**
 * The relay `diffo --remote` dials, stored once by `diffo remote setup` so the
 * user never sees or types the access key: the relay's own setup script
 * generates it and pipes it in. One file, `remote.json`, in the directory that
 * holds Diffo's database (so `$DIFFO_DB` moves it too):
 * `{ "relay": "<origin>", "key": "<key>" }`.
 *
 * The key is a credential. It is written 0600 and atomically, a file anyone
 * else could read or swap is refused rather than used, and no message here
 * ever carries it (nor the file's text, which holds it).
 */
import { randomBytes } from 'node:crypto'
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { defaultDbPath } from '../server/db.js'
import { normalizeRelayUrl } from './tunnel.js'

export interface RemoteConfig {
  relay: string
  key: string
}

/** Where `diffo --remote` got its relay: the environment pair, or the stored setup. */
export type RelaySource = 'env' | 'setup'

/** A refusal whose message is safe to print: it never holds the key. */
export class RemoteConfigError extends Error {}

const KEY_MIN = 16
const KEY_MAX = 1024
// Far over any valid file; a bigger one is not ours, and is not read into memory.
const FILE_MAX = 8 * 1024
// Visible ASCII only: a generated key is base64url, and anything else (a space,
// a control or escape character from a botched paste) is a key that was mangled
// on the way in, better refused than sent.
const KEY_SHAPE = /^[\x21-\x7e]+$/
const POSIX = process.platform !== 'win32'

export function remoteConfigPath(dbPath: string = defaultDbPath()): string {
  return join(dirname(dbPath), 'remote.json')
}

/** Why a key is not one, or null when it is. Never quotes the key. */
export function relayKeyProblem(key: string): string | null {
  if (key.length < KEY_MIN || key.length > KEY_MAX) {
    return `the access key must be ${KEY_MIN} to ${KEY_MAX} characters`
  }
  if (!KEY_SHAPE.test(key)) {
    return 'the access key must be one line of visible characters, with no spaces'
  }
  return null
}

/** The stored config, or null when there is none. Throws RemoteConfigError
 * when there is a file but it cannot be trusted or read as one. */
export function readRemoteConfig(path: string = remoteConfigPath()): RemoteConfig | null {
  let text: string
  try {
    text = readOwnFile(path)
  } catch (err) {
    if (err instanceof RemoteConfigError) throw err
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return null
    // O_NOFOLLOW on a symlink fails with ELOOP (EMLINK on some BSDs).
    if (code === 'ELOOP' || code === 'EMLINK') throw symlinkRefused(path)
    throw new RemoteConfigError(`cannot read ${path} (${code ?? 'unknown error'})`)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    // JSON.parse quotes the text it choked on, and the text holds the key.
    throw malformed(path)
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw malformed(path)
  const fields = parsed as Record<string, unknown>
  const keys = Object.keys(fields).sort()
  if (keys.length !== 2 || keys[0] !== 'key' || keys[1] !== 'relay') throw malformed(path)
  const { relay, key } = fields
  if (typeof relay !== 'string' || typeof key !== 'string') throw malformed(path)
  const origin = normalizeRelayUrl(relay)
  if (!origin) throw new RemoteConfigError(`${path} names no valid relay; ${RERUN}`)
  const problem = relayKeyProblem(key)
  if (problem) throw new RemoteConfigError(`${path}: ${problem}; ${RERUN}`)
  return { relay: origin, key }
}

/** Stores the pair, replacing any earlier one in one step: a reader sees the
 * old file or the new one, never half of either. */
export function writeRemoteConfig(config: RemoteConfig, path: string = remoteConfigPath()): void {
  const relay = normalizeRelayUrl(config.relay)
  if (!relay)
    throw new RemoteConfigError('the relay is not a relay URL (https, or http on localhost)')
  const problem = relayKeyProblem(config.key)
  if (problem) throw new RemoteConfigError(problem)
  const dir = dirname(path)
  const temp = join(dir, `.remote.json.${randomBytes(6).toString('hex')}.tmp`)
  let fd: number | null = null
  try {
    // Only a directory made here gets 0700: an existing one keeps the
    // permissions its owner chose (the file itself is 0600 either way).
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    // `wx` (O_EXCL) never follows or reuses whatever sits at the temp name.
    fd = openSync(temp, 'wx', 0o600)
    // The umask can only narrow 0600, but say it exactly.
    if (POSIX) fchmodSync(fd, 0o600)
    writeSync(fd, `${JSON.stringify({ relay, key: config.key }, null, 2)}\n`)
    fsyncSync(fd)
    closeSync(fd)
    fd = null
    // rename replaces a symlink at `path` itself; it never writes through one.
    renameSync(temp, path)
  } catch (err) {
    if (fd !== null) closeSync(fd)
    try {
      unlinkSync(temp)
    } catch {
      // never created, or already renamed
    }
    if (err instanceof RemoteConfigError) throw err
    const code = (err as NodeJS.ErrnoException).code
    throw new RemoteConfigError(`cannot write ${path} (${code ?? 'unknown error'})`)
  }
}

/** Deletes the stored config; false when there was none. */
export function forgetRemoteConfig(path: string = remoteConfigPath()): boolean {
  try {
    // unlink removes a symlink itself, never its target.
    unlinkSync(path)
    return true
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return false
    throw new RemoteConfigError(`cannot delete ${path} (${code ?? 'unknown error'})`)
  }
}

/**
 * The relay and key `diffo --remote` uses, or null when none is configured.
 * The environment pair wins, and only as a pair: half of it is an error, never
 * completed from the stored file, so the stored key only ever goes to the
 * stored relay. Throws RemoteConfigError with a printable reason.
 */
export function resolveRelay(
  env: NodeJS.ProcessEnv = process.env,
  readStored: () => RemoteConfig | null = () => readRemoteConfig(),
): (RemoteConfig & { source: RelaySource }) | null {
  const url = env.DIFFO_RELAY_URL?.trim() ?? ''
  const key = env.DIFFO_RELAY_KEY?.trim() ?? ''
  if (url && key) {
    const relay = normalizeRelayUrl(url)
    if (!relay) {
      throw new RemoteConfigError(
        '$DIFFO_RELAY_URL is not a relay URL (https, or http on localhost)',
      )
    }
    return { relay, key, source: 'env' }
  }
  if (url)
    throw new RemoteConfigError(
      '$DIFFO_RELAY_URL is set but $DIFFO_RELAY_KEY is not; set both, or neither',
    )
  if (key)
    throw new RemoteConfigError(
      '$DIFFO_RELAY_KEY is set but $DIFFO_RELAY_URL is not; set both, or neither',
    )
  const stored = readStored()
  return stored ? { ...stored, source: 'setup' } : null
}

/** The key `diffo remote setup` stores: piped in (one line, trimmed), or typed
 * at a prompt with echo off when stdin is a terminal. */
export async function readKeyInput(
  input: NodeJS.ReadableStream & { isTTY?: boolean; setRawMode?: (raw: boolean) => unknown },
  prompt: NodeJS.WritableStream,
): Promise<string> {
  if (input.isTTY && input.setRawMode) return (await readHidden(input, prompt)).trim()
  let text = ''
  for await (const chunk of input) {
    text += typeof chunk === 'string' ? chunk : (chunk as Buffer).toString('utf8')
    if (text.length > FILE_MAX) throw new RemoteConfigError('the access key on stdin is too long')
  }
  return text.trim()
}

function readHidden(
  input: NodeJS.ReadableStream & { setRawMode?: (raw: boolean) => unknown },
  prompt: NodeJS.WritableStream,
): Promise<string> {
  prompt.write('relay access key (input hidden): ')
  return new Promise((resolve, reject) => {
    let line = ''
    const finish = (err?: Error) => {
      input.removeListener('data', onData)
      input.setRawMode?.(false)
      input.pause()
      prompt.write('\n')
      if (err) reject(err)
      else resolve(line)
    }
    const onData = (chunk: Buffer | string) => {
      // A terminal still in bracketed-paste mode wraps a paste in markers.
      const text = chunk.toString().replaceAll('\u001b[200~', '').replaceAll('\u001b[201~', '')
      for (const ch of text) {
        if (ch === '\r' || ch === '\n') return finish()
        if (ch === '\u0003' || (ch === '\u0004' && line === '')) {
          return finish(new RemoteConfigError('cancelled; nothing stored'))
        }
        if (ch === '\u0004') return finish()
        if (ch === '\u007f' || ch === '\b') line = line.slice(0, -1)
        else line += ch
        if (line.length > FILE_MAX) {
          return finish(new RemoteConfigError('the access key is too long'))
        }
      }
    }
    input.setRawMode?.(true)
    input.on('data', onData)
    input.resume()
  })
}

const RERUN = "re-run your relay's setup, or `diffo remote forget`"

const malformed = (path: string) =>
  new RemoteConfigError(`${path} is not a remote config Diffo wrote; ${RERUN}`)

const symlinkRefused = (path: string) =>
  new RemoteConfigError(`${path} is a symlink, so it is not used; ${RERUN}`)

/**
 * The file's text, only if it is a plain file of this user's that no one else
 * can read or write. On POSIX the checks run on the opened descriptor, so a
 * file swapped in after a check is never the one read.
 */
function readOwnFile(path: string): string {
  if (!POSIX) {
    // No O_NOFOLLOW, and no POSIX mode bits worth checking.
    if (lstatSync(path).isSymbolicLink()) throw symlinkRefused(path)
    return readFileSync(path, 'utf8')
  }
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const stat = fstatSync(fd)
    if (!stat.isFile()) throw malformed(path)
    if (process.getuid && stat.uid !== process.getuid()) {
      throw new RemoteConfigError(`${path} belongs to another user, so it is not used; ${RERUN}`)
    }
    if ((stat.mode & 0o077) !== 0) {
      throw new RemoteConfigError(
        `${path} can be read or changed by other users, so it is not used; run \`chmod 600 ${path}\`, then re-run`,
      )
    }
    if (stat.size > FILE_MAX) throw malformed(path)
    return readFileSync(fd, 'utf8')
  } finally {
    closeSync(fd)
  }
}
