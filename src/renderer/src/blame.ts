import type { Blame, BlameCommit } from '../../shared/types'

// The age legend from old to recent (t = 0 … 1): grey, brown, amber. Same values as --heat-old, --heat-mid and
// --heat-new in styles.css (inline styles cannot interpolate CSS variables).
const STOPS: [number, number[]][] = [
  [0, [0x4a, 0x4f, 0x5a]],
  [0.4, [0x7a, 0x5a, 0x24]],
  [1, [0xe8, 0xb2, 0x4a]]
]

export function heatColor(t: number): string {
  const x = Math.min(1, Math.max(0, t))
  const i = x <= STOPS[1][0] ? 1 : 2
  const [t0, a] = STOPS[i - 1]
  const [t1, b] = STOPS[i]
  const k = (x - t0) / (t1 - t0)
  return '#' + a.map((v, j) => Math.round(v + (b[j] - v) * k).toString(16).padStart(2, '0')).join('')
}

// Heat of each commit by the rank of its date among the file's commits (not by age: one very old commit must not
// flatten the others): newest amber, oldest grey, a single commit amber.
export function heatOf(commits: BlameCommit[]): Map<string, string> {
  const dates = [...new Set(commits.map((c) => c.date))].sort((a, b) => a - b)
  const rank = new Map(dates.map((d, i) => [d, dates.length === 1 ? 1 : i / (dates.length - 1)]))
  return new Map(commits.map((c) => [c.sha, heatColor(rank.get(c.date) ?? 1)]))
}

export interface BlameRow {
  n: number // 1-based line number
  text: string
  sha: string
  first: boolean // the first line of its chunk: shows the commit
}

// The lines drawn, at most `limit`.
export function blameRows(blame: Pick<Blame, 'lines' | 'chunks'>, limit = Infinity): BlameRow[] {
  const rows: BlameRow[] = []
  for (const c of blame.chunks) {
    for (let i = 0; i < c.count && c.start + i <= limit; i++) rows.push({ n: c.start + i, text: blame.lines[c.start + i - 1], sha: c.sha, first: i === 0 })
  }
  return rows
}
