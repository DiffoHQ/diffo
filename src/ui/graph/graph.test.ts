import { beforeAll, describe, expect, it } from 'vitest'
import type { FileChange } from '../../shared/types.js'
import { buildGraph as build, buildSides as sides } from './basic/build.js'
import { GTEST_MACRO, STD_CPP } from './language/idioms.js'
import type { ParseFile } from './language/parser.js'
import { pickRepo, plainRepo } from './repo/index.js'
import type { GraphRepo } from './repo/repo.js'
import { added, loadTestParser } from './testing.js'
import { layoutRouted } from './view/routed.js'

let parse: ParseFile

beforeAll(async () => {
  parse = await loadTestParser()
})

// A repo gives the language steps the names of its library and its style
// (see `language/idioms.ts`). This one has googletest, the style where a
// receiver has the name of its class, and the mark of what the tests call.
// The tests of the basic graph call `build` with no repo.
const styledRepo: GraphRepo = {
  ...plainRepo,
  cpp: { ...STD_CPP, testMacro: GTEST_MACRO, receiverNamesClass: true },
  testMark: true,
}
const buildGraph = (
  files: Parameters<typeof build>[0],
  texts: Parameters<typeof build>[1],
  parser: Parameters<typeof build>[2],
  isTest?: Parameters<typeof build>[3],
  baseTexts?: Parameters<typeof build>[4],
) => build(files, texts, parser, isTest, baseTexts, styledRepo)
const buildSides = (
  files: Parameters<typeof sides>[0],
  texts: Parameters<typeof sides>[1],
  parser: Parameters<typeof sides>[2],
  isTest: Parameters<typeof sides>[3],
  baseTexts: Parameters<typeof sides>[4],
) => sides(files, texts, parser, isTest, baseTexts, styledRepo)

const TS = `export class List {
  private remove_(items: number[]): void {
    this.notify_(items.length)
    helper(items)
  }

  private notify_(count: number): void {
    console.log(count)
  }

  private idle_(): void {
    this.notify_(0)
  }
}

function helper(items: number[]): void {
  items.sort()
}
`

const CC = `namespace history {
namespace {

int Count(int n) {
  return n + 1;
}

}  // namespace

void Handler::Remove(int n) {
  int c = Count(n);
  service_->Remove(c);
  this->Done(c);
}

void Handler::Done(int n) {
  std::move(callback_).Run(n);
}

void Service::Remove(int n) {}

}  // namespace history
`

describe('code graph', () => {
  it('makes a node for each changed function and an edge for each call between them', () => {
    const file = added('a/list.ts', TS, [3, 8, 18])
    const graph = buildGraph([file], new Map([[file.path, TS]]), parse)
    expect(graph.nodes.map((n) => n.name)).toEqual(['List.remove_', 'List.notify_', 'helper'])
    const edge = (e: (typeof graph.edges)[number]) =>
      `${e.from.split('#')[1]?.split('@')[0]} -> ${e.to.split('#')[1]?.split('@')[0]}`
    expect(graph.edges.map(edge).sort()).toEqual([
      'List.remove_ -> List.notify_',
      'List.remove_ -> helper',
    ])
    expect(graph.edges.find((e) => e.to.includes('notify_'))?.added).toBe(true)
    expect(graph.edges.find((e) => e.to.includes('helper'))?.added).toBe(false)
  })

  it('leaves out a function that the change does not touch', () => {
    const file = added('a/list.ts', TS, [3])
    const graph = buildGraph([file], new Map([[file.path, TS]]), parse)
    expect(graph.nodes.map((n) => n.name)).toEqual(['List.remove_'])
    expect(graph.edges).toEqual([])
  })

  it('splits one hunk with two functions into two nodes', () => {
    const file = added('a/list.ts', TS, [4, 5, 6, 7, 8])
    expect(file.hunks).toHaveLength(1)
    const graph = buildGraph([file], new Map([[file.path, TS]]), parse)
    expect(graph.nodes.map((n) => n.name)).toEqual(['List.remove_', 'List.notify_'])
  })

  it('resolves C++ calls by name, by this and by the receiver name', () => {
    const file = added('b/handler.cc', CC, [5, 11, 12, 13, 17, 20])
    const graph = buildGraph([file], new Map([[file.path, CC]]), parse)
    const name = (id: string) => id.split('#')[1]?.split('@')[0]
    expect(graph.edges.map((e) => `${name(e.from)} -> ${name(e.to)} ${e.method}`).sort()).toEqual([
      'history::Handler::Remove -> history::(anonymous)::Count syntax',
      'history::Handler::Remove -> history::Handler::Done syntax',
      'history::Handler::Remove -> history::Service::Remove name',
    ])
  })

  it('names a gtest by its fixture, so its calls find the fixture methods', () => {
    const text = `class ApiTest {
 protected:
  void Load() {}
};

TEST_F(ApiTest, Removes) {
  Load();
}
`
    const file = added('b/api_test.cc', text, [3, 7])
    const graph = buildGraph([file], new Map([[file.path, text]]), parse)
    expect(graph.nodes.map((n) => n.name)).toEqual(['ApiTest::Load', 'ApiTest::Removes'])
    expect(graph.edges.map((e) => e.method)).toEqual(['syntax'])
    // Basic: what the macro means is not known. The name is the use as it is
    // written, and the call in its body finds no method.
    const basic = build([file], new Map([[file.path, text]]), parse)
    expect(basic.nodes.map((n) => n.name)).toEqual(['ApiTest::Load', 'TEST_F(ApiTest, Removes)'])
    expect(basic.edges).toEqual([])
  })

  it('puts each node in a realm and marks the logic that a test calls', () => {
    const logic = `export function parse(s: string): number {
  return clean(s).length
}

function clean(s: string): string {
  return s.trim()
}

export function unused(): void {
  console.log('x')
}

import {x} from './x.js'
`
    const test = `function check(): void {
  parse('a')
}
`
    const files = [
      added('src/parse.ts', logic, [2, 6, 10, 13]),
      added('src/parse.test.ts', test, [2]),
      added('src/BUILD.gn', 'deps = []', [1]),
    ]
    const texts = new Map([
      ['src/parse.ts', logic],
      ['src/parse.test.ts', test],
    ])
    const graph = buildGraph(files, texts, parse, (path) => path.includes('.test.'))
    const row = (n: (typeof graph.nodes)[number]) =>
      `${n.name ?? (n.file ? 'file' : 'top')} ${n.realm} ${n.tested ?? '-'}`
    expect(graph.nodes.map(row).sort()).toEqual([
      'check tests -',
      'clean logic reached',
      'file boilerplate -',
      'parse logic direct',
      'top boilerplate -',
      'unused logic none',
    ])
    expect(graph.nodes.find((n) => n.file)?.file).toEqual({ additions: 1, deletions: 0 })
  })

  it('gives the plain repo to a change of no known repo', () => {
    expect(pickRepo(['src/a.cc']).name).toBe('plain')
  })

  it('routes each arrow around the cards and packs the parts with no arrow', async () => {
    const card = (id: string, realm: 'tests' | 'logic' | 'boilerplate', path?: string[]) => ({
      id,
      realm,
      path,
      width: 200,
      height: 100,
    })
    const cards = [
      card('t1', 'tests'),
      card('a1', 'logic', ['ui']),
      card('a2', 'logic', ['ui']),
      card('b1', 'logic', ['core']),
      card('b2', 'logic', ['core']),
      ...Array.from({ length: 12 }, (_, i) => card(`h${i}`, 'boilerplate')),
    ]
    const edge = (from: string, to: string, fromY: number) => ({
      key: `${from}>${to}`,
      from,
      to,
      fromY,
      toY: 17,
    })
    const layout = await layoutRouted(['tests', 'logic', 'boilerplate'], cards, [
      edge('t1', 'a1', 50),
      edge('a1', 'a2', 30),
      edge('a1', 'b1', 80),
      edge('b1', 'b2', 50),
    ])
    const at = (id: string) => {
      const p = layout.at.get(id)
      if (!p) throw new Error(id)
      return p
    }
    // Each card has a place, and no two cards are on one place.
    const placed = cards.map((c) => at(c.id))
    for (let i = 0; i < placed.length; i++) {
      for (let j = i + 1; j < placed.length; j++) {
        const [a, b] = [placed[i], placed[j]]
        if (!a || !b) continue
        const apart =
          a.x + a.width <= b.x ||
          b.x + b.width <= a.x ||
          a.y + a.height <= b.y ||
          b.y + b.height <= a.y
        expect(apart).toBe(true)
      }
    }
    // An arrow starts at the line of the call, on the right of its card.
    const route = layout.routes.get('a1>b1')
    expect(route?.[0]?.x).toBeCloseTo(at('a1').x + 200, -1)
    expect(route?.[0]?.y).toBeCloseTo(at('a1').y + 80, -1)
    // No point of a route is inside a card.
    for (const points of layout.routes.values()) {
      for (const p of points.slice(1, -1)) {
        const inside = placed.some(
          (c) =>
            p.x > c.x + 2 && p.x < c.x + c.width - 2 && p.y > c.y + 2 && p.y < c.y + c.height - 2,
        )
        expect(inside).toBe(false)
      }
    }
    // The call order goes to the right.
    expect(at('b1').x).toBeGreaterThan(at('a1').x)
    // The twelve cards with no arrow are not one long column.
    const columns = new Set(Array.from({ length: 12 }, (_, i) => Math.round(at(`h${i}`).x)))
    expect(columns.size).toBeGreaterThan(1)
    expect(layout.width / layout.height).toBeGreaterThan(0.5)
    expect(layout.width / layout.height).toBeLessThan(3)
  })

  it('follows a callback that a function gives to a constructor', () => {
    const cc = `class Job {
 public:
  Job(int size, std::function<void(bool)> done) : done_(std::move(done)) {}
  void Finish() { done_(true); }

 private:
  std::function<void(bool)> done_;
};

void Start(int size, std::function<void(bool)> done) {
  if (size == 0) {
    done(false);
    return;
  }
  auto job = std::make_unique<Job>(size, std::move(done));
  Queue(std::move(job));
}

void Wrap(std::function<void(bool)> done) {
  Start(1, std::bind(&Other, std::move(done)));
}

void Other(std::function<void(bool)> done, bool ok) {}

void Client::Go() {
  Start(3, std::bind(&Client::Done, this));
}

void Client::Done(bool ok) {}

void Two(std::function<void()> first, std::function<void()> second) {
  first();
}

void Client::Pick() {
  Two(std::bind(&Client::Ran, this), std::bind(&Client::Kept, this));
}

void Client::Ran() {}
void Client::Kept() {}

class Timer {
 public:
  explicit Timer(std::function<void()> tick) { tick_ = std::move(tick); }
  void Fire() { tick_(); }

 private:
  std::function<void()> tick_;
};

void Client::Watch() {
  auto timer = std::make_unique<Timer>(std::bind(&Client::Tick, this));
}

void Client::Tick() {}
`
    const lines = cc.split('\n').map((_, i) => i + 1)
    const end = (id: string) => id.split('#')[1]?.split('@')[0] ?? id
    // A repository that follows callbacks by its style, with the standard
    // library: its members have a name that ends with `_`.
    const styled = { ...plainRepo, cpp: { ...STD_CPP, followCallbacks: true, memberName: /_$/ } }
    const callbacks = (style: boolean) =>
      build(
        [added('lib/job.cc', cc, lines)],
        new Map([['lib/job.cc', cc]]),
        parse,
        undefined,
        undefined,
        style ? styled : undefined,
      )
        .edges.filter((e) => e.kind === 'callback')
        .map((e) => `${end(e.from)} -> ${end(e.to)} ${e.method}${e.via ? ` ${e.via}` : ''}`)
        .sort()
    // Basic: what the text tells for each C++ code, by the position of the
    // argument and the name of the parameter.
    expect(callbacks(false)).toEqual([
      // The second parameter of `Two` is not run: the bind site is the fact.
      'Client::Pick -> Client::Kept open Two',
      // The constructor of `Timer` puts its parameter in a member in its
      // body, not in its initializer list: not followed.
      'Client::Watch -> Client::Tick open make_unique<Timer>',
      // The initializer list puts the parameter in `done_`, and `Finish`
      // runs `done_`.
      'Job::Finish -> Client::Done flow',
      'Job::Finish -> Other flow',
      // `Start` runs its parameter.
      'Start -> Client::Done flow',
      'Start -> Other flow',
      // `Two` runs its first parameter.
      'Two -> Client::Ran flow',
      // `Wrap` puts its parameter into a new callable: `Start` does not run
      // the parameter of `Wrap`, so nothing runs the parameter of `Other`.
    ])
    // With the style of a repository, a run of each member of the class of
    // a constructor counts: `Fire` runs `tick_`. It also takes the second
    // parameter of `Two` as run. That is a guess, and it is wrong here.
    const styledRuns = callbacks(true)
    expect(styledRuns).toContain('Timer::Fire -> Client::Tick flow')
    expect(styledRuns).toContain('Two -> Client::Kept flow')
  })

  it('joins the place where an object escapes with the overrides of its class', () => {
    const cc = `class Task : public Runner::Work {
 public:
  explicit Task(int size) : size_(size) {}
  void Run() override { Use(size_); }
  void Cancel() override {}
  int size() const { return size_; }

 private:
  int size_;
};

class Plain {
 public:
  void Run() {}
};

void Start(Runner* runner) {
  auto task = std::make_unique<Task>(3);
  task->size();
  runner->Post(std::move(task));
}

void StartNow(Runner* runner) {
  runner->Post(new Task(1));
}

void Keep() {
  auto task = std::make_unique<Task>(3);
  Hold(std::move(task));
}

void Hold(std::unique_ptr<Task> task) {}

void NoOverrides(Runner* runner) {
  runner->Post(std::make_unique<Plain>());
}
`
    const lines = cc.split('\n').map((_, i) => i + 1)
    const graph = build([added('lib/task.cc', cc, lines)], new Map([['lib/task.cc', cc]]), parse)
    const end = (id: string) => id.split('#')[1]?.split('@')[0] ?? id
    expect(
      graph.edges
        .filter((e) => e.kind === 'callback')
        .map((e) => `${end(e.from)} -> ${end(e.to)} ${e.method} ${e.via}`)
        .sort(),
    ).toEqual([
      // The object goes to a function that is not in the change: each of its
      // overrides can run. A method that is not an override is not part of it.
      'Start -> Task::Cancel open Post',
      'Start -> Task::Run open Post',
      'StartNow -> Task::Cancel open Post',
      'StartNow -> Task::Run open Post',
      // `Keep` gives the object to a function of the change: no escape. A
      // class with no override has no edge.
    ])
    const override = (name: string) => graph.nodes.find((n) => n.name === name)?.override
    expect(override('Task::Run')).toEqual(['Runner::Work'])
    expect(override('Task::size')).toBeUndefined()
    expect(override('Plain::Run')).toBeUndefined()
  })

  it('marks an override whose declaration is in a header of the change', () => {
    const h = `class Watcher : public Source::Observer, public Other {
 public:
  void OnChanged(int value) override;
  void Stop();
};
`
    const cc = `void Watcher::OnChanged(int value) {
  Stop();
}

void Watcher::Stop() {}
`
    const all = (text: string) => text.split('\n').map((_, i) => i + 1)
    const graph = build(
      [added('lib/watcher.h', h, all(h)), added('lib/watcher.cc', cc, all(cc))],
      new Map([
        ['lib/watcher.h', h],
        ['lib/watcher.cc', cc],
      ]),
      parse,
    )
    const node = (name: string) =>
      graph.nodes.find((n) => n.name === name && n.path.endsWith('.cc'))
    expect(node('Watcher::OnChanged')?.override).toEqual(['Source::Observer', 'Other'])
    expect(node('Watcher::Stop')?.override).toBeUndefined()
  })

  it('has only the calls whose text names the target in the basic graph', () => {
    const cc = `class Store {
 public:
  void Save() { this->Flush(); Log(); }
  void Flush() {}
};

void Log() {}

void Client::Go() {
  store_->Save();
  Store::Flush();
}
`
    const lines = cc.split('\n').map((_, i) => i + 1)
    const files = [added('lib/store.cc', cc, lines)]
    const texts = new Map([['lib/store.cc', cc]])
    const end = (id: string) => id.split('#')[1]?.split('@')[0] ?? id
    const named = { ...plainRepo, cpp: { ...STD_CPP, receiverNamesClass: true } }
    const calls = (style: boolean) =>
      build(files, texts, parse, undefined, undefined, style ? named : undefined)
        .edges.map((e) => `${end(e.from)} -> ${end(e.to)} ${e.method}`)
        .sort()
    // `this`, a full name, and a bare name of a function with no scope.
    expect(calls(false)).toEqual([
      'Client::Go -> Store::Flush syntax',
      'Store::Save -> Log syntax',
      'Store::Save -> Store::Flush syntax',
    ])
    // With the style of a repository: also the receiver whose name agrees
    // with the class.
    expect(calls(true)).toContain('Client::Go -> Store::Save name')
  })

  it('shows a function that the change removes', () => {
    const base = `export class List {
  private keep_(): void {
    console.log(1)
  }

  private drop_(): void {
    this.helper_()
  }

  private helper_(): void {
    console.log(2)
  }
}
`
    const head = `export class List {
  private keep_(): void {
    console.log(1)
  }
}
`
    // One hunk: the lines 5 to 12 of the base text are deleted.
    const baseLines = base.split('\n')
    const file: FileChange = {
      path: 'a/list.ts',
      oldPath: null,
      status: 'modified',
      kind: 'text',
      staged: false,
      hunks: [
        {
          id: 'h1',
          path: 'a/list.ts',
          oldStart: 4,
          newStart: 4,
          lines: [
            { kind: 'context', oldNo: 4, newNo: 4, text: baseLines[3] ?? '' },
            ...[5, 6, 7, 8, 9, 10, 11, 12].map((no) => ({
              kind: 'del' as const,
              oldNo: no,
              newNo: null,
              text: baseLines[no - 1] ?? '',
            })),
            { kind: 'context', oldNo: 13, newNo: 5, text: '}' },
          ],
        },
      ],
    }
    const graph = buildGraph(
      [file],
      new Map([['a/list.ts', head]]),
      parse,
      () => false,
      new Map([['a/list.ts', base]]),
    )
    const removed = graph.nodes.filter((n) => n.removed)
    expect(removed.map((n) => n.name).sort()).toEqual(['List.drop_', 'List.helper_'])
    // Each removed function has its own deleted lines, and `keep_` has none.
    const drop = removed.find((n) => n.name === 'List.drop_')
    expect(drop?.lines.map((l) => l.oldNo)).toEqual([6, 7, 8])
    expect(drop?.lines.every((l) => l.kind === 'del')).toBe(true)
    expect(graph.nodes.some((n) => n.name === 'List.keep_')).toBe(false)
    // The call of a removed function to a removed function is a removed arrow.
    expect(graph.edges).toMatchObject([
      { from: drop?.id, to: removed.find((n) => n.name === 'List.helper_')?.id, removed: true },
    ])

    // Side by side. Before: the two removed functions as they were, with
    // their call, and no line that the change adds. After: no removed node.
    const sides = buildSides(
      [file],
      new Map([['a/list.ts', head]]),
      parse,
      () => false,
      new Map([['a/list.ts', base]]),
    )
    expect(sides.before.nodes.map((n) => n.name).sort()).toEqual(['List.drop_', 'List.helper_'])
    expect(sides.before.nodes.every((n) => !n.removed)).toBe(true)
    expect(sides.before.nodes.flatMap((n) => n.lines).every((l) => l.kind !== 'add')).toBe(true)
    expect(sides.before.edges).toHaveLength(1)
    expect(sides.after.nodes.some((n) => n.removed)).toBe(false)
    expect(sides.after.nodes.flatMap((n) => n.lines).every((l) => l.kind !== 'del')).toBe(true)
    expect(sides.after.edges).toEqual([])
  })

  it('reads a file with JSX: its components and the calls in them', () => {
    const tsx = `import { useState } from 'react'

function format(n: number): string {
  return String(n)
}

export function Counter({ start }: { start: number }) {
  const [n, setN] = useState(start)
  return <button onClick={() => setN(n + 1)}>{format(n)}</button>
}

export const Total = ({ items }: { items: number[] }) => {
  return <span>{format(items.length)}</span>
}
`
    const file = added('ui/Counter.tsx', tsx, [4, 8, 9, 13])
    const graph = build([file], new Map([[file.path, tsx]]), parse)
    expect(graph.skipped).toEqual([])
    expect(graph.nodes.map((n) => n.name)).toEqual(['format', 'Counter', 'Total'])
    const end = (id: string) => id.split('#')[1]?.split('@')[0]
    expect(graph.edges.map((e) => `${end(e.from)} -> ${end(e.to)}`).sort()).toEqual([
      'Counter -> format',
      'Total -> format',
    ])
  })

  it('reports a file whose text it did not get', () => {
    const file = added('a/list.ts', TS, [3])
    expect(buildGraph([file], new Map(), parse).skipped).toEqual(['a/list.ts'])
  })
})
