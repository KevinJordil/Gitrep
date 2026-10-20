import { parseConflicts, type ConflictBlock } from '../../shared/conflicts'
import type { ConflictHunk, ConflictSuggestion } from '../../shared/types'

// Where a line of the result comes from: kept as is, taken from a side, proposed by Claude, typed, or still in conflict.
export type Origin = 'common' | 'ours' | 'theirs' | 'claude' | 'edited' | 'conflict'

// The result of one conflicted file while it is being resolved. Unresolved blocks keep their markers.
export interface Draft {
  source: string // the file as git left it; another source means a new conflict and a stale draft
  lines: string[]
  origins: Origin[] // one per line
  newline: boolean // the file ends with a newline
  notes: string[] // what Claude said about the blocks it proposed
}

export function newDraft(text: string): Draft {
  const lines = text.split('\n')
  const newline = lines.length > 1 && lines[lines.length - 1] === ''
  if (newline) lines.pop()
  const origins: Origin[] = lines.map(() => 'common')
  for (const b of parseConflicts(lines)) origins.fill('conflict', b.start, b.end)
  return { source: text, lines, origins, newline, notes: [] }
}

export const blocksOf = (d: Draft): ConflictBlock[] => parseConflicts(d.lines)
export const textOf = (d: Draft): string => d.lines.join('\n') + (d.newline ? '\n' : '')

// Replaces one block of the result (markers included) with the chosen lines.
export function take(d: Draft, b: ConflictBlock, lines: string[], origins: Origin[]): Draft {
  return {
    ...d,
    lines: [...d.lines.slice(0, b.start), ...lines, ...d.lines.slice(b.end)],
    origins: [...d.origins.slice(0, b.start), ...origins, ...d.origins.slice(b.end)]
  }
}

export type Choice = 'ours' | 'theirs' | 'both'

// 'both': the upper side first, then the lower one.
export function takeSide(d: Draft, b: ConflictBlock, choice: Choice): Draft {
  const ours = choice === 'theirs' ? [] : b.ours
  const theirs = choice === 'ours' ? [] : b.theirs
  return take(d, b, [...ours, ...theirs], [...ours.map((): Origin => 'ours'), ...theirs.map((): Origin => 'theirs')])
}

// Every remaining block from one side, last block first so earlier positions stay valid.
export function takeAll(d: Draft, side: 'ours' | 'theirs'): Draft {
  return blocksOf(d)
    .reverse()
    .reduce((acc, b) => takeSide(acc, b, side), d)
}

// One edit changes one region: the lines kept before and after it keep their origin, the rest is 'edited'.
export function edit(d: Draft, text: string): Draft {
  const next = text.split('\n')
  const old = d.lines
  let p = 0
  while (p < old.length && p < next.length && old[p] === next[p]) p++
  let s = 0
  while (s < old.length - p && s < next.length - p && old[old.length - 1 - s] === next[next.length - 1 - s]) s++
  const typed: Origin[] = Array(next.length - p - s).fill('edited')
  return { ...d, lines: next, origins: [...d.origins.slice(0, p), ...typed, ...d.origins.slice(old.length - s)] }
}

const CONTEXT = 5

// What Claude gets for one block: its three versions and a few lines around it.
export function hunkOf(d: Draft, b: ConflictBlock): ConflictHunk {
  return { before: d.lines.slice(Math.max(0, b.start - CONTEXT), b.start), ours: b.ours, base: b.base, theirs: b.theirs, after: d.lines.slice(b.end, b.end + CONTEXT) }
}

export const noteOf = (s: ConflictSuggestion, n: number): string => `Conflict ${n}: ${s.summary} (${s.confidence} confidence). ${s.explanation}`.trim()

// Claude's proposals for the blocks of `d`, in block order (null: none for that block). Applied last block first.
export function applySuggestions(d: Draft, suggestions: (ConflictSuggestion | null)[]): Draft {
  const blocks = blocksOf(d)
  let out = d
  for (let i = blocks.length - 1; i >= 0; i--) {
    const s = suggestions[i]
    if (s) out = take(out, blocks[i], s.lines, s.lines.map((): Origin => 'claude'))
  }
  const notes = suggestions.flatMap((s, i) => (s ? [noteOf(s, i + 1)] : []))
  return { ...out, notes: [...d.notes, ...notes] }
}
