import type { RepoRules } from './repo.js'

/**
 * The repos that have rules, the most specific one first. To add the rules
 * of a repo: write a `GraphRepo` (see `repo.ts` and `plain.ts`) and put it in
 * this list.
 */
export const RULES: readonly RepoRules[] = []
