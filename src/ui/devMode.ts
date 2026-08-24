/**
 * Whether the server that served this page runs from a source checkout
 * (`ENV=development`) rather than the released CLI.
 *
 * The server injects the marker into index.html, so this is settled at first
 * paint. That matters: the reviewer may have a shipped review open in another
 * tab, and a page that looks released for even one frame is a page they may
 * start reading — and reporting on — as if it were.
 */
export function isDevServer(): boolean {
  if (typeof document === 'undefined') return false
  return document.querySelector('meta[name="diffo-env"]')?.getAttribute('content') === 'development'
}
