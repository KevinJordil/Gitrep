import type { DiffSide, OpOutcome } from '../../shared/types'

// What the right panel shows: the working tree changes, one commit, one stash, or the conflicts of an operation.
// explain: set (to a new value each time) to ask Claude for an explanation as soon as the panel opens.
// conflicts: path is the file shown (default: the first conflicted one). rebase: the interactive rebase editor of a local branch.
// review: the review screen of the current review session (it takes the three panes).
// file: the history or the blame of one file, from the commit `rev` (null: HEAD).
export type Focus =
  | { kind: 'wip' }
  | { kind: 'commit'; sha: string; explain?: number }
  | { kind: 'stash'; sha: string }
  | { kind: 'conflicts'; path?: string }
  | { kind: 'rebase'; branch: string; upstream: string }
  | { kind: 'file'; path: string; rev: string | null; view: FileView }
  | { kind: 'review' }

// What the file view's center shows: the selected commit's diff of the file, or the file's blame.
export type FileView = 'diff' | 'blame'

// The file whose diff the center shows: a working-tree side, or a file of a commit (read-only; oldPath: the commit renamed it).
export type Selection = { path: string; side: DiffSide; commit?: undefined } | { path: string; commit: string; oldPath?: string | null; side?: undefined }

// Runs a repo operation: shows a toast on error (and `done` on success), then refreshes the repo. Resolves to success.
export type RunOp = (label: string, fn: () => Promise<unknown>, done?: string) => Promise<boolean>

// Runs a merge-like operation: on 'conflicts' says so instead of `done` and opens the conflict view;
// prepare: then asks Claude to propose a resolution of every conflicted file (shown for review, nothing is written).
export type RunOutcome = (label: string, fn: () => Promise<OpOutcome>, done: string, prepare?: boolean) => Promise<boolean>
