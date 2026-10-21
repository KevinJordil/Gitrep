import { describe, expect, it } from 'vitest'
import { DEFAULT_CONFIG } from '../src/main/config'
import { promptProblem } from '../src/renderer/src/PromptsDialog'
import { type FindingEdit, defaultBase, initialEdits, keptComments, isMoved, keptFixes, postPlan, postStatus, promptChoices, visibleFindings } from '../src/renderer/src/review'
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

describe('posting', () => {
  const del: ReviewFinding = { ...finding(5, 'minor', 'a.c', 2), side: 'old', anchor: { oldNo: 2, newNo: null } }
  const ctx: ReviewFinding = { ...finding(6, 'important', 'a.c', 7), anchor: { oldNo: 6, newNo: 7 } }
  const review = { prompt: 'Mine', findings: [finding(1, 'critical', 'a.c', 3), del, ctx], files: [{ oldPath: 'a.c', newPath: 'a.c' }] } as Review

  it('makes comments of the kept findings, with the line numbers each side has', () => {
    const edits: Record<number, FindingEdit> = { ...initialEdits(review.findings), 6: { keep: true, body: '  edited  ', fix: null } }
    expect(keptComments(review, edits)).toEqual([
      { label: 'a.c:3', comment: { path: 'a.c', oldPath: 'a.c', newLine: 3, oldLine: null, body: 'body 1' } },
      { label: 'a.c:7', comment: { path: 'a.c', oldPath: 'a.c', newLine: 7, oldLine: 6, body: 'edited' } },
      { label: 'a.c:2', comment: { path: 'a.c', oldPath: 'a.c', newLine: null, oldLine: 2, body: 'body 5' } }
    ])
    expect(keptComments(review, { ...edits, 1: { ...edits[1], keep: false }, 5: { ...edits[5], body: ' ' } }).map((c) => c.label)).toEqual(['a.c:7'])
  })

  it('plans the calls of each forge and mode', () => {
    const comments = keptComments(review, initialEdits(review.findings)).slice(0, 1)
    const c = comments[0].comment
    expect(postPlan('gitlab', false, comments).map((s) => s.step)).toEqual([{ kind: 'comment', comment: c }])
    expect(postPlan('gitlab', true, comments).map((s) => s.label)).toEqual(['a.c:3', 'Publish the draft review'])
    expect(postPlan('github', false, comments).map((s) => s.step.kind)).toEqual(['comment'])
    expect(postPlan('github', true, comments)).toEqual([{ label: 'Pending review (1 comment)', step: { kind: 'review', body: '', comments: [c] } }])
    expect(postPlan('github', true, [])).toEqual([])
    expect(postPlan('gitlab', true, [])).toEqual([])
  })
})

describe('post progress', () => {
  const st = (state: 'todo' | 'run' | 'done' | 'fail' | 'skip') => ({ label: 'x', step: { kind: 'publish' as const }, state })
  it('counts a skipped step as complete, so the publish gate and the end can follow', () => {
    expect(postStatus([st('done'), st('skip'), st('todo')])).toEqual({ done: 1, skipped: 1, failed: 0, todo: 1, finished: false })
    expect(postStatus([st('done'), st('skip')])).toMatchObject({ finished: true })
    expect(postStatus([st('done'), st('fail')])).toMatchObject({ failed: 1, finished: false })
  })

  it('recognises the moved-request refusal through the IPC wrapper', () => {
    expect(isMoved(new Error("Error invoking remote method 'postReviewStep': Error: HEAD_MOVED: The request is at abc"))).toBe(true)
    expect(isMoved(new Error('GitLab refused the data (400)'))).toBe(false)
  })
})
