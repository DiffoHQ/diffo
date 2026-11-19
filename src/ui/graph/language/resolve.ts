import type { FunctionInfo, GraphLang } from './extract.js'
import { type CppIdioms, STD_CPP } from './idioms.js'

/**
 * Which function a call means, by fixed rules on the call text. There are no
 * types: a call on a receiver whose class the text does not tell makes no edge.
 * A call that the text does not show (a call across a process) is not resolved
 * here: a repo adds it (`repo/repo.ts`),
 * and a callback is not resolved.
 */

export interface GraphFunction extends FunctionInfo {
  /** Unique in the graph: `path#name@first`. */
  id: string
  path: string
  lang: GraphLang
}

export interface ResolvedCall {
  from: string
  to: string
  /** 1-based line of the call in the file of `from`. */
  line: number
  /**
   * `syntax`: the call text names the target (`this.x`, a full name).
   * `name`: the receiver name agrees with the class name of the target.
   */
  method: 'syntax' | 'name'
}

export const RECEIVER = /^([\s\S]*?)\s*(?:->|\.)\s*(\w+)$/
const QUALIFIED = /^(?:\w+::)*\w+$/

function split(name: string): string[] {
  return name.split(/::|\./)
}

export function short(name: string): string {
  const parts = split(name)
  return parts[parts.length - 1] ?? name
}

export function scope(name: string): string {
  return split(name).slice(0, -1).join('::')
}

/** A scope without the anonymous namespace. */
function plain(text: string): string {
  return text.replace(/::\(anonymous\)/g, '').replace(/\(anonymous\)::/g, '')
}

function flat(text: string): string {
  return text.replace(/_/g, '').toLowerCase()
}

function lastWord(text: string): string {
  const words = text.match(/\w+/g)
  return words ? (words[words.length - 1] ?? '') : ''
}

export class Resolver {
  private readonly cpp: GraphFunction[]
  private readonly cppShort = new Map<string, GraphFunction[]>()
  private readonly tsShort = new Map<string, GraphFunction[]>()
  private readonly tsName = new Map<string, GraphFunction[]>()

  constructor(
    functions: readonly GraphFunction[],
    private readonly idioms: CppIdioms = STD_CPP,
  ) {
    // A declaration and its definition are one function: keep the definition.
    const defined = new Set(functions.filter((f) => f.kind === 'def').map((f) => f.name))
    const kept = functions.filter(
      (f) =>
        f.kind === 'def' || ![...defined].some((d) => d === f.name || d.endsWith(`::${f.name}`)),
    )
    this.cpp = kept.filter((f) => f.lang === 'cpp')
    for (const f of this.cpp) push(this.cppShort, short(f.name), f)
    for (const f of kept.filter((f) => f.lang === 'ts')) {
      push(this.tsShort, short(f.name), f)
      push(this.tsName, f.name, f)
    }
  }

  /** The calls of `caller` that mean exactly one function. */
  resolve(caller: GraphFunction): ResolvedCall[] {
    const out: ResolvedCall[] = []
    const seen = new Set<string>()
    for (const call of caller.calls) {
      if (call.kind === 'bind') continue
      const hit =
        caller.lang === 'cpp'
          ? this.cppTarget(call.text, caller)
          : this.tsTarget(call.kind === 'new' ? 'new' : 'call', call.text, caller)
      if (hit === null || hit.targets.length !== 1) continue
      // A target from the style of a repository, not from the text.
      if (hit.method === 'name' && !this.idioms.receiverNamesClass) continue
      const to = hit.targets[0]
      if (to === undefined) continue
      const key = `${to.id}:${call.line}`
      if (seen.has(key)) continue
      seen.add(key)
      out.push({ from: caller.id, to: to.id, line: call.line, method: hit.method })
    }
    return out
  }

  /** The C++ functions that a name without a receiver can mean. */
  cppNamed(text: string, caller: GraphFunction): GraphFunction[] {
    const hits = this.cpp.filter((f) => f.name === text || f.name.endsWith(`::${text}`))
    if (hits.length < 2) return hits
    const mine = plain(scope(caller.name))
    const same = hits.filter((f) => plain(scope(f.name)) === mine)
    if (same.length > 0) return same
    const near = hits.filter((f) => {
      const theirs = plain(scope(f.name))
      return mine.startsWith(`${theirs}::`) || theirs.startsWith(`${mine}::`)
    })
    return near.length > 0 ? near : hits
  }

  cppTarget(
    text: string,
    caller: GraphFunction,
  ): { targets: GraphFunction[]; method: 'syntax' | 'name' } | null {
    if (this.idioms.runMethod.test(text)) return null // a callback, not a call
    const make = this.idioms.make.exec(text)
    if (make?.[1] !== undefined) {
      const cls = short(make[1])
      return { targets: this.cppNamed(`${cls}::${cls}`, caller), method: 'syntax' }
    }
    if (QUALIFIED.test(text)) {
      let hits = this.cppNamed(text, caller)
      if (hits.length === 0) {
        const cls = short(text)
        hits = this.cppNamed(`${cls}::${cls}`, caller) // a constructor
      }
      const mine = plain(scope(caller.name))
      const sure =
        text.includes('::') ||
        hits.some((f) => {
          const theirs = plain(scope(f.name))
          return theirs === '' || mine === theirs || mine.startsWith(`${theirs}::`)
        })
      return { targets: hits, method: sure ? 'syntax' : 'name' }
    }
    const m = RECEIVER.exec(text)
    if (m === null) return null
    const recv = (m[1] ?? '').trim()
    const name = m[2] ?? ''
    const hits = (this.cppShort.get(name) ?? []).filter((f) => short(scope(f.name)) !== name)
    if (recv === 'this') {
      const cls = scope(caller.name)
      return { targets: hits.filter((f) => scope(f.name) === cls), method: 'syntax' }
    }
    const ident = flat(lastWord(recv))
    const agree = hits.filter((f) => flat(short(scope(f.name))) === ident)
    // Without agreement, the receiver name does not tell the class: no edge.
    return agree.length > 0 ? { targets: agree, method: 'name' } : null
  }

  private tsTarget(
    kind: 'call' | 'new',
    text: string,
    caller: GraphFunction,
  ): { targets: GraphFunction[]; method: 'syntax' | 'name' } | null {
    if (kind === 'new') {
      return { targets: this.tsName.get(`${text}.constructor`) ?? [], method: 'syntax' }
    }
    const m = RECEIVER.exec(text)
    if (m === null) {
      if (!/^\w+$/.test(text)) return null
      let hits = this.tsName.get(text) ?? []
      if (hits.length > 1) {
        const here = hits.filter((f) => f.path === caller.path)
        if (here.length > 0) hits = here
      }
      return { targets: hits, method: 'syntax' }
    }
    const recv = (m[1] ?? '').trim()
    const name = m[2] ?? ''
    if (recv === 'this') {
      let cls = caller.name.includes('.') ? caller.name.slice(0, caller.name.lastIndexOf('.')) : ''
      if (cls === '') {
        // A function with a typed `this` parameter, as in a template file.
        cls = /\bthis\s*:\s*(\w+)/.exec(caller.params)?.[1] ?? ''
      }
      return { targets: this.tsName.get(`${cls}.${name}`) ?? [], method: 'syntax' }
    }
    if (/^\w+$/.test(recv)) {
      const exact = this.tsName.get(`${recv}.${name}`)
      if (exact !== undefined) return { targets: exact, method: 'syntax' }
    }
    const ident = flat(lastWord(recv))
    const agree = (this.tsShort.get(name) ?? []).filter(
      (f) => f !== caller && f.name.includes('.') && flat(short(scope(f.name))) === ident,
    )
    return agree.length > 0 ? { targets: agree, method: 'name' } : null
  }
}

function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key)
  if (list === undefined) map.set(key, [value])
  else list.push(value)
}
