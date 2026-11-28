/**
 * Whether this page reached the server through the remote-mode relay (another
 * device, in the reviewer's role only).
 *
 * The server writes the marker into index.html, as it does for a dev page, so
 * it is settled at first paint: the page leaves out what the server would
 * refuse a remote device (reviewer agents) instead of offering it and failing.
 */
export function isViaRelay(): boolean {
  if (typeof document === 'undefined') return false
  return document.querySelector('meta[name="diffo-via"]')?.getAttribute('content') === 'relay'
}
