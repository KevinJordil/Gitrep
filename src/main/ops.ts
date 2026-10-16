import type { Branch, MergePreview, MergeRequest, OpOutcome, ResetMode } from '../shared/types'
import { git, serialized } from './git'
import { resolveCommit } from './history'
import { getBranches, getStatus, RO } from './repo'

// Conflict hunks keep the common ancestor: easier to resolve by hand.
const DIFF3 = ['-c', 'merge.conflictStyle=diff3']
// --continue and friends must never wait for an editor nobody can see.
const NO_EDITOR = { GIT_EDITOR: 'true' }
const RESET_MODES: readonly ResetMode[] = ['soft', 'mixed', 'hard']

export async function ensureIdle(repo: string): Promise<void> {
  const s = await getStatus(repo)
  if (s.operation) throw new Error(`A ${s.operation} is in progress: continue or abort it first`)
  if (s.conflicted.length) throw new Error('Resolve the conflicted files first')
}

// Stopping on conflicts is not a failure: git left conflicted files and the banner offers continue/abort.
export async function mayConflict(repo: string, args: string[]): Promise<OpOutcome> {
  try {
    await git(repo, [...DIFF3, ...args], { env: NO_EDITOR })
    // --autostash re-applying onto the result can conflict while git still exits 0.
    return (await getStatus(repo)).conflicted.length ? 'conflicts' : 'done'
  } catch (e) {
    if ((await getStatus(repo)).conflicted.length) return 'conflicts'
    throw e
  }
}

// Returns git's normalized name; rejects names git would refuse or read as an option.
export async function validBranchName(repo: string, name: string): Promise<string> {
  const invalid = new Error(`Invalid branch name: ${name}`)
  if (typeof name !== 'string' || !name.trim() || name.startsWith('-') || name.includes('@{')) throw invalid
  try {
    return (await git(repo, ['check-ref-format', '--branch', name])).trim()
  } catch {
    throw invalid
  }
}

async function isMerge(repo: string, sha: string): Promise<boolean> {
  return (await git(repo, [...RO, 'rev-list', '--parents', '-n1', sha])).trim().split(' ').length > 2
}

export async function checkoutCommit(repo: string, rev: string): Promise<void> {
  const sha = await resolveCommit(repo, rev)
  await serialized(repo, async () => {
    await ensureIdle(repo)
    await git(repo, ['switch', '--detach', sha])
  })
}

export async function createBranch(repo: string, name: string, rev: string, checkout: boolean): Promise<void> {
  const [branch, at] = await Promise.all([validBranchName(repo, name), resolveCommit(repo, rev)])
  await serialized(repo, async () => {
    if (checkout) await ensureIdle(repo)
    await git(repo, checkout ? ['switch', '-c', branch, at] : ['branch', branch, at])
  })
}

// A message makes an annotated tag.
export async function createTag(repo: string, name: string, rev: string, message: string): Promise<void> {
  const invalid = new Error(`Invalid tag name: ${name}`)
  if (typeof name !== 'string' || !name.trim() || name.startsWith('-')) throw invalid
  await git(repo, ['check-ref-format', `refs/tags/${name}`]).catch(() => {
    throw invalid
  })
  const at = await resolveCommit(repo, rev)
  const annotated = String(message ?? '').trim()
  await serialized(repo, () => git(repo, annotated ? ['tag', '-a', '-F', '-', '--cleanup=whitespace', name, at] : ['tag', name, at], { input: annotated }))
}

// Merge commits are picked/reverted against their first parent.
export async function cherryPick(repo: string, rev: string): Promise<OpOutcome> {
  const sha = await resolveCommit(repo, rev)
  return serialized(repo, async () => {
    await ensureIdle(repo)
    return mayConflict(repo, ['cherry-pick', ...((await isMerge(repo, sha)) ? ['-m', '1'] : []), sha])
  })
}

export async function revert(repo: string, rev: string): Promise<OpOutcome> {
  const sha = await resolveCommit(repo, rev)
  return serialized(repo, async () => {
    await ensureIdle(repo)
    return mayConflict(repo, ['revert', '--no-edit', ...((await isMerge(repo, sha)) ? ['-m', '1'] : []), sha])
  })
}

export async function resetTo(repo: string, rev: string, mode: ResetMode): Promise<void> {
  if (!RESET_MODES.includes(mode)) throw new Error(`Invalid reset mode: ${mode}`)
  const sha = await resolveCommit(repo, rev)
  await serialized(repo, () => git(repo, ['reset', `--${mode}`, sha]))
}

export async function continueOperation(repo: string): Promise<OpOutcome> {
  return serialized(repo, async () => {
    const s = await getStatus(repo)
    if (!s.operation) throw new Error('No merge, rebase, cherry-pick or revert in progress')
    if (s.conflicted.length) throw new Error('Resolve the conflicted files and stage them first')
    return mayConflict(repo, [s.operation, '--continue'])
  })
}

export async function abortOperation(repo: string): Promise<void> {
  await serialized(repo, async () => {
    const op = (await getStatus(repo)).operation
    if (!op) throw new Error('No merge, rebase, cherry-pick or revert in progress')
    await git(repo, [op, '--abort'])
  })
}

// Names come from the renderer: both must be existing branches, the target a local one.
export async function branchPair(repo: string, sourceName: string, targetName: string): Promise<{ source: Branch & { ref: string }; target: Branch }> {
  const branches = await getBranches(repo)
  const source = branches.find((b) => b.name === sourceName)
  const target = branches.find((b) => b.name === targetName && !b.remote)
  if (!source) throw new Error(`Unknown branch: ${sourceName}`)
  if (!target) throw new Error(`Not a local branch: ${targetName}`)
  if (source === target) throw new Error('Drop the branch onto another branch')
  return { source: { ...source, ref: (source.remote ? 'refs/remotes/' : 'refs/heads/') + source.name }, target }
}

const count = async (repo: string, range: string) => Number((await git(repo, [...RO, 'rev-list', '--count', range])).trim())

// Dry-run merge (`git merge-tree`): writes objects only, never the work tree, the index or refs. `base` overrides the merge base.
export async function predictConflicts(repo: string, ours: string, theirs: string, base?: string): Promise<string[]> {
  const out = await git(repo, [...RO, 'merge-tree', '--write-tree', '--name-only', '--no-messages', '-z', ...(base ? [`--merge-base=${base}`] : []), ours, theirs], { okCodes: [1] })
  return out.split('\0').filter(Boolean).slice(1) // first entry: the tree id
}

export async function mergePreview(repo: string, sourceName: string, targetName: string): Promise<MergePreview> {
  const { source, target } = await branchPair(repo, sourceName, targetName)
  const [incoming, local, conflicts] = await Promise.all([
    count(repo, `${target.sha}..${source.sha}`),
    count(repo, `${source.sha}..${target.sha}`),
    predictConflicts(repo, target.sha, source.sha)
  ])
  return { incoming, local, conflicts }
}

export function defaultMergeMessage(source: Pick<Branch, 'name' | 'remote'>, target: string): string {
  return `Merge ${source.remote ? 'remote-tracking ' : ''}branch '${source.name}' into ${target}`
}

// Merge and rebase switch to the target first when it is not checked out. --autostash is git's own: stash, run, re-apply.
export async function integrate(repo: string, req: MergeRequest): Promise<OpOutcome> {
  const { source, target } = await branchPair(repo, req.source, req.target)
  const auto = req.autostash ? ['--autostash'] : []
  return serialized(repo, async () => {
    await ensureIdle(repo)
    const current = (await getStatus(repo)).branch === target.name
    if (req.mode === 'ff') {
      if ((await count(repo, `${source.sha}..${target.sha}`)) > 0) throw new Error(`${target.name} cannot be fast-forwarded: it has commits that ${source.name} does not have`)
      if (current) await git(repo, ['merge', '--ff-only', ...auto, source.ref])
      else await git(repo, ['update-ref', `refs/heads/${target.name}`, source.sha, target.sha])
      return 'done'
    }
    if (req.mode === 'rebase') return mayConflict(repo, ['rebase', ...auto, source.ref, target.name])
    if (req.mode !== 'merge') throw new Error(`Invalid mode: ${req.mode}`)
    if (!current) await git(repo, ['switch', target.name])
    const message = String(req.message ?? '').trim() || defaultMergeMessage(source, target.name)
    return mayConflict(repo, ['merge', '--no-ff', ...auto, '-m', message, source.ref])
  })
}
