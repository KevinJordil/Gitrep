import { describe, expect, it } from 'vitest'
import type { Hunk } from '../src/shared/types'
import { diffSides, highlightDiff, MAX_HIGHLIGHT, tokenize } from '../src/renderer/src/highlight'

const hunk = (lines: [kind: 'context' | 'add' | 'del', text: string][]): Hunk => ({
  header: '@@',
  oldStart: 1,
  oldLines: 0,
  newStart: 1,
  newLines: 0,
  lines: lines.map(([kind, text]) => ({ kind, text, oldNo: null, newNo: null }))
})

describe('tokenize', () => {
  it('colors a C snippet with the theme variables, comments in italics', async () => {
    const lines = await tokenize('#include <stdio.h>\n/* a\n b */\nint main(void) {\n  return printf("hi %d", 42);\n}', 'c')
    const color = (line: number, text: string) => lines[line].find((t) => t.text.trim() === text)
    expect(color(0, '#include')?.color).toBe('var(--syn-pp)')
    expect(color(0, '<stdio.h>')?.color).toBe('var(--syn-str)')
    expect(lines[2][0]).toEqual({ text: ' b */', color: 'var(--syn-com)', italic: true }) // inside a multi-line comment
    expect(color(3, 'int')?.color).toBe('var(--syn-ty)')
    expect(color(3, 'main')?.color).toBe('var(--syn-fn)')
    expect(color(4, 'return')?.color).toBe('var(--syn-kw)')
    expect(color(4, '"hi %d"')?.color).toBe('var(--syn-str)')
    expect(color(4, '42')?.color).toBe('var(--syn-num)')
    expect(color(4, ');')?.color).toBeUndefined() // punctuation keeps the line color
  })
})

describe('diffSides and highlightDiff', () => {
  const hunks = [hunk([['context', '/* start'], ['del', 'old */'], ['add', 'new */'], ['context', 'int x;']])]

  it('splits the lines into the old and the new text', () => {
    expect(diffSides(hunks)).toEqual({
      old: ['/* start', 'old */', 'int x;'],
      new: ['/* start', 'new */', 'int x;'],
      at: [[{ side: 'new', line: 0 }, { side: 'old', line: 1 }, { side: 'new', line: 1 }, { side: 'new', line: 2 }]]
    })
  })

  it('colors each line within its side, keeping multi-line comments', async () => {
    const lines = (await highlightDiff(hunks, 'c'))![0]
    expect(lines[1]?.[0].color).toBe('var(--syn-com)')
    expect(lines[2]?.[0].color).toBe('var(--syn-com)')
    expect(lines[3]?.find((t) => t.text === 'int')?.color).toBe('var(--syn-ty)')
  })

  it('leaves too big diffs plain', async () => {
    expect(await highlightDiff([hunk([['add', 'x'.repeat(MAX_HIGHLIGHT + 1)]])], 'c')).toBeNull()
  })
})
