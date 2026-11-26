import { describe, expect, it } from 'vitest'
import { parseReviewerName } from './review.js'
import {
  AGENT_PICKS_SET,
  allRoles,
  allSets,
  BUILT_IN_ROLES,
  BUILT_IN_SETS,
  CUSTOM_ROLES_MAX,
  CUSTOM_SETS_MAX,
  DEFAULT_ROLE,
  findRole,
  findSet,
  parseCustomRoles,
  parseCustomSets,
  parseSetDefault,
  ROLE_FOCUS_MAX,
  readCustomSets,
  roleIdFor,
  setIdFor,
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
    for (const set of BUILT_IN_SETS) {
      for (const id of set.roles) expect(ids, set.name).toContain(id)
      expect(parseReviewerName(set.id), set.id).toEqual({ ok: true, name: set.id })
      expect(set.when.length).toBeGreaterThan(10)
      expect(set.id).not.toBe(AGENT_PICKS_SET)
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

describe('reviewer sets', () => {
  const known = new Set(BUILT_IN_ROLES.map((r) => r.id))

  it('names a new set from its name, and never as a built-in or "agent"', () => {
    const parsed = parseCustomSets(
      [
        { name: 'Auth changes', when: ' Login and sessions. ', roles: ['security', 'errors'] },
        { name: 'Refactor', roles: ['tests'] },
        { name: 'Agent', roles: ['general'] },
      ],
      known,
    )
    expect(parsed).toEqual({
      ok: true,
      sets: [
        {
          id: 'auth-changes',
          name: 'Auth changes',
          when: 'Login and sessions.',
          roles: ['security', 'errors'],
        },
        { id: 'refactor-2', name: 'Refactor', when: '', roles: ['tests'] },
        { id: 'agent-2', name: 'Agent', when: '', roles: ['general'] },
      ],
    })
    expect(setIdFor('!!!', new Set())).toBeNull()
  })

  it('keeps the id a saved set already has, through a rename', () => {
    const parsed = parseCustomSets([{ id: 'auth', name: 'Sign-in', roles: ['security'] }], known)
    expect(parsed.ok && parsed.sets[0]!.id).toBe('auth')
  })

  it('refuses the whole list on a bad set, and says which', () => {
    const refused = (sets: unknown) => {
      const parsed = parseCustomSets(sets, known)
      return parsed.ok ? null : parsed.error
    }
    expect(refused([{ name: 'Empty', roles: [] }])).toMatch(/"Empty" needs at least one agent/)
    expect(refused([{ name: 'Ghost', roles: ['nope'] }])).toMatch(/"nope", which is not a reviewer/)
    expect(refused([{ name: '', roles: ['general'] }])).toMatch(/needs a name/)
    expect(refused([{ id: 'refactor', name: 'Mine', roles: ['general'] }])).toMatch(/built-in/)
    // No cap on how many agents a set holds: the picker has none either.
    expect(refused([{ name: 'Wide', roles: BUILT_IN_ROLES.map((r) => r.id) }])).toBeNull()
    expect(
      refused(
        Array.from({ length: CUSTOM_SETS_MAX + 1 }, (_, i) => ({
          name: `s${i}`,
          roles: ['general'],
        })),
      ),
    ).toMatch(/at most/)
  })

  it('reads what is stored leniently: a role that is gone leaves its set, an empty set goes', () => {
    const stored = [
      { id: 'mine', name: 'Mine', when: '', roles: ['general', 'deleted-role'] },
      { id: 'orphan', name: 'Orphan', when: '', roles: ['deleted-role'] },
      'junk',
    ]
    expect(readCustomSets(stored, known)).toEqual([
      { id: 'mine', name: 'Mine', when: '', roles: ['general'] },
    ])
    expect(readCustomSets('nope', known)).toEqual([])
  })

  it('says what it dropped, and keeps a set whose id a built-in took', () => {
    // The page saves the list it was shown: a set dropped without a word is
    // erased by the next save.
    const said: string[] = []
    const stored = [
      { id: 'refactor', name: 'My refactor', when: '', roles: ['general'] },
      { id: 'orphan', name: 'Orphan', when: '', roles: ['deleted-role'] },
      { id: 'twin', name: 'One', when: '', roles: ['general'] },
      { id: 'twin', name: 'Two', when: '', roles: ['general'] },
    ]
    expect(readCustomSets(stored, known, (m) => said.push(m))).toEqual([
      { id: 'my-refactor', name: 'My refactor', when: '', roles: ['general'] },
      { id: 'twin', name: 'One', when: '', roles: ['general'] },
    ])
    expect(said).toEqual([
      'dropped saved reviewer set "orphan": set "Orphan" needs at least one agent',
      'dropped saved reviewer set "twin": its id is taken',
    ])
  })

  it('finds a set among the built-ins and the reviewer own, and a default that exists', () => {
    const mine = [{ id: 'mine', name: 'Mine', when: '', roles: ['general'] }]
    expect(allSets(mine).map((s) => s.id)).toEqual([...BUILT_IN_SETS.map((s) => s.id), 'mine'])
    expect(findSet(mine, 'mine')?.name).toBe('Mine')
    expect(parseSetDefault('mine', mine)).toBe('mine')
    expect(parseSetDefault('refactor', [])).toBe('refactor')
    // A default whose set was deleted goes back to the agent's pick.
    expect(parseSetDefault('mine', [])).toBe(AGENT_PICKS_SET)
    expect(parseSetDefault(null, mine)).toBe(AGENT_PICKS_SET)
  })
})
