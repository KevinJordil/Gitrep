import type { OpOutcome, Stash } from '../shared/types'
import { git, serialized } from './git'
import { ensureIdle, mayConflict, predictConflicts, validBranchName } from './ops'
import { parseStashes, STASH_FORMAT } from './parse'
import { getStatus, RO } from './repo'

export async function getStashes(repo: string): Promise<Stash[]> {
  return parseStashes(await git(repo, [...RO, 'stash', 'list', `--format=${STASH_FORMAT}`]))
}

// Stashes are designated by SHA (stash@{n} shifts when another one is dropped); pop/drop need the reflog name.
async function find(repo: string, sha: string): Promise<Stash & { ref: string }> {
  const s = (await getStashes(repo)).find((x) => x.sha === sha)
  if (!s) throw new Error('This stash no longer exists: refresh the list')
  return { ...s, ref: `stash@{${s.index}}` }
}

export async function stashPush(repo: string, message: string, includeUntracked: boolean): Promise<void> {
  await serialized(repo, async () => {
    await ensureIdle(repo)
    const s = await getStatus(repo)
    const untracked = s.unstaged.filter((f) => f.status === '?').length
    const tracked = s.staged.length + s.unstaged.length - untracked
    // git exits 0 with "No local changes to save": say it instead of doing nothing.
    if (!tracked && !(includeUntracked && untracked)) throw new Error(untracked ? 'Only untracked files changed: tick "Include untracked files"' : 'No local changes to stash')
    const text = String(message ?? '').trim()
    // No renderer path here; literal pathspecs would stop `stash push -u` from removing the untracked files it saved.
    await git(repo, ['stash', 'push', ...(includeUntracked ? ['--include-untracked'] : []), ...(text ? ['-m', text] : [])], { env: { GIT_LITERAL_PATHSPECS: '0' } })
  })
}

// Conflicts keep the stash, even for pop (git's behaviour).
export async function stashApply(repo: string, sha: string, pop: boolean): Promise<OpOutcome> {
  return serialized(repo, async () => {
    await ensureIdle(repo)
    const { ref } = await find(repo, sha)
    return mayConflict(repo, ['stash', pop ? 'pop' : 'apply', ref])
  })
}

export async function stashDrop(repo: string, sha: string): Promise<void> {
  await serialized(repo, async () => {
    const { ref } = await find(repo, sha)
    // An external git process could have shifted the list since find(): never drop another stash.
    if ((await git(repo, [...RO, 'rev-parse', ref])).trim() !== sha) throw new Error('This stash no longer exists: refresh the list')
    await git(repo, ['stash', 'drop', ref])
  })
}

// New branch at the stash's base commit, checked out, with the stash applied then dropped.
export async function stashBranch(repo: string, sha: string, name: string): Promise<OpOutcome> {
  const branch = await validBranchName(repo, name)
  return serialized(repo, async () => {
    await ensureIdle(repo)
    return mayConflict(repo, ['stash', 'branch', branch, (await find(repo, sha)).ref])
  })
}

// Files that applying the stash on HEAD would likely conflict on (ignores uncommitted changes).
export async function stashConflicts(repo: string, sha: string): Promise<string[]> {
  const s = await find(repo, sha)
  return predictConflicts(repo, 'HEAD', s.sha, s.base)
}
