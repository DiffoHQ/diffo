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

export function reviewUrl(port: number): string {
  return `http://localhost:${port}`
}
