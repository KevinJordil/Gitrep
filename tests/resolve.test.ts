import { describe, expect, it } from 'vitest'
import { hasConflictMarkers, parseConflicts } from '../src/shared/conflicts'
import { applySuggestions, blocksOf, edit, hunkOf, newDraft, takeAll, takeSide, textOf } from '../src/renderer/src/resolve'

const FILE = ['one', '<<<<<<< HEAD', 'MAIN', '||||||| parent of 593254c (feat)', 'two', '=======', 'FEATURE', '>>>>>>> 593254c (feat)', 'three', '<<<<<<< HEAD', 'a', '=======', 'b', '>>>>>>> feature', ''].join('\n')

describe('parseConflicts', () => {
  it('reads diff3 blocks (with base) and plain blocks (without)', () => {
    expect(parseConflicts(FILE.split('\n'))).toEqual([
      { start: 1, end: 8, ours: ['MAIN'], base: ['two'], theirs: ['FEATURE'] },
      { start: 9, end: 14, ours: ['a'], base: null, theirs: ['b'] }
    ])
  })

  it('ignores unterminated blocks and accepts CRLF markers', () => {
    expect(parseConflicts(['<<<<<<< HEAD', 'x', '======='])).toEqual([])
    expect(parseConflicts(['<<<<<<< HEAD\r', 'x\r', '=======\r', 'y\r', '>>>>>>> b\r'])).toEqual([{ start: 0, end: 5, ours: ['x\r'], base: null, theirs: ['y\r'] }])
    expect(hasConflictMarkers('a\n=======\nb\n')).toBe(false)
    expect(hasConflictMarkers(FILE)).toBe(true)
  })
})

describe('draft', () => {
  it('marks conflict lines and keeps the final newline', () => {
    const d = newDraft(FILE)
    expect(d.lines).toHaveLength(14)
    expect(d.origins.slice(0, 3)).toEqual(['common', 'conflict', 'conflict'])
    expect(textOf(d)).toBe(FILE)
  })

  it('takes one side, both sides, or every block from one side', () => {
    const d = newDraft(FILE)
    const [first] = blocksOf(d)
    const ours = takeSide(d, first, 'ours')
    expect(ours.lines.slice(0, 3)).toEqual(['one', 'MAIN', 'three'])
    expect(ours.origins.slice(0, 3)).toEqual(['common', 'ours', 'common'])
    expect(blocksOf(ours)).toHaveLength(1)
    const both = takeSide(d, first, 'both')
    expect(both.lines.slice(0, 4)).toEqual(['one', 'MAIN', 'FEATURE', 'three'])
    expect(both.origins.slice(1, 3)).toEqual(['ours', 'theirs'])
    expect(textOf(takeAll(d, 'theirs'))).toBe('one\nFEATURE\nthree\nb\n')
  })

  it('marks typed lines as edited and keeps the origin of the others', () => {
    const raw = newDraft('x\n<<<<<<< HEAD\na\n=======\nb\n>>>>>>> f\ny\n')
    const d = takeSide(raw, blocksOf(raw)[0], 'both')
    const e = edit(d, 'x\na\nnew\nb\ny')
    expect(e.origins).toEqual(['common', 'ours', 'edited', 'theirs', 'common'])
    expect(edit(e, 'x\nb\ny').origins).toEqual(['common', 'theirs', 'common'])
  })

  it('sends a block with its context and applies Claude proposals as a draft', () => {
    const d = newDraft(FILE)
    const blocks = blocksOf(d)
    expect(hunkOf(d, blocks[1])).toEqual({ before: ['two', '=======', 'FEATURE', '>>>>>>> 593254c (feat)', 'three'], ours: ['a'], base: null, theirs: ['b'], after: [] })
    const s = applySuggestions(d, [{ lines: ['MAIN', 'FEATURE'], confidence: 'high', summary: 'keep both', explanation: 'Both are needed.' }, null])
    expect(s.lines.slice(0, 4)).toEqual(['one', 'MAIN', 'FEATURE', 'three'])
    expect(s.origins.slice(1, 3)).toEqual(['claude', 'claude'])
    expect(blocksOf(s)).toHaveLength(1)
    expect(s.notes).toEqual(['Conflict 1: keep both (high confidence). Both are needed.'])
  })
})
