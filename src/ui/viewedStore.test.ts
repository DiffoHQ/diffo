// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest'
import { loadViewed, saveViewed, storageKey } from './viewedStore.js'

const cs = (repo: string, spec: 'working-tree' | string, parent = '/tmp') => ({
  repo: { path: `${parent}/${repo}`, name: repo, branch: 'main', worktree: null },
  spec:
    spec === 'working-tree'
      ? ({ kind: 'working-tree' } as const)
      : ({ kind: 'branch', base: spec } as const),
})

describe('viewedStore', () => {
  beforeEach(() => localStorage.clear())

  it('round-trips a viewed set', () => {
    const key = storageKey(cs('myrepo', 'working-tree'))
    saveViewed(key, new Set(['a', 'b']))
    expect(loadViewed(key)).toEqual(new Set(['a', 'b']))
  })

  it('keys are distinct per repo and per spec', () => {
    const k1 = storageKey(cs('repo1', 'working-tree'))
    const k2 = storageKey(cs('repo2', 'working-tree'))
    const k3 = storageKey(cs('repo1', 'main'))
    expect(new Set([k1, k2, k3]).size).toBe(3)
  })

  it('two repos with the same basename do NOT share a bucket', () => {
    const work = storageKey(cs('api', 'working-tree', '/home/me/work'))
    const personal = storageKey(cs('api', 'working-tree', '/home/me/personal'))
    expect(work).not.toBe(personal)
  })

  it('tolerates garbage in storage', () => {
    localStorage.setItem('bad', '{not json')
    expect(loadViewed('bad')).toEqual(new Set())
    localStorage.setItem('bad2', '{"an":"object"}')
    expect(loadViewed('bad2')).toEqual(new Set())
  })
})
