import { describe, expect, it } from 'vitest'
import type { Commit } from '../src/shared/types'
import { ancestorsOf, layoutGraph, searchCommits, splitMatch, type GraphNode } from '../src/renderer/src/graph'

const n = (sha: string, ...parents: string[]): GraphNode => ({ sha, parents })
const seg = (kind: 'through' | 'top' | 'bottom', from: number, to: number, color: number, dashed = false) => ({ kind, from, to, color, dashed })

describe('layoutGraph', () => {
  it('keeps a linear history in one lane', () => {
    expect(layoutGraph([n('a', 'b'), n('b', 'c'), n('c')])).toEqual([
      { lane: 0, color: 0, width: 1, segments: [seg('bottom', 0, 0, 0)] },
      { lane: 0, color: 0, width: 1, segments: [seg('top', 0, 0, 0), seg('bottom', 0, 0, 0)] },
      { lane: 0, color: 0, width: 1, segments: [seg('top', 0, 0, 0)] }
    ])
  })

  it('opens a lane for the second parent of a merge and joins it back at the fork point', () => {
    const rows = layoutGraph([n('m', 'a', 'f'), n('f', 'a'), n('a', 'r'), n('r')])
    expect(rows[0]).toEqual({ lane: 0, color: 0, width: 2, segments: [seg('bottom', 0, 0, 0), seg('bottom', 0, 1, 1)] })
    expect(rows[1]).toEqual({ lane: 1, color: 1, width: 2, segments: [seg('through', 0, 0, 0), seg('top', 1, 1, 1), seg('bottom', 1, 1, 1)] })
    expect(rows[2]).toEqual({ lane: 0, color: 0, width: 2, segments: [seg('top', 0, 0, 0), seg('top', 1, 0, 1), seg('bottom', 0, 0, 0)] })
    expect(rows[3]).toEqual({ lane: 0, color: 0, width: 1, segments: [seg('top', 0, 0, 0)] })
  })

  it('joins a merge parent into the lane already waiting for it', () => {
    const rows = layoutGraph([n('x', 'b'), n('m', 'a', 'b'), n('b', 'a'), n('a')])
    expect(rows[1]).toEqual({ lane: 1, color: 1, width: 2, segments: [seg('through', 0, 0, 0), seg('bottom', 1, 1, 1), seg('bottom', 1, 0, 0)] })
    expect(rows[3].segments).toEqual([seg('top', 0, 0, 0), seg('top', 1, 0, 1)])
  })

  it('reuses freed lanes and gives every new lane a new color', () => {
    const rows = layoutGraph([n('a', 'c'), n('b', 'c'), n('c'), n('d')])
    expect(rows.map((r) => [r.lane, r.color])).toEqual([
      [0, 0],
      [1, 1],
      [0, 0],
      [0, 2]
    ])
    expect(rows[2].segments).toEqual([seg('top', 0, 0, 0), seg('top', 1, 0, 1)])
  })

  it('draws the work-in-progress line dashed down to HEAD, even across other rows', () => {
    const rows = layoutGraph([{ sha: 'WIP', parents: ['h'], wip: true }, n('x', 'h'), n('h')])
    expect(rows[0].segments).toEqual([seg('bottom', 0, 0, 0, true)])
    expect(rows[1].segments).toEqual([seg('through', 0, 0, 0, true), seg('bottom', 1, 1, 1)])
    expect(rows[2].segments).toEqual([seg('top', 0, 0, 0, true), seg('top', 1, 0, 1)])
  })

  it('ends the line at a parent outside the loaded history', () => {
    expect(layoutGraph([n('a', 'zzz')])).toEqual([{ lane: 0, color: 0, width: 1, segments: [] }])
  })
})

const commit = (sha: string, subject: string, author: string): Commit => ({ sha, parents: [], author, email: '', date: 0, subject, refs: [] })

describe('searchCommits', () => {
  const list = [commit('a1b2', 'fix(ota): timeout', 'Nora'), commit('c3d4', 'docs: OTA guide', 'Arno'), commit('e5f6', 'chore: bump', 'Otavio')]

  it('matches message, author and SHA prefix, case-insensitively', () => {
    expect(searchCommits(list, 'ota', 'all')).toEqual([0, 1, 2])
    expect(searchCommits(list, 'OTA', 'message')).toEqual([0, 1])
    expect(searchCommits(list, 'ota', 'author')).toEqual([2])
    expect(searchCommits(list, 'c3', 'sha')).toEqual([1])
    expect(searchCommits(list, 'b2', 'sha')).toEqual([])
    expect(searchCommits(list, '  ', 'all')).toEqual([])
  })
})

describe('splitMatch', () => {
  it('splits around the first occurrence, keeping the original case', () => {
    expect(splitMatch('fix(OTA): raise', 'ota')).toEqual(['fix(', 'OTA', '): raise'])
    expect(splitMatch('nothing', 'ota')).toBeNull()
    expect(splitMatch('x', '')).toBeNull()
  })
})

describe('ancestorsOf', () => {
  it('lists the strict ancestors of HEAD through every parent, not HEAD itself nor other branches', () => {
    const c = (sha: string, ...parents: string[]) => ({ sha, parents }) as Commit
    const log = [c('m', 'a', 'f'), c('x', 'a'), c('f', 'r'), c('a', 'r'), c('r')]
    expect([...ancestorsOf('m', log)].sort()).toEqual(['a', 'f', 'r'])
    expect(ancestorsOf(null, log).size).toBe(0)
  })
})
