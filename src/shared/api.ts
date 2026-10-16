import type {
  Branch,
  Commit,
  CommitDetails,
  Config,
  DiffSide,
  FileChange,
  FileDiff,
  GeneratedMessage,
  GraphScope,
  LineAction,
  RepoEntry,
  RepoStatus,
  RepoSummary,
  Tag
} from './types'

export interface Api {
  getConfig(): Promise<Config>
  addRepos(): Promise<RepoEntry[]>
  removeRepo(path: string): Promise<void>
  setOpenTabs(paths: string[]): Promise<void>
  summaries(): Promise<RepoSummary[]>
  status(repo: string): Promise<RepoStatus>
  log(repo: string, scope: GraphScope): Promise<Commit[]>
  branches(repo: string): Promise<Branch[]>
  tags(repo: string): Promise<Tag[]>
  commitDetails(repo: string, sha: string): Promise<CommitDetails>
  commitDiff(repo: string, sha: string, path: string): Promise<FileDiff | null>
  copyText(text: string): Promise<void>
  diff(repo: string, path: string, side: DiffSide): Promise<FileDiff | null>
  stage(repo: string, paths: string[]): Promise<void>
  unstage(repo: string, paths: string[]): Promise<void>
  discard(repo: string, files: FileChange[]): Promise<void>
  applyLines(repo: string, file: FileDiff, hunk: number, lines: number[] | null, action: LineAction): Promise<void>
  commit(repo: string, message: string, amend: boolean): Promise<void>
  lastMessage(repo: string): Promise<string>
  generateMessage(repo: string): Promise<GeneratedMessage>
  fetch(repo: string): Promise<void>
  fetchAll(): Promise<void>
  pull(repo: string): Promise<void>
  push(repo: string): Promise<void>
  switchBranch(repo: string, name: string, remote: boolean): Promise<void>
  openInCode(repo: string): Promise<void>
  openTerminal(repo: string): Promise<void>
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
  'fetch',
  'fetchAll',
  'pull',
  'push',
  'switchBranch',
  'openInCode',
  'openTerminal',
  'setWatched'
] as const satisfies readonly InvokeMethod[]

// Compile-time guard: every invoke method must be listed above.
export const API_COMPLETE: [Exclude<InvokeMethod, (typeof API_METHODS)[number]>] extends [never] ? true : false = true

export type IpcResult = { ok: true; value: unknown } | { ok: false; error: string }
