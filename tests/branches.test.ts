import { describe, expect, it } from 'vitest'
import { isActive } from '../src/shared/branches'
import type { Branch } from '../src/shared/types'

const DAY = 86400
const NOW = 1_800_000_000
const b = (name: string, daysAgo: number, extra: Partial<Branch> = {}): Branch => ({
  name, remote: false, current: false, upstream: null, ahead: 0, behind: 0, sha: name, date: NOW - daysAgo * DAY, ...extra
})

describe('isActive', () => {
  const list = [
    b('main', 400, { current: true, upstream: 'origin/main' }),
    b('origin/main', 400, { remote: true }),
    b('origin/old', 400, { remote: true }),
    b('recent', 29),
    b('edge', 30),
    b('quarter', 60)
  ]
  const names = (days: number) => list.filter(isActive(list, days, NOW)).map((x) => x.name)

  it('keeps tips committed in the last N days, the current branch and its upstream', () => {
    expect(names(30)).toEqual(['main', 'origin/main', 'recent', 'edge'])
    expect(names(90)).toEqual(['main', 'origin/main', 'recent', 'edge', 'quarter'])
  })

  it('keeps every branch when days is 0', () => {
    expect(names(0)).toHaveLength(list.length)
  })
})
