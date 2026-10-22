import type { DiffLine, Hunk } from '../../shared/types'

// A run of rows of the full listing: a hunk of the diff (index = its place in the diff) or a gap of unchanged lines (index null).
export interface Segment {
  index: number | null
  hunk: Hunk
}

const startOf = (start: number, count: number) => (count === 0 ? start + 1 : start) // a hunk without lines on a side names the line before it

// The whole file as rows: the hunks exactly as they are, with the unchanged lines between, before and after them as context.
// text: the new side of the file (the old side for a deleted file, side 'old'). Carriage returns stay in the text.
export function fullListing(text: string, hunks: Hunk[], side: 'new' | 'old' = 'new'): Segment[] {
  const file = text.split('\n')
  if (file[file.length - 1] === '') file.pop()
  const out: Segment[] = []
  let oldNext = 1
  let newNext = 1
  const gap = (until: number) => {
    const lines: DiffLine[] = []
    for (let n = side === 'new' ? newNext : oldNext; n < until && n <= file.length; n++, oldNext++, newNext++) {
      lines.push({ kind: 'context', text: file[n - 1], oldNo: side === 'new' ? oldNext : n, newNo: side === 'new' ? n : null })
    }
    if (lines.length) out.push({ index: null, hunk: { header: '', oldStart: lines[0].oldNo ?? 0, oldLines: lines.length, newStart: lines[0].newNo ?? 0, newLines: lines.length, lines } })
  }
  hunks.forEach((h, index) => {
    gap(startOf(side === 'new' ? h.newStart : h.oldStart, side === 'new' ? h.newLines : h.oldLines))
    out.push({ index, hunk: h })
    oldNext = startOf(h.oldStart, h.oldLines) + h.oldLines
    newNext = startOf(h.newStart, h.newLines) + h.newLines
  })
  gap(Infinity)
  return out
}
