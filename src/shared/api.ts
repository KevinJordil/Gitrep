import type {
  Branch,
  Commit,
  CommitDetails,
  ConflictFile,
  ConflictHunk,
  ConflictSuggestion,
  Config,
  DiffSide,
  Explanation,
  FileChange,
  FileDiff,
  GeneratedMessage,
  GraphScope,
  InteractiveRebaseRequest,
  LineAction,
  MergeAdvice,
  MergePreview,
  MergeRequest,
  OperationInfo,
  OpOutcome,
  RebasePlan,
  RebaseProposal,
  RepoEntry,
  RepoStatus,
  RepoSummary,
  ResetMode,
  Settings,
  Stash,
  Tag,
  UndoState
} from './types'

export interface Api {
  getConfig(): Promise<Config>
  addRepos(): Promise<RepoEntry[]>
  removeRepo(path: string): Promise<void>
  setOpenTabs(paths: string[]): Promise<void>
  updateSettings(patch: Partial<Settings>): Promise<void> // only the settings the app edits (see applySettings)
  summaries(): Promise<RepoSummary[]>
  status(repo: string): Promise<RepoStatus>
  log(repo: string, scope: GraphScope, days?: number): Promise<Commit[]> // days: active branches only; 0 or omitted = every branch
  branches(repo: string): Promise<Branch[]>
  tags(repo: string): Promise<Tag[]>
  commitDetails(repo: string, sha: string): Promise<CommitDetails>
  commitDiff(repo: string, sha: string, path: string): Promise<FileDiff | null>
  copyText(text: string): Promise<void>
  diff(repo: string, path: string, side: DiffSide): Promise<FileDiff | null>
  stage(repo: string, paths: string[]): Promise<void>
  unstage(repo: string, paths: string[]): Promise<void>
  discard(repo: string, files: FileChange[]): Promise<boolean> // false: could not be journaled, history cleared
  applyLines(repo: string, file: FileDiff, hunk: number, lines: number[] | null, action: LineAction): Promise<void>
  commit(repo: string, message: string, amend: boolean): Promise<void>
  lastMessage(repo: string): Promise<string>
  generateMessage(repo: string): Promise<GeneratedMessage>
  explainCommit(repo: string, sha: string): Promise<Explanation>
  stashMessage(repo: string): Promise<string>
  adviseMerge(repo: string, source: string, target: string): Promise<MergeAdvice>
  mergeMessage(repo: string, source: string, target: string): Promise<string>
  fetch(repo: string): Promise<void>
  fetchAll(): Promise<void>
  pull(repo: string): Promise<OpOutcome>
  push(repo: string, force?: boolean): Promise<void> // force: --force-with-lease --force-if-includes
  switchBranch(repo: string, name: string, remote: boolean): Promise<void>
  checkoutCommit(repo: string, sha: string): Promise<void>
  createBranch(repo: string, name: string, at: string, checkout: boolean): Promise<void>
  deleteBranch(repo: string, name: string, force: boolean): Promise<void>
  createTag(repo: string, name: string, at: string, message: string): Promise<void>
  cherryPick(repo: string, sha: string): Promise<OpOutcome>
  revert(repo: string, sha: string): Promise<OpOutcome>
  reset(repo: string, sha: string, mode: ResetMode): Promise<void>
  continueOperation(repo: string): Promise<OpOutcome>
  abortOperation(repo: string): Promise<void>
  skipOperation(repo: string): Promise<OpOutcome>
  operationInfo(repo: string): Promise<OperationInfo>
  conflictFile(repo: string, path: string): Promise<ConflictFile>
  resolveFile(repo: string, path: string, content: string, source: string): Promise<void>
  resolveSide(repo: string, path: string, side: 'ours' | 'theirs'): Promise<void>
  handOver(repo: string): Promise<void> // opens Claude Code in a terminal with the conflict's context
  suggestConflict(repo: string, path: string, hunks: ConflictHunk[]): Promise<(ConflictSuggestion | null)[]>
  rebaseCommits(repo: string, branch: string, upstream: string): Promise<RebasePlan>
  interactiveRebase(repo: string, req: InteractiveRebaseRequest): Promise<OpOutcome>
  proposeRebase(repo: string, branch: string, upstream: string): Promise<RebaseProposal>
  mergePreview(repo: string, source: string, target: string): Promise<MergePreview>
  integrate(repo: string, req: MergeRequest): Promise<OpOutcome>
  stashes(repo: string): Promise<Stash[]>
  stashPush(repo: string, message: string, includeUntracked: boolean): Promise<void>
  stashApply(repo: string, sha: string, pop: boolean): Promise<OpOutcome>
  stashDrop(repo: string, sha: string): Promise<void>
  stashBranch(repo: string, sha: string, name: string): Promise<OpOutcome>
  stashConflicts(repo: string, sha: string): Promise<string[]>
  openInCode(repo: string): Promise<void>
  openTerminal(repo: string): Promise<void>
  undoState(repo: string): Promise<UndoState>
  undo(repo: string): Promise<string> // resolves to the message to show
  redo(repo: string): Promise<string>
  setWatched(repos: string[]): Promise<void>
  onRepoChanged(cb: (repo: string) => void): () => void
}

export type InvokeMethod = Exclude<keyof Api, 'onRepoChanged'>

export const API_METHODS = [
  'getConfig',
  'addRepos',
  'removeRepo',
  'setOpenTabs',
  'summaries',
  'status',
  'log',
  'branches',
  'tags',
  'commitDetails',
  'commitDiff',
  'copyText',
  'diff',
  'stage',
  'unstage',
  'discard',
  'applyLines',
  'commit',
  'lastMessage',
  'generateMessage',
  'explainCommit',
  'stashMessage',
  'adviseMerge',
  'mergeMessage',
  'fetch',
  'fetchAll',
  'pull',
  'push',
  'switchBranch',
  'checkoutCommit',
  'createBranch',
  'deleteBranch',
  'createTag',
  'cherryPick',
  'revert',
  'reset',
  'continueOperation',
  'abortOperation',
  'skipOperation',
  'operationInfo',
  'conflictFile',
  'resolveFile',
  'resolveSide',
  'handOver',
  'suggestConflict',
  'rebaseCommits',
  'interactiveRebase',
  'proposeRebase',
  'mergePreview',
  'integrate',
  'stashes',
  'stashPush',
  'stashApply',
  'stashDrop',
  'stashBranch',
  'stashConflicts',
  'openInCode',
  'openTerminal',
  'undoState',
  'undo',
  'redo',
  'setWatched',
  'updateSettings'
] as const satisfies readonly InvokeMethod[]

// Compile-time guard: every invoke method must be listed above.
export const API_COMPLETE: [Exclude<InvokeMethod, (typeof API_METHODS)[number]>] extends [never] ? true : false = true

export type IpcResult = { ok: true; value: unknown } | { ok: false; error: string }
