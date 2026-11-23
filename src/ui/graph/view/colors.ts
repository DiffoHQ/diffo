import type { GraphColor } from '../../../shared/graphs.js'

/** The colors that the agent can give to a box, as `r, g, b`. */
export const COLOR_RGB: Record<GraphColor, string> = {
  blue: '10, 132, 255',
  green: '48, 176, 110',
  purple: '191, 90, 242',
  orange: '255, 159, 10',
  red: '255, 69, 58',
  teal: '48, 176, 199',
  pink: '255, 55, 95',
  yellow: '255, 204, 0',
}

/** A box mostly removes code: 4 of each 5 changed lines, or more. */
export function mostlyRemoved(lines: { add: number; del: number }): boolean {
  const all = lines.add + lines.del
  return all > 0 && lines.del / all >= 0.8
}

/**
 * The color of a group from its diff: red when all its changed lines are
 * removed, green when all are added, and a gray-blue between the two.
 */
export function diffRgb(add: number, del: number): string {
  const red = [255, 69, 58]
  const mid = [130, 142, 165]
  const green = [48, 209, 88]
  const all = add + del
  const part = all === 0 ? 0.5 : add / all
  const [from, to, t] = part < 0.5 ? [red, mid, part * 2] : [mid, green, part * 2 - 1]
  return from.map((c, i) => Math.round(c + ((to[i] ?? c) - c) * t)).join(', ')
}
