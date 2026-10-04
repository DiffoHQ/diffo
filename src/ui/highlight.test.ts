import type { ThemedToken } from 'shiki/core'
import { describe, expect, it } from 'vitest'
import { symbolRuns } from './highlight.js'

function token(parts: [string, string][]): ThemedToken {
  return {
    content: parts.map(([c]) => c).join(''),
    offset: 0,
    explanation: parts.map(([content, scopes]) => ({
      content,
      scopes: scopes.split(' ').map((scopeName) => ({ scopeName })),
    })),
  }
}

describe('symbolRuns', () => {
  it('cuts a merged token so the name is kept and its punctuation is not', () => {
    const t = token([
      [' ', 'source.tsx meta.import.tsx'],
      ['{', 'source.tsx meta.import.tsx punctuation.definition.block.tsx'],
      [' ', 'source.tsx meta.import.tsx'],
      ['isSymbolToken', 'source.tsx meta.import.tsx variable.other.readwrite.alias.tsx'],
      [',', 'source.tsx punctuation.separator.comma.tsx'],
      [' ', 'source.tsx'],
    ])
    expect(symbolRuns(t)).toEqual([
      { content: ' ', sym: true },
      { content: '{', sym: false },
      { content: ' isSymbolToken', sym: true },
      { content: ',', sym: false },
      { content: ' ', sym: true },
    ])
  })

  it('rules out comments, strings, keywords and literals wherever the scope sits', () => {
    expect(symbolRuns(token([['// note', 'source.ts comment.line.double-slash.ts']]))).toEqual([
      { content: '// note', sym: false },
    ])
    expect(symbolRuns(token([["'nosym'", 'source.ts string.quoted.single.ts']]))[0]!.sym).toBe(
      false,
    )
    expect(symbolRuns(token([['return', 'source.ts keyword.control.flow.ts']]))[0]!.sym).toBe(false)
    expect(symbolRuns(token([['const', 'source.ts storage.type.ts']]))[0]!.sym).toBe(false)
    expect(
      symbolRuns(token([['undefined', 'source.ts constant.language.undefined.ts']]))[0]!.sym,
    ).toBe(false)
    expect(
      symbolRuns(token([['self', 'source.python variable.language.special.self.python']]))[0]!.sym,
    ).toBe(false)
    expect(
      symbolRuns(token([['load', 'source.ts meta.function-call.ts entity.name.function.ts']]))[0]!
        .sym,
    ).toBe(true)
  })

  it('leaves prose alone: anything rooted in a text.* grammar', () => {
    expect(
      symbolRuns(token([['Rest the pointer', 'text.html.markdown meta.paragraph.markdown']]))[0]!
        .sym,
    ).toBe(false)
    expect(
      symbolRuns(
        token([['div', 'text.html.basic meta.tag.block.any.html entity.name.tag.html']]),
      )[0]!.sym,
    ).toBe(false)
  })

  it('treats a token without scopes as one hoverable run', () => {
    const plain: ThemedToken = { content: 'anything at all', offset: 0 }
    expect(symbolRuns(plain)).toEqual([{ content: 'anything at all', sym: true }])
  })
})
