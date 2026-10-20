import { git, serialized } from './git'
import { changedBranches, clear, peek, shift, snapshot, type Snapshot, type Step } from './journal'
import { ensureIdle } from './ops'

// HEAD or a ref is no longer where the journal left it: something else changed the repository.
class Stale extends Error {}
// The refs moved but the saved changes could not be re-applied.
class Unapplied extends Error {}

const short = (sha: string | null) => sha?.slice(0, 7) ?? ''

// Moves HEAD and the local branches of a step from one snapshot to the other.
// The checked-out branch moves with `reset --<mode>`; other branches with update-ref, which checks their old value.
async function moveRefs(repo: string, from: Snapshot, to: Snapshot, mode: 'soft' | 'mixed' | 'keep' | 'hard'): Promise<void> {
  const now = await snapshot(repo)
  const names = changedBranches(from, to)
  if (now.head.branch !== from.head.branch || now.head.sha !== from.head.sha || names.some((n) => now.heads[n]?.sha !== from.heads[n]?.sha)) throw new Stale()
  const set = async (n: string) => {
    const old = from.heads[n]?.sha
    const next = to.heads[n]
    if (!next) return void (await git(repo, ['update-ref', '-d', `refs/heads/${n}`, old!]))
    await git(repo, ['update-ref', `refs/heads/${n}`, next.sha, old ?? ''])
    if (!old && next.upstream) await git(repo, ['branch', `--set-upstream-to=${next.upstream}`, n]).catch(() => undefined)
  }
  if (from.head.branch === to.head.branch) {
    const current = to.head.branch
    if (from.head.sha !== to.head.sha) {
      if (to.head.sha) await git(repo, ['reset', `--${mode}`, to.head.sha])
      else if (current) await set(current) // back before the first commit
    }
    for (const n of names) if (n !== current) await set(n)
    return
  }
  // HEAD changes branch: the branch to switch to first, then the switch (undone if refused), then the other
  // branches, the branch left behind last.
  const target = to.head.branch && names.includes(to.head.branch) ? to.head.branch : null
  if (target) await set(target)
  try {
    await git(repo, to.head.branch ? ['switch', to.head.branch] : ['switch', '--detach', to.head.sha!])
  } catch (e) {
    if (target) await git(repo, from.heads[target] ? ['update-ref', `refs/heads/${target}`, from.heads[target].sha, to.heads[target]?.sha ?? ''] : ['update-ref', '-d', `refs/heads/${target}`, to.heads[target]!.sha])
    throw e
  }
  for (const n of names) if (n !== from.head.branch && n !== target) await set(n)
  if (from.head.branch && names.includes(from.head.branch)) await set(from.head.branch)
}

// Staged state back when possible; otherwise the saved commit is kept in the Stashes list.
async function reapply(repo: string, saved: string): Promise<void> {
  try {
    await git(repo, ['stash', 'apply', '--index', saved])
  } catch {
    try {
      await git(repo, ['stash', 'apply', saved])
    } catch (e) {
      await git(repo, ['stash', 'store', '-m', 'GitRep: changes saved before reset', saved])
      throw new Unapplied(`The reset was undone but the changes it discarded could not be re-applied (${(e as Error).message.trim().split('\n')[0]}). They are kept in the Stashes list as "GitRep: changes saved before reset".`)
    }
  }
}

// Applies one step backwards (undo) or forwards (redo); returns where HEAD ends up when it moved.
async function apply(repo: string, step: Step, dir: 'undo' | 'redo'): Promise<string> {
  if (step.kind === 'refs') {
    const [from, to] = dir === 'undo' ? [step.after, step.before] : [step.before, step.after]
    const hard = step.mode === 'hard'
    if (hard && dir === 'redo') step.saved = (await git(repo, ['stash', 'create'])).trim() || undefined
    await moveRefs(repo, from, to, hard ? (dir === 'undo' ? 'keep' : 'hard') : step.mode)
    if (hard && dir === 'undo' && step.saved) await reapply(repo, step.saved)
    if (from.head.branch === to.head.branch && from.head.sha === to.head.sha) return ''
    return `${to.head.branch ?? 'HEAD'} ${dir === 'undo' ? 'is back at' : 'is at'} ${short(to.head.sha)}`
  }
  const [old, next] = dir === 'undo' ? [step.after, step.before] : [step.before, step.after]
  const current = (await git(repo, ['rev-parse', '-q', '--verify', step.ref], { okCodes: [1] })).trim() || null
  if (current !== old) throw new Stale()
  await git(repo, next ? ['update-ref', step.ref, next, old ?? ''] : ['update-ref', '-d', step.ref, old!])
  return ''
}

async function replay(repo: string, dir: 'undo' | 'redo'): Promise<string> {
  return serialized(repo, async () => {
    const entry = peek(repo, dir)
    if (!entry) throw new Error(dir === 'undo' ? 'Nothing to undo' : 'Nothing to redo')
    await ensureIdle(repo)
    let detail: string
    try {
      detail = await apply(repo, entry.step, dir)
    } catch (e) {
      if (e instanceof Unapplied) {
        shift(repo, dir)
        throw e
      }
      if (!(e instanceof Stale)) throw e
      clear(repo)
      throw new Error(`Cannot ${dir} "${entry.label}": the repository changed since. The undo history was cleared.`)
    }
    shift(repo, dir)
    return `${entry.label} ${dir === 'undo' ? 'undone' : 'redone'}${detail ? `: ${detail}` : ''}`
  })
}

// Both resolve to the message to show.
export const undo = (repo: string): Promise<string> => replay(repo, 'undo')
export const redo = (repo: string): Promise<string> => replay(repo, 'redo')
