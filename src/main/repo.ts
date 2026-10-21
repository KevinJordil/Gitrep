import { existsSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { isActive } from '../shared/branches'
import { GRAPH_LIMIT, type Branch, type Commit, type SyncState, type DiffSide, type FileChange, type FileDiff, type GraphScope, type LineAction, type OpOutcome, type RepoStatus, type RepoSummary } from '../shared/types'
import { buildPatch, parseDiff } from './diff'
import { currentOperation, git, serialized } from './git'
import { clear, record, tracked } from './journal'
import { mayConflict } from './ops'
import { BRANCH_FORMAT, LOG_FORMAT, parseBranches, parseLog, parseNumstat, parseStatus } from './parse'

// Background reads must not take index.lock (would collide with the user's own git commands).
export const RO = ['--no-optional-locks']


async function hasHead(repo: string): Promise<boolean> {
  return (await git(repo, ['rev-parse', '--verify', '-q', 'HEAD'], { okCodes: [1] })).trim() !== ''
}

export async function getStatus(repo: string): Promise<RepoStatus> {
  const [out, worktree, index, op] = await Promise.all([
    git(repo, [...RO, 'status', '--porcelain=v2', '--branch', '-z']),
    git(repo, [...RO, 'diff', '--numstat', '-z', '--no-renames']),
    git(repo, [...RO, 'diff', '--cached', '--numstat', '-z', '--no-renames']),
    currentOperation(repo)
  ])
  const s = parseStatus(out)
  const w = parseNumstat(worktree)
  const c = parseNumstat(index)
  for (const f of s.unstaged) Object.assign(f, w[f.path])
  for (const f of s.staged) Object.assign(f, c[f.path])
  return { ...s, operation: op }
}

export const ALL_REFS: GraphScope = { only: null, hidden: [] }

// days: only the active branches (see isActive), 0 = every branch and tag.
// --date-order: newest first across branches, still never a parent before its children (layoutGraph relies on it).
export async function getLog(repo: string, scope: GraphScope = ALL_REFS, days = 0, limit = GRAPH_LIMIT): Promise<Commit[]> {
  if (!(await hasHead(repo))) return []
  const refs = await graphRefs(repo, scope, days)
  return parseLog(await git(repo, [...RO, 'log', '--date-order', `-n${limit}`, `--format=${LOG_FORMAT}`, ...refs, '--']))
}

// Commits no remote has (any local branch) and commits of the upstream the current branch lacks. Neither is an error when absent.
export async function getSync(repo: string, limit = GRAPH_LIMIT): Promise<SyncState> {
  const list = async (args: string[]) => (await git(repo, [...RO, 'rev-list', `-n${limit}`, ...args, '--'], { okCodes: [128] })).split('\n').filter(Boolean)
  const upstream = (await git(repo, [...RO, 'rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'], { okCodes: [128] })).trim() || null
  // Without any remote-tracking ref every commit would count as not pushed: there is nothing to push to.
  const hasRemotes = (await git(repo, [...RO, 'for-each-ref', '--count=1', '--format=%(refname)', 'refs/remotes'])).trim() !== ''
  const [outgoing, incoming] = await Promise.all([hasRemotes ? list(['--branches', '--not', '--remotes']) : [], upstream ? list(['HEAD..@{upstream}']) : []])
  return { outgoing, incoming, upstream }
}

const refName = (b: Branch) => (b.remote ? 'refs/remotes/' : 'refs/heads/') + b.name

// Stashes are not drawn (they have their own sidebar list). Unknown branch names (deleted since) are ignored.
// Isolating a branch shows it whatever its age. Active branches only: tags are not walked (their pills still show on drawn commits).
async function graphRefs(repo: string, scope: GraphScope, days: number): Promise<string[]> {
  const all = ['--branches', '--remotes', '--tags', 'HEAD']
  if (!scope.only && !scope.hidden.length && !days) return all
  const branches = await getBranches(repo)
  const only = branches.find((b) => b.name === scope.only)
  if (only) return [refName(only)]
  if (days) return [...branches.filter(isActive(branches, days)).filter((b) => !scope.hidden.includes(b.name)).map(refName), 'HEAD']
  const hidden = branches.filter((b) => scope.hidden.includes(b.name))
  // --exclude applies to the next --branches/--remotes only, with names relative to refs/heads/ or refs/remotes/.
  const exclude = (remote: boolean) => hidden.filter((b) => b.remote === remote).map((b) => `--exclude=${b.name}`)
  return [...exclude(false), '--branches', ...exclude(true), '--remotes', '--tags', 'HEAD']
}

export async function getBranches(repo: string): Promise<Branch[]> {
  return parseBranches(await git(repo, [...RO, 'for-each-ref', `--format=${BRANCH_FORMAT}`, 'refs/heads', 'refs/remotes']))
}

// The changes of a working file against HEAD, whatever is staged (an untracked file is all added).
export async function getHeadDiff(repo: string, path: string): Promise<FileDiff | null> {
  if (path.endsWith('/')) return null
  insideRepo(repo, path)
  const tracked = (await git(repo, [...RO, 'ls-files', '--', path])).trim() !== '' // literal pathspecs: GIT_LITERAL_PATHSPECS is set by git()
  if (!tracked) return getDiff(repo, path, 'untracked')
  const head = await hasHead(repo)
  if (!head) return getDiff(repo, path, 'staged')
  return parseDiff(await git(repo, [...RO, 'diff', '--no-color', '--no-ext-diff', '--no-renames', 'HEAD', '--', path]))[0] ?? null
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

export function insideRepo(repo: string, path: string): string {
  const root = resolve(repo)
  const full = resolve(root, path)
  if (!full.startsWith(root + sep) || relative(root, full).split(sep)[0] === '.git') throw new Error(`Path outside the repository: ${path}`)
  return full
}

const PATCH = ['diff', '--binary', '--no-color', '--no-ext-diff', '--no-textconv', '--no-renames']
const MAX_UNDO_PATCH = 20 * 1024 * 1024 // Limit: bigger discards cannot be undone

// A tracked file deleted in the work tree weighs what HEAD holds.
const size = (repo: string, f: string) =>
  stat(join(repo, f)).then(
    (s) => s.size,
    () => git(repo, ['cat-file', '-s', `HEAD:${f}`], { okCodes: [128] }).then((o) => Number(o.trim()) || 0, () => 0)
  )

// The changes a discard is about to drop, as a binary patch undo can re-apply (untracked files included).
// Bytes, not text: files that are not UTF-8 must come back identical. Null when too big to keep, checked before capturing.
async function discardPatch(repo: string, known: string[], untracked: string[]): Promise<Buffer | null> {
  const extra: string[] = []
  for (const path of untracked) extra.push(...(await git(repo, ['ls-files', '-z', '--others', '--exclude-standard', '--', path])).split('\0').filter(Boolean))
  let bytes = 0
  for (const f of [...known, ...extra]) bytes += await size(repo, f)
  if (bytes > MAX_UNDO_PATCH) return null
  const parts = known.length ? [await git(repo, [...PATCH, '--', ...known], { raw: true })] : []
  for (const f of extra) parts.push(await git(repo, [...PATCH, '--no-index', '--', '/dev/null', f], { raw: true, okCodes: [1] }))
  return Buffer.concat(parts)
}

// Resolves to false when the discard could not be journaled: the history is cleared so that Undo never reverses something older.
export async function discard(repo: string, files: FileChange[]): Promise<boolean> {
  for (const f of files) insideRepo(repo, f.path)
  return serialized(repo, async () => {
    // Never trust the renderer's status: use the real one, skip paths that are not unstaged.
    const real = new Map((await getStatus(repo)).unstaged.map((f) => [f.path, f.status]))
    const targets = files.filter((f) => real.has(f.path)).map((f) => ({ path: f.path, status: real.get(f.path), full: insideRepo(repo, f.path) }))
    const known = targets.filter((t) => t.status !== '?').map((t) => t.path)
    const untracked = targets.filter((t) => t.status === '?').map((t) => t.path)
    const patch = await discardPatch(repo, known, untracked)
    if (known.length) await git(repo, ['restore', '--worktree', '--', ...known])
    // git clean keeps ignored files inside untracked folders.
    for (const path of untracked) await git(repo, ['clean', '-f', '-d', '--', path])
    if (!targets.length) return true
    if (!patch?.length) {
      clear(repo)
      return false
    }
    record(repo, `Discard changes to ${targets.length === 1 ? targets[0].path : `${targets.length} files`}`, { kind: 'patch', patch })
    return true
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
    if (action === 'discard') record(repo, `Discard lines in ${fresh.newPath}`, { kind: 'patch', patch: Buffer.from(patch) })
  })
}

export async function commit(repo: string, message: string, amend: boolean): Promise<void> {
  if (!message.trim()) throw new Error('Empty commit message')
  const label = `${amend ? 'Amend' : 'Commit'} "${message.trim().split('\n')[0].slice(0, 60)}"`
  // --cleanup=whitespace keeps lines starting with "#" (issue numbers). Undo is a soft reset: the changes come back staged.
  await serialized(repo, () => tracked(repo, label, 'soft', () => git(repo, ['commit', '-F', '-', '--cleanup=whitespace', ...(amend ? ['--amend'] : [])], { input: message })))
}

export async function lastMessage(repo: string): Promise<string> {
  return (await git(repo, ['log', '-1', '--format=%B'])).trim()
}

export async function fetchRepo(repo: string): Promise<void> {
  await serialized(`net:${repo}`, () => git(repo, ['fetch', '--all', '--prune']))
}

export async function pull(repo: string): Promise<OpOutcome> {
  return serialized(repo, () => tracked(repo, 'Pull', 'keep', () => mayConflict(repo, ['pull', '--autostash'])))
}

// force: after a rewrite (amend, rebase). --force-with-lease and --force-if-includes refuse when the remote got
// commits this repository has not seen, even after a background fetch.
export async function push(repo: string, force = false): Promise<void> {
  const s = await getStatus(repo)
  if (!s.branch) throw new Error('Detached HEAD: nothing to push')
  const lease = force ? ['--force-with-lease', '--force-if-includes'] : []
  await serialized(repo, () => git(repo, s.upstream ? ['push', ...lease] : ['push', ...lease, '-u', 'origin', s.branch!]))
}

export async function switchBranch(repo: string, name: string, remote: boolean): Promise<void> {
  if (name.startsWith('-')) throw new Error(`Invalid branch name: ${name}`)
  const label = `Switch to ${remote ? name.replace(/^[^/]+\//, '') : name}`
  await serialized(repo, () => tracked(repo, label, 'keep', () => git(repo, remote ? ['switch', '--track', name] : ['switch', name])))
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
