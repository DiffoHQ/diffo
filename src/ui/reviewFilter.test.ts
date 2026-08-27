import { describe, expect, it } from 'vitest'
import type { FileChange } from '../shared/types.js'
import { isTestFile, reviewScope, splitFiles } from './reviewFilter.js'

function file(path: string, hunkIds: string[] = ['h1']): FileChange {
  return {
    path,
    oldPath: null,
    status: 'modified',
    kind: 'text',
    staged: false,
    hunks: hunkIds.map((id) => ({ id, path, oldStart: 1, newStart: 1, lines: [] })),
  }
}

const NONE: ReadonlySet<string> = new Set()
const paths = (files: FileChange[]) => files.map((f) => f.path)

describe('isTestFile', () => {
  it('catches the .test. / .spec. twins and __tests__ folders', () => {
    expect(isTestFile('src/a.test.ts')).toBe(true)
    expect(isTestFile('src/a.spec.tsx')).toBe(true)
    expect(isTestFile('src/__tests__/a.ts')).toBe(true)
    expect(isTestFile('src/a.ts')).toBe(false)
    expect(isTestFile('src/testing/a.ts')).toBe(false)
  })

  it('catches the PascalCase suffix .NET and Java name their tests with', () => {
    expect(isTestFile('MyApp.Tests/UserServiceTests.cs')).toBe(true)
    expect(isTestFile('src/MyApp.Tests/OrderTests.cs')).toBe(true)
    expect(isTestFile('src/UserServiceTest.cs')).toBe(true)
    expect(isTestFile('src/test/java/com/x/FooTest.java')).toBe(true)
    expect(isTestFile('Tests.cs')).toBe(true)
    expect(isTestFile('src/UserService.cs')).toBe(false)
  })

  it('catches a .NET test project by its directory and its csproj', () => {
    expect(isTestFile('MyApp.Tests/MyApp.Tests.csproj')).toBe(true)
    expect(isTestFile('MyApp.Tests.csproj')).toBe(true)
    expect(isTestFile('src/MyApp.Test/Helpers.cs')).toBe(true)
    expect(isTestFile('src/MyApp/MyApp.csproj')).toBe(false)
  })

  it('catches the test, tests and spec directories other stacks use', () => {
    expect(isTestFile('tests/OrderTest.cs')).toBe(true)
    expect(isTestFile('test/Foo.cs')).toBe(true)
    expect(isTestFile('spec/models/user_spec.rb')).toBe(true)
    expect(isTestFile('src/main/java/com/x/Foo.java')).toBe(false)
  })

  it('catches a capitalised Tests directory, which is how Unity and .NET spell it', () => {
    expect(isTestFile('Assets/Tests/EditMode/PlayerMovement.cs')).toBe(true)
    expect(isTestFile('Assets/Tests/EditMode/Tests.asmdef')).toBe(true)
    expect(isTestFile('src/MyApp/Test/Helper.cs')).toBe(true)
    // Odin Inspector is the reason the directory rule stays anchored: "Inspector"
    // contains "spec", and a real Unity project is full of it.
    expect(isTestFile('Assets/ThirdParty/Sirenix/Odin Inspector/Scripts/Foo.cs')).toBe(false)
    expect(isTestFile('Assets/Sirenix.OdinInspector.Editor.dll')).toBe(false)
  })

  it('catches the snake and prefix spellings Go, Python and Ruby use', () => {
    expect(isTestFile('internal/foo_test.go')).toBe(true)
    expect(isTestFile('tests/test_parser.py')).toBe(true)
    expect(isTestFile('app/models/user_spec.rb')).toBe(true)
    expect(isTestFile('internal/foo.go')).toBe(false)
    expect(isTestFile('app/parser.py')).toBe(false)
  })

  it('leaves source alone when a word merely ends in test', () => {
    expect(isTestFile('src/Latest.cs')).toBe(false)
    expect(isTestFile('src/Contest.cs')).toBe(false)
    expect(isTestFile('src/Protest/Protester.cs')).toBe(false)
    expect(isTestFile('src/latest.ts')).toBe(false)
    expect(isTestFile('src/manifest.json')).toBe(false)
    expect(isTestFile('src/fixtures/TestData.json')).toBe(false)
    expect(isTestFile('src/attestation.go')).toBe(false)
  })
})

describe('splitFiles', () => {
  const files = [file('src/a.ts'), file('src/a.test.ts'), file('src/b.ts')]
  const done = (paths: string[]) => (f: FileChange) => paths.includes(f.path)
  const opts = (over: Partial<Parameters<typeof splitFiles>[1]> = {}) => ({
    query: '',
    hideReviewed: false,
    hideTests: false,
    onlyChanged: false,
    changed: NONE,
    pinned: NONE,
    isDone: done([]),
    ...over,
  })

  it('keeps everything when both switches are off', () => {
    const split = splitFiles(
      files,
      opts({
        hideReviewed: false,
        hideTests: false,
        pinned: NONE,
        isDone: done(['src/a.ts']),
      }),
    )
    expect(paths(split.visible)).toEqual(['src/a.ts', 'src/a.test.ts', 'src/b.ts'])
    expect(split.hiddenReviewed).toBe(0)
    expect(split.hiddenTests).toBe(0)
  })

  it('drops read files and counts them', () => {
    const split = splitFiles(
      files,
      opts({
        hideReviewed: true,
        hideTests: false,
        pinned: NONE,
        isDone: done(['src/a.ts']),
      }),
    )
    expect(paths(split.visible)).toEqual(['src/a.test.ts', 'src/b.ts'])
    expect(split.hiddenReviewed).toBe(1)
  })

  it('drops tests and counts them', () => {
    const split = splitFiles(
      files,
      opts({
        hideReviewed: false,
        hideTests: true,
        pinned: NONE,
        isDone: done([]),
      }),
    )
    expect(paths(split.visible)).toEqual(['src/a.ts', 'src/b.ts'])
    expect(split.hiddenTests).toBe(1)
  })

  it('counts a reviewed test file as a test, not twice', () => {
    const split = splitFiles(
      files,
      opts({
        hideReviewed: true,
        hideTests: true,
        pinned: NONE,
        isDone: done(['src/a.test.ts']),
      }),
    )
    expect(paths(split.visible)).toEqual(['src/a.ts', 'src/b.ts'])
    expect(split.hiddenTests).toBe(1)
    expect(split.hiddenReviewed).toBe(0)
  })

  it('renders a pinned file whichever switch would have hidden it', () => {
    const split = splitFiles(
      files,
      opts({
        hideReviewed: true,
        hideTests: true,
        pinned: new Set(['src/a.ts', 'src/a.test.ts']),
        isDone: done(['src/a.ts']),
      }),
    )
    expect(paths(split.visible)).toEqual(['src/a.ts', 'src/a.test.ts', 'src/b.ts'])
    expect(split.hiddenTests).toBe(0)
    expect(split.hiddenReviewed).toBe(0)
  })

  it('keeps a file the app does not consider read', () => {
    const split = splitFiles([file('assets/logo.png', [])], opts({ hideReviewed: true }))
    expect(paths(split.visible)).toEqual(['assets/logo.png'])
  })

  it('narrows to what the agent rewrote, and counts the rest as unchanged', () => {
    const split = splitFiles(files, opts({ onlyChanged: true, changed: new Set(['src/b.ts']) }))
    expect(paths(split.visible)).toEqual(['src/b.ts'])
    expect(split.hiddenUnchanged).toBe(2)
  })

  it('claims an unchanged reviewed test file as unchanged, once', () => {
    const split = splitFiles(
      files,
      opts({
        onlyChanged: true,
        changed: new Set(['src/b.ts']),
        hideReviewed: true,
        hideTests: true,
        isDone: done(['src/a.test.ts']),
      }),
    )
    expect(paths(split.visible)).toEqual(['src/b.ts'])
    expect(split.hiddenUnchanged).toBe(2)
    expect(split.hiddenTests).toBe(0)
    expect(split.hiddenReviewed).toBe(0)
  })

  it('a pin outranks the narrowing too', () => {
    const split = splitFiles(
      files,
      opts({ onlyChanged: true, changed: NONE, pinned: new Set(['src/a.ts']) }),
    )
    expect(paths(split.visible)).toEqual(['src/a.ts'])
  })

  it('the typed word narrows by path, case-insensitively, and counts what it drops', () => {
    const split = splitFiles(files, opts({ query: 'B.TS' }))
    expect(paths(split.visible)).toEqual(['src/b.ts'])
    expect(split.hiddenQuery).toBe(2)
  })

  it('an all-space query filters nothing', () => {
    const split = splitFiles(files, opts({ query: '   ' }))
    expect(paths(split.visible)).toEqual(['src/a.ts', 'src/a.test.ts', 'src/b.ts'])
    expect(split.hiddenQuery).toBe(0)
  })

  it('a file the word drops is claimed by the word, whatever else would hide it', () => {
    const split = splitFiles(
      files,
      opts({ query: 'b.ts', hideTests: true, hideReviewed: true, isDone: done(['src/a.ts']) }),
    )
    expect(paths(split.visible)).toEqual(['src/b.ts'])
    expect(split.hiddenQuery).toBe(2)
    expect(split.hiddenTests).toBe(0)
    expect(split.hiddenReviewed).toBe(0)
  })

  it('a pin outranks the typed word — a jump must land even mid-search', () => {
    const split = splitFiles(files, opts({ query: 'zzz', pinned: new Set(['src/a.ts']) }))
    expect(paths(split.visible)).toEqual(['src/a.ts'])
    expect(split.hiddenQuery).toBe(2)
  })
})

describe('reviewScope', () => {
  const files = [file('src/a.ts'), file('src/a.test.ts'), file('src/b.ts')]
  const done = (paths: string[]) => (f: FileChange) => paths.includes(f.path)
  const opts = (over: Partial<Parameters<typeof reviewScope>[1]> = {}) => ({
    hideTests: false,
    onlyChanged: false,
    changed: NONE,
    pinned: NONE,
    isDone: done([]),
    ...over,
  })

  it('with nothing hidden, scope is the whole changeset', () => {
    const scope = reviewScope(files, opts({ isDone: done(['src/a.ts']) }))
    expect(scope).toMatchObject({ left: 2, total: 3, excludedTests: 0, excludedUnchanged: 0 })
  })

  it('a hidden unread test leaves scope, and is named', () => {
    const scope = reviewScope(files, opts({ hideTests: true, isDone: done(['src/a.ts']) }))
    expect(scope).toMatchObject({ left: 1, total: 2, excludedTests: 1 })
    expect(scope.excludedPaths).toEqual(['src/a.test.ts'])
  })

  it('reaches zero once everything in scope is read', () => {
    const scope = reviewScope(
      files,
      opts({ hideTests: true, isDone: done(['src/a.ts', 'src/b.ts']) }),
    )
    expect(scope.left).toBe(0)
    expect(scope.excludedTests).toBe(1)
  })

  it('does not name a hidden file the reviewer had already read', () => {
    const scope = reviewScope(files, opts({ hideTests: true, isDone: done(['src/a.test.ts']) }))
    expect(scope.excludedTests).toBe(0)
    expect(scope.excludedPaths).toEqual([])
  })

  it('the round narrows scope too, and claims its files first', () => {
    const scope = reviewScope(
      files,
      opts({ onlyChanged: true, changed: new Set(['src/b.ts']), hideTests: true }),
    )
    expect(scope).toMatchObject({ left: 1, total: 1, excludedTests: 0, excludedUnchanged: 2 })
  })

  it('a pin puts a file back in scope', () => {
    const scope = reviewScope(files, opts({ hideTests: true, pinned: new Set(['src/a.test.ts']) }))
    expect(scope).toMatchObject({ left: 3, total: 3, excludedTests: 0 })
  })

  it('everything excluded is an empty scope, not a finished one', () => {
    const scope = reviewScope(files, opts({ onlyChanged: true, changed: NONE }))
    expect(scope).toMatchObject({ left: 0, total: 0, excludedUnchanged: 3 })
  })
})
