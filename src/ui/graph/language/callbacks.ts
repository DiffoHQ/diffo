import type { CallSite } from './extract.js'
import { type CppIdioms, STD_CPP } from './idioms.js'
import { type GraphFunction, RECEIVER, type Resolver, scope, short } from './resolve.js'

/**
 * The callback join, for C++. A callback has two sites: the bind site, where
 * a bind (`std::bind(&Function, ...)`) names the function, and the run site,
 * where `callback(...)` runs it. The names of the bind and of the run are data
 * of the repo (`idioms.ts`). The script follows the callback from its bind
 * site to its run sites through at most one of these:
 *
 * - a parameter: the bind is an argument of a call, and that function runs
 *   its callback parameter;
 * - a class member: the bind is assigned to a member, or goes into a
 *   constructor, and a method of the class runs a member;
 * - a bound function: the function that gets the callback moves it into a
 *   second bind, and that function runs its callback parameter;
 * - a second function: the function that gets the callback gives it to a
 *   function or a constructor of the change, and the run sites of that one
 *   are run sites of the callback.
 *
 * There are no types, so this is the weakest join. Each edge has the method
 * `flow`. When no run site is found, the edge is at the bind site and has the
 * method `open`.
 *
 * The bind site alone is a fact: the function names a callback and gives it
 * to a call. Which code runs it is not. So without `flow`, each bind site is
 * one `open` edge with the name of the call that gets the callback, and
 * nothing is followed.
 */

export interface CallbackEdge {
  /** The function that runs the callback, or the id that `origin` gave. */
  from: string
  /** The bound function. */
  to: string
  /** The line of the run site, or of the bind site for `open`. 0 when the
   * callback is run from outside. */
  line: number
  method: 'flow' | 'open'
  /** The bind site. */
  bind: { in: string; line: number }
  /** For `open`: the name of the function that gets the callback. */
  via?: string
}

function word(name: string): RegExp {
  return new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`)
}

/** The names of the parameters that are callbacks. */
function callbackParams(params: string, callable: RegExp): string[] {
  const out: string[] = []
  let depth = 0
  let part = ''
  for (const ch of `${params.replace(/^\(|\)$/g, '')},`) {
    if (ch === '<' || ch === '(') depth++
    else if (ch === '>' || ch === ')') depth--
    if (ch !== ',' || depth > 0) {
      part += ch
      continue
    }
    const name = part.match(/\w+/g)?.pop()
    if (name !== undefined && callable.test(part)) out.push(name)
    part = ''
  }
  return out
}

/** The parts of an argument list or a parameter list, at the top level. */
function splitTop(list: string): string[] {
  const text = list.trim().replace(/^\(/, '').replace(/\)$/, '')
  const out: string[] = []
  let depth = 0
  let part = ''
  for (const ch of text) {
    if (ch === '(' || ch === '<' || ch === '[' || ch === '{') depth++
    else if (ch === ')' || ch === '>' || ch === ']' || ch === '}') depth--
    if (ch === ',' && depth === 0) {
      out.push(part.trim())
      part = ''
    } else part += ch
  }
  if (part.trim() !== '') out.push(part.trim())
  return out
}

/** The name of a parameter, from its text in the parameter list. */
function paramName(text: string | undefined): string | undefined {
  return text?.replace(/=.*$/, '').match(/\w+/g)?.pop()
}

/** The name that an argument gives as it is: `x`, `std::move(x)`. Undefined
 * for each other argument (a call, a bind, an expression). */
function passedAs(arg: string): string | undefined {
  return /^(?:std::(?:move|forward<[^()]*>)\(\s*)?(\w+)\s*\)?$/.exec(arg.trim())?.[1]
}

/** The arguments of a call without the binds in them. */
function withoutBinds(args: string, bind: RegExp): string {
  let out = ''
  let rest = args
  for (;;) {
    const m = bind.exec(rest)
    if (m === null) return out + rest
    out += rest.slice(0, m.index)
    let depth = 1
    let i = m.index + m[0].length
    for (; i < rest.length && depth > 0; i++) {
      if (rest[i] === '(') depth++
      else if (rest[i] === ')') depth--
    }
    rest = rest.slice(i)
  }
}

interface RunSite {
  fn: GraphFunction
  call: CallSite
}

export class CallbackJoin {
  private readonly cpp: GraphFunction[]

  constructor(
    functions: readonly GraphFunction[],
    private readonly resolver: Resolver,
    private readonly idioms: CppIdioms = STD_CPP,
  ) {
    this.cpp = functions.filter((f) => f.lang === 'cpp' && f.kind === 'def')
  }

  /**
   * The callback edges of all functions.
   * `outside`: for a function that hands a callback to something outside the
   * change (the dispatch of an event), the id of the node that runs it.
   * `replies`: the calls of the repo with a reply: the implementation runs its
   * callback parameter, and the flow comes back to the caller.
   */
  resolve(
    outside: (fn: GraphFunction) => string | null,
    replies: readonly { caller: GraphFunction; line: number; impl: GraphFunction }[],
  ): CallbackEdge[] {
    const flow = this.idioms.followCallbacks
    const out: CallbackEdge[] = []
    for (const f of this.cpp) {
      const origin = outside(f)
      for (const b of f.calls) {
        if (b.kind !== 'bind') continue
        if (flow && !(b.enc ?? []).some((t) => this.idioms.helper.test(t))) continue
        const target = this.resolver.cppNamed(b.text, f)
        const x = target[0]
        if (target.length !== 1 || x === undefined) continue
        const bind = { in: f.id, line: b.line }
        // The call that gets the callback: the outer one around the bind
        // site that is not a helper of the library. A call between it and
        // the bind site can be a wrapper that the library data does not
        // know.
        const around = b.enc ?? []
        const getter =
          [...around].reverse().find((t) => !this.idioms.helper.test(t)) ??
          around[around.length - 1]
        const via = getter !== undefined ? (RECEIVER.exec(getter)?.[2] ?? short(getter)) : undefined
        if (!flow) {
          // What the text tells for each C++ code: the run sites that the
          // callback gets to by the position of an argument and the name of
          // a parameter. With none, the bind site is the fact.
          const runs = this.exactRuns(f, b)
          const seen = new Set<string>()
          for (const s of runs) {
            const key = `${s.fn.id}:${s.call.line}`
            if (seen.has(key)) continue
            seen.add(key)
            out.push({ from: s.fn.id, to: x.id, line: s.call.line, method: 'flow', bind })
          }
          if (runs.length === 0 && x.id !== f.id) {
            out.push({ from: f.id, to: x.id, line: b.line, method: 'open', bind, via })
          }
          continue
        }
        const { fns, members } = this.receivers(f, b)
        const sites = [
          ...fns.flatMap((g) => this.whereRun(g, 0)),
          ...members.flatMap((m) => this.memberRuns(scope(f.name), m)),
        ]
        const seen = new Set<string>()
        for (const s of sites) {
          const key = `${s.fn.id}:${s.call.line}`
          if (seen.has(key)) continue
          seen.add(key)
          out.push({ from: s.fn.id, to: x.id, line: s.call.line, method: 'flow', bind })
        }
        const byParam = sites.some((s) => fns.includes(s.fn))
        if (origin !== null && !byParam) {
          // The function sends an event and gives the callback to an object.
          // The answer from outside runs the callback.
          out.push({ from: origin, to: x.id, line: 0, method: 'flow', bind })
        } else if (seen.size === 0) {
          out.push({ from: f.id, to: x.id, line: b.line, method: 'open', bind, via })
        }
      }
    }
    for (const r of flow ? replies : []) {
      const seen = new Set<string>()
      for (const s of this.whereRun(r.impl, 0)) {
        const key = `${s.fn.id}:${s.call.line}`
        if (seen.has(key)) continue
        seen.add(key)
        out.push({
          from: s.fn.id,
          to: r.caller.id,
          line: s.call.line,
          method: 'flow',
          bind: { in: r.caller.id, line: r.line },
        })
      }
    }
    return out
  }

  /**
   * The run sites of the callback of a bind site, with no guess. The bind is
   * argument `k` of a call to a function `g` of the change, so the callback
   * is parameter `k` of `g`. Then:
   *
   * - `g` runs that parameter;
   * - `g` gives that parameter, as it is, to a second function: the same
   *   steps for that function and that position;
   * - `g` is a constructor, and its initializer list puts that parameter in
   *   a member: a method of the class runs that member.
   */
  private exactRuns(f: GraphFunction, bind: CallSite): RunSite[] {
    for (const text of bind.enc ?? []) {
      if (this.idioms.helper.test(text)) continue
      const g = this.oneByText(text, f)
      if (g === null) return []
      // The call to `g` that has the bind site in its arguments.
      const call = [...f.calls]
        .reverse()
        .find(
          (c) =>
            c.kind === 'call' &&
            c.text === text &&
            c.line <= bind.line &&
            (c.args ?? '').includes(`&${bind.text}`),
        )
      if (call === undefined) return []
      const k = splitTop(call.args ?? '').findIndex((a) => a.includes(`&${bind.text}`))
      return k < 0 ? [] : this.runsOfParam(g, k, 0)
    }
    return []
  }

  /** The run sites of the parameter at position `k` of `g`. */
  private runsOfParam(g: GraphFunction, k: number, depth: number): RunSite[] {
    const param = paramName(splitTop(g.params)[k])
    if (param === undefined) return []
    const out: RunSite[] = this.runSites(g)
      .filter((s) => s.ident === param)
      .map((s) => ({ fn: g, call: s.call }))
    // A constructor: the initializer list puts the parameter in a member.
    const cls = scope(g.name)
    for (const init of g.inits ?? []) {
      if (passedAs(init.value.replace(/^[({]|[)}]$/g, '')) !== param) continue
      for (const h of this.cpp) {
        if (h === g || scope(h.name) !== cls) continue
        out.push(
          ...this.runSites(h)
            .filter((s) => s.ident === init.member)
            .map((s) => ({ fn: h, call: s.call })),
        )
      }
    }
    // The parameter goes, as it is, to a second function of the change.
    if (depth < 3) {
      for (const c of g.calls) {
        if (c.kind !== 'call' && c.kind !== 'new') continue
        if (this.idioms.helper.test(c.text)) continue
        const at = splitTop(c.args ?? '').findIndex((a) => passedAs(a) === param)
        if (at < 0) continue
        const h = this.oneByText(c.text, g)
        if (h && h !== g) out.push(...this.runsOfParam(h, at, depth + 1))
      }
    }
    return out
  }

  /** The one function of the change that a call means, from the text of the
   * call. A target from the style of a repository counts only with that
   * style. */
  private oneByText(text: string, caller: GraphFunction): GraphFunction | null {
    const hit = this.resolver.cppTarget(text, caller)
    if (hit === null || hit.targets.length !== 1) return null
    if (hit.method === 'name' && !this.idioms.receiverNamesClass) return null
    return hit.targets[0] ?? null
  }

  private runSites(f: GraphFunction): { call: CallSite; ident: string }[] {
    const out: { call: CallSite; ident: string }[] = []
    for (const call of f.calls) {
      const m = call.kind === 'call' ? this.idioms.run.exec(call.text) : null
      const ident = m?.[1] ?? m?.[2]
      if (ident !== undefined) out.push({ call, ident })
    }
    return out
  }

  /** The run sites of a member of a class. Without a member name, each run of
   * a name that the style of the repository gives to a member. */
  private memberRuns(cls: string, member?: string): RunSite[] {
    return this.cpp
      .filter((h) => scope(h.name) === cls)
      .flatMap((h) =>
        this.runSites(h)
          .filter((s) =>
            member !== undefined ? s.ident === member : this.idioms.memberName.test(s.ident),
          )
          .map((s) => ({ fn: h, call: s.call })),
      )
  }

  private one(text: string, caller: GraphFunction): GraphFunction | null {
    const hit = this.resolver.cppTarget(text, caller)
    return hit !== null && hit.targets.length === 1 ? (hit.targets[0] ?? null) : null
  }

  /** The functions that get the callback of a bind site, and the class
   * members that hold it. */
  private receivers(f: GraphFunction, bind: CallSite): { fns: GraphFunction[]; members: string[] } {
    for (const text of bind.enc ?? []) {
      if (this.idioms.helper.test(text)) continue
      const g = this.one(text, f)
      if (g) return { fns: [g], members: [] }
      // The callback goes into a second callback: see the left side.
      if (this.idioms.run.test(text) || this.idioms.chain.test(text)) break
      return { fns: [], members: [] }
    }
    const name = bind.lhs?.match(/\w+/g)?.pop()
    if (name === undefined) return { fns: [], members: [] }
    if (this.idioms.memberName.test(name)) return { fns: [], members: [name] }
    // A local variable. The call that gets the variable gets the callback.
    const fns: GraphFunction[] = []
    for (const c of f.calls) {
      if (c.kind !== 'call' || c.line < bind.line || !word(name).test(c.args ?? '')) continue
      const text = [c.text, ...(c.enc ?? [])].find((t) => !this.idioms.helper.test(t))
      const g = text !== undefined ? this.one(text, f) : null
      if (g) fns.push(g)
    }
    return { fns, members: [] }
  }

  /** The run sites of a callback that the function `g` gets as a parameter. */
  private whereRun(g: GraphFunction, depth: number): RunSite[] {
    if (!this.idioms.callable.test(g.params)) return []
    const out: RunSite[] = this.runSites(g)
      .filter((s) => word(s.ident).test(g.params))
      .map((s) => ({ fn: g, call: s.call }))
    // A constructor puts the parameter into a member. A method of the class
    // runs it.
    const cls = scope(g.name)
    if (cls !== '' && short(cls) === short(g.name)) {
      out.push(...this.memberRuns(cls).filter((s) => s.fn !== g))
    }
    if (depth < 2) {
      // The parameter goes into a second function or a constructor.
      const names = callbackParams(g.params, this.idioms.callable)
      const next = new Set<GraphFunction>()
      for (const c of g.calls) {
        if (c.kind !== 'call' || this.idioms.helper.test(c.text)) continue
        // A parameter inside a bind is part of a new callback: not this one.
        const direct = withoutBinds(c.args ?? '', this.idioms.bind)
        if (!names.some((n) => word(n).test(direct))) continue
        const h = this.one(c.text, g)
        if (h && h !== g) next.add(h)
      }
      for (const h of next) out.push(...this.whereRun(h, depth + 1))
      // The parameter goes into a bound function, which runs it.
      const moved = g.calls.filter(
        (c) =>
          c.kind === 'call' &&
          c.text === 'std::move' &&
          this.idioms.helper.test(c.enc?.[0] ?? '') &&
          word((c.args ?? '').replace(/[()\s]/g, '') || '\0').test(g.params),
      )
      for (const b of g.calls) {
        if (b.kind !== 'bind' || moved.length === 0) continue
        const same = moved.some(
          (c) =>
            Math.abs(c.line - b.line) <= 5 && (c.enc ?? []).join('|') === (b.enc ?? []).join('|'),
        )
        if (!same) continue
        const y = this.resolver.cppNamed(b.text, g)
        const fn = y[0]
        if (y.length !== 1 || fn === undefined) continue
        out.push(
          ...this.runSites(fn)
            .filter((s) => word(s.ident).test(fn.params))
            .map((s) => ({ fn, call: s.call })),
        )
      }
    }
    return out
  }
}
