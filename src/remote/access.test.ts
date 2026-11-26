import { describe, expect, it } from 'vitest'
import { relayAllows, relayBodyRefusal } from './access.js'

describe('relayAllows', () => {
  const allowed: [string, string][] = [
    // The page and its assets.
    ['GET', '/'],
    ['GET', '/assets/index.js'],
    ['GET', '/favicon.svg'],
    ['HEAD', '/'],
    // Reads.
    ...[
      '/api/review',
      '/api/events',
      '/api/changeset',
      '/api/commits',
      '/api/commits/0123abcd',
      '/api/file',
      '/api/settings',
      '/api/telemetry',
      '/api/presets',
      '/api/presets/p1/thread',
      '/api/remote',
    ].flatMap((p): [string, string][] => [
      ['GET', p],
      ['HEAD', p],
    ]),
    // The reviewer's writes.
    ['POST', '/api/review/threads'],
    ['POST', '/api/review/threads/t1/messages'],
    ['PATCH', '/api/review/threads/t1/messages/m1'],
    ['POST', '/api/review/threads/t1/messages/m1/pr-comment'],
    ['POST', '/api/review/threads/t1/state'],
    ['POST', '/api/review/threads/t1/send'],
    ['DELETE', '/api/review/threads'],
    ['DELETE', '/api/review/threads/t1'],
    ['DELETE', '/api/review/landed'],
    ['POST', '/api/review/finish/preview'],
    ['POST', '/api/review/finish'],
    ['POST', '/api/review/layers/request'],
    ['DELETE', '/api/review/layers'],
    ['PUT', '/api/settings'],
    // Lowercase methods are the same methods.
    ['post', '/api/review/threads'],
  ]

  const denied: [string, string][] = [
    // The agent's role.
    ['GET', '/api/agent/poll'],
    ['POST', '/api/agent/arrive'],
    ['POST', '/api/agent/end'],
    ['GET', '/api/agent/invite'],
    ['POST', '/api/review/layers'],
    ['POST', '/api/presets/p1'],
    // The CLI's, and the machine's.
    ['POST', '/api/remote'],
    ['DELETE', '/api/remote'],
    ['POST', '/api/shutdown'],
    // Reviewer agents: seating one, steering one, and their roles (prompt text
    // kept for every repo) are all the local user's to do.
    ['GET', '/api/reviewer/roles'],
    ['GET', '/api/reviewer/poll'],
    ['GET', '/api/reviewer/invite'],
    ['POST', '/api/reviewer/request'],
    ['POST', '/api/reviewer/message'],
    ['POST', '/api/reviewer/roles/perf'],
    ['PUT', '/api/reviewer/roles'],
    ['PUT', '/api/reviewer/sets'],
    ['DELETE', '/api/reviewer/seats'],
    ['POST', '/api/review/artifacts/issues'],
    ['GET', '/api/health'],
    ['POST', '/api/presets/p1/messages'],
    ['DELETE', '/api/presets/p1/thread'],
    ['PUT', '/api/telemetry'],
    ['POST', '/api/telemetry/opened'],
    // A write on a read route, a read on a write route, and the page.
    ['POST', '/api/review'],
    ['PUT', '/api/changeset'],
    ['GET', '/api/review/threads'],
    ['GET', '/api/review/finish'],
    ['POST', '/'],
    ['DELETE', '/assets/index.js'],
    // Methods no route has.
    ['OPTIONS', '/api/review'],
    ['OPTIONS', '/'],
    ['PATCH', '/api/review/threads/t1'],
    ['TRACE', '/api/review'],
    // Look-alikes: trailing slashes, extra or missing segments, empty segments.
    ['GET', '/api'],
    ['GET', '/api/'],
    ['GET', '/api/review/'],
    ['POST', '/api/review/threads/'],
    ['POST', '/api/review/threads/t1/send/'],
    ['POST', '/api/review/threads/t1/send/x'],
    ['POST', '/api/review/threads//send'],
    ['POST', '/api/review/threads/t1/messages/m1'],
    ['PATCH', '/api/review/threads/t1/messages'],
    ['GET', '/api/commits/a/b'],
    ['GET', '/api/commits/'],
    ['GET', '/api/presets/p1'],
    ['GET', '/api/presets/p1/thread/x'],
    ['DELETE', '/api/review/layers/request'],
    ['POST', '/api/review/layers/request/x'],
    ['GET', '/api/something-new'],
    ['GET', '//api/agent/poll'],
    ['GET', '/api//agent/poll'],
    // An encoded slash stays one segment: it never becomes the agent's route.
    ['GET', '/api%2Fagent%2Fpoll'],
    ['GET', '/api/agent%2Fpoll'],
    ['POST', '/api/review%2Flayers'],
    ['GET', '/API/agent/poll'],
    ['GET', '/%61pi/agent/poll'],
    ['GET', '/api%5Cagent'],
    ['GET', '/%E0%A4%A'],
  ]

  it.each(allowed)('allows %s %s', (method, path) => {
    expect(relayAllows(method, path)).toBe(true)
  })

  it.each(denied)('denies %s %s', (method, path) => {
    expect(relayAllows(method, path)).toBe(false)
  })

  it('a param is one segment, even an encoded slash in it, never an empty one', () => {
    expect(relayAllows('POST', '/api/review/threads/a%2Fb/send')).toBe(true)
    expect(relayAllows('POST', '/api/review/threads/a/b/send')).toBe(false)
  })
})

describe('relayBodyRefusal', () => {
  it('lets the display settings through, nothing else', () => {
    for (const body of [{ theme: 'dark' }, { critter: 'off' }, { starNudge: 'snoozed' }, {}]) {
      expect(relayBodyRefusal('PUT', '/api/settings', body)).toBeNull()
    }
    for (const body of [
      { voice: 'be terse' },
      { layersPresets: { presets: [] } },
      { theme: 'dark', voice: '' },
      { theme: 'dark', somethingNew: 1 },
      null,
      [],
      'theme',
    ]) {
      expect(relayBodyRefusal('PUT', '/api/settings', body)).not.toBeNull()
    }
  })

  it('refuses any author on a write: the agent speaks through its own CLI', () => {
    for (const author of ['agent', 'reviewer', 'Agent', null]) {
      expect(relayBodyRefusal('POST', '/api/review/threads', { text: 'x', author })).not.toBeNull()
      expect(
        relayBodyRefusal('POST', '/api/review/threads/t1/messages', { text: 'x', author }),
      ).not.toBeNull()
    }
    expect(relayBodyRefusal('POST', '/api/review/threads', { text: 'x', anchor: {} })).toBeNull()
    expect(relayBodyRefusal('POST', '/api/review/finish', null)).toBeNull()
  })

  it('refuses `as` on a write: a reviewer agent speaks through its own CLI too', () => {
    for (const as of ['perf', 'security', '', null]) {
      expect(relayBodyRefusal('POST', '/api/review/threads', { text: 'x', as })).not.toBeNull()
      expect(
        relayBodyRefusal('POST', '/api/review/threads/t1/messages', { text: 'x', as }),
      ).not.toBeNull()
    }
  })

  it('has nothing to say about a read', () => {
    expect(relayBodyRefusal('GET', '/api/settings', { voice: 'x' })).toBeNull()
  })
})
