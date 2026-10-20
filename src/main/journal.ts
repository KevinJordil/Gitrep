import type { OpOutcome, UndoState } from '../shared/types'
import { currentOperation, git } from './git'

const RO = ['--no-optional-locks']

export interface Snapshot {
  head: { branch: string | null; sha: string | null } // branch null: detached; sha null: no commit yet
  heads: Record<string, { sha: string; upstream: string }> // local branches
}

// How the checked-out branch goes back: soft keeps the index and the files (commit, amend, soft reset), mixed keeps
// the files (mixed reset), keep updates the files but refuses to overwrite local changes, hard is keep plus the
// local changes the reset discarded, saved beforehand with `git stash create`.
export type MoveMode = 'soft' | 'mixed' | 'keep' | 'hard'

export type Step =
  | { kind: 'refs'; before: Snapshot; after: Snapshot; mode: MoveMode; saved?: string }
  | { kind: 'ref'; ref: string; before: string | null; after: string | null } // a tag
  | { kind: 'stash'; pushed: boolean; sha: string; message: string; untracked: boolean } // a push, or a pop on a clean tree
  | { kind: 'stash-drop'; sha: string; subject: string }
  | { kind: 'patch'; patch: Buffer } // discarded changes: undo applies the patch, redo reverses it

export interface Entry {
  label: string
  step: Step
}

interface History {
  undo: Entry[]
  redo: Entry[]
  pending?: { label: string; mode: MoveMode; before: Snapshot } // an operation stopped on conflicts
}

// In memory only: the history of a repo is lost when GitRep quits.
const MAX_ENTRIES = 50 // Limit: older entries fall off
const histories = new Map<string, History>()

function historyOf(repo: string): History {
  let h = histories.get(repo)
  if (!h) histories.set(repo, (h = { undo: [], redo: [] }))
  return h
}

const MAX_PATCH_BYTES = 100 * 1024 * 1024 // Limit: saved patches across a repo's history; oldest steps fall off
const patchBytes = (h: History) => [...h.undo, ...h.redo].reduce((n, e) => n + (e.step.kind === 'patch' ? e.step.patch.length : 0), 0)

export function record(repo: string, label: string, step: Step): void {
  const h = historyOf(repo)
  h.undo.push({ label, step })
  if (h.undo.length > MAX_ENTRIES) h.undo.shift()
  h.redo = []
  while (h.undo.length > 1 && patchBytes(h) > MAX_PATCH_BYTES) h.undo.shift()
}

export const peek = (repo: string, stack: 'undo' | 'redo'): Entry | undefined => histories.get(repo)?.[stack].at(-1)

// After a successful undo the entry goes to the redo stack, and back after a redo.
export function shift(repo: string, from: 'undo' | 'redo'): void {
  const h = historyOf(repo)
  const e = h[from].pop()
  if (e) h[from === 'undo' ? 'redo' : 'undo'].push(e)
}

export const clear = (repo: string): void => void histories.delete(repo)

export function undoState(repo: string): UndoState {
  return { undo: peek(repo, 'undo')?.label ?? null, redo: peek(repo, 'redo')?.label ?? null }
}

export async function snapshot(repo: string): Promise<Snapshot> {
  const [heads, branch, sha] = await Promise.all([
    git(repo, [...RO, 'for-each-ref', '--format=%(refname:strip=2)%1f%(objectname)%1f%(upstream:short)', 'refs/heads']),
    git(repo, ['symbolic-ref', '-q', '--short', 'HEAD'], { okCodes: [1] }),
    git(repo, ['rev-parse', '-q', '--verify', 'HEAD'], { okCodes: [1] })
  ])
  const entries = heads
    .split('\n')
    .filter(Boolean)
    .map((line): [string, { sha: string; upstream: string }] => {
      const [name, s, upstream] = line.split('\x1f')
      return [name, { sha: s, upstream }]
    })
  return { head: { branch: branch.trim() || null, sha: sha.trim() || null }, heads: Object.fromEntries(entries) }
}

// Local branches whose tip differs (created, deleted or moved).
export function changedBranches(a: Snapshot, b: Snapshot): string[] {
  return [...new Set([...Object.keys(a.heads), ...Object.keys(b.heads)])].filter((n) => a.heads[n]?.sha !== b.heads[n]?.sha)
}

const same = (a: Snapshot, b: Snapshot) => a.head.branch === b.head.branch && a.head.sha === b.head.sha && changedBranches(a, b).length === 0

// A pending operation that git no longer reports was finished or aborted outside GitRep: forget it.
async function dropStalePending(repo: string): Promise<void> {
  const h = histories.get(repo)
  if (h?.pending && !(await currentOperation(repo))) h.pending = undefined
}

// Runs a write that moves HEAD or branches and journals what changed. Call it inside serialized(repo).
// An operation git stopped on conflicts is journaled when it completes (resumed) and dropped when aborted.
export async function tracked<T>(repo: string, label: string, mode: MoveMode, fn: () => Promise<T>, saved?: string): Promise<T> {
  await dropStalePending(repo)
  const before = await snapshot(repo)
  let result: T
  try {
    result = await fn()
  } catch (e) {
    // A stop without conflicts (failing exec, signing failure) leaves an operation in progress: Continue journals it.
    if (await currentOperation(repo)) historyOf(repo).pending = { label, mode, before }
    throw e
  }
  if (result === 'conflicts' && (await currentOperation(repo))) {
    historyOf(repo).pending = { label, mode, before }
    return result
  }
  historyOf(repo).pending = undefined
  const after = await snapshot(repo)
  // Saved changes make a step even when the refs did not move (reset --hard HEAD).
  if (!same(before, after) || saved) record(repo, label, { kind: 'refs', before, after, mode, ...(saved ? { saved } : {}) })
  return result
}

// --continue and --skip: the stopped operation is journaled as a whole once git is done with it.
export async function resumed(repo: string, fn: () => Promise<OpOutcome>): Promise<OpOutcome> {
  await dropStalePending(repo)
  const result = await fn()
  const h = histories.get(repo)
  const p = h?.pending
  if (!h || !p || (result === 'conflicts' && (await currentOperation(repo)))) return result
  h.pending = undefined
  const after = await snapshot(repo)
  if (!same(p.before, after)) record(repo, p.label, { kind: 'refs', before: p.before, after, mode: p.mode })
  return result
}

// --abort: what is left (the switch made before the operation started) is journaled on its own.
export async function aborted(repo: string, fn: () => Promise<unknown>): Promise<void> {
  await dropStalePending(repo)
  await fn()
  const h = histories.get(repo)
  const p = h?.pending
  if (!h || !p) return
  h.pending = undefined
  const after = await snapshot(repo)
  if (!same(p.before, after)) record(repo, `Switch to ${after.head.branch ?? after.head.sha?.slice(0, 7)}`, { kind: 'refs', before: p.before, after, mode: 'keep' })
}
