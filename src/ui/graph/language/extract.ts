import type { Node } from 'web-tree-sitter'

/**
 * The functions of one source file and the calls in their bodies, read from a
 * tree-sitter tree. It records what the text says and resolves nothing:
 * `resolve.ts` decides which function a call means.
 */

export type GraphLang = 'cpp' | 'ts'

export interface CallSite {
  /**
   * `call`: a call expression. `new`: a `new X(...)`. `bind`: a C++
   * `&Function` in the arguments of a call, the function of a callback.
   */
  kind: 'call' | 'new' | 'bind'
  /** The callee as written: `this.foo`, `ns::Foo`, `member_->Run`. */
  text: string
  /** 1-based line of the call. */
  line: number
  /** C++: the callee text of each call that has this site in its arguments,
   * the nearest call first. */
  enc?: string[]
  /** C++ `call`: the arguments as written, on one line. */
  args?: string
  /** C++: the left side of the assignment or the declaration that holds the
   * site, when there is one. */
  lhs?: string
}

export interface FunctionInfo {
  /** Full name: `ns::Class::Method` in C++, `Class.method` in TypeScript. */
  name: string
  /** The parameter list as written, on one line. */
  params: string
  /** 1-based first and last line of the function. */
  first: number
  last: number
  /** A definition has a body. A declaration does not. */
  kind: 'def' | 'decl'
  /** The class of a method: `Class`, or `Outer::Inner`. */
  cls?: string
  /** C++: the function is made by a macro. The name of the macro, its
   * arguments, and the scope (namespaces) of the use. */
  macro?: { name: string; args: string[]; scope: string }
  /** C++: the initializer list of a constructor: the member, and the text
   * that it gets. `Job(F done) : done_(std::move(done))`. */
  inits?: { member: string; value: string }[]
  /** C++: the method has `override` or `final`. */
  override?: boolean
  /** C++: the base classes of the class of a method in a class body. */
  bases?: string[]
  calls: CallSite[]
}

const LANG_BY_EXT: Record<string, GraphLang> = {
  cc: 'cpp',
  cpp: 'cpp',
  cxx: 'cpp',
  h: 'cpp',
  hh: 'cpp',
  hpp: 'cpp',
  mm: 'cpp',
  ts: 'ts',
  mts: 'ts',
  cts: 'ts',
  tsx: 'ts',
  js: 'ts',
  mjs: 'ts',
  cjs: 'ts',
  jsx: 'ts',
}

/**
 * The grammar that parses a file. A file with JSX has the TSX grammar: it is
 * a grammar of its own, because `<T>x` is a type assertion in TypeScript and
 * the start of an element in TSX. The language of the file is TypeScript for
 * the two: the functions and the calls are the same.
 */
export type Grammar = 'cpp' | 'ts' | 'tsx'

/** The language of the graph for a path, or null when the graph does not read
 * that kind of file. */
export function graphLang(path: string): GraphLang | null {
  const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase()
  return LANG_BY_EXT[ext] ?? null
}

/** The grammar for a path, or null when the graph does not read that kind
 * of file. */
export function graphGrammar(path: string): Grammar | null {
  const lang = graphLang(path)
  return lang === 'ts' && /\.[jt]sx$/i.test(path) ? 'tsx' : lang
}

function oneLine(text: string): string {
  return text
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/([([<]) /g, '$1')
}

function kids(node: Node): Node[] {
  return node.children.filter((c): c is Node => c !== null)
}

const STATEMENT = new Set([
  'expression_statement',
  'declaration',
  'return_statement',
  'compound_statement',
  'field_declaration',
])

/** The left side of the assignment or the declaration that holds a node. */
function lhsOf(node: Node): string | undefined {
  for (let n = node.parent; n !== null && !STATEMENT.has(n.type); n = n.parent) {
    const left =
      n.type === 'assignment_expression'
        ? n.childForFieldName('left')
        : n.type === 'init_declarator'
          ? n.childForFieldName('declarator')
          : null
    if (left !== null) return oneLine(left.text)
  }
  return undefined
}

function collectCalls(
  node: Node | null,
  lang: GraphLang,
  out: CallSite[],
  enc: readonly string[] = [],
): void {
  if (node === null) return
  const line = node.startPosition.row + 1
  const cpp = lang === 'cpp'
  if (node.type === 'call_expression') {
    const fn = node.childForFieldName('function')
    if (fn !== null) {
      const name = oneLine(fn.text)
      const args = node.childForFieldName('arguments')
      const lhs = cpp ? lhsOf(node) : undefined
      out.push(
        cpp
          ? {
              kind: 'call',
              text: name,
              line,
              enc: [...enc],
              args: oneLine(args?.text ?? ''),
              ...(lhs !== undefined ? { lhs } : {}),
            }
          : { kind: 'call', text: name, line },
      )
      for (const child of kids(node)) {
        collectCalls(child, lang, out, args !== null && child.id === args.id ? [name, ...enc] : enc)
      }
      return
    }
  } else if (
    cpp &&
    node.type === 'pointer_expression' &&
    node.text.startsWith('&') &&
    node.parent?.type === 'argument_list'
  ) {
    const arg = node.childForFieldName('argument')
    if (arg !== null && (arg.type === 'qualified_identifier' || arg.type === 'identifier')) {
      const lhs = lhsOf(node)
      out.push({
        kind: 'bind',
        text: oneLine(arg.text),
        line,
        enc: [...enc],
        ...(lhs !== undefined ? { lhs } : {}),
      })
    }
  } else if (lang === 'ts' && node.type === 'new_expression') {
    const ctor = node.childForFieldName('constructor')
    if (ctor !== null) out.push({ kind: 'new', text: oneLine(ctor.text), line })
  } else if (cpp && node.type === 'new_expression') {
    const type = node.childForFieldName('type')
    if (type !== null) {
      const lhs = lhsOf(node)
      const args = node.childForFieldName('arguments')
      out.push({
        kind: 'new',
        text: oneLine(type.text),
        line,
        enc: [...enc],
        args: oneLine(args?.text ?? ''),
        ...(lhs !== undefined ? { lhs } : {}),
      })
    }
  }
  for (const child of kids(node)) collectCalls(child, lang, out, enc)
}

function cppScope(node: Node): string {
  const parts: string[] = []
  for (let n = node.parent; n !== null; n = n.parent) {
    if (n.type === 'class_specifier' || n.type === 'struct_specifier') {
      const name = n.childForFieldName('name')
      if (name !== null) parts.push(name.text)
    } else if (n.type === 'namespace_definition') {
      const name = n.childForFieldName('name')
      parts.push(name !== null ? name.text : '(anonymous)')
    }
  }
  return parts.reverse().join('::')
}

function cppClass(node: Node): string {
  const parts: string[] = []
  for (let n = node.parent; n !== null; n = n.parent) {
    if (n.type === 'class_specifier' || n.type === 'struct_specifier') {
      const name = n.childForFieldName('name')
      if (name !== null) parts.push(name.text)
    }
  }
  return parts.reverse().join('::')
}

/** The initializer list of a constructor. */
function cppInits(node: Node): { member: string; value: string }[] {
  const list = kids(node).find((c) => c.type === 'field_initializer_list')
  if (list === undefined) return []
  const out: { member: string; value: string }[] = []
  for (const init of kids(list)) {
    if (init.type !== 'field_initializer') continue
    const parts = kids(init)
    const member = parts[0]
    const value = parts[parts.length - 1]
    if (member === undefined || value === undefined || member.id === value.id) continue
    out.push({ member: oneLine(member.text), value: oneLine(value.text) })
  }
  return out
}

/** The base classes of the class body that holds a node. */
function cppBases(node: Node): string[] {
  for (let n = node.parent; n !== null; n = n.parent) {
    if (n.type !== 'class_specifier' && n.type !== 'struct_specifier') continue
    const clause = kids(n).find((c) => c.type === 'base_class_clause')
    if (clause === undefined) return []
    return oneLine(clause.text)
      .replace(/^:/, '')
      .split(',')
      .map((b) => b.replace(/\b(public|protected|private|virtual)\b/g, '').trim())
      .filter((b) => b !== '')
  }
  return []
}

function cppFunctionDeclarator(node: Node): Node | null {
  let d = node.childForFieldName('declarator')
  while (d !== null && d.type !== 'function_declarator') d = d.childForFieldName('declarator')
  return d
}

/** A macro that makes a function: `NAME(a, b) { ... }`. */
const MACRO_NAME = /^[A-Z][A-Z0-9_]*$/
const MACRO_ARGS = /^\(\s*(\w+(?:\s*,\s*\w+)*)?\s*\)$/

function cppFunctions(root: Node): FunctionInfo[] {
  const rows: FunctionInfo[] = []
  const add = (node: Node, body: Node | null): void => {
    const d = cppFunctionDeclarator(node)
    if (d === null) return
    const nameNode = d.childForFieldName('declarator')
    const params = d.childForFieldName('parameters')
    if (nameNode === null || params === null) return
    const scope = cppScope(node)
    const name = oneLine(nameNode.text)
    const calls: CallSite[] = []
    collectCalls(body, 'cpp', calls)
    // A macro that makes a function reads as a function with the name of the
    // macro: `TEST_F(Fixture, Name) { ... }`. Each use would have the same
    // name, so the name is the use as written. What the macro means is not
    // known here: a library gives that (`CppIdioms.testMacro`).
    const args = MACRO_NAME.test(name) && body !== null ? MACRO_ARGS.exec(params.text) : null
    const macro = args
      ? {
          name,
          args: (args[1] ?? '')
            .split(',')
            .map((a) => a.trim())
            .filter(Boolean),
          scope,
        }
      : undefined
    const own = macro ? `${name}(${macro.args.join(', ')})` : name
    // A method in the body of its class, or a definition with the class in
    // its name: `Class::Method`.
    const cls = own.includes('::') ? own.slice(0, own.lastIndexOf('::')) : cppClass(node)
    const bases = cppBases(node)
    const inits = cppInits(node)
    rows.push({
      ...(inits.length > 0 ? { inits } : {}),
      ...(cls ? { cls } : {}),
      ...(macro ? { macro } : {}),
      ...(kids(d).some((c) => c.type === 'virtual_specifier') ? { override: true } : {}),
      ...(bases.length > 0 ? { bases } : {}),
      name: scope ? `${scope}::${own}` : own,
      params: oneLine(params.text),
      first: node.startPosition.row + 1,
      last: node.endPosition.row + 1,
      kind: body !== null ? 'def' : 'decl',
      calls,
    })
  }
  const walk = (node: Node): void => {
    if (node.type === 'function_definition') {
      // Functions inside a body (lambdas) stay part of this function.
      add(node, node.childForFieldName('body'))
      return
    }
    if (
      (node.type === 'declaration' || node.type === 'field_declaration') &&
      cppFunctionDeclarator(node) !== null
    ) {
      add(node, null)
      return
    }
    for (const child of kids(node)) walk(child)
  }
  walk(root)
  return rows
}

const TS_CLASS = new Set([
  'class_declaration',
  'class',
  'abstract_class_declaration',
  'interface_declaration',
])

function tsScope(node: Node): string {
  const parts: string[] = []
  for (let n = node.parent; n !== null; n = n.parent) {
    if (TS_CLASS.has(n.type)) {
      const name = n.childForFieldName('name')
      if (name !== null) parts.push(name.text)
    }
  }
  return parts.reverse().join('.')
}

const TS_METHOD = new Set([
  'method_definition',
  'function_declaration',
  'method_signature',
  'abstract_method_signature',
])

function tsFunctions(root: Node): FunctionInfo[] {
  const rows: FunctionInfo[] = []
  const add = (node: Node, nameNode: Node, fn: Node): void => {
    const params = fn.childForFieldName('parameters')
    const body = fn.childForFieldName('body')
    const scope = tsScope(node)
    const calls: CallSite[] = []
    collectCalls(body, 'ts', calls)
    rows.push({
      ...(scope ? { cls: scope } : {}),
      name: scope ? `${scope}.${nameNode.text}` : nameNode.text,
      params: params !== null ? oneLine(params.text) : '()',
      first: node.startPosition.row + 1,
      last: node.endPosition.row + 1,
      kind: body !== null ? 'def' : 'decl',
      calls,
    })
  }
  const walk = (node: Node): void => {
    if (TS_METHOD.has(node.type)) {
      const name = node.childForFieldName('name')
      if (name !== null) add(node, name, node)
      return
    }
    if (node.type === 'variable_declarator') {
      const value = node.childForFieldName('value')
      const name = node.childForFieldName('name')
      const top = node.parent?.parent?.type
      if (
        value !== null &&
        name !== null &&
        (value.type === 'arrow_function' || value.type === 'function_expression') &&
        (top === 'program' || top === 'export_statement') &&
        node.parent !== null
      ) {
        add(node.parent, name, value)
        return
      }
    }
    for (const child of kids(node)) walk(child)
  }
  walk(root)
  return rows
}

/** The functions of a parsed file, in source order. */
export function extractFunctions(root: Node, grammar: Grammar): FunctionInfo[] {
  return grammar === 'cpp' ? cppFunctions(root) : tsFunctions(root)
}
