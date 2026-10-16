import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { git } from '../src/main/git'
import { abortOperation, checkoutCommit, cherryPick, continueOperation, createBranch, createTag, integrate, mergePreview, resetTo, revert } from '../src/main/ops'
import { getStatus } from '../src/main/repo'
import { commitAll, makeRepo, write } from './helpers'

const rev = async (repo: string, r: string) => (await git(repo, ['rev-parse', r])).trim()
const subject = async (repo: string, r = 'HEAD') => (await git(repo, ['log', '-1', '--format=%s', r])).trim()

// main: base -> m1 (edits a.txt); feature: base -> f1 (adds f.txt). With conflict: feature also edits a.txt.
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

describe('checkout, branch, tag', () => {
  it('checks out a commit detached', async () => {
    const repo = await setup()
    await checkoutCommit(repo, 'feature')
    const s = await getStatus(repo)
    expect(s.branch).toBeNull()
    expect(s.head).toBe(await rev(repo, 'feature'))
  })

  it('creates a branch at a commit, optionally checking it out', async () => {
    const repo = await setup()
    await createBranch(repo, 'from-base', 'HEAD~1', false)
    expect(await rev(repo, 'from-base')).toBe(await rev(repo, 'HEAD~1'))
    expect((await getStatus(repo)).branch).toBe('main')
    await createBranch(repo, 'work', 'feature', true)
    expect((await getStatus(repo)).branch).toBe('work')
  })

  it('rejects invalid branch names', async () => {
    const repo = await setup()
    await expect(createBranch(repo, '-f', 'HEAD', false)).rejects.toThrow('Invalid branch name')
    await expect(createBranch(repo, 'bad..name', 'HEAD', false)).rejects.toThrow('Invalid branch name')
    await expect(createBranch(repo, '', 'HEAD', false)).rejects.toThrow('Invalid branch name')
    await expect(createBranch(repo, '@{-1}', 'HEAD', false)).rejects.toThrow('Invalid branch name')
  })

  it('creates lightweight and annotated tags, rejects invalid names', async () => {
    const repo = await setup()
    await createTag(repo, 'v1', 'HEAD~1', '')
    await createTag(repo, 'v2', 'HEAD', 'Release 2\n')
    expect(await rev(repo, 'v1^{commit}')).toBe(await rev(repo, 'HEAD~1'))
    expect((await git(repo, ['cat-file', '-t', 'v2'])).trim()).toBe('tag')
    expect((await git(repo, ['tag', '-l', '--format=%(contents)', 'v2'])).trim()).toBe('Release 2')
    await expect(createTag(repo, 'bad tag', 'HEAD', '')).rejects.toThrow('Invalid tag name')
  })
})

describe('safety while busy', () => {
  it('refuses to switch during a stopped merge', async () => {
    const repo = await setup(true)
    expect(await integrate(repo, { source: 'feature', target: 'main', mode: 'merge', message: '', autostash: false })).toBe('conflicts')
    await expect(checkoutCommit(repo, 'feature')).rejects.toThrow('merge is in progress')
    await expect(createBranch(repo, 'x', 'feature', true)).rejects.toThrow('merge is in progress')
  })

  it('reports conflicts when re-applying the autostash conflicts', async () => {
    const repo = await makeRepo()
    await write(repo, 'a.txt', 'base\n')
    await commitAll(repo, 'base')
    await git(repo, ['switch', '-q', '-c', 'feature'])
    await write(repo, 'a.txt', 'feature\n')
    await commitAll(repo, 'f1')
    await git(repo, ['switch', '-q', 'main'])
    await write(repo, 'm.txt', 'm\n')
    await commitAll(repo, 'm1')
    await write(repo, 'a.txt', 'dirty\n')
    expect(await integrate(repo, { source: 'feature', target: 'main', mode: 'merge', message: '', autostash: true })).toBe('conflicts')
    expect((await getStatus(repo)).conflicted.map((f) => f.path)).toEqual(['a.txt'])
    expect((await git(repo, ['stash', 'list'])).trim()).not.toBe('')
  })
})

describe('cherry-pick, revert, reset', () => {
  it('cherry-picks a commit onto the current branch', async () => {
    const repo = await setup()
    expect(await cherryPick(repo, 'feature')).toBe('done')
    expect(await subject(repo)).toBe('f1')
    expect(existsSync(join(repo, 'f.txt'))).toBe(true)
  })

  it('reports conflicts instead of failing, then aborts', async () => {
    const repo = await setup(true)
    expect(await cherryPick(repo, 'feature')).toBe('conflicts')
    const s = await getStatus(repo)
    expect(s.operation).toBe('cherry-pick')
    expect(s.conflicted.map((f) => f.path)).toEqual(['a.txt'])
    expect(await readFile(join(repo, 'a.txt'), 'utf8')).toContain('||||||| ') // diff3 style
    await expect(revert(repo, 'HEAD')).rejects.toThrow('cherry-pick is in progress')
    await abortOperation(repo)
    expect((await getStatus(repo)).operation).toBeNull()
    expect(await subject(repo)).toBe('m1')
  })

  it('reverts a commit with the default message', async () => {
    const repo = await setup()
    expect(await revert(repo, 'HEAD')).toBe('done')
    expect(await subject(repo)).toBe('Revert "m1"')
    expect(await readFile(join(repo, 'a.txt'), 'utf8')).toBe('base\n')
  })

  it('resets soft, mixed and hard', async () => {
    const repo = await setup()
    const base = await rev(repo, 'HEAD~1')
    await resetTo(repo, base, 'soft')
    expect((await getStatus(repo)).staged.map((f) => f.path)).toEqual(['a.txt'])
    await git(repo, ['reset', '-q', 'ORIG_HEAD'])
    await resetTo(repo, base, 'mixed')
    const s = await getStatus(repo)
    expect([s.staged.length, s.unstaged.map((f) => f.path)]).toEqual([0, ['a.txt']])
    await resetTo(repo, base, 'hard')
    expect(await readFile(join(repo, 'a.txt'), 'utf8')).toBe('base\n')
    await expect(resetTo(repo, base, 'keep' as never)).rejects.toThrow('Invalid reset mode')
  })
})

describe('mergePreview and integrate', () => {
  it('counts commits on both sides and predicts conflicts without touching the work tree', async () => {
    const repo = await setup(true)
    expect(await mergePreview(repo, 'feature', 'main')).toEqual({ incoming: 1, local: 1, conflicts: ['a.txt'] })
    expect((await getStatus(repo)).unstaged).toEqual([])
    const clean = await setup()
    expect(await mergePreview(clean, 'feature', 'main')).toEqual({ incoming: 1, local: 1, conflicts: [] })
  })

  it('rejects unknown branches and remote targets', async () => {
    const repo = await setup()
    await expect(mergePreview(repo, 'nope', 'main')).rejects.toThrow('Unknown branch')
    await expect(mergePreview(repo, 'feature', 'feature')).rejects.toThrow('another branch')
    await expect(integrate(repo, { source: 'feature', target: 'origin/main', mode: 'merge', message: '', autostash: false })).rejects.toThrow('Not a local branch')
  })

  it('merges with a merge commit and the given message, auto-stashing local changes', async () => {
    const repo = await setup()
    await write(repo, 'a.txt', 'main\nlocal\n')
    expect(await integrate(repo, { source: 'feature', target: 'main', mode: 'merge', message: 'Merge feature', autostash: true })).toBe('done')
    expect(await subject(repo)).toBe('Merge feature')
    expect((await git(repo, ['rev-list', '--parents', '-n1', 'HEAD'])).trim().split(' ')).toHaveLength(3)
    expect(await readFile(join(repo, 'a.txt'), 'utf8')).toBe('main\nlocal\n')
  })

  it('switches to the target first when it is not checked out', async () => {
    const repo = await setup()
    await git(repo, ['switch', '-q', 'feature'])
    await integrate(repo, { source: 'feature', target: 'main', mode: 'merge', message: '', autostash: false })
    expect((await getStatus(repo)).branch).toBe('main')
    expect(await subject(repo)).toBe("Merge branch 'feature' into main")
  })

  it('rebases the target onto the source', async () => {
    const repo = await setup()
    expect(await integrate(repo, { source: 'feature', target: 'main', mode: 'rebase', message: '', autostash: false })).toBe('done')
    expect(await rev(repo, 'main~1')).toBe(await rev(repo, 'feature'))
    expect(await subject(repo, 'main')).toBe('m1')
  })

  it('fast-forwards the current branch or another one, refuses when diverged', async () => {
    const repo = await setup()
    await git(repo, ['branch', 'behind', 'HEAD~1'])
    await integrate(repo, { source: 'main', target: 'behind', mode: 'ff', message: '', autostash: false })
    expect(await rev(repo, 'behind')).toBe(await rev(repo, 'main'))
    await git(repo, ['switch', '-q', '-c', 'cur', 'HEAD~1'])
    await integrate(repo, { source: 'main', target: 'cur', mode: 'ff', message: '', autostash: false })
    expect(await rev(repo, 'HEAD')).toBe(await rev(repo, 'main'))
    await expect(integrate(repo, { source: 'feature', target: 'main', mode: 'ff', message: '', autostash: false })).rejects.toThrow('cannot be fast-forwarded')
  })

  it('stops a conflicting merge, then continues once resolved', async () => {
    const repo = await setup(true)
    expect(await integrate(repo, { source: 'feature', target: 'main', mode: 'merge', message: 'Merge it', autostash: false })).toBe('conflicts')
    expect((await getStatus(repo)).operation).toBe('merge')
    await expect(continueOperation(repo)).rejects.toThrow('Resolve the conflicted files')
    await write(repo, 'a.txt', 'resolved\n')
    await git(repo, ['add', 'a.txt'])
    expect(await continueOperation(repo)).toBe('done')
    expect((await getStatus(repo)).operation).toBeNull()
    expect(await subject(repo)).toBe('Merge it')
  })

  it('stops a conflicting rebase and aborts it', async () => {
    const repo = await setup(true)
    const before = await rev(repo, 'main')
    expect(await integrate(repo, { source: 'feature', target: 'main', mode: 'rebase', message: '', autostash: false })).toBe('conflicts')
    expect((await getStatus(repo)).operation).toBe('rebase')
    await abortOperation(repo)
    expect(await rev(repo, 'main')).toBe(before)
    await expect(abortOperation(repo)).rejects.toThrow('No merge')
  })
})
