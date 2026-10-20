import { describe, expect, it } from 'vitest'
import { git } from '../src/main/git'
import { getBlame, getCommitDetails, getCommitDiff, getFileHistory, getTags, resolveCommit } from '../src/main/history'
import { commitAll, lines, makeRepo, write } from './helpers'

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

// old.txt: added, an unrelated commit, edited, then moved to docs/new.txt and edited in the same commit.
async function renamedRepo() {
  const repo = await makeRepo()
  await write(repo, 'old.txt', lines(10))
  await commitAll(repo, 'add old')
  await write(repo, 'other.txt', 'x\n')
  await commitAll(repo, 'unrelated')
  await write(repo, 'old.txt', lines(10, (i) => (i === 2 ? 'two' : `line ${i}`)))
  await commitAll(repo, 'edit old')
  await git(repo, ['rm', '-q', 'old.txt'])
  await write(repo, 'docs/new.txt', lines(10, (i) => (i === 2 ? 'two' : i === 9 ? 'nine' : `line ${i}`)))
  await commitAll(repo, 'move and edit')
  return repo
}

describe('getFileHistory', () => {
  const rows = (h: Awaited<ReturnType<typeof getFileHistory>>) => h.map((c) => [c.subject, c.path, c.oldPath, c.add, c.del])

  it('follows renames, newest first, with the path and the counts in each commit', async () => {
    const repo = await renamedRepo()
    expect(rows(await getFileHistory(repo, 'docs/new.txt', null, true))).toEqual([
      ['move and edit', 'docs/new.txt', 'old.txt', 1, 1],
      ['edit old', 'old.txt', null, 1, 1],
      ['add old', 'old.txt', null, 10, 0]
    ])
  })

  it('stops at the rename without follow and starts at a given revision', async () => {
    const repo = await renamedRepo()
    expect(rows(await getFileHistory(repo, 'docs/new.txt', null, false))).toEqual([['move and edit', 'docs/new.txt', null, 10, 0]])
    expect(rows(await getFileHistory(repo, 'old.txt', 'HEAD~1', true)).map((r) => r[0])).toEqual(['edit old', 'add old'])
  })

  it('reads a file whose name contains the record separator', async () => {
    const repo = await makeRepo()
    await write(repo, 'a\x1eb.txt', '1\n')
    await commitAll(repo, 'one')
    expect(rows(await getFileHistory(repo, 'a\x1eb.txt', null, true))).toEqual([['one', 'a\x1eb.txt', null, 1, 0]])
  })

  it('is empty before the first commit and refuses bad paths and revisions', async () => {
    const repo = await makeRepo()
    expect(await getFileHistory(repo, 'a.txt', null, true)).toEqual([])
    await expect(getFileHistory(repo, '../a.txt', null, true)).rejects.toThrow('outside the repository')
    await write(repo, 'a.txt', '1\n')
    await commitAll(repo, 'one')
    await expect(getFileHistory(repo, 'a.txt', '--all', true)).rejects.toThrow('Invalid revision')
  })
})

describe('getCommitDiff of a renamed file', () => {
  it('shows the rename with its edits when given the old path', async () => {
    const repo = await renamedRepo()
    const d = (await getCommitDiff(repo, 'HEAD', 'docs/new.txt', 'old.txt'))!
    expect([d.oldPath, d.newPath, d.isNew]).toEqual(['old.txt', 'docs/new.txt', false])
    expect(d.hunks.flatMap((h) => h.lines).filter((l) => l.kind !== 'context').map((l) => [l.kind, l.text])).toEqual([
      ['del', 'line 9'],
      ['add', 'nine']
    ])
    expect((await getCommitDiff(repo, 'HEAD', 'docs/new.txt'))!.isNew).toBe(true)
    await expect(getCommitDiff(repo, 'HEAD', 'docs/new.txt', '../old.txt')).rejects.toThrow('outside the repository')
    await expect(getCommitDiff(repo, 'HEAD', 'docs/new.txt', '')).rejects.toThrow('outside the repository')
  })
})

describe('getBlame', () => {
  const shas = (repo: string, ...revs: string[]) => Promise.all(revs.map(async (r) => (await git(repo, ['rev-parse', r])).trim()))

  it('names the commit of each line through the rename, with each commit once', async () => {
    const repo = await renamedRepo()
    const [move, edit, unrelated, add] = await shas(repo, 'HEAD', 'HEAD~1', 'HEAD~2', 'HEAD~3')
    const b = await getBlame(repo, null, 'docs/new.txt')
    expect([b.sha, b.path, b.lines.length, b.lines[1]]).toEqual([move, 'docs/new.txt', 10, 'two'])
    expect(b.chunks).toEqual([
      { sha: add, start: 1, count: 1 },
      { sha: edit, start: 2, count: 1 },
      { sha: add, start: 3, count: 6 },
      { sha: move, start: 9, count: 1 },
      { sha: add, start: 10, count: 1 }
    ])
    expect(b.commits[edit]).toMatchObject({ author: 'Test User', email: 'test@example.com', subject: 'edit old', previous: { sha: unrelated, path: 'old.txt' } })
    expect(b.commits[move].previous).toEqual({ sha: edit, path: 'old.txt' })
    expect(b.commits[add].previous).toBeNull()
  })

  it('blames at a revision and refuses missing and binary files, bad paths and revisions', async () => {
    const repo = await renamedRepo()
    expect((await getBlame(repo, 'HEAD~1', 'old.txt')).lines).toHaveLength(10)
    await expect(getBlame(repo, 'HEAD~1', 'docs/new.txt')).rejects.toThrow('docs/new.txt does not exist in')
    await expect(getBlame(repo, '--all', 'old.txt')).rejects.toThrow('Invalid revision')
    await expect(getBlame(repo, null, '../old.txt')).rejects.toThrow('outside the repository')
    await write(repo, 'bin.dat', 'a\0b\n')
    await commitAll(repo, 'binary')
    await expect(getBlame(repo, null, 'bin.dat')).rejects.toThrow('binary file')
  })
})

describe('getBlame robustness', () => {
  it('ignores a missing blame.ignoreRevsFile, keeps CRLF, refuses too large files and passes other git errors', async () => {
    const repo = await makeRepo()
    await write(repo, 'crlf.txt', 'a\r\nb\r\n')
    await write(repo, 'big.txt', 'x'.repeat(4 * 1024 * 1024 + 1))
    await commitAll(repo, 'files')
    await git(repo, ['config', 'blame.ignoreRevsFile', 'missing.txt'])
    expect((await getBlame(repo, null, 'crlf.txt')).lines).toEqual(['a\r', 'b\r'])
    await expect(getBlame(repo, null, 'big.txt')).rejects.toThrow('too large to blame')
    await expect(getBlame(repo, null, 'nope.txt')).rejects.toThrow('does not exist in')
  })
})
