import { describe, expect, it } from 'vitest'
import { actionForKey } from './keyboard.js'

describe('actionForKey', () => {
  it('maps the reading keys', () => {
    expect(actionForKey('j', false)).toBe('next-hunk')
    expect(actionForKey('k', false)).toBe('prev-hunk')
    expect(actionForKey('J', true)).toBe('next-file')
    expect(actionForKey('K', true)).toBe('prev-file')
    expect(actionForKey('n', false)).toBe('next-unreviewed')
    expect(actionForKey('v', false)).toBe('toggle-viewed')
    expect(actionForKey('?', false)).toBe('shortcuts')
  })

  it('brackets step the outline — J/K stay inside a layer', () => {
    expect(actionForKey(']', false)).toBe('next-layer')
    expect(actionForKey('[', false)).toBe('prev-layer')
  })

  it('anything else is nobody’s', () => {
    expect(actionForKey('x', false)).toBeNull()
    expect(actionForKey('Enter', false)).toBeNull()
  })
})
