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

/** The review link: the proxy's address under `DIFFO_PUBLIC_URL`, else loopback. */
export function reviewUrl(port: number): string {
  return publicUrl(port)?.origin ?? `http://localhost:${port}`
}

/**
 * `DIFFO_PUBLIC_URL` is the address a reverse proxy serves this server at, with
 * `{port}` standing for its port (`https://diffo-{port}.devbox.internal`). That
 * one origin is the link diffo prints and the only non-loopback host the
 * server's Host and Origin guard accepts. Undefined when unset; a value that
 * isn't a bare http(s) origin throws rather than being half-used.
 */
export function publicUrl(port: number): URL | undefined {
  const template = process.env.DIFFO_PUBLIC_URL?.trim()
  if (!template) return undefined
  let url: URL
  try {
    url = new URL(template.replaceAll('{port}', String(port)))
  } catch {
    throw new Error(`DIFFO_PUBLIC_URL is not a URL: ${template}`)
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.href !== `${url.origin}/`) {
    throw new Error(
      `DIFFO_PUBLIC_URL must be a scheme and host only, like https://diffo-{port}.devbox.internal`,
    )
  }
  return url
}
