import { describe, expect, it } from 'vitest'
import type { FileDiff } from '../src/shared/types'
import { changeMarks } from '../src/renderer/src/changeMarks'

const line = (kind: 'add' | 'del' | 'ctx', newNo: number | null) => ({ kind, newNo, oldNo: null, text: '' })
const diff = (lines: ReturnType<typeof line>[], newStart = 1, newLines = 5) => ({ hunks: [{ newStart, newLines, lines }] }) as unknown as FileDiff

describe('changeMarks', () => {
  it('marks added lines and the line after a removal', () => {
    const d = diff([line('ctx', 1), line('add', 2), line('del', null), line('ctx', 3), line('ctx', 4)])
    expect(changeMarks(d)).toEqual({ add: [2], del: [3] })
  })
  it('marks a removal at the end of the file after the last line', () => {
    expect(changeMarks(diff([line('ctx', 1), line('del', null)], 1, 1))).toEqual({ add: [], del: [2] })
  })
  it('has nothing for no diff', () => {
    expect(changeMarks(null)).toEqual({ add: [], del: [] })
  })
})
