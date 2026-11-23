import { HEADER } from './constants.js'
import type { Point } from './routed.js'

/** The key of an arrow, for its route. */
export function edgeKey(e: { from: string; to: string; line: number }): string {
  return `${e.from}>${e.to}:${e.line}`
}

/** The path of a route: straight parts, with round corners. */
export function routePath(points: readonly Point[]): string {
  const first = points[0]
  if (first === undefined) return ''
  let d = `M${first.x} ${first.y}`
  for (let i = 1; i < points.length; i++) {
    const p = points[i]
    const before = points[i - 1]
    const after = points[i + 1]
    if (p === undefined || before === undefined) continue
    if (after === undefined) {
      d += ` L${p.x} ${p.y}`
      continue
    }
    // A corner: stop before it, and curve to a point after it.
    const r = Math.min(
      12,
      Math.hypot(p.x - before.x, p.y - before.y) / 2,
      Math.hypot(after.x - p.x, after.y - p.y) / 2,
    )
    const toward = (a: Point, b: Point) => {
      const len = Math.hypot(b.x - a.x, b.y - a.y) || 1
      return { x: a.x + ((b.x - a.x) * r) / len, y: a.y + ((b.y - a.y) * r) / len }
    }
    const inPt = toward(p, before)
    const outPt = toward(p, after)
    d += ` L${inPt.x} ${inPt.y} Q${p.x} ${p.y} ${outPt.x} ${outPt.y}`
  }
  return d
}

/** One card is above or below the other: they share a part of their width. */
export function isStacked(
  a: { x: number; width: number },
  b: { x: number; width: number },
): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width
}

/** Where on a card the line of a call is, from the top of the card. A line
 * that the card does not show (it is folded) is at the last line. */
export function callOffset(line: number, tops: readonly [number, number][] | undefined): number {
  if (tops === undefined || tops.length === 0) return HEADER / 2
  return tops.find(([no]) => no === line)?.[1] ?? tops[tops.length - 1]?.[1] ?? HEADER / 2
}
