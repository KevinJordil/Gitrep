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
  date: number // unix seconds
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
}

// Most commits the graph loads (`git log -n`).
export const GRAPH_LIMIT = 2000

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
}

export interface Config {
  repos: RepoEntry[]
  openTabs: string[]
  settings: Settings
}

export interface GeneratedMessage {
  message: string
  excluded: string[]
  files: number
}
