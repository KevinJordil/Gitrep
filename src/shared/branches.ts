import type { Branch, GraphScope } from './types'

// Active: the tip was committed in the last `days` days, or it is the checked-out branch or its upstream. days 0: every branch.
export function isActive(branches: Branch[], days: number, now = Date.now() / 1000): (b: Branch) => boolean {
  const upstream = branches.find((b) => b.current)?.upstream
  const since = now - days * 86400
  return (b) => !days || b.date >= since || b.current || (b.remote && b.name === upstream)
}

// The scope after the Hide / Show toggle of a branch (clears an isolation).
export const toggleHide = (scope: GraphScope, name: string): GraphScope => ({ only: null, hidden: scope.hidden.includes(name) ? scope.hidden.filter((h) => h !== name) : [...scope.hidden, name] })

// The scope after the Isolate / Stop isolating toggle of a branch.
export const toggleOnly = (scope: GraphScope, name: string): GraphScope => ({ only: scope.only === name ? null : name, hidden: [] })
