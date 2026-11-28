/**
 * What a request that came through the relay may reach: the review page and
 * the reviewer's own actions on this review, nothing else. Whoever holds the
 * paired device can instruct the agent, so the role is the reviewer's only —
 * never the agent's (`/api/agent/*`, the agent's own posts), the CLI's
 * (`/api/remote`, `/api/shutdown`), or anything that persists machine-wide
 * (presets, the voice, telemetry).
 *
 * Exact method + route patterns, on purpose: a route added later stays local
 * until someone decides the phone needs it. `:param` is exactly one path
 * segment; nothing else is a wildcard.
 */

const READS = [
  '/api/review',
  '/api/events',
  '/api/changeset',
  '/api/commits',
  '/api/commits/:sha',
  '/api/file',
  '/api/settings',
  '/api/telemetry',
  '/api/presets',
  '/api/presets/:id/thread',
  '/api/remote',
].map((route) => ({ method: 'GET', route }))

const WRITES: { method: string; route: string }[] = [
  { method: 'POST', route: '/api/review/threads' },
  { method: 'POST', route: '/api/review/threads/:id/messages' },
  { method: 'PATCH', route: '/api/review/threads/:id/messages/:messageId' },
  { method: 'POST', route: '/api/review/threads/:id/messages/:messageId/pr-comment' },
  { method: 'POST', route: '/api/review/threads/:id/state' },
  { method: 'POST', route: '/api/review/threads/:id/send' },
  { method: 'DELETE', route: '/api/review/threads' },
  { method: 'DELETE', route: '/api/review/threads/:id' },
  { method: 'DELETE', route: '/api/review/landed' },
  { method: 'POST', route: '/api/review/finish/preview' },
  { method: 'POST', route: '/api/review/finish' },
  { method: 'POST', route: '/api/review/layers/request' },
  { method: 'DELETE', route: '/api/review/layers' },
  // Only the reviewer's own display settings; relayBodyRefusal narrows the body.
  { method: 'PUT', route: '/api/settings' },
  // Only the notice's "seen it": whether usage data is sent stays a local choice.
  { method: 'PUT', route: '/api/telemetry' },
]

const ALLOWED = [...READS, ...WRITES].map(({ method, route }) => ({
  method,
  segments: route.split('/'),
}))

const SEGMENT = /^[^/]+$/

function matches(pattern: string[], path: string[]): boolean {
  if (pattern.length !== path.length) return false
  return pattern.every((p, i) => {
    const s = path[i]!
    return p.startsWith(':') ? SEGMENT.test(s) : p === s
  })
}

/** Whether the path, decoded and with empty segments dropped, starts in `/api`
 * in any case. Undecodable counts as yes. */
function looksLikeApi(path: string): boolean {
  let decoded: string
  try {
    decoded = decodeURIComponent(path)
  } catch {
    return true
  }
  const first = decoded.split(/[\\/]/).find((s) => s !== '') ?? ''
  return first.toLowerCase() === 'api'
}

export function relayAllows(method: string, path: string): boolean {
  const m = method.toUpperCase()
  // HEAD is answered by the GET route, so it is a read wherever GET is.
  const asRead = m === 'HEAD' ? 'GET' : m
  // The page itself and its assets: read-only, and nothing that a looser
  // reader of the path (a proxy, a later router) could take for an API route.
  if (path !== '/api' && !path.startsWith('/api/')) {
    return asRead === 'GET' && !path.includes('//') && !looksLikeApi(path)
  }
  const segments = path.split('/')
  return ALLOWED.some((a) => a.method === asRead && matches(a.segments, segments))
}

/** Settings a remote device may change: how the page looks to it. The voice
 * and the layers presets are prompt text persisted for every repo on this
 * machine, so they stay local. */
const RELAY_SETTINGS = new Set(['theme', 'critter', 'starNudge'])

/**
 * The body checks the route table cannot make, for a request already allowed
 * by `relayAllows`. Fails closed: a body it cannot read as the reviewer's is
 * refused. Returns the reason to refuse, or null to let it through.
 */
export function relayBodyRefusal(method: string, path: string, body: unknown): string | null {
  const m = method.toUpperCase()
  if (m === 'GET' || m === 'HEAD') return null
  const fields = typeof body === 'object' && body !== null && !Array.isArray(body) ? body : null
  if (m === 'PUT' && path === '/api/settings') {
    if (!fields) return 'need a JSON object'
    const other = Object.keys(fields).filter((k) => !RELAY_SETTINGS.has(k))
    return other.length > 0 ? `not from a remote device: ${other.join(', ')}` : null
  }
  if (m === 'PUT' && path === '/api/telemetry') {
    const keys = fields ? Object.keys(fields) : []
    const notice = (fields as { notice?: unknown } | null)?.notice
    return keys.length === 1 && (notice === 'shown' || notice === 'acknowledged')
      ? null
      : 'not from a remote device: the usage-data setting'
  }
  // The thread routes speak for someone else when the body says so:
  // `author: "agent"` is the author agent, `as: <seat>` a reviewer agent. The
  // reviewer's page sends neither, so either one is refused.
  if (fields && ('author' in fields || 'as' in fields)) {
    return 'a remote device speaks as the reviewer only'
  }
  return null
}
