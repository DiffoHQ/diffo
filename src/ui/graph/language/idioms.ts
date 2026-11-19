/**
 * What the language steps must be told about C++ code, because the language
 * does not tell it: the names of a library (how it binds a callable, runs it
 * and makes an object) and the style of a repository (how it names things).
 * The rules of `callbacks.ts`, `objects.ts` and `resolve.ts` are the same for
 * each repository. Only this data changes, so a repository gives it.
 *
 * `STD_CPP` is the language layer: the standard library and no style. It is
 * true for each C++ repository.
 */
export interface CppIdioms {
  /** The callee of a call that only wraps its arguments: a bind, a move. It
   * is not a step of the flow of a value. */
  helper: RegExp
  /** The start of a bind in the text of an argument list, with its `(`. A
   * value inside a bind is part of a new callable. */
  bind: RegExp
  /** The callee of the run of a callable. Group 1 or group 2 is the name of
   * the callable. */
  run: RegExp
  /** The callee of a run that looks like a method call. It is not a call of
   * a method of the change. */
  runMethod: RegExp
  /** The callee of a call on a callable that makes a second callable. */
  chain: RegExp
  /** The type of a parameter that is a callable. */
  callable: RegExp
  /** The callee of a call that makes an object. Group 1 is the class. */
  make: RegExp
  /**
   * The name of a macro that makes a test of a fixture: `M(Fixture, Name)`.
   * The test is then a method `Fixture::Name`, so a call in its body finds
   * the methods of the fixture.
   */
  testMacro: RegExp
  /**
   * Style: a receiver has the name of its class (`history_service_` is a
   * `HistoryService`). Then a call on a receiver means the method of that
   * class.
   */
  receiverNamesClass: boolean
  /** Style: the name of a member of a class (`callback_`). */
  memberName: RegExp
  /**
   * Follow a callback from its bind site to the code that runs it. The
   * steps use `memberName` and the names of the parameters, with no types.
   * Without it, a bind site is one fact: the function gives the callback to
   * a call.
   */
  followCallbacks: boolean
}

/** The test macros of googletest: `TEST`, `TEST_F`, `TEST_P`, `IN_PROC_BROWSER_TEST_F`. */
export const GTEST_MACRO = /^(?:[A-Z][A-Z0-9_]*_)?TEST(?:_[A-Z]+)?$/

const NEVER = /$^/

/** The standard library: `std::function`, `std::bind`, `f()`. */
export const STD_CPP: CppIdioms = {
  helper: /^std::(bind|bind_front|move|forward<.*>|ref|cref)$/,
  bind: /\bstd::bind(?:_front)?\s*\(/,
  run: /^(?:std::move\(\s*(\w+)\s*\)|(\w+))$/,
  runMethod: NEVER,
  chain: NEVER,
  callable: /\bstd::(?:move_only_)?function\b/,
  make: /^(?:std::make_unique|std::make_shared)<\s*([\w:]+)\s*>$/,
  testMacro: NEVER,
  receiverNamesClass: false,
  memberName: NEVER,
  followCallbacks: false,
}
