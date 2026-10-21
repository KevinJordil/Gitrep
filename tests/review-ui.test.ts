import { describe, expect, it } from 'vitest'
import { DEFAULT_CONFIG } from '../src/main/config'
import { promptProblem } from '../src/renderer/src/PromptsDialog'
import { defaultBase, initialEdits, keptFixes, promptChoices, visibleFindings } from '../src/renderer/src/review'
import type { Branch, Review, ReviewFinding } from '../src/shared/types'

const branch = (name: string, remote = false): Branch => ({ name, remote, current: false, upstream: null, ahead: 0, behind: 0, sha: 'a'.repeat(40), date: 0 })
const finding = (id: number, severity: ReviewFinding['severity'], path: string, line: number, fix: string[] | null = null): ReviewFinding => ({
  id,
  severity,
  path,
  side: 'new',
  line,
  endLine: line,
  anchor: { oldNo: null, newNo: line },
  title: `t${id}`,
  body: `body ${id}`,
  fix: fix && { original: [`old ${line}`], lines: fix }
})

describe('defaultBase', () => {
  it('prefers the request target, then develop, main, master, the remote-tracking copy first', () => {
    const list = [branch('feature'), branch('main'), branch('develop'), branch('origin/main', true), branch('origin/release', true)]
    expect(defaultBase(list, 'feature')).toBe('develop')
    expect(defaultBase(list, 'feature', 'main')).toBe('origin/main')
    expect(defaultBase(list, 'feature', 'release')).toBe('origin/release')
    expect(defaultBase([branch('feature'), branch('trunk')], 'feature')).toBe('trunk')
    expect(defaultBase([branch('upstream/topic', true), branch('upstream/main', true), branch('main')], 'upstream/topic')).toBe('upstream/main')
  })
})

describe('promptChoices', () => {
  it('puts the repository prompt first, then the global ones', () => {
    const own = { name: 'Firmware', text: 'ISR' }
    expect(promptChoices(DEFAULT_CONFIG.settings).map((c) => c.key)).toEqual(['global:Default review'])
    expect(promptChoices(DEFAULT_CONFIG.settings, { path: '/r', name: 'r', reviewPrompt: own })).toEqual([
      { key: 'repo', prompt: own, repo: true },
      { key: 'global:Default review', prompt: DEFAULT_CONFIG.settings.reviewPrompts[0], repo: false }
    ])
  })
})

describe('findings', () => {
  const list = [finding(1, 'minor', 'b.c', 3), finding(2, 'critical', 'b.c', 9, ['fixed 9']), finding(3, 'critical', 'a.c', 5, ['']), finding(4, 'important', 'a.c', 1)]

  it('sorts by severity, then file and line, and filters by severity and text', () => {
    expect(visibleFindings(list, 'all', '').map((f) => f.id)).toEqual([3, 2, 4, 1])
    expect(visibleFindings(list, 'critical', '').map((f) => f.id)).toEqual([3, 2])
    expect(visibleFindings(list, 'all', 'BODY 4').map((f) => f.id)).toEqual([4])
  })

  it('sends the edited fixes of the kept findings only; an emptied fix deletes the lines', () => {
    const review = { findings: list } as Review
    const edits = initialEdits(list)
    expect(keptFixes(review, edits)).toEqual([
      { id: 2, path: 'b.c', line: 9, endLine: 9, original: ['old 9'], lines: ['fixed 9'] },
      { id: 3, path: 'a.c', line: 5, endLine: 5, original: ['old 5'], lines: [] }
    ])
    expect(keptFixes(review, { ...edits, 2: { ...edits[2], keep: false }, 3: { ...edits[3], fix: 'a\nb' } })).toEqual([{ id: 3, path: 'a.c', line: 5, endLine: 5, original: ['old 5'], lines: ['a', 'b'] }])
  })
})

describe('promptProblem', () => {
  it('needs a unique name for each prompt', () => {
    expect(promptProblem([{ name: 'A', text: '' }], { name: 'A', text: 'own may reuse a global name' })).toBe('')
    expect(promptProblem([{ name: ' ', text: '' }], null)).toBe('Every prompt needs a name.')
    expect(promptProblem([{ name: 'A', text: '' }], { name: '', text: '' })).toBe('Every prompt needs a name.')
    expect(promptProblem([{ name: 'A', text: '' }, { name: 'A ', text: '' }], null)).toBe('Two prompts have the same name.')
    expect(promptProblem([{ name: 'x'.repeat(61), text: '' }], null)).toBe('A name is limited to 60 characters.')
  })
})
