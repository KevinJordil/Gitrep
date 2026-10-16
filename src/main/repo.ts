import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import type { Branch, Commit, DiffSide, FileChange, FileDiff, LineAction, RepoOperation, RepoStatus, RepoSummary } from '../shared/types'
import { buildPatch, parseDiff } from './diff'
import { git, serialized } from './git'
import { BRANCH_FORMAT, LOG_FORMAT, parseBranches, parseLog, parseNumstat, parseStatus } from './parse'

// Background reads must not take index.lock (would collide with the user's own git commands).
const RO = ['--no-optional-locks']
const gitDirs = new Map<string, string>()

export async function gitDir(repo: string): Promise<string> {
  let dir = gitDirs.get(repo)
  if (!dir) {
    dir = (await git(repo, ['rev-parse', '--absolute-git-dir'])).trim()
    gitDirs.set(repo, dir)
  }
  return dir
}

async function operation(repo: string): Promise<RepoOperation> {
  const d = await gitDir(repo)
  if (existsSync(join(d, 'rebase-merge')) || existsSync(join(d, 'rebase-apply'))) return 'rebase'
  if (existsSync(join(d, 'MERGE_HEAD'))) return 'merge'
  if (existsSync(join(d, 'CHERRY_PICK_HEAD'))) return 'cherry-pick'
  if (existsSync(join(d, 'REVERT_HEAD'))) return 'revert'
  return null
}

async function hasHead(repo: string): Promise<boolean> {
  return (await git(repo, ['rev-parse', '--verify', '-q', 'HEAD'], { okCodes: [1] })).trim() !== ''
}

export async function getStatus(repo: string): Promise<RepoStatus> {
  const [out, worktree, index, op] = await Promise.all([
    git(repo, [...RO, 'status', '--porcelain=v2', '--branch', '-z']),
    git(repo, [...RO, 'diff', '--numstat', '-z', '--no-renames']),
    git(repo, [...RO, 'diff', '--cached', '--numstat', '-z', '--no-renames']),
    operation(repo)
  ])
  const s = parseStatus(out)
  const w = parseNumstat(worktree)
  const c = parseNumstat(index)
  for (const f of s.unstaged) Object.assign(f, w[f.path])
  for (const f of s.staged) Object.assign(f, c[f.path])
  return { ...s, operation: op }
}

export async function getLog(repo: string, limit = 300): Promise<Commit[]> {
  if (!(await hasHead(repo))) return []
  return parseLog(await git(repo, [...RO, 'log', 'HEAD', `-n${limit}`, `--format=${LOG_FORMAT}`]))
}

export async function getBranches(repo: string): Promise<Branch[]> {
  return parseBranches(await git(repo, [...RO, 'for-each-ref', `--format=${BRANCH_FORMAT}`, 'refs/heads', 'refs/remotes']))
}

export async function getDiff(repo: string, path: string, side: DiffSide): Promise<FileDiff | null> {
  if (path.endsWith('/')) return null // untracked folder: no single-file diff
  if (side === 'untracked') insideRepo(repo, path)
  const base = ['diff', '--no-color', '--no-ext-diff', '--no-renames']
  const out =
    side === 'untracked'
      ? await git(repo, [...base, '--no-index', '--', '/dev/null', path], { okCodes: [1] })
      : await git(repo, [...RO, ...base, ...(side === 'staged' ? ['--cached'] : []), '--', path])
  return parseDiff(out)[0] ?? null
}

export async function stage(repo: string, paths: string[]): Promise<void> {
  await serialized(repo, () => git(repo, ['add', '-A', '--', ...paths]))
}

export async function unstage(repo: string, paths: string[]): Promise<void> {
  await serialized(repo, async () => {
    const args = (await hasHead(repo)) ? ['restore', '--staged', '--', ...paths] : ['rm', '--cached', '-r', '-q', '--', ...paths]
    await git(repo, args)
  })
}

function insideRepo(repo: string, path: string): string {
  const root = resolve(repo)
  const full = resolve(root, path)
  if (!full.startsWith(root + sep) || relative(root, full).split(sep)[0] === '.git') throw new Error(`Path outside the repository: ${path}`)
  return full
}

export async function discard(repo: string, files: FileChange[]): Promise<void> {
  for (const f of files) insideRepo(repo, f.path)
  await serialized(repo, async () => {
    // Never trust the renderer's status: use the real one, skip paths that are not unstaged.
    const real = new Map((await getStatus(repo)).unstaged.map((f) => [f.path, f.status]))
    const targets = files.filter((f) => real.has(f.path)).map((f) => ({ path: f.path, status: real.get(f.path), full: insideRepo(repo, f.path) }))
    const tracked = targets.filter((t) => t.status !== '?').map((t) => t.path)
    if (tracked.length) await git(repo, ['restore', '--worktree', '--', ...tracked])
    // git clean keeps ignored files inside untracked folders.
    for (const t of targets) if (t.status === '?') await git(repo, ['clean', '-f', '-d', '--', t.path])
  })
}

export async function applyLines(repo: string, file: FileDiff, hunk: number, lines: number[] | null, action: LineAction): Promise<void> {
  // Rebuild from a fresh diff: the renderer's object is only used to detect staleness.
  await serialized(repo, async () => {
    const fresh = await getDiff(repo, file.newPath, action === 'unstage' ? 'staged' : 'unstaged')
    if (!fresh || JSON.stringify(fresh.hunks[hunk]) !== JSON.stringify(file.hunks[hunk])) throw new Error('The file has changed: refresh the diff')
    const patch = buildPatch(fresh, hunk, lines, action !== 'stage')
    const args =
      action === 'discard'
        ? ['apply', '--recount', '--whitespace=nowarn', '-R', '-']
        : ['apply', '--cached', '--recount', '--whitespace=nowarn', ...(action === 'unstage' ? ['-R'] : []), '-']
    await git(repo, args, { input: patch })
  })
}

export async function commit(repo: string, message: string, amend: boolean): Promise<void> {
  if (!message.trim()) throw new Error('Empty commit message')
  // --cleanup=whitespace keeps lines starting with "#" (issue numbers).
  await serialized(repo, () => git(repo, ['commit', '-F', '-', '--cleanup=whitespace', ...(amend ? ['--amend'] : [])], { input: message }))
}

export async function lastMessage(repo: string): Promise<string> {
  return (await git(repo, ['log', '-1', '--format=%B'])).trim()
}

export async function fetchRepo(repo: string): Promise<void> {
  await serialized(`net:${repo}`, () => git(repo, ['fetch', '--all', '--prune']))
}

export async function pull(repo: string): Promise<void> {
  await serialized(repo, () => git(repo, ['pull', '--autostash']))
}

export async function push(repo: string): Promise<void> {
  const s = await getStatus(repo)
  if (!s.branch) throw new Error('Detached HEAD: nothing to push')
  await serialized(repo, () => git(repo, s.upstream ? ['push'] : ['push', '-u', 'origin', s.branch!]))
}

export async function switchBranch(repo: string, name: string, remote: boolean): Promise<void> {
  if (name.startsWith('-')) throw new Error(`Invalid branch name: ${name}`)
  await serialized(repo, () => git(repo, remote ? ['switch', '--track', name] : ['switch', name]))
}

export function displayFolder(path: string, home = homedir()): string {
  const dir = dirname(path)
  if (dir === home) return '~'
  return dir.startsWith(home + sep) ? '~' + dir.slice(home.length) : dir
}

export async function summary(repo: string): Promise<RepoSummary> {
  const base = { path: repo, name: basename(repo), folder: displayFolder(repo), fetchError: null }
  if (!existsSync(repo)) return { ...base, status: null, lastCommit: null, stashCount: 0, error: `Folder not found: ${repo}` }
  try {
    const [status, last, stashes] = await Promise.all([
      getStatus(repo),
      git(repo, [...RO, 'log', '-1', '--format=%s%x1f%an%x1f%at']).catch(() => ''),
      git(repo, [...RO, 'stash', 'list', '--format=%gd']).catch(() => '')
    ])
    const [subject, author, at] = last.trim().split('\x1f')
    return {
      ...base,
      status,
      lastCommit: last.trim() ? { subject, author, date: Number(at) } : null,
      stashCount: stashes.split('\n').filter(Boolean).length,
      error: null
    }
  } catch (e) {
    return { ...base, status: null, lastCommit: null, stashCount: 0, error: e instanceof Error ? e.message : String(e) }
  }
}

export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length)
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const i = next++
      out[i] = await fn(items[i])
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return out
}
