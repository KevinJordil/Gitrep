import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { git } from '../src/main/git'
import { undoState } from '../src/main/journal'
import { abortOperation, checkoutCommit, cherryPick, continueOperation, createBranch, createTag, deleteBranch, integrate, resetTo } from '../src/main/ops'
import { commit, getStatus, pull, stage, switchBranch } from '../src/main/repo'
import { redo, undo } from '../src/main/undo'
import { commitAll, makeRepo, tempDir, write } from './helpers'

const rev = async (repo: string, r = 'HEAD') => (await git(repo, ['rev-parse', r])).trim()
const branchOf = async (repo: string) => (await git(repo, ['branch', '--show-current'])).trim()
const read = (repo: string, f: string) => readFile(join(repo, f), 'utf8')

// main: base -> m1 (edits a.txt); feature: base -> f1 (adds f.txt, or edits a.txt when conflicting).
async function setup(conflict = false) {
  const repo = await makeRepo()
  await write(repo, 'a.txt', 'base\n')
  await commitAll(repo, 'base')
  await git(repo, ['switch', '-q', '-c', 'feature'])
  await write(repo, conflict ? 'a.txt' : 'f.txt', 'feature\n')
  await commitAll(repo, 'f1')
  await git(repo, ['switch', '-q', 'main'])
  await write(repo, 'a.txt', 'main\n')
  await commitAll(repo, 'm1')
  return repo
}

describe('undo and redo of commits', () => {
  it('undoes a commit softly (changes back staged) and redoes it', async () => {
    const repo = await setup()
    const before = await rev(repo)
    await write(repo, 'a.txt', 'next\n')
    await stage(repo, ['a.txt'])
    await commit(repo, 'feat: next\n', false)
    const after = await rev(repo)
    expect(undoState(repo)).toEqual({ undo: 'Commit "feat: next"', redo: null })
    expect(await undo(repo)).toBe(`Commit "feat: next" undone: main is back at ${before.slice(0, 7)}`)
    expect(await rev(repo)).toBe(before)
    expect((await getStatus(repo)).staged.map((f) => f.path)).toEqual(['a.txt'])
    expect(undoState(repo)).toEqual({ undo: null, redo: 'Commit "feat: next"' })
    expect(await redo(repo)).toBe(`Commit "feat: next" redone: main is at ${after.slice(0, 7)}`)
    expect(await rev(repo)).toBe(after)
    expect((await getStatus(repo)).staged).toEqual([])
  })

  it('undoes an amend and the very first commit', async () => {
    const repo = await makeRepo()
    await write(repo, 'a.txt', '1\n')
    await stage(repo, ['a.txt'])
    await commit(repo, 'first\n', false)
    const first = await rev(repo)
    await write(repo, 'b.txt', '2\n')
    await stage(repo, ['b.txt'])
    await commit(repo, 'first, amended\n', true)
    await undo(repo)
    expect(await rev(repo)).toBe(first)
    expect((await getStatus(repo)).staged.map((f) => f.path)).toEqual(['b.txt'])
    await undo(repo)
    const s = await getStatus(repo)
    expect(s.head).toBeNull()
    expect(s.staged.map((f) => f.path).sort()).toEqual(['a.txt', 'b.txt'])
    await redo(repo)
    expect(await rev(repo)).toBe(first)
  })

  it('says when there is nothing to undo or redo', async () => {
    const repo = await setup()
    await expect(undo(repo)).rejects.toThrow('Nothing to undo')
    await expect(redo(repo)).rejects.toThrow('Nothing to redo')
  })

  it('refuses and clears the history when the repository changed since', async () => {
    const repo = await setup()
    await createBranch(repo, 'x', 'HEAD', false)
    await write(repo, 'a.txt', 'outside\n')
    await commitAll(repo, 'made in a terminal')
    await git(repo, ['branch', '-f', 'x', 'HEAD'])
    await expect(undo(repo)).rejects.toThrow('Cannot undo "Create branch x": the repository changed since')
    expect(undoState(repo)).toEqual({ undo: null, redo: null })
  })
})

describe('undo of operations that move HEAD', () => {
  it('undoes a cherry-pick with reset --keep, which refuses to overwrite local changes', async () => {
    const repo = await setup()
    const before = await rev(repo)
    await cherryPick(repo, 'feature')
    await write(repo, 'f.txt', 'local edit\n')
    await expect(undo(repo)).rejects.toThrow('reset --keep')
    expect(undoState(repo).undo).toBe(`Cherry-pick ${(await rev(repo, 'feature')).slice(0, 7)}`)
    await write(repo, 'f.txt', 'feature\n')
    await undo(repo)
    expect(await rev(repo)).toBe(before)
  })

  it('undoes a rebase that switched branch first: the branch goes back, then HEAD', async () => {
    const repo = await setup()
    const feature = await rev(repo, 'feature')
    await integrate(repo, { source: 'main', target: 'feature', mode: 'rebase', message: '', autostash: false })
    const rebased = await rev(repo, 'feature')
    expect(await branchOf(repo)).toBe('feature')
    expect(await undo(repo)).toContain('main is back at')
    expect(await branchOf(repo)).toBe('main')
    expect(await rev(repo, 'feature')).toBe(feature)
    await redo(repo)
    expect(await branchOf(repo)).toBe('feature')
    expect(await rev(repo, 'feature')).toBe(rebased)
  })

  it('undoes a fast-forward of a branch that is not checked out', async () => {
    const repo = await setup()
    await git(repo, ['branch', 'behind', 'HEAD~1'])
    const old = await rev(repo, 'behind')
    await integrate(repo, { source: 'main', target: 'behind', mode: 'ff', message: '', autostash: false })
    await undo(repo)
    expect(await rev(repo, 'behind')).toBe(old)
    expect(await branchOf(repo)).toBe('main')
  })

  it('journals a conflicted merge once it is continued, and only the switch when it is aborted', async () => {
    const repo = await setup(true)
    const main = await rev(repo)
    expect(await integrate(repo, { source: 'feature', target: 'main', mode: 'merge', message: '', autostash: false })).toBe('conflicts')
    expect(undoState(repo).undo).toBeNull()
    await write(repo, 'a.txt', 'both\n')
    await stage(repo, ['a.txt'])
    expect(await continueOperation(repo)).toBe('done')
    expect(undoState(repo).undo).toBe('Merge feature into main')
    await undo(repo)
    expect(await rev(repo)).toBe(main)

    await git(repo, ['switch', '-q', 'feature'])
    expect(await integrate(repo, { source: 'feature', target: 'main', mode: 'merge', message: '', autostash: false })).toBe('conflicts')
    await abortOperation(repo)
    expect(undoState(repo).undo).toBe('Switch to main')
    await undo(repo)
    expect(await branchOf(repo)).toBe('feature')
  })

  it('undoes a hard reset, local changes included, and redoes it', async () => {
    const repo = await setup()
    const before = await rev(repo)
    await write(repo, 'a.txt', 'uncommitted\n')
    await resetTo(repo, 'HEAD~1', 'hard')
    expect(await read(repo, 'a.txt')).toBe('base\n')
    await undo(repo)
    expect(await rev(repo)).toBe(before)
    expect(await read(repo, 'a.txt')).toBe('uncommitted\n')
    await redo(repo)
    expect(await read(repo, 'a.txt')).toBe('base\n')
    await undo(repo)
    expect(await read(repo, 'a.txt')).toBe('uncommitted\n')
  })

  it('undoes a mixed reset without touching the files', async () => {
    const repo = await setup()
    const before = await rev(repo)
    await resetTo(repo, 'HEAD~1', 'mixed')
    expect(await read(repo, 'a.txt')).toBe('main\n')
    await undo(repo)
    expect(await rev(repo)).toBe(before)
    expect((await getStatus(repo)).unstaged).toEqual([])
  })
})

describe('undo of checkouts, branches and tags', () => {
  it('goes back to the previous branch after a checkout, and after creating a checked-out branch', async () => {
    const repo = await setup()
    await checkoutCommit(repo, 'feature')
    await undo(repo)
    expect(await branchOf(repo)).toBe('main')
    await createBranch(repo, 'work', 'feature', true)
    await undo(repo)
    expect(await branchOf(repo)).toBe('main')
    expect((await git(repo, ['branch', '--list', 'work'])).trim()).toBe('')
    await redo(repo)
    expect(await branchOf(repo)).toBe('work')
  })

  it('deletes the local branch a remote checkout created, and brings it back with its upstream', async () => {
    const origin = await setup()
    const repo = await tempDir()
    await git(repo, ['clone', '-q', origin, '.'])
    await switchBranch(repo, 'origin/feature', true)
    expect(await branchOf(repo)).toBe('feature')
    await undo(repo)
    expect(await branchOf(repo)).toBe('main')
    expect((await git(repo, ['branch', '--list', 'feature'])).trim()).toBe('')
    await redo(repo)
    expect((await git(repo, ['rev-parse', '--abbrev-ref', 'feature@{upstream}'])).trim()).toBe('origin/feature')
  })

  it('deletes a branch only when merged unless forced, and undo restores it with its upstream', async () => {
    const origin = await setup()
    const repo = await tempDir()
    await git(repo, ['clone', '-q', origin, '.'])
    await git(repo, ['branch', '-q', '--track', 'feature', 'origin/feature'])
    await git(repo, ['branch', '-q', '--no-track', 'local', 'origin/feature'])
    const sha = await rev(repo, 'feature')
    await expect(deleteBranch(repo, 'local', false)).rejects.toThrow('not fully merged')
    await expect(deleteBranch(repo, 'main', true)).rejects.toThrow('checked-out branch')
    await deleteBranch(repo, 'local', true)
    await deleteBranch(repo, 'feature', false) // merged into its upstream: no force needed
    expect(undoState(repo).undo).toBe('Delete branch feature')
    await undo(repo)
    expect(await rev(repo, 'feature')).toBe(sha)
    expect((await git(repo, ['rev-parse', '--abbrev-ref', 'feature@{upstream}'])).trim()).toBe('origin/feature')
  })

  it('removes a created tag and restores the same annotated tag object', async () => {
    const repo = await setup()
    await createTag(repo, 'v1', 'HEAD', 'Release 1\n')
    const object = await rev(repo, 'refs/tags/v1')
    await undo(repo)
    expect((await git(repo, ['tag', '--list'])).trim()).toBe('')
    await redo(repo)
    expect(await rev(repo, 'refs/tags/v1')).toBe(object)
  })
})

describe('journal limits', () => {
  it('a new operation clears the redo stack', async () => {
    const repo = await setup()
    await createBranch(repo, 'a', 'HEAD', false)
    await undo(repo)
    expect(undoState(repo).redo).toBe('Create branch a')
    await writeFile(join(repo, 'n.txt'), 'n\n')
    await stage(repo, ['n.txt'])
    await commit(repo, 'n\n', false)
    expect(undoState(repo)).toEqual({ undo: 'Commit "n"', redo: null })
  })
})

describe('saved changes and pull', () => {
  it('undoes reset --hard HEAD, which only discards local changes', async () => {
    const repo = await setup()
    await write(repo, 'a.txt', 'dirty\n')
    await resetTo(repo, 'HEAD', 'hard')
    expect(await read(repo, 'a.txt')).toBe('main\n')
    await undo(repo)
    expect(await read(repo, 'a.txt')).toBe('dirty\n')
  })

  it('keeps the saved changes in the stash list when they cannot be re-applied', async () => {
    const repo = await setup()
    await write(repo, 'a.txt', 'dirty\n')
    await resetTo(repo, 'HEAD', 'hard')
    await write(repo, 'a.txt', 'other\n') // the saved edit would overwrite this one
    await expect(undo(repo)).rejects.toThrow('GitRep: changes saved before reset')
    expect(await git(repo, ['stash', 'list'])).toContain('GitRep: changes saved before reset')
    expect(await read(repo, 'a.txt')).toBe('other\n')
  })

  it('journals a pull that stopped on conflicts once it is continued', async () => {
    const origin = await setup(true)
    await git(origin, ['switch', '-q', 'feature'])
    const repo = await tempDir()
    await git(repo, ['clone', '-q', '-b', 'feature', origin, '.'])
    await write(origin, 'a.txt', 'remote\n')
    await commitAll(origin, 'remote')
    await write(repo, 'a.txt', 'local\n')
    await commitAll(repo, 'local')
    await git(repo, ['config', 'pull.rebase', 'false'])
    expect(await pull(repo)).toBe('conflicts')
    await write(repo, 'a.txt', 'both\n')
    await stage(repo, ['a.txt'])
    expect(await continueOperation(repo)).toBe('done')
    expect(undoState(repo).undo).toBe('Pull')
  })
})
