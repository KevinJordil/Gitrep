export type FileStatus = 'M' | 'A' | 'D' | 'R' | 'C' | 'T' | 'U' | '?'

export interface FileChange {
  path: string
  origPath?: string
  status: FileStatus
  add?: number
  del?: number
}

export type RepoOperation = 'merge' | 'rebase' | 'cherry-pick' | 'revert' | null

export interface RepoStatus {
  branch: string | null // null = detached HEAD
  head: string | null // null = no commit yet
  upstream: string | null
  ahead: number
  behind: number
  staged: FileChange[]
  unstaged: FileChange[] // includes untracked files (status '?')
  conflicted: FileChange[]
  operation: RepoOperation
}

export interface Commit {
  sha: string
  parents: string[]
  author: string
  email: string
  date: number // author date, unix seconds
  committed: number // committer date, unix seconds (rebases and cherry-picks move it, not the author date)
  subject: string
  refs: string[] // git %D decorations: "HEAD -> main", "origin/main", "tag: v1.0"
}

export interface Branch {
  name: string
  remote: boolean
  current: boolean
  upstream: string | null
  ahead: number
  behind: number
  sha: string // tip commit
  date: number // committer date of the tip, unix seconds
}

// Most commits the graph loads (`git log -n`).
export const GRAPH_LIMIT = 2000
export const GRAPH_COLUMN_MIN = 48 // px, the Author, Date and SHA columns of the history
export const GRAPH_COLUMN_MAX = 480
export const MAX_INSTRUCTIONS = 4000 // characters of a commit message instructions text
export const GRAPH_LANES_MIN = 40 // px, the graph (lanes) column when set by hand; 0 = automatic
export const DEFAULT_GRAPH_COLUMNS = { graph: 0, author: 150, date: 110, sha: 70 }

export interface Tag {
  name: string
  sha: string // the tagged commit (annotated tags are peeled)
}

export interface CommitDetails extends Commit {
  body: string // message without the subject line
  files: FileChange[] // against the first parent
}

// Which refs the graph draws: one branch only, or every branch, remote and tag except the hidden branches.
export interface GraphScope {
  only: string | null
  hidden: string[]
}

export interface DiffLine {
  kind: 'context' | 'add' | 'del'
  text: string
  oldNo: number | null
  newNo: number | null
  noNewline?: boolean
}

export interface Hunk {
  header: string
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
  lines: DiffLine[]
}

export interface FileDiff {
  oldPath: string
  newPath: string
  headerLines: string[] // raw lines before the first hunk, starting with "diff --git"
  hunks: Hunk[]
  binary: boolean
  isNew: boolean
  isDeleted: boolean
}

export type DiffSide = 'staged' | 'unstaged' | 'untracked'
export type LineAction = 'stage' | 'unstage' | 'discard'

export interface RepoEntry {
  path: string
  name: string
  commitInstructions?: string // free text added to the commit message prompt for this repository
}

export interface RepoSummary {
  path: string
  name: string
  folder: string // parent folder for display, home shortened to "~"
  status: RepoStatus | null
  lastCommit: { subject: string; author: string; date: number } | null
  stashCount: number
  error: string | null
  fetchError: string | null
}

export interface Settings {
  claudeModel: string
  claudePath: string // empty = resolve from the login shell
  activeDays: number // the graph draws the branches committed to in the last N days; 0 = every branch
  sidebarWidth: number // px, resizable
  rightWidth: number // px, resizable
  commitInstructions: string // free text added to the commit message prompt, all repositories
  graphColumns: { graph: number; author: number; date: number; sha: number } // px, resizable in the history header
}

export interface Config {
  repos: RepoEntry[]
  openTabs: string[]
  settings: Settings
}

export interface Stash {
  index: number // n in stash@{n}: changes when stashes are added or dropped, use `sha` to refer to one
  sha: string
  base: string // the commit it was made on
  untracked: string | null // commit holding the untracked files, if they were included
  date: number // unix seconds
  branch: string | null
  message: string
}

export type ResetMode = 'soft' | 'mixed' | 'hard'

// 'conflicts': git stopped with conflicted files; the operation banner takes over.
export type OpOutcome = 'done' | 'conflicts'

export type MergeMode = 'merge' | 'rebase' | 'ff'

// Drag `source` onto `target`: merge source into target, rebase target onto source, or fast-forward target to source.
export interface MergeRequest {
  source: string
  target: string // a local branch
  mode: MergeMode
  message: string // merge commit message ('' = git's default)
  autostash: boolean
}

export interface MergePreview {
  incoming: number // commits of source missing from target
  local: number // commits of target missing from source
  conflicts: string[] // predicted by a dry-run merge
}

export interface MergeAdvice {
  choice: 'merge' | 'rebase' | null
  text: string
}

export interface Explanation {
  text: string
  excluded: string[] // sensitive files left out of what Claude saw
}

export interface GeneratedMessage {
  message: string
  excluded: string[]
  files: number
}

// One conflict block as sent to Claude: the three versions and a few lines around them.
export interface ConflictHunk {
  before: string[]
  ours: string[]
  base: string[] | null
  theirs: string[]
  after: string[]
}

export type Confidence = 'high' | 'medium' | 'low'

export interface ConflictSuggestion {
  lines: string[] // replaces the whole block
  confidence: Confidence
  summary: string
  explanation: string
}

// Labels of the operations Undo and Redo would revert or replay, null when there is none.
export interface UndoState {
  undo: string | null
  redo: string | null
}

// One side of a conflict, by name: a branch, a commit, or the stash. detail: sha and role ("checked out", "being merged"…).
export interface ConflictSide {
  name: string
  detail: string
}

export interface RebaseStep {
  sha: string
  subject: string
  state: 'done' | 'current' | 'todo' // current: the step git stopped on
}

// The operation git stopped in (null: conflicts left by a stash apply), its two sides and, for a rebase, its steps.
export interface OperationInfo {
  operation: RepoOperation
  ours: ConflictSide // upper side: stage 2, HEAD (during a rebase: the branch rebased onto)
  theirs: ConflictSide // lower side: stage 3, what is merged, picked or replayed
  steps: RebaseStep[]
}

// text: the file with its conflict markers; binary or deleted (one side deleted it) files are resolved by taking a side.
export interface ConflictFile {
  path: string
  kind: 'text' | 'binary' | 'deleted'
  text: string
  ours: boolean // the upper side still has the file
  theirs: boolean
}

export interface RebaseCommit {
  sha: string
  subject: string
  body: string
  author: string
  date: number // unix seconds
}

// What an interactive rebase of `branch` onto `onto` replays.
export interface RebasePlan {
  branch: string
  onto: string // sha
  ontoLabel: string // a branch at onto, else its short sha
  commits: RebaseCommit[] // newest first
  pushed: number // how many of them are already on a remote (a force push will be needed)
}

export type RebaseAction = 'pick' | 'reword' | 'squash' | 'fixup' | 'drop'

// squash and fixup meld into the previous kept commit; squash keeps both messages. message: the new one (reword).
export interface RebaseItem {
  sha: string
  action: RebaseAction
  message?: string
}

export interface InteractiveRebaseRequest {
  branch: string
  upstream: string
  items: RebaseItem[] // oldest first, in the new order
  autostash: boolean
}

export interface RebaseProposal {
  items: RebaseItem[] // oldest first
  explanation: string
}
