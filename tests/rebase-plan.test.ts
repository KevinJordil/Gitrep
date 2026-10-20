import { describe, expect, it } from 'vitest'
import { applyPlan, move, movedRows, result, rowsOf, setRow, summary, targetOf, toRequest, validate, type Row } from '../src/renderer/src/rebase'
import type { RebasePlan } from '../src/shared/types'

// Newest first, like the editor: d (wip), c (typo fix), b (feature, with a body), a (test).
const PLAN: RebasePlan = {
  branch: 'feature',
  onto: 'base0000',
  ontoLabel: 'main',
  pushed: 0,
  commits: [
    { sha: 'dddd0000', subject: 'wip: debug', body: '', author: 'A', date: 0 },
    { sha: 'cccc0000', subject: 'fix typo', body: '', author: 'A', date: 0 },
    { sha: 'bbbb0000', subject: 'feat: retry', body: 'Why it retries.', author: 'A', date: 0 },
    { sha: 'aaaa0000', subject: 'test: cover', body: '', author: 'A', date: 0 }
  ]
}
const shas = (rows: Row[]) => rows.map((r) => r.sha[0])

describe('rebase editor rows', () => {
  it('start as picks in the original order and move up or down', () => {
    const rows = rowsOf(PLAN)
    expect(rows.map((r) => [r.sha[0], r.action, r.message])).toEqual([
      ['d', 'pick', 'wip: debug'],
      ['c', 'pick', 'fix typo'],
      ['b', 'pick', 'feat: retry'],
      ['a', 'pick', 'test: cover']
    ])
    expect(shas(move(rows, 3, 0))).toEqual(['a', 'd', 'c', 'b'])
    expect(move(rows, 0, -1)).toBe(rows)
  })

  it('count as moved only the rows that left the original order', () => {
    const rows = rowsOf(PLAN)
    expect([...movedRows(move(rows, 3, 0))]).toEqual(['aaaa0000'])
    expect(movedRows(rows).size).toBe(0)
  })

  it('show the expected result: melded, dropped, renamed and moved commits', () => {
    let rows = move(rowsOf(PLAN), 3, 0) // test: cover moves to the top
    rows = setRow(rows, 1, { action: 'drop' })
    rows = setRow(rows, 2, { action: 'fixup' })
    rows = setRow(rows, 3, { action: 'reword', message: 'feat: retry with backoff' })
    expect(shas(rows)).toEqual(['a', 'd', 'c', 'b'])
    expect(targetOf(rows, 2)?.sha).toBe('bbbb0000')
    expect(result(rows)).toEqual([
      { sha: 'aaaa0000', subject: 'test: cover', note: 'moved' },
      { sha: 'bbbb0000', subject: 'feat: retry with backoff', note: 'includes cccc000 · renamed' }
    ])
    expect(summary(rows)).toEqual({ squashed: 1, dropped: 1, renamed: 1, moved: 1 })
  })

  it('refuse a melded oldest commit, an all-dropped list and an empty message', () => {
    const rows = rowsOf(PLAN)
    expect(validate(rows)).toBeNull()
    expect(validate(setRow(rows, 3, { action: 'squash' }))).toBe('aaaa000 has no kept commit below it to meld into')
    expect(validate(rows.map((r) => ({ ...r, action: 'drop' as const })))).toBe('Keep at least one commit')
    expect(validate(setRow(rows, 0, { action: 'reword', message: ' ' }))).toBe('A reworded commit needs a message')
  })

  it('send the list oldest first, a reword keeping its body', () => {
    const rows = setRow(rowsOf(PLAN), 2, { action: 'reword', message: 'feat: better' })
    expect(toRequest('feature', 'main', rows, true)).toEqual({
      branch: 'feature',
      upstream: 'main',
      autostash: true,
      items: [
        { sha: 'aaaa0000', action: 'pick' },
        { sha: 'bbbb0000', action: 'reword', message: 'feat: better\n\nWhy it retries.' },
        { sha: 'cccc0000', action: 'pick' },
        { sha: 'dddd0000', action: 'pick' }
      ]
    })
  })

  it('apply a plan proposed by Claude to the original rows', () => {
    const rows = applyPlan(rowsOf(PLAN), {
      explanation: 'x',
      items: [
        { sha: 'aaaa0000', action: 'pick' },
        { sha: 'bbbb0000', action: 'reword', message: 'feat: retry on reconnect\n\nWhy it retries.' },
        { sha: 'cccc0000', action: 'fixup' },
        { sha: 'dddd0000', action: 'drop' }
      ]
    })
    expect(rows.map((r) => [r.sha[0], r.action, r.message])).toEqual([
      ['d', 'drop', 'wip: debug'],
      ['c', 'fixup', 'fix typo'],
      ['b', 'reword', 'feat: retry on reconnect'],
      ['a', 'pick', 'test: cover']
    ])
  })
})
