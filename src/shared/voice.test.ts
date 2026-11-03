import { describe, expect, it } from 'vitest'
import { DEFAULT_VOICE, effectiveVoice, normalizeVoice, VOICE_MAX } from './voice.js'

describe('the voice setting', () => {
  it('reads empty, absent, or non-string as the default', () => {
    expect(normalizeVoice(undefined)).toBeNull()
    expect(normalizeVoice(null)).toBeNull()
    expect(normalizeVoice('')).toBeNull()
    expect(normalizeVoice('   \n')).toBeNull()
    expect(normalizeVoice(42)).toBeNull()
    expect(effectiveVoice('')).toBe(DEFAULT_VOICE)
  })

  it('trims a custom voice and keeps it', () => {
    expect(normalizeVoice('  Short. Blunt. British.\n')).toBe('Short. Blunt. British.')
    expect(effectiveVoice('Short.')).toBe('Short.')
  })

  it('drops a voice over the cap rather than shipping it', () => {
    expect(normalizeVoice('x'.repeat(VOICE_MAX))).toHaveLength(VOICE_MAX)
    expect(normalizeVoice('x'.repeat(VOICE_MAX + 1))).toBeNull()
  })

  it('the default practises what it preaches', () => {
    expect(DEFAULT_VOICE).not.toContain('—')
    expect(DEFAULT_VOICE.length).toBeLessThanOrEqual(VOICE_MAX)
  })
})
