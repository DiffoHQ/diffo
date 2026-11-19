/** Path conventions for test code, grouped by the stack that uses them. Nothing
 * off the shelf covers this (go-enry's `IsTest` is a subset), so the list is ours.
 * Case-sensitive on purpose: lowercased, these also hide `Latest.cs`. A bare
 * `spec/` or `fixtures/` is no rule — both hold API specs and app data as often as
 * tests. Ambiguous paths resolve toward showing the file. */
const TEST_PATTERNS: readonly RegExp[] = [
  // Filenames, any stack
  /[._-](test|spec)s?\.[^/]+$/, // a.test.ts, foo_test.go, user_spec.rb, my-test.js, app.e2e-spec.ts
  /(^|\/)test_[^/]+$/, // test_parser.py
  /[a-z0-9_](unit|browser|api|ui|perf|fuzz)tests?\.[^/]+$/, // foo_unittest.cc, bar_browsertest.mm
  /(^|[/.a-z0-9])Tests?\.[^/]+$/, // UserServiceTests.cs, FooTest.java, MyApp.Tests.csproj
  /(^|\/)test[-_]?([Uu]tils?|[Hh]elpers?|[Ss]etup|[Ss]upport)\.[^/]+$/, // test-utils.tsx, testHelpers.ts
  // JS/TS runners
  /\.cy\.[^/]+$/, // login.cy.ts (Cypress)
  /[._-]e2e\.[^/]+$/, // checkout.e2e.ts
  /(^|\/)(jest|vitest|playwright|cypress|karma|wdio|protractor)[.-](config|setup)(\.[^/]+)?$/,
  /\.snap$/, // Jest/Vitest snapshots
  // JVM, Swift
  /[a-z0-9]Specs?\.(kt|kts|scala|groovy|swift)$/, // Kotest, ScalaTest, Spock, Quick
  /[a-z0-9](IT|ITCase)\.(java|kt|groovy|scala)$/, // Failsafe integration tests
  // Python, Ruby, PHP
  /(^|\/)(conftest|tests?)\.py$/, // pytest fixtures, Django tests.py
  /(^|\/)pytest\.ini$/,
  /(^|\/)(spec|rails)_helper\.rb$/,
  /(^|\/)spec\/.+\.rb$/, // RSpec: support/, factories/ — .rb only, so OpenAPI specs stay
  /(^|\/)phpunit\.xml(\.dist)?$/,
  // Go
  /(^|\/)mock_[^/]+\.go$/,
  /_mock\.go$/,
  /\.golden$/,
  // BDD
  /\.(feature|robot)$/, // Gherkin, Robot Framework
  // Directories
  /(^|\/)(__tests__|__mocks__|__snapshots__|__fixtures__|[Tt]ests?)\//, // tests/, Assets/Tests/
  /\.([A-Z][A-Za-z]*)?Tests?\//, // MyApp.Tests/, MyApp.UnitTests/ — .NET test projects
  /(^|\/)[a-z]+Tests?\//, // src/androidTest/, src/integrationTest/ — Gradle source sets
  /(^|\/)test[A-Z][A-Za-z]*\//, // src/testFixtures/, testUtils/
  /(^|\/)tests?[-_][a-z]+\//, // test-utils/, test_helpers/
  /(^|[/_-])e2e([-_][^/]*)?\//, // e2e/, apps/web-e2e/ (Nx), e2e-tests/
  /(^|\/)(cypress|playwright|testdata|step_definitions|mocks)\//,
]

export function isTestFile(path: string): boolean {
  return TEST_PATTERNS.some((pattern) => pattern.test(path))
}
