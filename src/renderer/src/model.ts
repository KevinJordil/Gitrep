import type { DiffSide, OpOutcome } from '../../shared/types'

// What the right panel shows: the working tree changes, one commit, or one stash.
// explain: set (to a new value each time) to ask Claude for an explanation as soon as the panel opens.
export type Focus = { kind: 'wip' } | { kind: 'commit'; sha: string; explain?: number } | { kind: 'stash'; sha: string }

// The file whose diff the center shows: a working-tree side, or a file of a commit (read-only).
export type Selection = { path: string; side: DiffSide; commit?: undefined } | { path: string; commit: string; side?: undefined }

// Runs a repo operation: shows a toast on error (and `done` on success), then refreshes the repo. Resolves to success.
export type RunOp = (label: string, fn: () => Promise<unknown>, done?: string) => Promise<boolean>

// Runs a merge-like operation: on 'conflicts' says so instead of `done` (the operation banner takes over).
export type RunOutcome = (label: string, fn: () => Promise<OpOutcome>, done: string) => Promise<boolean>
