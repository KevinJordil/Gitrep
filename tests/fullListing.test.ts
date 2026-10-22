import { describe, expect, it } from 'vitest'
import { parseDiff } from '../src/main/diff'
import { fullListing } from '../src/renderer/src/fullListing'

const hunks = (patch: string) => parseDiff(`diff --git a/f b/f\n--- a/f\n+++ b/f\n${patch}`)[0].hunks
const view = (s: ReturnType<typeof fullListing>) => s.map((x) => ({ index: x.index, rows: x.hunk.lines.map((l) => `${l.kind[0]}${l.oldNo ?? ''}/${l.newNo ?? ''}:${l.text}`) }))

const TWO = '@@ -2,3 +2,3 @@\n b\n-c\n+C\n d\n@@ -7,3 +7,3 @@\n g\n-h\n+H\n i\n'

describe('fullListing', () => {
  it('fills the gaps before, between and after the hunks, with both line numbers', () => {
    const out = fullListing('a\nb\nC\nd\ne\nf\ng\nH\ni\nj\n', hunks(TWO))
    expect(view(out)).toEqual([
      { index: null, rows: ['c1/1:a'] },
      { index: 0, rows: ['c2/2:b', 'd3/:c', 'a/3:C', 'c4/4:d'] },
      { index: null, rows: ['c5/5:e', 'c6/6:f'] },
      { index: 1, rows: ['c7/7:g', 'd8/:h', 'a/8:H', 'c9/9:i'] },
      { index: null, rows: ['c10/10:j'] }
    ])
    expect(out[1].hunk.header).toBe('@@ -2,3 +2,3 @@')
  })

  it('keeps old and new numbers apart once hunks add or remove lines', () => {
    const h = hunks('@@ -2 +1,0 @@\n-b\n')
    expect(view(fullListing('a\nc\n', h))).toEqual([
      { index: null, rows: ['c1/1:a'] },
      { index: 0, rows: ['d2/:b'] },
      { index: null, rows: ['c3/2:c'] }
    ])
  })

  it('handles a hunk at the very start and at the very end', () => {
    expect(view(fullListing('A\nb\nc\n', hunks('@@ -1 +1 @@\n-a\n+A\n')))).toEqual([
      { index: 0, rows: ['d1/:a', 'a/1:A'] },
      { index: null, rows: ['c2/2:b', 'c3/3:c'] }
    ])
    expect(view(fullListing('a\nb\nC\n', hunks('@@ -3 +3 @@\n-c\n+C\n')))).toEqual([
      { index: null, rows: ['c1/1:a', 'c2/2:b'] },
      { index: 0, rows: ['d3/:c', 'a/3:C'] }
    ])
  })

  it('shows the old content of a deleted file', () => {
    expect(view(fullListing('a\nb\n', hunks('@@ -1,2 +0,0 @@\n-a\n-b\n'), 'old'))).toEqual([{ index: 0, rows: ['d1/:a', 'd2/:b'] }])
  })

  it('does not invent a line after the last newline, nor without one', () => {
    expect(fullListing('a\nb\nc\n', hunks('@@ -1 +1 @@\n-x\n+a\n')).flatMap((s) => s.hunk.lines).length).toBe(4)
    expect(view(fullListing('A\nb\nc', hunks('@@ -1 +1 @@\n-a\n+A\n')))).toEqual([
      { index: 0, rows: ['d1/:a', 'a/1:A'] },
      { index: null, rows: ['c2/2:b', 'c3/3:c'] }
    ])
  })

  it('keeps carriage returns in the text without breaking the numbering', () => {
    const out = fullListing('a\r\nB\r\nc\r\n', hunks('@@ -2 +2 @@\n-b\r\n+B\r\n'))
    expect(view(out)).toEqual([
      { index: null, rows: ['c1/1:a\r'] },
      { index: 0, rows: ['d2/:b\r', 'a/2:B\r'] },
      { index: null, rows: ['c3/3:c\r'] }
    ])
  })

  it('is the plain hunks when there are none', () => {
    expect(view(fullListing('a\nb\n', []))).toEqual([{ index: null, rows: ['c1/1:a', 'c2/2:b'] }])
  })
})
