import { describe, expect, it } from 'vitest'
import type { DiffLine, RepoStatus, RepoSummary } from '../src/shared/types'
import { changeGroups, groupByFolder, initials, matchesFilter, parseRef, relativeDate, splitPath } from '../src/renderer/src/format'

const now = Date.UTC(2026, 9, 16, 12, 0, 0)
const ago = (ms: number) => (now - ms) / 1000

describe('relativeDate', () => {
  it('formats in English', () => {
    expect(relativeDate(ago(10_000), now)).toBe('just now')
    expect(relativeDate(ago(2 * 3_600_000), now)).toBe('2 hours ago')
    expect(relativeDate(ago(25 * 3_600_000), now)).toBe('yesterday')
    expect(relativeDate(ago(14 * 86_400_000), now)).toBe('2 weeks ago')
  })
})

describe('small helpers', () => {
  it('initials', () => {
    expect(initials('Lea Rossi')).toBe('LR')
    expect(initials('arno')).toBe('A')
    expect(initials('  ')).toBe('?')
  })
  it('splitPath', () => {
    expect(splitPath('src/mqtt/client.c')).toEqual(['src/mqtt/', 'client.c'])
    expect(splitPath('README.md')).toEqual(['', 'README.md'])
    expect(splitPath('build/out/')).toEqual(['build/', 'out/'])
  })
  it('parseRef', () => {
    const remotes = new Set(['origin/main'])
    expect(parseRef('HEAD -> main', remotes)).toEqual({ label: 'main', kind: 'head' })
    expect(parseRef('tag: v1.0', remotes)).toEqual({ label: 'v1.0', kind: 'tag' })
    expect(parseRef('origin/main', remotes)).toEqual({ label: 'origin/main', kind: 'remote' })
    expect(parseRef('feature/x', remotes)).toEqual({ label: 'feature/x', kind: 'local' })
  })
})

describe('changeGroups', () => {
  it('groups contiguous changed lines', () => {
    const l = (kind: DiffLine['kind']): DiffLine => ({ kind, text: '', oldNo: null, newNo: null })
    expect(changeGroups([l('context'), l('del'), l('add'), l('context'), l('add'), l('context')])).toEqual([[1, 2], [4]])
  })
})

describe('dashboard filters', () => {
  const status = (o: Partial<RepoStatus>): RepoStatus => ({ branch: 'main', head: 'a', upstream: null, ahead: 0, behind: 0, staged: [], unstaged: [], conflicted: [], operation: null, ...o })
  const repo = (o: Partial<RepoSummary>): RepoSummary => ({ path: '/w/x', name: 'x', folder: '~/w', status: status({}), lastCommit: null, stashCount: 0, error: null, fetchError: null, ...o })

  it('classifies repos', () => {
    expect(matchesFilter(repo({}), 'dirty')).toBe(false)
    expect(matchesFilter(repo({ status: status({ unstaged: [{ path: 'a', status: 'M' }] }) }), 'dirty')).toBe(true)
    expect(matchesFilter(repo({ status: status({ ahead: 1 }) }), 'push')).toBe(true)
    expect(matchesFilter(repo({ status: status({ behind: 2 }) }), 'behind')).toBe(true)
    expect(matchesFilter(repo({ fetchError: 'x' }), 'attention')).toBe(true)
    expect(matchesFilter(repo({ status: status({ branch: null }) }), 'attention')).toBe(true)
    expect(matchesFilter(repo({ status: status({ operation: 'rebase' }) }), 'attention')).toBe(true)
    expect(matchesFilter(repo({}), 'attention')).toBe(false)
  })

  it('groups by folder keeping first-seen order', () => {
    const groups = groupByFolder([repo({ folder: '~/a', name: '1' }), repo({ folder: '~/b', name: '2' }), repo({ folder: '~/a', name: '3' })])
    expect(groups.map((g) => [g.folder, g.items.map((i) => i.name)])).toEqual([['~/a', ['1', '3']], ['~/b', ['2']]])
  })
})
