// Conflict markers as git writes them with merge.conflictStyle=diff3; the base section is optional.
export interface ConflictBlock {
  start: number // index of the <<<<<<< line
  end: number // index after the >>>>>>> line
  ours: string[] // upper side: stage 2, HEAD
  base: string[] | null // common ancestor; null when the file was written without diff3
  theirs: string[] // lower side: stage 3
}

const OPEN = /^<{7}(?: |\r?$)/
const BASE = /^\|{7}(?: |\r?$)/
const SPLIT = /^={7}\r?$/
const CLOSE = /^>{7}(?: |\r?$)/

// Blocks in file order. An unterminated or garbled block is not a block: its lines stay plain text.
export function parseConflicts(lines: string[]): ConflictBlock[] {
  const blocks: ConflictBlock[] = []
  for (let i = 0; i < lines.length; i++) {
    if (!OPEN.test(lines[i])) continue
    let base = -1
    let split = -1
    let j = i + 1
    for (; j < lines.length; j++) {
      const l = lines[j]
      if (OPEN.test(l) || (split >= 0 && CLOSE.test(l))) break
      if (split < 0 && base < 0 && BASE.test(l)) base = j
      else if (split < 0 && SPLIT.test(l)) split = j
    }
    if (j >= lines.length || split < 0 || !CLOSE.test(lines[j])) continue
    blocks.push({ start: i, end: j + 1, ours: lines.slice(i + 1, base >= 0 ? base : split), base: base >= 0 ? lines.slice(base + 1, split) : null, theirs: lines.slice(split + 1, j) })
    i = j
  }
  return blocks
}

export const hasConflictMarkers = (text: string): boolean => parseConflicts(text.split('\n')).length > 0
