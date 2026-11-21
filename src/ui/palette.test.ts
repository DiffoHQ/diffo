import { describe, expect, it } from 'vitest'
import { filterPalette, type PaletteItem, scoreItem } from './palette.js'

const item = (label: string, hint?: string): PaletteItem => ({
  id: label,
  group: 'Files',
  label,
  ...(hint ? { hint } : {}),
  run: () => {},
})

describe('scoreItem', () => {
  it('matches everything on an empty query', () => {
    expect(scoreItem(item('delivery.ts'), '  ')).toBe(0)
  })

  it('ranks a label prefix over a word start, over mid-word, over the hint', () => {
    expect(scoreItem(item('delivery.ts'), 'del')).toBe(0)
    expect(scoreItem(item('review-delivery.ts'), 'del')).toBe(1)
    expect(scoreItem(item('modelist.ts'), 'del')).toBe(2)
    expect(scoreItem(item('index.ts', 'src/delivery'), 'del')).toBe(3)
  })

  it('needs every word, in any order, and ignores case', () => {
    expect(scoreItem(item('Finish review'), 'REVIEW fin')).not.toBeNull()
    expect(scoreItem(item('Finish review'), 'finish split')).toBeNull()
  })
})

describe('filterPalette', () => {
  const items = [
    item('prompt.ts', 'src/server'),
    item('delivery.ts', 'src/server'),
    item('App.tsx'),
  ]

  it('is the list as composed when nothing is typed', () => {
    expect(filterPalette(items, '').map((i) => i.label)).toEqual([
      'prompt.ts',
      'delivery.ts',
      'App.tsx',
    ])
  })

  it('keeps only matches, best first, stable among equals', () => {
    expect(filterPalette(items, 'server').map((i) => i.label)).toEqual(['prompt.ts', 'delivery.ts'])
    expect(filterPalette(items, 'p').map((i) => i.label)).toEqual(['prompt.ts', 'App.tsx'])
  })

  it('caps the rows it returns', () => {
    const many = Array.from({ length: 80 }, (_, i) => item(`file-${i}.ts`))
    expect(filterPalette(many, 'file', 10)).toHaveLength(10)
  })
})
