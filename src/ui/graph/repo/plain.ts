import { STD_CPP } from '../language/idioms.js'
import { folderOf, type GraphRepo, NO_JOIN } from './repo.js'

/** A repo with no rules: one group, a box for each folder and each class,
 * and only the connections of the language. */
export const plainRepo: GraphRepo = {
  name: 'plain',
  kinds: [],
  reads: () => false,
  groupOf: () => '',
  boxes: (path, cls) => [folderOf(path), cls],
  tags: () => [],
  cpp: STD_CPP,
  testMark: false,
  isTest: (_path, byName) => byName,
  connect: () => NO_JOIN,
}
