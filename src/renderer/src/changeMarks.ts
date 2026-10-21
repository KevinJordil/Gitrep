import type { FileDiff } from '../../shared/types'

export type Marks = { add: number[]; del: number[] }

// Lines (1-based, in the new file) a diff adds or changes, and where it removes lines (the line after the removal).
export function changeMarks(diff: FileDiff | null | undefined): Marks {
  const add: number[] = []
  const del: number[] = []
  for (const h of diff?.hunks ?? []) {
    let removed = false
    for (const l of h.lines) {
      if (l.kind === 'del') removed = true
      else if (l.newNo !== null) {
        if (l.kind === 'add') add.push(l.newNo)
        else if (removed) del.push(l.newNo)
        removed = false
      }
    }
    if (removed) del.push(h.newStart + h.newLines)
  }
  return { add, del }
}
