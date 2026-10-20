import type { DiffLine, RepoSummary } from '../../shared/types'

export const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e))

const rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto' })
const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ['year', 31_536_000_000],
  ['month', 2_592_000_000],
  ['week', 604_800_000],
  ['day', 86_400_000],
  ['hour', 3_600_000],
  ['minute', 60_000]
]

export function relativeDate(unixSeconds: number, now = Date.now()): string {
  const diff = unixSeconds * 1000 - now
  for (const [unit, ms] of UNITS) if (Math.abs(diff) >= ms) return rtf.format(Math.round(diff / ms), unit)
  return 'just now'
}

// The lane colors of the theme (styles.css :root --l0 … --l4).
const PALETTE = ['var(--l0)', 'var(--l1)', 'var(--l2)', 'var(--l3)', 'var(--l4)']

// Graph lanes cycle through the same colors as the avatars (amber, blue, pink, green, violet).
export const laneColor = (index: number): string => PALETTE[index % PALETTE.length]

export function colorFor(name: string): string {
  let h = 0
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0
  return PALETTE[h % PALETTE.length]
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  if (!parts.length) return '?'
  return (parts[0][0] + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase()
}

export function splitPath(path: string): [dir: string, file: string] {
  const trimmed = path.endsWith('/') ? path.slice(0, -1) : path
  const i = trimmed.lastIndexOf('/')
  return i < 0 ? ['', path] : [path.slice(0, i + 1), path.slice(i + 1)]
}

// Runs of consecutive changed lines inside a hunk: each run gets its own "+" button.
export function changeGroups(lines: DiffLine[]): number[][] {
  const groups: number[][] = []
  let current: number[] | null = null
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].kind === 'context') {
      current = null
      continue
    }
    if (!current) {
      current = []
      groups.push(current)
    }
    current.push(i)
  }
  return groups
}

export type RefKind = 'head' | 'local' | 'remote' | 'tag'

export function parseRef(ref: string, remoteNames: ReadonlySet<string>): { label: string; kind: RefKind } {
  if (ref.startsWith('HEAD -> ')) return { label: ref.slice(8), kind: 'head' }
  if (ref === 'HEAD') return { label: 'HEAD', kind: 'head' }
  if (ref.startsWith('tag: ')) return { label: ref.slice(5), kind: 'tag' }
  return { label: ref, kind: remoteNames.has(ref) ? 'remote' : 'local' }
}

export type DashFilter = 'all' | 'dirty' | 'push' | 'behind' | 'attention'

export function changeCount(s: RepoSummary): number {
  const st = s.status
  return st ? st.staged.length + st.unstaged.length + st.conflicted.length : 0
}

export function matchesFilter(s: RepoSummary, f: DashFilter): boolean {
  const st = s.status
  switch (f) {
    case 'all':
      return true
    case 'dirty':
      return changeCount(s) > 0
    case 'push':
      return !!st && st.ahead > 0
    case 'behind':
      return !!st && st.behind > 0
    case 'attention':
      return !!s.error || !!s.fetchError || !st || !!st.operation || st.conflicted.length > 0 || st.branch === null
  }
}

export function groupByFolder<T extends { folder: string }>(items: T[]): { folder: string; items: T[] }[] {
  const map = new Map<string, T[]>()
  for (const item of items) map.set(item.folder, [...(map.get(item.folder) ?? []), item])
  return [...map].map(([folder, list]) => ({ folder, items: list }))
}
