import type { InteractiveRebaseRequest, RebaseAction, RebasePlan, RebaseProposal } from '../../shared/types'

// One commit of the interactive rebase editor, listed newest first like the graph.
// squash / fixup meld the commit into the kept commit below it (older). message: the new subject of a reword.
export interface Row {
  sha: string
  subject: string
  body: string
  action: RebaseAction
  message: string
  index: number // position in the original list
}

export const rowsOf = (plan: RebasePlan): Row[] => plan.commits.map((c, index) => ({ sha: c.sha, subject: c.subject, body: c.body, action: 'pick', message: c.subject, index }))

export function move(rows: Row[], from: number, to: number): Row[] {
  if (to < 0 || to >= rows.length || from === to) return rows
  const next = [...rows]
  const [row] = next.splice(from, 1)
  next.splice(to, 0, row)
  return next
}

export const setRow = (rows: Row[], i: number, change: Partial<Row>): Row[] => rows.map((r, k) => (k === i ? { ...r, ...change } : r))

// The rows that moved: those outside the longest run that kept its original order.
export function movedRows(rows: Row[]): Set<string> {
  const best: number[] = rows.map(() => 1)
  const prev: number[] = rows.map(() => -1)
  rows.forEach((r, i) => {
    for (let j = 0; j < i; j++) {
      if (rows[j].index < r.index && best[j] + 1 > best[i]) {
        best[i] = best[j] + 1
        prev[i] = j
      }
    }
  })
  const kept = new Set<string>()
  for (let i = best.indexOf(Math.max(0, ...best)); i >= 0; i = prev[i]) kept.add(rows[i].sha)
  return new Set(rows.filter((r) => !kept.has(r.sha)).map((r) => r.sha))
}

// The kept commit a squash / fixup row melds into: the first kept row below it that is not melded itself.
export function targetOf(rows: Row[], i: number): Row | null {
  for (let k = i + 1; k < rows.length; k++) if (rows[k].action !== 'drop' && rows[k].action !== 'squash' && rows[k].action !== 'fixup') return rows[k]
  return null
}

export interface ResultCommit {
  sha: string
  subject: string
  note: string
}

// The branch after the rebase, newest first: melded commits go into the kept commit below them.
export function result(rows: Row[]): ResultCommit[] {
  const moved = movedRows(rows)
  const groups: { head: Row; melded: Row[] }[] = []
  for (const r of [...rows].reverse()) {
    if (r.action === 'drop') continue
    const last = groups[groups.length - 1]
    if ((r.action === 'squash' || r.action === 'fixup') && last) last.melded.push(r)
    else groups.push({ head: r, melded: [] })
  }
  return groups.reverse().map(({ head, melded }) => {
    const renamed = head.action === 'reword' && head.message.trim() !== head.subject
    const note = [melded.length ? `includes ${melded.map((m) => m.sha.slice(0, 7)).join(', ')}` : '', renamed ? 'renamed' : '', moved.has(head.sha) ? 'moved' : ''].filter(Boolean).join(' · ')
    return { sha: head.sha, subject: renamed ? head.message.trim() : head.subject, note }
  })
}

export function summary(rows: Row[]): { squashed: number; dropped: number; renamed: number; moved: number } {
  return {
    squashed: rows.filter((r) => r.action === 'squash' || r.action === 'fixup').length,
    dropped: rows.filter((r) => r.action === 'drop').length,
    renamed: rows.filter((r) => r.action === 'reword' && r.message.trim() !== r.subject).length,
    moved: movedRows(rows).size
  }
}

// Why the list cannot be run as it is, or null.
export function validate(rows: Row[]): string | null {
  const kept = rows.filter((r) => r.action !== 'drop')
  if (!kept.length) return 'Keep at least one commit'
  const oldest = kept[kept.length - 1]
  if (oldest.action === 'squash' || oldest.action === 'fixup') return `${oldest.sha.slice(0, 7)} has no kept commit below it to meld into`
  if (rows.some((r) => r.action === 'reword' && !r.message.trim())) return 'A reworded commit needs a message'
  return null
}

// git wants the oldest commit first. A reword keeps the original body under the new subject.
export function toRequest(branch: string, upstream: string, rows: Row[], autostash: boolean): InteractiveRebaseRequest {
  const items = [...rows].reverse().map((r) => (r.action === 'reword' ? { sha: r.sha, action: r.action, message: r.body ? `${r.message.trim()}\n\n${r.body}` : r.message.trim() } : { sha: r.sha, action: r.action }))
  return { branch, upstream, items, autostash }
}

// Claude's plan (oldest first) applied to the original rows.
export function applyPlan(rows: Row[], proposal: RebaseProposal): Row[] {
  const bySha = new Map(rows.map((r) => [r.sha, r]))
  return [...proposal.items].reverse().flatMap((item) => {
    const r = bySha.get(item.sha)
    return r ? [{ ...r, action: item.action, message: item.action === 'reword' && item.message ? item.message.split('\n')[0] : r.subject }] : []
  })
}
