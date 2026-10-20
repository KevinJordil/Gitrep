import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { git } from '../src/main/git'
import { parseStashes } from '../src/main/parse'
import { getStatus } from '../src/main/repo'
import { integrate } from '../src/main/ops'
import { redo, undo } from '../src/main/undo'
import { getStashes, stashApply, stashBranch, stashConflicts, stashDrop, stashPush } from '../src/main/stash'
import { commitAll, makeRepo, write } from './helpers'

describe('parseStashes', () => {
  it('reads index, parents, branch and message', () => {
    const out = [
      ['stash@{0}', 's0', 'b0 i0 u0', '1700000000', 'On feature/x: try DMA'].join('\x1f'),
      ['stash@{1}', 's1', 'b1 i1', '1690000000', 'WIP on main: 97069aa add file'].join('\x1f')
    ].join('\n')
    expect(parseStashes(out + '\n')).toEqual([
      { index: 0, sha: 's0', base: 'b0', untracked: 'u0', date: 1700000000, branch: 'feature/x', message: 'try DMA' },
      { index: 1, sha: 's1', base: 'b1', untracked: null, date: 1690000000, branch: 'main', message: 'WIP on main: 97069aa add file' }
    ])
  })
})

async function setup() {
  const repo = await makeRepo()
  await write(repo, 'a.txt', 'base\n')
  await commitAll(repo, 'base')
  return repo
}

describe('stash operations', () => {
  it('stashes with a message and untracked files, then lists it', async () => {
    const repo = await setup()
    await write(repo, 'a.txt', 'changed\n')
    await write(repo, 'new.txt', 'n\n')
    await stashPush(repo, 'my work', true)
    const [s] = await getStashes(repo)
    expect(s).toMatchObject({ index: 0, branch: 'main', message: 'my work' })
    expect(s.untracked).toMatch(/^[0-9a-f]{40}$/)
    expect(existsSync(join(repo, 'new.txt'))).toBe(false)
    expect((await getStatus(repo)).unstaged).toEqual([])
  })

  it('redoes a push with untracked files ticked when there were none', async () => {
    const repo = await setup()
    await write(repo, 'a.txt', 'changed\n')
    await stashPush(repo, 'tracked only', true)
    await undo(repo)
    await redo(repo)
    expect(await getStashes(repo)).toHaveLength(1)
  })

  it('refuses when there is nothing to stash', async () => {
    const repo = await setup()
    await expect(stashPush(repo, '', false)).rejects.toThrow('No local changes')
    await write(repo, 'new.txt', 'n\n')
    await expect(stashPush(repo, '', false)).rejects.toThrow('Include untracked files')
  })

  it('applies (keeps), pops (removes) and drops by SHA', async () => {
    const repo = await setup()
    await write(repo, 'a.txt', 'one\n')
    await stashPush(repo, 'one', false)
    await write(repo, 'a.txt', 'two\n')
    await stashPush(repo, 'two', false)
    const [two, one] = await getStashes(repo)
    expect(await stashApply(repo, one.sha, false)).toBe('done')
    expect(await readFile(join(repo, 'a.txt'), 'utf8')).toBe('one\n')
    expect(await getStashes(repo)).toHaveLength(2)
    await git(repo, ['checkout', '--', 'a.txt'])
    expect(await stashApply(repo, one.sha, true)).toBe('done')
    expect((await getStashes(repo)).map((s) => s.message)).toEqual(['two'])
    await stashDrop(repo, two.sha)
    expect(await getStashes(repo)).toEqual([])
    await expect(stashDrop(repo, two.sha)).rejects.toThrow('no longer exists')
  })

  it('reports conflicts and keeps the stash on a conflicting pop', async () => {
    const repo = await setup()
    await write(repo, 'a.txt', 'stashed\n')
    await stashPush(repo, 's', false)
    const [s] = await getStashes(repo)
    await write(repo, 'a.txt', 'committed\n')
    await commitAll(repo, 'other')
    expect(await stashConflicts(repo, s.sha)).toEqual(['a.txt'])
    expect(await stashApply(repo, s.sha, true)).toBe('conflicts')
    expect((await getStatus(repo)).conflicted.map((f) => f.path)).toEqual(['a.txt'])
    expect(await getStashes(repo)).toHaveLength(1)
  })

  it('predicts no conflict for an unrelated stash', async () => {
    const repo = await setup()
    await write(repo, 'a.txt', 'stashed\n')
    await stashPush(repo, 's', false)
    await write(repo, 'b.txt', 'b\n')
    await commitAll(repo, 'other')
    expect(await stashConflicts(repo, (await getStashes(repo))[0].sha)).toEqual([])
  })

  it('creates a branch from a stash at its base commit', async () => {
    const repo = await setup()
    const base = (await git(repo, ['rev-parse', 'HEAD'])).trim()
    await write(repo, 'a.txt', 'stashed\n')
    await stashPush(repo, 's', false)
    await write(repo, 'b.txt', 'b\n')
    await commitAll(repo, 'moved on')
    await stashBranch(repo, (await getStashes(repo))[0].sha, 'from-stash')
    const st = await getStatus(repo)
    expect(st.branch).toBe('from-stash')
    expect(st.head).toBe(base)
    expect(await readFile(join(repo, 'a.txt'), 'utf8')).toBe('stashed\n')
    expect(await getStashes(repo)).toEqual([])
  })

  it('addresses a stash by SHA after the list shifted', async () => {
    const repo = await setup()
    await write(repo, 'a.txt', 'one\n')
    await stashPush(repo, 'one', false)
    await write(repo, 'a.txt', 'two\n')
    await stashPush(repo, 'two', false)
    const [two, one] = await getStashes(repo)
    expect(one.index).toBe(1)
    await stashDrop(repo, two.sha)
    expect(await stashApply(repo, one.sha, true)).toBe('done')
    expect(await readFile(join(repo, 'a.txt'), 'utf8')).toBe('one\n')
    expect(await getStashes(repo)).toEqual([])
  })

  it('keeps the stash when stash branch cannot apply it', async () => {
    const repo = await setup()
    await write(repo, 'a.txt', 'stashed\n')
    await stashPush(repo, 's', false)
    await write(repo, 'b.txt', 'b\n')
    await commitAll(repo, 'moved on')
    await write(repo, 'a.txt', 'dirty\n') // carried over by the checkout, blocks the apply
    await expect(stashBranch(repo, (await getStashes(repo))[0].sha, 'nb')).rejects.toThrow()
    expect((await getStatus(repo)).branch).toBe('nb')
    expect(await getStashes(repo)).toHaveLength(1)
  })

  it('reports conflicts from stash branch and keeps the stash', async () => {
    const repo = await setup()
    await write(repo, 'a.txt', 'stashed\n')
    await stashPush(repo, 's', false)
    await write(repo, 'b.txt', 'b\n')
    await commitAll(repo, 'moved on')
    await write(repo, 'a.txt', 'staged\n')
    await git(repo, ['add', 'a.txt']) // carried over by the checkout, then clashes with the stash
    expect(await stashBranch(repo, (await getStashes(repo))[0].sha, 'nb')).toBe('conflicts')
    const st = await getStatus(repo)
    expect(st.branch).toBe('nb')
    expect(st.conflicted.map((f) => f.path)).toEqual(['a.txt'])
    expect(await getStashes(repo)).toHaveLength(1)
  })

  it('refuses while an operation is in progress', async () => {
    const repo = await setup()
    await write(repo, 'a.txt', 'stashed\n')
    await stashPush(repo, 's', false)
    await git(repo, ['checkout', '-b', 'feature'])
    await write(repo, 'a.txt', 'feature\n')
    await commitAll(repo, 'f')
    await git(repo, ['checkout', 'main'])
    await write(repo, 'a.txt', 'main\n')
    await commitAll(repo, 'm')
    expect(await integrate(repo, { source: 'feature', target: 'main', mode: 'merge', message: '', autostash: false })).toBe('conflicts')
    await expect(stashApply(repo, (await getStashes(repo))[0].sha, false)).rejects.toThrow('merge is in progress')
    await expect(stashPush(repo, '', false)).rejects.toThrow('merge is in progress')
  })
})
