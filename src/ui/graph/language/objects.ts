import { type CppIdioms, STD_CPP } from './idioms.js'
import { type GraphFunction, RECEIVER, type Resolver, short } from './resolve.js'

/**
 * The object join, for C++. An object with virtual methods carries code, as a
 * callback does: the code that gets the object can call its overrides. When a
 * function makes an object of a class of the change and gives it to a function
 * that is not in the change, the object escapes. The script cannot see which
 * override that function calls, or when, so the edge goes from the place where
 * the object escapes to each override of the class.
 *
 * There are no types. The class comes from the text that makes the object
 * (`std::make_unique<X>`, `new X`; the names are in `idioms.ts`), and the object is followed only by the
 * name of its local variable, in the function that makes it.
 */

export interface ObjectEdge {
  /** The function that makes the object and gives it away. */
  from: string
  /** An override of the class of the object. */
  to: string
  /** The line where the object escapes. */
  line: number
  /** The name of the function that gets the object. */
  via: string
}

function word(name: string): RegExp {
  return new RegExp(`\\b${name}\\b`)
}

/** `Class::Method`, without the namespaces. */
function methodKey(f: GraphFunction): string | null {
  if (f.cls === undefined) return null
  return `${short(f.cls)}::${short(f.name)}`
}

/** The overrides of each class, by the short name of the class. A method is
 * an override when its definition or its declaration says so. */
export function overridesByClass(
  functions: readonly GraphFunction[],
): Map<string, GraphFunction[]> {
  const cpp = functions.filter((f) => f.lang === 'cpp')
  const marked = new Set(cpp.filter((f) => f.override).map(methodKey))
  const out = new Map<string, GraphFunction[]>()
  for (const f of cpp) {
    if (f.kind !== 'def' || f.cls === undefined || !marked.has(methodKey(f))) continue
    const cls = short(f.cls)
    const list = out.get(cls)
    if (list) list.push(f)
    else out.set(cls, [f])
  }
  return out
}

/**
 * The functions that are overrides, each with the base classes of its class.
 * The code that calls an override calls it through a base class, so that
 * call can be outside the change. The list of bases is empty when no class
 * body of the change tells them.
 */
export function overrideBases(functions: readonly GraphFunction[]): Map<string, string[]> {
  const bases = new Map<string, string[]>()
  for (const f of functions) {
    if (f.lang === 'cpp' && f.cls !== undefined && f.bases !== undefined) {
      bases.set(short(f.cls), f.bases)
    }
  }
  const out = new Map<string, string[]>()
  for (const [cls, methods] of overridesByClass(functions)) {
    for (const m of methods) out.set(m.id, bases.get(cls) ?? [])
  }
  return out
}

export function objectEscapes(
  functions: readonly GraphFunction[],
  resolver: Resolver,
  idioms: CppIdioms = STD_CPP,
): ObjectEdge[] {
  const wraps = (text: string) => idioms.helper.test(text) || idioms.make.test(text)
  const overrides = overridesByClass(functions)
  const out: ObjectEdge[] = []
  for (const f of functions) {
    if (f.lang !== 'cpp' || f.kind !== 'def') continue
    // A call that is not a helper and that means no function of the change.
    const outside = (text: string): boolean => {
      if (wraps(text)) return false
      const hit = resolver.cppTarget(text, f)
      return hit === null || hit.targets.length === 0
    }
    const seen = new Set<string>()
    for (const made of f.calls) {
      const type = made.kind === 'new' ? made.text : idioms.make.exec(made.text)?.[1]
      const methods = type !== undefined ? overrides.get(short(type)) : undefined
      if (methods === undefined) continue
      // The object is made in the arguments of the call that gets it, or it
      // is in a local variable that a later call gets.
      let exit: { text: string; line: number } | undefined
      const direct = (made.enc ?? []).find((t) => !wraps(t))
      if (direct !== undefined) {
        if (outside(direct)) exit = { text: direct, line: made.line }
      } else {
        const name = made.lhs?.match(/\w+/g)?.pop()
        if (name === undefined) continue
        const own = new RegExp(`^${name}\\s*(?:->|\\.)`)
        const got = f.calls.find(
          (c) =>
            c.kind === 'call' &&
            c.line >= made.line &&
            c !== made &&
            !own.test(c.text) &&
            word(name).test(c.args ?? '') &&
            !wraps(c.text),
        )
        if (got !== undefined && outside(got.text)) exit = { text: got.text, line: got.line }
      }
      if (exit === undefined) continue
      const via = RECEIVER.exec(exit.text)?.[2] ?? short(exit.text)
      for (const m of methods) {
        const key = `${m.id}:${exit.line}`
        if (m.id === f.id || seen.has(key)) continue
        seen.add(key)
        out.push({ from: f.id, to: m.id, line: exit.line, via })
      }
    }
  }
  return out
}
