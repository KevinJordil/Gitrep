import type { OpOutcome, Stash } from '../shared/types'
import { git, serialized } from './git'
import { record } from './journal'
import { ensureIdle, mayConflict, predictConflicts, validBranchName } from './ops'
import { parseStashes, STASH_FORMAT } from './parse'
import { getStatus, RO } from './repo'

export async function getStashes(repo: string): Promise<Stash[]> {
  return parseStashes(await git(repo, [...RO, 'stash', 'list', `--format=${STASH_FORMAT}`]))
}

// Stashes are designated by SHA (stash@{n} shifts when another one is dropped); pop/drop need the reflog name.
export async function findStash(repo: string, sha: string): Promise<Stash & { ref: string }> {
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
    const sha = await pushStash(repo, text, includeUntracked)
    if (sha) record(repo, `Stash "${text || 'local changes'}"`, { kind: 'stash', pushed: true, sha, message: text, untracked: includeUntracked && untracked > 0 })
  })
}

// Returns the new stash's SHA ('' when git found nothing to save). '' as message: git's default name.
export async function pushStash(repo: string, message: string, untracked: boolean): Promise<string> {
  const top = () => git(repo, ['rev-parse', '-q', '--verify', 'refs/stash'], { okCodes: [1] }).then((s) => s.trim())
  const before = await top()
  // No renderer path here; literal pathspecs would stop `stash push -u` from removing the untracked files it saved.
  await git(repo, ['stash', 'push', ...(untracked ? ['--include-untracked'] : []), ...(message ? ['-m', message] : [])], { env: { GIT_LITERAL_PATHSPECS: '0' } })
  const after = await top()
  return after === before ? '' : after
}

const subjectOf = async (repo: string, ref: string) => (await git(repo, [...RO, 'log', '-g', '-1', '--format=%gs', ref])).trim()

// Conflicts keep the stash, even for pop (git's behaviour).
export async function stashApply(repo: string, sha: string, pop: boolean): Promise<OpOutcome> {
  return serialized(repo, async () => {
    await ensureIdle(repo)
    const s = await getStatus(repo)
    const stash = await findStash(repo, sha)
    const subject = await subjectOf(repo, stash.ref)
    const outcome = await mayConflict(repo, ['stash', pop ? 'pop' : 'apply', stash.ref])
    // Undoing a pop stashes the changes again: only possible when they are the only ones in the work tree.
    if (pop && outcome === 'done' && !s.staged.length && !s.unstaged.length) {
      const named = subject.startsWith('On ')
      record(repo, `Pop stash "${stash.message}"`, { kind: 'stash', pushed: false, sha, message: named ? stash.message : '', untracked: !!stash.untracked })
    }
    return outcome
  })
}

export async function stashDrop(repo: string, sha: string): Promise<void> {
  await serialized(repo, async () => {
    const s = await findStash(repo, sha)
    // An external git process could have shifted the list since findStash(): never drop another stash.
    if ((await git(repo, [...RO, 'rev-parse', s.ref])).trim() !== sha) throw new Error('This stash no longer exists: refresh the list')
    const subject = await subjectOf(repo, s.ref)
    await git(repo, ['stash', 'drop', s.ref])
    record(repo, `Drop stash "${s.message}"`, { kind: 'stash-drop', sha, subject })
  })
}

// New branch at the stash's base commit, checked out, with the stash applied then dropped.
export async function stashBranch(repo: string, sha: string, name: string): Promise<OpOutcome> {
  const branch = await validBranchName(repo, name)
  return serialized(repo, async () => {
    await ensureIdle(repo)
    return mayConflict(repo, ['stash', 'branch', branch, (await findStash(repo, sha)).ref])
  })
}

// Files that applying the stash on HEAD would likely conflict on (ignores uncommitted changes).
export async function stashConflicts(repo: string, sha: string): Promise<string[]> {
  const s = await findStash(repo, sha)
  return predictConflicts(repo, 'HEAD', s.sha, s.base)
}
