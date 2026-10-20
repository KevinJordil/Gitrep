import type { Branch } from './types'

// Active: the tip was committed in the last `days` days, or it is the checked-out branch or its upstream. days 0: every branch.
export function isActive(branches: Branch[], days: number, now = Date.now() / 1000): (b: Branch) => boolean {
  const upstream = branches.find((b) => b.current)?.upstream
  const since = now - days * 86400
  return (b) => !days || b.date >= since || b.current || (b.remote && b.name === upstream)
}
