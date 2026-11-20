/**
 * Every URL that reaches a review server is built here, and nowhere else.
 * Two names on purpose — `apiUrl` is what the CLI speaks over HTTP, `reviewUrl`
 * is what a human opens — so the managed version can swap either base (a remote
 * host, auth in the URL) without touching a call site. The listen host in
 * `src/server/index.ts` is the other side of this seam and stays separate: it
 * says where the local server binds, not how anything reaches it.
 */
export function apiUrl(port: number, path = ''): string {
  return `http://127.0.0.1:${port}${path}`
}

/** `DIFFO_REVIEW_URL` replaces the loopback address with the one a reverse
 * proxy serves this port at, `{port}` standing for the server's port. The
 * proxy's host must also be in `DIFFO_ALLOWED_HOSTS`, or the server refuses it. */
export function reviewUrl(port: number): string {
  const template = process.env.DIFFO_REVIEW_URL?.trim()
  return template ? template.replaceAll('{port}', String(port)) : `http://localhost:${port}`
}

/**
 * The hosts named in `DIFFO_ALLOWED_HOSTS`, beyond loopback, that the server's
 * Host and Origin guard accepts: comma-separated hostnames, no port. An entry
 * starting with a dot covers every subdomain under it (`.devbox.internal` covers
 * `diffo-4949.devbox.internal`) but not the bare domain itself.
 */
export function parseAllowedHosts(raw: string | undefined): { matches(host: string): boolean } {
  const entries = (raw ?? '')
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry !== '' && entry !== '.')
  const exact = new Set(entries.filter((entry) => !entry.startsWith('.')))
  const suffixes = entries.filter((entry) => entry.startsWith('.'))
  return {
    matches: (host) => exact.has(host) || suffixes.some((suffix) => host.endsWith(suffix)),
  }
}
