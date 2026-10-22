import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { git } from '../src/main/git'
import { undoState } from '../src/main/journal'
import { dropCommit } from '../src/main/rebase'
import { undo } from '../src/main/undo'
import { commitAll, makeRepo, tempDir, write } from './helpers'

const rev = async (repo: string, r = 'HEAD') => (await git(repo, ['rev-parse', r])).trim()
const subjects = async (repo: string) => (await git(repo, ['log', '--format=%s'])).trim().split('\n')

// main: base, c1 (a.txt), c2 (b.txt), c3 (c.txt). Returns the shas, oldest first.
async function setup() {
  const repo = await makeRepo()
  await write(repo, 'base.txt', 'base\n')
  await commitAll(repo, 'base')
  for (const f of ['a', 'b', 'c']) {
    await write(repo, `${f}.txt`, `${f}\n`)
    await commitAll(repo, `add ${f}`)
  }
  const shas = (await git(repo, ['rev-list', '--reverse', 'HEAD'])).trim().split('\n')
  return { repo, shas }
}

describe('dropCommit', () => {
  it('drops a middle commit and keeps the later ones with their content', async () => {
    const { repo, shas } = await setup()
    await dropCommit(repo, { sha: shas[2], autostash: false })
    expect(await subjects(repo)).toEqual(['add c', 'add a', 'base'])
    expect(await readFile(join(repo, 'c.txt'), 'utf8')).toBe('c\n')
    expect(await git(repo, ['ls-files'])).not.toContain('b.txt')
  })

  it('drops HEAD', async () => {
    const { repo, shas } = await setup()
    await dropCommit(repo, { sha: shas[3], autostash: false })
    expect(await rev(repo)).toBe(shas[2])
    expect(await git(repo, ['status', '--porcelain'])).toBe('')
  })

  it('undo restores the branch exactly', async () => {
    const { repo, shas } = await setup()
    await dropCommit(repo, { sha: shas[1], autostash: false })
    expect(await rev(repo)).not.toBe(shas[3])
    expect(undoState(repo).undo).toBe(`Drop ${shas[1].slice(0, 7)}`)
    await undo(repo)
    expect(await rev(repo)).toBe(shas[3])
    expect(await git(repo, ['status', '--porcelain'])).toBe('')
  })

  it('refuses a pushed commit, even when only an older one is dropped', async () => {
    const { repo, shas } = await setup()
    const remote = await tempDir()
    await git(remote, ['init', '-q', '--bare'])
    await git(repo, ['remote', 'add', 'origin', remote])
    await git(repo, ['push', '-q', 'origin', `${shas[2]}:refs/heads/main`])
    await git(repo, ['fetch', '-q', 'origin'])
    await expect(dropCommit(repo, { sha: shas[1], autostash: false })).rejects.toThrow(/pushed/)
    await dropCommit(repo, { sha: shas[3], autostash: false })
    expect(await rev(repo)).toBe(shas[2])
  })

  it('refuses a merge commit', async () => {
    const { repo } = await setup()
    await git(repo, ['switch', '-q', '-c', 'side', 'HEAD~2'])
    await write(repo, 's.txt', 's\n')
    await commitAll(repo, 'side')
    await git(repo, ['switch', '-q', 'main'])
    await git(repo, ['merge', '-q', '--no-ff', '-m', 'merge side', 'side'])
    await expect(dropCommit(repo, { sha: await rev(repo), autostash: false })).rejects.toThrow(/Merge commits/)
  })

  it('refuses a commit that is not on the checked-out branch', async () => {
    const { repo } = await setup()
    await git(repo, ['switch', '-q', '-c', 'other', 'HEAD~2'])
    await write(repo, 'o.txt', 'o\n')
    await commitAll(repo, 'other')
    const other = await rev(repo)
    await git(repo, ['switch', '-q', 'main'])
    await expect(dropCommit(repo, { sha: other, autostash: false })).rejects.toThrow(/current branch/)
  })

  it('refuses the root commit', async () => {
    const { repo, shas } = await setup()
    await expect(dropCommit(repo, { sha: shas[0], autostash: false })).rejects.toThrow(/first commit/)
  })

  it('refuses local changes without autostash, stashes them with it', async () => {
    const { repo, shas } = await setup()
    await write(repo, 'a.txt', 'changed\n')
    await expect(dropCommit(repo, { sha: shas[2], autostash: false })).rejects.toThrow()
    await dropCommit(repo, { sha: shas[2], autostash: true })
    expect(await readFile(join(repo, 'a.txt'), 'utf8')).toBe('changed\n')
    expect(await subjects(repo)).toEqual(['add c', 'add a', 'base'])
  })
})
