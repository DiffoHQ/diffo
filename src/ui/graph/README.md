# The code graph

The graph view shows the change as cards (code) and arrows (control that moves
from one card to another). This note records the layers of the graph and the
folder of each one.

## The layers

Each layer adds to the one below it. A rule is in a layer only when it is
always true there. A rule that is not always true moves up one layer.

| Layer        | Knows                                                                                         | True for                         | Folder                 |
| ------------ | --------------------------------------------------------------------------------------------- | -------------------------------- | ---------------------- |
| **Basic**    | The diff: files, hunks, lines                                                                 | Each change                      | `basic/`               |
| **Language** | What the text of a language tells: functions, classes, calls, overrides, the standard library | Each repository in that language | `language/`            |
| **Repo**     | The rules of one repository: its connections, its groups, its libraries, its style            | That repository                  | `repo/`                |
| **Runtime**  | What really runs: the exact target of each call                                               | That build                       | `runtime/` (not built) |

`view/` is not a layer: it draws the cards, the boxes and the arrows that the
layers give, and it knows no language and no repository.

**The basic graph is Basic and Language together.** The two are always on,
because they are true for each repository. They are in two folders because a
language is a part that can be added or changed.

**The Repo layer is a switch** (`Repo: <name>`). It shows only when Diffo has
the rules of the repository of the change (`repo/index.ts` picks it from the
list of `repo/rules.ts`).

## What each layer gives

### Basic and Language (always on)

- A card for each function that a hunk touches, removed functions, the code
  before and after.
- A call whose text names the target: `this`, a full name, a bare name of a
  function of the same scope.
- A callback that is followed with no guess, by the position of the
  argument and the name of the parameter: the function that gets it runs that
  parameter, or gives it as it is to a second function, or is a constructor
  whose initializer list puts it in a member that a method runs.
- A hand-off, when the callback is not followed: the function gives a callback (`&F` in the arguments of a call)
  or an object with overrides (`make_unique<X>`, `new X`) to a call. One arrow,
  with the name of the call: "given to X". The code that gets it runs it.
- The override mark, the folder box and the class box.

### Repo (the switch)

A repo is one `GraphRepo` (`repo/repo.ts`):

| Member                        | What it tells                                                                                                                  |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `groupOf`                     | The group of a file (where its code runs)                                                                                      |
| `boxes`, `tags`               | The boxes inside a group, and the marks of a card                                                                              |
| `isTest`, `reads`, `testMark` | Which files are tests, which files it reads that are not parsed, and if the tests are known well enough to mark what they call |
| `kinds`, `connect`            | The cards and the arrows that the language cannot see, and their kinds                                                         |
| `cpp`                         | Data for the language steps (`language/idioms.ts`): the names of its libraries and its style                                   |

`plain.ts` is the repo with no rules: the basic graph. To add the rules of a
repository, write a `GraphRepo` in a folder of its own below `repo/`, and put
it in the list of `repo/rules.ts` with the test that finds the repository in
the paths of a change.

The style of a repository turns on three steps of the language code. They are
not true for each C++ repository, so they are not in the basic graph:

- `receiverNamesClass`: a call on a receiver means the method of the class
  with that name.
- `memberName` and `followCallbacks`: a callback is followed also where the
  text does not tell the way: each run of a member of the class of a
  constructor, a member by its name, a second bind, with no position of the
  argument.
- `testMacro`: a test of googletest is a method of its fixture.

## What is not in its layer yet

- **The test file names of one repository** (`foo_unittest.cc`) are in the test
  rule of Diffo (`reviewFilter.ts`), not in the rules of that repository. The "Hide test
  files" switch of the page uses that rule for the list and for the graph, and
  the page has no repo. The Repo layer must become a layer of the page, not
  only of the graph, before the pattern can move.
- **Libraries that many repositories use** (googletest) are data of a repo.
  There is no place for a library that is apart from a repo.
- `basic/build.ts` holds the model of the graph and the calls to the language
  steps in one function.
- The realms (tests, logic, headers and boilerplate) are fixed in `view/`.
- C++ and TypeScript share the files of `language/`, with a branch for each.

## Limits of the language layer

There are no types. An object is followed only by the name of its local
variable, in the function that makes it. Templates, operators, destructors and
macros are not followed.
