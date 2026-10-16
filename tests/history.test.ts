import { describe, expect, it } from 'vitest'
import { git } from '../src/main/git'
import { getCommitDetails, getCommitDiff, getTags, resolveCommit } from '../src/main/history'
import { commitAll, makeRepo, write } from './helpers'

describe('resolveCommit', () => {
  it('returns the full SHA and rejects options and unknown revisions', async () => {
    const repo = await makeRepo()
    await write(repo, 'a', '1\n')
    await commitAll(repo, 'one')
    const head = (await git(repo, ['rev-parse', 'HEAD'])).trim()
    expect(await resolveCommit(repo, head.slice(0, 7))).toBe(head)
    expect(await resolveCommit(repo, 'main')).toBe(head)
    await expect(resolveCommit(repo, '--all')).rejects.toThrow('Invalid revision')
    await expect(resolveCommit(repo, 'nope')).rejects.toThrow('Unknown commit')
  })
})

describe('getTags', () => {
  it('lists lightweight and annotated tags with their commit', async () => {
    const repo = await makeRepo()
    await write(repo, 'a', '1\n')
    await commitAll(repo, 'one')
    const head = (await git(repo, ['rev-parse', 'HEAD'])).trim()
    await git(repo, ['tag', 'v1'])
    await git(repo, ['tag', '-a', 'v2', '-m', 'release'])
    expect((await getTags(repo)).sort((a, b) => a.name.localeCompare(b.name))).toEqual([
      { name: 'v1', sha: head },
      { name: 'v2', sha: head }
    ])
  })
})

describe('getCommitDetails and getCommitDiff', () => {
  async function setup() {
    const repo = await makeRepo()
    await write(repo, 'a.txt', 'one\n')
    await commitAll(repo, 'root')
    await git(repo, ['switch', '-q', '-c', 'side'])
    await write(repo, 'b.txt', 'b\n')
    await commitAll(repo, 'side work')
    await git(repo, ['switch', '-q', 'main'])
    await write(repo, 'a.txt', 'one\ntwo\n')
    await git(repo, ['add', '-A'])
    await git(repo, ['commit', '-q', '-m', 'add two', '-m', 'Body line.'])
    await git(repo, ['merge', '-q', '--no-ff', '-m', 'merge side', 'side'])
    return repo
  }

  it('returns message, body and changed files with counts', async () => {
    const repo = await setup()
    const d = await getCommitDetails(repo, 'HEAD~1')
    expect(d.subject).toBe('add two')
    expect(d.body).toBe('Body line.')
    expect(d.author).toBe('Test User')
    expect(d.files).toEqual([{ path: 'a.txt', status: 'M', add: 1, del: 0 }])
  })

  it('shows a merge against its first parent and a root commit as additions', async () => {
    const repo = await setup()
    const merge = await getCommitDetails(repo, 'HEAD')
    expect(merge.parents).toHaveLength(2)
    expect(merge.refs).toEqual(['HEAD -> main'])
    expect(merge.files).toEqual([{ path: 'b.txt', status: 'A', add: 1, del: 0 }])
    const root = await getCommitDetails(repo, 'HEAD~2')
    expect(root.files).toEqual([{ path: 'a.txt', status: 'A', add: 1, del: 0 }])
  })

  it('returns the diff of one file in a commit, null for an untouched file', async () => {
    const repo = await setup()
    const diff = (await getCommitDiff(repo, 'HEAD~1', 'a.txt'))!
    expect(diff.hunks[0].lines.map((l) => [l.kind, l.text])).toEqual([
      ['context', 'one'],
      ['add', 'two']
    ])
    expect(await getCommitDiff(repo, 'HEAD~1', 'b.txt')).toBeNull()
    expect((await getCommitDiff(repo, 'HEAD~2', 'a.txt'))!.isNew).toBe(true)
  })
})
