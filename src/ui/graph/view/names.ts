import { useLayoutEffect, useState } from 'react'
import type { GraphStep } from '../../components/ReadingPane.js'
import type { GraphNode } from '../basic/build.js'
import { CARD_WIDTH, HEAD_EXTRA, LINE_GUTTER, MAX_CARD_WIDTH } from './constants.js'

/** The width of one character of the code font. */
export function useCharWidth(): number {
  const [width, setWidth] = useState(7.3)
  useLayoutEffect(() => {
    const probe = document.createElement('span')
    probe.className = 'hunk-lines'
    probe.style.cssText = 'position:absolute;visibility:hidden;white-space:pre'
    probe.textContent = 'x'.repeat(100)
    document.body.appendChild(probe)
    const w = probe.getBoundingClientRect().width / 100
    probe.remove()
    if (w > 0) setWidth(w)
  }, [])
  return width
}

/** The width of a card that shows each line of the node in full. */
export function cardWidth(node: GraphNode, char: number): number {
  let longest = 0
  for (const line of node.lines) {
    const length = line.text.replace(/\t/g, '        ').length
    if (length > longest) longest = length
  }
  const fit = Math.ceil(longest * char) + LINE_GUTTER
  // The header shows the name in full, with space for its marks.
  const head = Math.ceil(cardName(node).length * char * 1.1) + HEAD_EXTRA
  return Math.min(MAX_CARD_WIDTH, Math.max(CARD_WIDTH, fit, head))
}

export function shortName(name: string): string {
  const parts = name.split(/::|\./)
  return parts.slice(-2).join(name.includes('::') ? '::' : '.')
}

/** The name in the top left corner of a box. */
export function boxName(group: string, level: number, grouped: boolean): string {
  if (level === 0) return group.includes('↔') ? `Contract: ${group}` : group
  // Level 1 is a component: the last two folders of its path.
  return !grouped && level === 1 ? group.split('/').slice(-2).join('/') : group
}

/** The name that a card shows for its node. */
export function cardName(node: GraphNode): string {
  if (node.file) return baseName(node.path)
  if (node.name === null) return node.schema ? baseName(node.path) : '(top level)'
  return node.schema ? node.name : shortName(node.name)
}

/** The name in the header of a card. */
export function nodeTitle(node: GraphNode): string {
  if (node.file) return baseName(node.path)
  if (node.name === null)
    return node.schema ? baseName(node.path) : `(top level) ${baseName(node.path)}`
  return node.schema ? node.name : shortName(node.name)
}

export function baseName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1)
}

/** The name of the group of a step: its number and its title. */
export function stepName(step: GraphStep): string {
  return step.number === null ? step.title : `${step.number} · ${step.title}`
}
