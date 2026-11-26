import { normalizeConversationMessage, normalizeConversations } from './conversation.js'
import { parseReviewerName } from './review.js'

/**
 * A reviewer role: what one reviewer agent reads a change for. The reviewer is
 * handed its role's focus when it joins (`diffo join --role <id>`), on top of
 * the review brief every reviewer agent gets, so two reviewers on one change
 * look for different things and neither comments on everything.
 *
 * A role narrows what a reviewer looks for. It never changes what a reviewer
 * may do: the thread and round limits, the rule that it edits no code, and the
 * human's final word are the review's, not a role's.
 */
export interface ReviewerRole {
  /** Said in commands (`diffo join --role <id>`), so it obeys a name's
   * rules: 1 to 24 characters of a-z, 0-9 and "-". */
  id: string
  name: string
  /** One line for the picker. */
  blurb: string
  /** When to open it, in a line: the quick read before the whole focus.
   * The built-ins have one; a role of the reviewer's own shows its blurb. */
  when?: string
  /** What to look for, and what to leave to others. */
  focus: string
  builtIn?: true
  /** A built-in worth opening on most changes: active (in the picker) until
   * the human says otherwise. The other built-ins wait in the library. */
  quick?: true
}

/**
 * A set: the reviewer agents that fit one kind of change, started together.
 * The picker offers them, the human can keep sets of their own, and the
 * author agent can say which one fits the change it wrote (`diffo reviewer
 * --set`), so the picker opens with those agents already ticked.
 */
export interface ReviewerSet {
  /** Said in commands, so it obeys a name's rules, like a role's id. */
  id: string
  name: string
  /** The kind of change it is for, in a line: what the author agent reads
   * to pick one, and the human to remember why they made it. */
  when: string
  /** Role ids, in the order they are listed. */
  roles: string[]
  builtIn?: true
}

export const ROLE_NAME_MAX = 32
export const ROLE_BLURB_MAX = 120
export const ROLE_FOCUS_MAX = 2000
/** How many roles of their own a reviewer may keep. */
export const CUSTOM_ROLES_MAX = 20

export const SET_NAME_MAX = 32
export const SET_WHEN_MAX = 120
/** How many sets of their own a reviewer may keep. */
export const CUSTOM_SETS_MAX = 20

/** The sets Diffo ships: the roles that matter for a kind of change. */
export const BUILT_IN_SETS: readonly ReviewerSet[] = [
  {
    id: 'agent-written',
    name: 'Agent-written change',
    when: 'A change an agent wrote end to end, of no special kind.',
    roles: ['general', 'ai-slop', 'comments'],
    builtIn: true,
  },
  {
    id: 'refactor',
    name: 'Refactor',
    when: 'Code moved, renamed or reshaped, with behaviour meant to stay the same.',
    roles: ['blast-radius', 'simplicity', 'tests'],
    builtIn: true,
  },
  {
    id: 'new-api',
    name: 'New API or command',
    when: 'A new route, exported function, CLI command or flag that others will call.',
    roles: ['api-design', 'blast-radius', 'security'],
    builtIn: true,
  },
  {
    id: 'ui-change',
    name: 'UI change',
    when: 'Screens, components, or how something on the page behaves.',
    roles: ['general', 'accessibility', 'concurrency'],
    builtIn: true,
  },
  {
    id: 'data',
    name: 'Data or settings',
    when: 'Stored data, a migration, config keys or defaults.',
    roles: ['data', 'blast-radius'],
    builtIn: true,
  },
  {
    id: 'release',
    name: 'Before release',
    when: 'The last read before it ships: is it documented, and is it what was asked.',
    roles: ['docs', 'scope'],
    builtIn: true,
  },
]

/**
 * The default the picker opens on when the human has not named a set: the one
 * the author agent picked for this change. Never a set's id (`setIdFor`).
 */
export const AGENT_PICKS_SET = 'agent'

/** The role of a reviewer that named none. */
export const DEFAULT_ROLE = 'general'

/**
 * The roles Diffo ships, most useful first. Each is narrow, so a reviewer
 * opens a few at once; each says what counts as evidence for its kind of
 * finding and which neighbour owns what it leaves out, so two never argue.
 * Drawn from what review tools and skills ship and what AI-written code gets
 * wrong (research in the reviewer agents notes).
 */
export const BUILT_IN_ROLES: readonly ReviewerRole[] = [
  {
    id: 'general',
    name: 'General',
    blurb: 'Anything that would bite, bugs first',
    when: 'Any change. The safe default when you want one reviewer to catch real bugs.',
    focus:
      'Read the whole change for what would go wrong when it runs. First, wrong behaviour: an input or state it mishandles (empty, missing, duplicate, out of order, at a boundary), a branch that does the wrong thing, a call to a function or option that does not exist or does not do what the code assumes, a contract a caller relies on that it now breaks, state that can be left half-updated. Trace each one through the code before you write: name the input or sequence and what happens. Then what makes the change unsafe to build on: a name that says something the code does not do, a comment that is no longer true. Cleanups, style and test coverage belong to other reviewers.',
    quick: true,
    builtIn: true,
  },
  {
    id: 'blast-radius',
    name: 'Blast radius',
    blurb: 'What else this change touches: callers, consumers, stored data, config',
    when: 'Changes to shared code: a signature, flag, config key or stored data other code relies on.',
    focus:
      'Read the change for its effects outside the lines it edits. For every changed signature, return value, default, thrown error, event, route, CLI flag, config key, environment variable, file format or stored field, search the codebase for who uses it and check that each still works: callers passing the old arguments, code matching on an old value or message, readers of data written in the old shape, other packages, scripts, tests, docs and UI that assume the old behaviour. Treat what leaves the process as reaching beyond this repo: files on disk, databases, caches, URLs, public APIs, telemetry, other versions of the app running at the same time. Every finding names the affected place by file and line and says what goes wrong there. A worry that something might depend on this is not a finding until you have found the thing. Bugs inside the edited lines belong to another reviewer.',
    quick: true,
    builtIn: true,
  },
  {
    id: 'ai-slop',
    name: 'AI slop',
    blurb:
      'What an agent adds that a careful human would not: needless guards, shims, casts, debris',
    when: 'Code an agent wrote: flags needless guards, casts, shims and leftovers.',
    focus:
      'Read the change for the habits of generated code that make it longer or falsely reassuring. Look for: a check, try/catch or default for a case the types or every caller already rule out; a fallback that returns an empty or made-up value where failing loudly was right; a cast to any, a non-null assertion or a ts-ignore used to get past an error instead of fixing the type; a shim, re-export, alias or `_unused` rename kept for a caller that does not exist; a parameter, import, variable or branch nothing uses; logging, prints, debug flags or commented-out code left behind; validation repeated at every layer instead of once at the boundary; docstrings, types or reformatting added to code the task did not touch. For each, show why it is dead weight: the type or caller that makes it unreachable, the search that finds no user. Comment wording belongs to the comments reviewer; reshaping working code to be smaller belongs to the simplicity reviewer; failures that can really happen belong to the error handling reviewer.',
    quick: true,
    builtIn: true,
  },
  {
    id: 'simplicity',
    name: 'Simplicity',
    blurb: 'Less code that does the same',
    when: 'When the change feels bigger than the problem it solves.',
    focus:
      'Read the change for what could be smaller and still do the same thing. An abstraction, interface, factory or option with one user; a parameter every caller passes the same way; a helper that hides a line or two; a class where a function would do; nesting an early return would flatten; a special case the general path already handles; state stored and kept in sync where it could be derived; code that repeats something the change or the codebase already has; dead code; machinery for a future the task does not need. Name the simpler shape concretely: what it looks like and which lines it replaces, and check it keeps every behaviour callers and tests rely on. A few plain repeated lines beat a premature abstraction, and shorter is not simpler when it is denser: no nested ternaries or clever one-liners. Bugs belong to another reviewer.',
    quick: true,
    builtIn: true,
  },
  {
    id: 'comments',
    name: 'Code comments',
    blurb: 'Comments that restate the code, narrate the change, or are no longer true',
    when: 'When the code is full of comments that repeat it or describe the session.',
    focus:
      'Read every comment and docstring the change adds or edits, and those beside code it changed. Flag: a comment that says what the next line plainly does; one that narrates the change or the session ("added X", "now uses Y", "fixed the bug", "as requested") instead of describing the code; a docstring that repeats the signature; a banner over a short section; a commented-out block; a comment that is false: wrong parameters, return value, units or side effects, an edge case the code does not handle, a TODO already done, a reference to code that moved or is gone. Check every claim against the code before calling it false, and point at the line that disagrees. Say whether to delete it or how to rewrite it, in a few words. Keep comments that give what the code cannot: a reason, a constraint, a workaround and its cause, a link. Ask for a new comment only where a reader would otherwise get something wrong. The code itself belongs to other reviewers.',
    quick: true,
    builtIn: true,
  },
  {
    id: 'errors',
    name: 'Error handling',
    blurb: 'Failures that get swallowed, hidden behind a fallback, or reported as success',
    when: 'Code that can fail (files, network, parsing): finds failures that get hidden.',
    focus:
      'Find every place the change can fail and follow what happens to the failure. A catch that swallows it, logs and carries on, or returns success, null or a default the caller cannot tell from a real result; a catch so broad it hides errors it was not written for; a promise not awaited or never handled; a fallback that quietly serves stale, empty or fake data where the user should know; a retry that gives up without a word; cleanup skipped on the error path (a lock, a temp file, a spinner left spinning); an error message that does not say what failed or what to do next; an error logged without what was being done or to which item. For each, name a real failure (a missing file, a timeout, bad input), trace where it ends up, and say what the user or caller sees. Guards for cases that cannot happen belong to the AI slop reviewer; secrets leaked in errors belong to the security reviewer.',
    quick: true,
    builtIn: true,
  },
  {
    id: 'tests',
    name: 'Tests',
    blurb: 'Whether the tests would catch it breaking',
    when: 'When the change comes with tests, or should have.',
    focus:
      'Read the change for whether its behaviour is tested, and whether those tests would fail if it broke. A new branch, edge or error path with no test; a test that asserts nothing that matters (only that it ran, or a snapshot nobody reads); a test that mocks the very thing it claims to check, or computes its expected value with the code under test; a test that passes for the wrong reason; one that depends on time, order, randomness or the network; behaviour that changed while its test did not, or a test edited to match a bug, skipped or loosened to go green. Run the tests when that settles a doubt, or name the assertion that would still pass if the line were wrong. Ask for the one test that would catch the likeliest regression, not for coverage. The design of the production code belongs to another reviewer.',
    builtIn: true,
  },
  {
    id: 'security',
    name: 'Security',
    blurb: 'What an attacker could reach through this change',
    when: 'Code that handles input, logins, secrets, files or outbound requests.',
    focus:
      'Read the change for what it exposes. Untrusted input (a request, an uploaded or cloned file, a URL, repository content, model output) that reaches a query, a shell, a file path, a template or HTML unescaped; a permission or ownership check that is missing, client-side only, or skippable; a secret or token that is logged, returned, put in a URL or stored in the clear; a server request to a host or scheme the caller chose; a new endpoint, port, listener, CORS rule or dependency; eval or unsafe deserialisation. Report only what someone could actually reach through this change: who the attacker is, what they send, what they get. Leave out hardening with no attack path, theoretical denial of service, outdated dependencies and anything that needs control of the environment or CLI flags. Ordinary bugs with no security consequence belong to another reviewer.',
    builtIn: true,
  },
  {
    id: 'scope',
    name: 'Scope',
    blurb: 'Did it do what was asked: nothing missing, nothing extra, nothing faked',
    when: 'Before you accept it: did it do what was asked, without stubs or extras.',
    focus:
      'Read the change against the task it was made for: the pull request\'s description, the commit messages, the layers\' summaries, the plan or issue they name. Flag a requirement the change does not meet, or meets for one case only; a path that looks finished but is stubbed: a hard-coded result, a TODO where the work should be, a placeholder, a flag that is never on; a claim the code does not back ("handles X", "tested"); work nobody asked for: an unrelated refactor, a moved file, a new option, a drive-by change that widens what has to be reviewed. Quote the requirement or claim and point at the lines that fall short. If the task is stated nowhere you can read, ask the author agent for it in one comment on the whole change before judging. How well the in-scope code is written belongs to other reviewers.',
    builtIn: true,
  },
  {
    id: 'conventions',
    name: 'Conventions',
    blurb: 'Does it do things the way this codebase already does',
    when: 'In a mature codebase: catches a second way of doing what it already does.',
    focus:
      "Read the change beside the code around it, and search for how the codebase already does the same thing. Flag a new helper, type, constant or dependency for something the codebase or the standard library already provides; a second way of doing what the codebase does one way: errors, logging, config, paths, dates, ids, HTTP calls, state, file layout, test setup; a rule in the project's CLAUDE.md, AGENTS.md, CONTRIBUTING or lint config that the change breaks. Every finding cites the existing example or the written rule by file and line and says what to use instead. A one-off difference that costs the next reader nothing is taste: leave it. Whether the code is correct belongs to another reviewer.",
    builtIn: true,
  },
  {
    id: 'performance',
    name: 'Performance',
    blurb: 'What gets slower, heavier, or grows without bound',
    when: 'Code on a hot path, in a loop, or over data that grows.',
    focus:
      "Read the change for what it costs at real sizes. A query, request, file read or process spawn inside a loop; work redone on every render, keystroke, poll or request that could be done once; a list loaded, rendered or sent whole with no limit; a nested walk over something that grows with the user's data; synchronous I/O or heavy work on a UI or event-loop thread; a cache with no bound or invalidation; a listener, timer or subscription never removed. Each finding names the size or frequency that makes it hurt (how many items, how often) and where that number comes from; a cost that is fine at the sizes this code will see is not a finding. Leave micro-optimisations. Correctness belongs to another reviewer.",
    builtIn: true,
  },
  {
    id: 'api-design',
    name: 'API & types',
    blurb: 'New interfaces that are easy to misuse or hard to change later',
    when: 'New exported functions, routes, CLI flags or config others will call.',
    focus:
      'Read every new or changed interface that others will call: exported functions and types, HTTP routes, CLI commands and flags, config keys, events, message and file formats. Flag what makes it easy to use wrong: a type that allows states the code cannot handle (two optional fields that must come together, a string where a union fits, a boolean argument unreadable at the call site); a default that surprises; an error a caller cannot tell apart from success or from another error; a name or shape that disagrees with its siblings; internals exposed so they can never change; something required made optional, or the reverse. Show the call that compiles but goes wrong, or the sibling it disagrees with. Who breaks when an existing interface changes belongs to the blast radius reviewer.',
    builtIn: true,
  },
  {
    id: 'concurrency',
    name: 'Concurrency & state',
    blurb: 'Races, ordering, and state two things can change at once',
    when: 'Async code, shared state, retries, or anything two users can do at once.',
    focus:
      'Read the change for what happens when things overlap or arrive out of order. Two requests, tabs, processes or async tasks that read, decide and write the same state; a check-then-act with an await or I/O in between; a response applied after a newer one, or after the component or session it belongs to is gone; a handler that runs twice (double click, retry, reconnect) and is not idempotent; writes that must land together with no transaction or lock; a stale closure; shutdown or cancellation that leaves work half done; an optimistic update with no rollback on failure. Each finding gives the interleaving step by step: who does what, in what order, and the state it leaves. A race that needs timing nothing in this code produces is not a finding. Single-threaded logic bugs belong to another reviewer.',
    builtIn: true,
  },
  {
    id: 'naming',
    name: 'Naming & readability',
    blurb: 'Where a reader would misread the code or have to read it twice',
    when: 'When the code is hard to follow on a first read.',
    focus:
      "Read the change as someone new to it would. Flag a name that says something the code does not do, or too little to tell two things apart (data, info, handle, process, utils, result2); a name padded with what its type or module already says; a boolean or number argument whose meaning is invisible at the call site; a function doing two unrelated things under one name; a condition that takes a moment to decode and would read better named; a bare magic value; control flow that jumps around where a straight sequence would do. Flag only what a reader would likely get wrong or have to re-read, and give the replacement name or shape. Matching the codebase's own naming belongs to the conventions reviewer; making the code shorter belongs to the simplicity reviewer.",
    builtIn: true,
  },
  {
    id: 'data',
    name: 'Data & migrations',
    blurb: 'What happens to data already stored, and to data written from now on',
    when: 'Migrations, stored files, caches or settings that outlive the process.',
    focus:
      'Read the change for what it does to data that outlives the process: database tables and migrations, files on disk, caches, local storage, saved settings, queued messages. Flag a migration that fails or loses data on rows that already exist (nulls, duplicates, old values); one with no way back where a rollback is likely; a new field that old data lacks, with no default or fallback on read; data written in a shape an older or newer version of the app cannot read; a write spread over steps with no transaction, leaving partial state on failure; a delete or overwrite with no recovery; a query that now scans what it used to look up. Name the existing row or file that breaks and how. Other code that reads the data belongs to the blast radius reviewer.',
    builtIn: true,
  },
  {
    id: 'docs',
    name: 'Docs & changelog',
    blurb: 'User-facing changes the docs, help text and changelog do not reflect yet',
    when: 'User-facing changes: flags, commands, defaults, anything the docs describe.',
    focus:
      'Read the change for what a user or contributor would now find wrong in the words around the code. A flag, command, option, setting, default, endpoint or behaviour that changed or was added while the README, docs pages, --help text, error hints, examples or changelog still describe the old one; an example that no longer runs; a changelog entry that misdescribes the change, or none where the project keeps one; an install, build or test step that changed without a word. Quote the stale sentence by file and line and say what it should say now. Comments inside the code belong to the comments reviewer; leave prose style alone.',
    builtIn: true,
  },
  {
    id: 'accessibility',
    name: 'Accessibility',
    blurb: 'UI changes that shut out keyboard, screen reader or low-vision users',
    when: 'UI changes: buttons, dialogs, forms, focus.',
    focus:
      "Read the change's UI for who cannot use it. A clickable element that is not a button or link, or that the keyboard cannot reach or operate; focus that is lost, trapped or invisible after something opens, closes or updates; an icon-only control or an input with no accessible name; ARIA state (expanded, selected, checked, pressed) hard-coded instead of tied to the real state; meaning carried by colour alone; text or controls with too little contrast; motion with no reduced-motion path; a live update a screen reader never hears. Name the element and the user action that fails. If the change touches no UI, say so and stop. Visual design and copy belong to other reviewers.",
    builtIn: true,
  },
]

const flat = (value: unknown): string =>
  typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : ''

/**
 * The reviewer's own roles, as stored or as the dialog sends them: the whole
 * list, replaced. Refused whole on a bad entry, with the reason, so a save
 * never keeps half of what was sent.
 */
export function parseCustomRoles(
  value: unknown,
): { ok: true; roles: ReviewerRole[] } | { ok: false; error: string } {
  if (!Array.isArray(value)) return { ok: false, error: 'roles must be a list' }
  if (value.length > CUSTOM_ROLES_MAX) {
    return { ok: false, error: `keep at most ${CUSTOM_ROLES_MAX} roles of your own` }
  }
  const roles: ReviewerRole[] = []
  const taken = new Set(BUILT_IN_ROLES.map((r) => r.id))
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) {
      return { ok: false, error: 'a role is { id, name, blurb, focus }' }
    }
    const r = entry as Record<string, unknown>
    const id = parseReviewerName(r.id)
    if (!id.ok) return { ok: false, error: `role id: ${id.error}` }
    if (taken.has(id.name)) return { ok: false, error: `there is already a role "${id.name}"` }
    // A draft key names a new role's conversation before the role exists:
    // a role under one would share that conversation.
    if (isDraftRoleKey(id.name)) {
      return { ok: false, error: `role id: "${id.name}" is kept for drafts` }
    }
    // One rule per field: the same one an agent's edit is held to.
    const fields = parseRolePatch({ name: r.name, blurb: r.blurb ?? '', focus: r.focus })
    if (!fields.ok) return { ok: false, error: `role "${id.name}": ${fields.error}` }
    const { name, blurb = '', focus } = fields.patch
    if (name === undefined) return { ok: false, error: `role "${id.name}" needs a name` }
    if (focus === undefined) return { ok: false, error: `role "${name}" needs what it looks for` }
    taken.add(id.name)
    roles.push({ id: id.name, name, blurb, focus })
  }
  return { ok: true, roles }
}

/**
 * Which roles the human keeps in the Add reviewer picker: their word on each,
 * over the default (the quick picks and their own roles are active; the other
 * built-ins wait in the library on the Reviewer agents page).
 */
export interface RoleActivity {
  on: string[]
  off: string[]
}

export function isActiveRole(role: ReviewerRole, activity: RoleActivity): boolean {
  if (activity.off.includes(role.id)) return false
  if (activity.on.includes(role.id)) return true
  return !role.builtIn || role.quick === true
}

/** A stored activity, read leniently: anything that is not a list of ids is none. */
export function parseRoleActivity(value: unknown): RoleActivity {
  const ids = (list: unknown) =>
    Array.isArray(list) ? list.filter((id): id is string => typeof id === 'string') : []
  const v = typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
  return { on: ids(v.on), off: ids(v.off) }
}

/** Every role on offer: the built-ins, then the reviewer's own. */
export function allRoles(custom: readonly ReviewerRole[]): ReviewerRole[] {
  return [...BUILT_IN_ROLES, ...custom]
}

export function findRole(custom: readonly ReviewerRole[], id: string): ReviewerRole | undefined {
  return allRoles(custom).find((r) => r.id === id)
}

/**
 * The conversation about a role (Reviewer agents page): the reviewer asks the
 * author agent to make a role or change one, and the agent answers through
 * `diffo role update` (an edit, recorded with the values before, for undo) or
 * `diffo role reply`. Kept beside the roles, per human, keyed by role id.
 *
 * A new role has no id until the agent makes one from the role's name, so its
 * conversation starts under a draft key the page mints (`draft-<8 hex>`).
 * When the agent makes the role, its answer lands in that draft with the new
 * role's id, and the conversation carries on under the role.
 */
export type RoleField = 'name' | 'blurb' | 'focus'

export type RoleDraft = Pick<ReviewerRole, RoleField>

export const ROLE_FIELDS: readonly RoleField[] = ['name', 'blurb', 'focus']

export const ROLE_MESSAGE_MAX = 2000
/** A thread keeps its newest messages, this many. */
export const ROLE_THREAD_MAX = 200

export interface RoleChange {
  /** The fields the agent set. */
  fields: RoleField[]
  /** Their values before, for undo. Empty when the role was made. */
  before: Partial<RoleDraft>
  /** The agent made a role with this message. */
  created?: boolean
  /** The role it made, when that is not the thread's own: a copy of a
   * built-in, or the role a draft became. */
  roleId?: string
}

export interface RoleMessage {
  id: string
  author: 'reviewer' | 'agent'
  text: string
  at: string
  change?: RoleChange
}

/** One conversation about a role, kept under the role's id (or a new
 * role's draft key): the key says whose it is. */
export interface RoleThread {
  messages: RoleMessage[]
}

export type RoleThreads = Record<string, RoleThread>

const DRAFT_KEY = /^draft-[0-9a-f]{8}$/

/** The key of a new role's conversation, before the role has an id. */
export const isDraftRoleKey = (key: string): boolean => DRAFT_KEY.test(key)

/** The stored conversations, read leniently: a bad one is dropped alone. */
export function normalizeRoleThreads(value: unknown): RoleThreads {
  return normalizeConversations(
    value,
    (id) => parseReviewerName(id).ok,
    (raw) =>
      normalizeConversationMessage(raw, ROLE_FIELDS, (c) =>
        typeof c.roleId === 'string' && parseReviewerName(c.roleId).ok ? { roleId: c.roleId } : {},
      ),
    (_key, messages) => ({ messages }),
  )
}

/**
 * The fields an agent's `diffo role update` sends: any subset of the three,
 * each held to a role's limits. Refused rather than cut, so the agent hears
 * what was too long instead of finding its focus trimmed mid-sentence.
 */
export function parseRolePatch(
  raw: unknown,
): { ok: true; patch: Partial<RoleDraft> } | { ok: false; error: string } {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, error: 'expected { name?, blurb?, focus? }' }
  }
  const p = raw as Record<string, unknown>
  for (const key of ROLE_FIELDS) {
    if (p[key] !== undefined && typeof p[key] !== 'string') {
      return { ok: false, error: `"${key}" must be a string` }
    }
  }
  const patch: Partial<RoleDraft> = {}
  if (p.name !== undefined) {
    const name = flat(p.name)
    if (name === '') return { ok: false, error: 'a role needs a "name"' }
    if (name.length > ROLE_NAME_MAX) {
      return { ok: false, error: `keep "name" under ${ROLE_NAME_MAX} characters` }
    }
    patch.name = name
  }
  if (p.blurb !== undefined) {
    const blurb = flat(p.blurb)
    if (blurb.length > ROLE_BLURB_MAX) {
      return { ok: false, error: `keep "blurb" to one line under ${ROLE_BLURB_MAX} characters` }
    }
    patch.blurb = blurb
  }
  if (p.focus !== undefined) {
    const focus = (p.focus as string).trim()
    if (focus === '') return { ok: false, error: 'a role needs a "focus": what it looks for' }
    if (focus.length > ROLE_FOCUS_MAX) {
      return { ok: false, error: `keep "focus" under ${ROLE_FOCUS_MAX} characters` }
    }
    patch.focus = focus
  }
  if (Object.keys(patch).length === 0)
    return { ok: false, error: 'nothing to change: send a field' }
  return { ok: true, patch }
}

/**
 * An id for a new role, from the name the reviewer gave it: lowercase, dashes
 * for everything else, numbered when the plain one is taken. Null when the
 * name has nothing an id can be made of.
 */
export function roleIdFor(name: string, taken: ReadonlySet<string>): string | null {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 20)
    .replace(/-+$/, '')
  if (base === '') return null
  for (let n = 1; n < 100; n++) {
    const id = n === 1 ? base : `${base}-${n}`
    if (!taken.has(id) && !isDraftRoleKey(id) && parseReviewerName(id).ok) return id
  }
  return null
}

/** Every set on offer: the built-ins, then the reviewer's own. */
export function allSets(custom: readonly ReviewerSet[]): ReviewerSet[] {
  return [...BUILT_IN_SETS, ...custom]
}

export function findSet(custom: readonly ReviewerSet[], id: string): ReviewerSet | undefined {
  return allSets(custom).find((s) => s.id === id)
}

/** An id for a new set, from its name: a role's rules, and never a built-in
 * set's id or the word that means "the agent picks". */
export function setIdFor(name: string, taken: ReadonlySet<string>): string | null {
  return roleIdFor(name, new Set([...taken, AGENT_PICKS_SET, ...BUILT_IN_SETS.map((s) => s.id)]))
}

/**
 * The reviewer's own sets, as stored or as the page sends them: the whole
 * list, replaced. A set the page just made has no id yet and gets one from
 * its name. Refused whole on a bad entry, with the reason. `known` is every
 * role there is: a set names real roles, at least one.
 */
export function parseCustomSets(
  value: unknown,
  known: ReadonlySet<string>,
): { ok: true; sets: ReviewerSet[] } | { ok: false; error: string } {
  if (!Array.isArray(value)) return { ok: false, error: 'expected a list of sets' }
  if (value.length > CUSTOM_SETS_MAX) {
    return { ok: false, error: `keep at most ${CUSTOM_SETS_MAX} sets of your own` }
  }
  const given = new Set<string>()
  for (const raw of value) {
    const id = (raw as { id?: unknown } | null)?.id
    if (typeof id === 'string') given.add(id)
  }
  const seen = new Set<string>()
  const sets: ReviewerSet[] = []
  for (const raw of value) {
    if (typeof raw !== 'object' || raw === null) return { ok: false, error: 'a set is an object' }
    const v = raw as Record<string, unknown>
    const name = flat(v.name)
    if (name === '') return { ok: false, error: 'a set needs a name' }
    if (name.length > SET_NAME_MAX) {
      return { ok: false, error: `keep a set's name under ${SET_NAME_MAX} characters` }
    }
    const when = flat(v.when)
    if (when.length > SET_WHEN_MAX) {
      return {
        ok: false,
        error: `keep "when to use it" to one line under ${SET_WHEN_MAX} characters`,
      }
    }
    const roles = Array.isArray(v.roles)
      ? [...new Set(v.roles.filter((r): r is string => typeof r === 'string'))]
      : []
    if (roles.length === 0) return { ok: false, error: `set "${name}" needs at least one agent` }
    const stranger = roles.find((r) => !known.has(r))
    if (stranger !== undefined) {
      return {
        ok: false,
        error: `set "${name}" names "${stranger}", which is not a reviewer agent`,
      }
    }
    let id: string
    if (typeof v.id === 'string' && v.id !== '') {
      const parsed = parseReviewerName(v.id)
      if (!parsed.ok) return { ok: false, error: `set id "${v.id}": ${parsed.error}` }
      if (parsed.name === AGENT_PICKS_SET || BUILT_IN_SETS.some((s) => s.id === parsed.name)) {
        return { ok: false, error: `"${parsed.name}" is a built-in set's id` }
      }
      id = parsed.name
    } else {
      const made = setIdFor(name, new Set([...given, ...seen]))
      if (made === null) {
        return { ok: false, error: `set "${name}" needs a letter or a digit in its name` }
      }
      id = made
    }
    if (seen.has(id)) return { ok: false, error: `two sets share the id "${id}"` }
    seen.add(id)
    sets.push({ id, name, when, roles })
  }
  return { ok: true, sets }
}

/**
 * The stored sets, read leniently: a bad entry is dropped alone, and so is a
 * role that is gone (a set outlives a role of the human's it named). A set
 * left with no role is dropped too. Every drop goes to `report`: a set that
 * vanished without a word is erased for good by the next save, which writes
 * the list as it was read. A set saved before a built-in took its id is kept,
 * as `my-<id>` (or `my-<id>-2`, …).
 */
export function readCustomSets(
  value: unknown,
  known: ReadonlySet<string>,
  report: (message: string) => void = () => {},
): ReviewerSet[] {
  if (!Array.isArray(value)) return []
  const builtIn = new Set([AGENT_PICKS_SET, ...BUILT_IN_SETS.map((s) => s.id)])
  const idOf = (raw: unknown) => (raw as { id?: unknown } | null)?.id
  const taken = new Set([
    ...builtIn,
    ...value.flatMap((raw) => (typeof idOf(raw) === 'string' ? [idOf(raw) as string] : [])),
  ])
  const sets: ReviewerSet[] = []
  for (const [i, raw] of value.entries()) {
    const id = idOf(raw)
    const dropped = (why: string) =>
      report(`dropped saved reviewer set ${JSON.stringify(id ?? null)}: ${why}`)
    if (i >= CUSTOM_SETS_MAX) {
      dropped(`past the ${CUSTOM_SETS_MAX}-set limit`)
      continue
    }
    let entry: unknown = raw
    if (typeof raw === 'object' && raw !== null && typeof id === 'string' && builtIn.has(id)) {
      const base = `my-${id}`.slice(0, 21)
      let next = base
      for (let n = 2; taken.has(next); n++) next = `${base}-${n}`
      taken.add(next)
      entry = { ...raw, id: next }
    }
    const roles: unknown = (entry as { roles?: unknown } | null)?.roles
    const kept = Array.isArray(roles)
      ? { ...(entry as object), roles: roles.filter((r) => typeof r === 'string' && known.has(r)) }
      : entry
    const parsed = parseCustomSets([kept], known)
    if (!parsed.ok) {
      dropped(parsed.error)
      continue
    }
    const set = parsed.sets[0]!
    if (sets.some((s) => s.id === set.id)) {
      dropped('its id is taken')
      continue
    }
    sets.push(set)
  }
  return sets
}

/** The default as stored: a set that exists, or the agent's pick. */
export function parseSetDefault(value: unknown, custom: readonly ReviewerSet[]): string {
  return typeof value === 'string' && findSet(custom, value) ? value : AGENT_PICKS_SET
}
