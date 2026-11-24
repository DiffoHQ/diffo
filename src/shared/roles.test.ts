import { describe, expect, it } from 'vitest'
import { parseReviewerName } from './review.js'
import {
  allRoles,
  BUILT_IN_ROLES,
  CUSTOM_ROLES_MAX,
  DEFAULT_ROLE,
  findRole,
  parseCustomRoles,
  ROLE_COMBOS,
  ROLE_FOCUS_MAX,
  roleIdFor,
} from './roles.js'

describe('reviewer roles', () => {
  it('ships narrow built-ins, the quick picks first, each a valid name with a focus that says what to leave alone', () => {
    const ids = BUILT_IN_ROLES.map((r) => r.id)
    expect(ids).toHaveLength(17)
    expect(new Set(ids).size).toBe(ids.length)
    expect(BUILT_IN_ROLES.filter((r) => r.quick).map((r) => r.id)).toEqual([
      'general',
      'blast-radius',
      'ai-slop',
      'simplicity',
      'comments',
      'errors',
    ])
    // Every set the picker offers names roles there are.
    for (const combo of ROLE_COMBOS) {
      for (const id of combo.roles) expect(ids, combo.label).toContain(id)
    }
    for (const role of BUILT_IN_ROLES) {
      expect(parseReviewerName(role.id), role.id).toEqual({ ok: true, name: role.id })
      expect(role.builtIn).toBe(true)
      expect(role.blurb.length).toBeGreaterThan(10)
      expect(role.focus.length).toBeGreaterThan(100)
      expect(role.focus.length).toBeLessThanOrEqual(ROLE_FOCUS_MAX)
      expect(role.focus, role.id).toMatch(/belongs? to (the |another |other )/)
    }
    expect(findRole([], DEFAULT_ROLE)?.name).toBe('General')
  })

  it("keeps the reviewer's own roles after the built-ins", () => {
    const parsed = parseCustomRoles([
      {
        id: 'perf',
        name: '  Performance ',
        blurb: 'What\ngets slower',
        focus: ' loops\nand queries ',
      },
    ])
    expect(parsed).toEqual({
      ok: true,
      roles: [
        { id: 'perf', name: 'Performance', blurb: 'What gets slower', focus: 'loops\nand queries' },
      ],
    })
    const roles = parsed.ok ? parsed.roles : []
    expect(allRoles(roles).map((r) => r.id)).toEqual([...BUILT_IN_ROLES.map((r) => r.id), 'perf'])
    expect(findRole(roles, 'perf')?.builtIn).toBeUndefined()
    expect(findRole(roles, 'nope')).toBeUndefined()
  })

  it('refuses the whole list on one bad role, and says which', () => {
    const bad = (roles: unknown) => {
      const parsed = parseCustomRoles(roles)
      return parsed.ok ? null : parsed.error
    }
    const ok = { id: 'perf', name: 'Performance', blurb: '', focus: 'loops' }
    expect(bad('nope')).toMatch(/must be a list/)
    expect(bad([ok, { ...ok, id: 'two words' }])).toMatch(/role id/)
    expect(bad([{ ...ok, id: 'agent' }])).toMatch(/taken by the review/)
    expect(bad([{ ...ok, id: 'security' }])).toMatch(/already a role "security"/)
    expect(bad([ok, ok])).toMatch(/already a role "perf"/)
    expect(bad([{ ...ok, name: ' ' }])).toMatch(/needs a "name"/)
    expect(bad([{ ...ok, focus: '' }])).toMatch(/needs a "focus": what it looks for/)
    expect(bad([{ ...ok, focus: 'x'.repeat(ROLE_FOCUS_MAX + 1) }])).toMatch(/under 2000/)
    // One rule per field: a long blurb is refused, as an agent's edit is, not cut.
    expect(bad([{ ...ok, blurb: 'x'.repeat(200) }])).toMatch(/one line under 120/)
    expect(
      bad(Array.from({ length: CUSTOM_ROLES_MAX + 1 }, (_, i) => ({ ...ok, id: `r${i}` }))),
    ).toMatch(/at most 20/)
    expect(parseCustomRoles([])).toEqual({ ok: true, roles: [] })
  })

  it('makes an id from a name, numbered when taken', () => {
    expect(roleIdFor('Performance', new Set())).toBe('performance')
    expect(roleIdFor('  API & Contracts! ', new Set())).toBe('api-contracts')
    expect(roleIdFor('Security', new Set(['security']))).toBe('security-2')
    expect(roleIdFor('Agent', new Set())).toBe('agent-2')
    expect(roleIdFor('x'.repeat(60), new Set())).toHaveLength(20)
    expect(roleIdFor('!!!', new Set())).toBeNull()
  })
})
