import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { blameRows, heatColor, heatOf } from '../src/renderer/src/blame'
import type { BlameCommit } from '../src/shared/types'

const commit = (sha: string, date: number): BlameCommit => ({ sha, author: 'Ada', email: 'ada@example.com', date, subject: sha, previous: null })

describe('heatColor and heatOf', () => {
  it('goes from grey (oldest) through brown to amber (newest), the colors of the legend', () => {
    expect([heatColor(0), heatColor(0.4), heatColor(1)]).toEqual(['#4a4f5a', '#7a5a24', '#e8b24a'])
    expect(heatColor(0.5)).toBe('#8c692a')
    expect(heatColor(7)).toBe('#e8b24a')
    const css = readFileSync(join(__dirname, '../src/renderer/src/styles.css'), 'utf8')
    const token = (name: string) => new RegExp(`--heat-${name}:\\s*(#[0-9a-f]{6});`).exec(css)?.[1]
    expect([token('old'), token('mid'), token('new')]).toEqual([heatColor(0), heatColor(0.4), heatColor(1)])
  })

  it('ranks the commits by date: newest amber, oldest grey, equal dates alike, a single commit amber', () => {
    const heat = heatOf([commit('new', 300), commit('old', 100), commit('mid', 200), commit('same', 300)])
    expect([heat.get('new'), heat.get('mid'), heat.get('old'), heat.get('same')]).toEqual(['#e8b24a', '#8c692a', '#4a4f5a', '#e8b24a'])
    expect(heatOf([commit('only', 5)]).get('only')).toBe('#e8b24a')
  })
})

describe('blameRows', () => {
  const blame = {
    lines: ['a', 'b', 'c', 'd'],
    chunks: [
      { sha: 'x', start: 1, count: 3 },
      { sha: 'y', start: 4, count: 1 }
    ]
  }

  it('gives each line its commit and marks the first line of each chunk', () => {
    expect(blameRows(blame)).toEqual([
      { n: 1, text: 'a', sha: 'x', first: true },
      { n: 2, text: 'b', sha: 'x', first: false },
      { n: 3, text: 'c', sha: 'x', first: false },
      { n: 4, text: 'd', sha: 'y', first: true }
    ])
  })

  it('stops at the line limit', () => {
    expect(blameRows(blame, 2).map((r) => r.n)).toEqual([1, 2])
  })
})
