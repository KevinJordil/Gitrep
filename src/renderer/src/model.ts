import type { DiffSide } from '../../shared/types'

export interface Selection {
  path: string
  side: DiffSide
}

// Runs a repo operation: shows a toast on error (and `done` on success), then refreshes the repo. Resolves to success.
export type RunOp = (label: string, fn: () => Promise<unknown>, done?: string) => Promise<boolean>
