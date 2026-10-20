import { describe, expect, it } from 'vitest'
import { parseBranches, parseCommitFiles, parseLog, parseNumstat, parseStatus, parseTags } from '../src/main/parse'

const nul = (...parts: string[]) => parts.join('\0') + '\0'

describe('parseStatus', () => {
  it('reads branch headers', () => {
    const s = parseStatus(nul('# branch.oid 1234abcd', '# branch.head main', '# branch.upstream origin/main', '# branch.ab +2 -3'))
    expect(s).toMatchObject({ head: '1234abcd', branch: 'main', upstream: 'origin/main', ahead: 2, behind: 3 })
  })

  it('handles initial commit and detached HEAD', () => {
    expect(parseStatus(nul('# branch.oid (initial)', '# branch.head main')).head).toBeNull()
    expect(parseStatus(nul('# branch.oid abc', '# branch.head (detached)')).branch).toBeNull()
  })

  it('splits staged, unstaged, untracked and conflicted entries', () => {
    const s = parseStatus(
      nul(
        '# branch.oid abc',
        '# branch.head main',
        '1 M. N... 100644 100644 100644 aaa bbb staged.txt',
        '1 .M N... 100644 100644 100644 aaa aaa with space.txt',
        '1 MM N... 100644 100644 100644 aaa bbb both.txt',
        '2 R. N... 100644 100644 100644 aaa aaa R100 new name.txt',
        'old name.txt',
        'u UU N... 100644 100644 100644 100644 aaa bbb ccc conflict.txt',
        '? untracked dir/'
      )
    )
    expect(s.staged).toEqual([
      { path: 'staged.txt', status: 'M' },
      { path: 'both.txt', status: 'M' },
      { path: 'new name.txt', origPath: 'old name.txt', status: 'R' }
    ])
    expect(s.unstaged).toEqual([
      { path: 'with space.txt', status: 'M' },
      { path: 'both.txt', status: 'M' },
      { path: 'untracked dir/', status: '?' }
    ])
    expect(s.conflicted).toEqual([{ path: 'conflict.txt', status: 'U' }])
  })
})

describe('parseNumstat', () => {
  it('maps paths to added/deleted counts, binary as 0', () => {
    expect(parseNumstat('3\t1\ta.txt\0-\t-\timg.png\0')).toEqual({ 'a.txt': { add: 3, del: 1 }, 'img.png': { add: 0, del: 0 } })
  })
})

describe('parseLog', () => {
  it('parses records separated by \\x1e', () => {
    const out =
      ['a1', 'p1 p2', 'Ann', 'ann@x', '1700000000', '1700000500', 'HEAD -> main, origin/main, tag: v1', 'Merge things'].join('\x1f') +
      '\x1e\n' +
      ['p1', '', 'Bob', 'bob@x', '1690000000', '1690000000', '', 'first'].join('\x1f') +
      '\x1e\n'
    expect(parseLog(out)).toEqual([
      { sha: 'a1', parents: ['p1', 'p2'], author: 'Ann', email: 'ann@x', date: 1700000000, committed: 1700000500, refs: ['HEAD -> main', 'origin/main', 'tag: v1'], subject: 'Merge things' },
      { sha: 'p1', parents: [], author: 'Bob', email: 'bob@x', date: 1690000000, committed: 1690000000, refs: [], subject: 'first' }
    ])
  })
})

describe('parseBranches', () => {
  it('parses local and remote refs, skips remote HEAD symrefs', () => {
    const out = [
      ['refs/heads/feature/x', ' ', 'origin/feature/x', '[ahead 2, behind 1]', 'f1', '1700000100'],
      ['refs/heads/main', '*', 'origin/main', '', 'm1', '1700000200'],
      ['refs/remotes/origin/HEAD', ' ', '', '', 'm1', '1700000200'],
      ['refs/remotes/origin/main', ' ', '', '', 'm1', '1700000200']
    ]
      .map((f) => f.join('\x1f'))
      .join('\n')
    expect(parseBranches(out + '\n')).toEqual([
      { name: 'feature/x', remote: false, current: false, upstream: 'origin/feature/x', ahead: 2, behind: 1, sha: 'f1', date: 1700000100 },
      { name: 'main', remote: false, current: true, upstream: 'origin/main', ahead: 0, behind: 0, sha: 'm1', date: 1700000200 },
      { name: 'origin/main', remote: true, current: false, upstream: null, ahead: 0, behind: 0, sha: 'm1', date: 1700000200 }
    ])
  })
})

describe('parseTags', () => {
  it('uses the peeled commit of annotated tags', () => {
    expect(parseTags('v2\x1ftagobj\x1fcommit2\nv1\x1fcommit1\x1f\n')).toEqual([
      { name: 'v2', sha: 'commit2' },
      { name: 'v1', sha: 'commit1' }
    ])
  })
})

describe('parseCommitFiles', () => {
  it('joins raw statuses with numstat counts, binary as 0', () => {
    const out = [':100644 100644 aaa bbb M', 'src/a b.c', ':000000 100644 000 ccc A', 'img.png', '3\t1\tsrc/a b.c', '-\t-\timg.png', ''].join('\0')
    expect(parseCommitFiles(out)).toEqual([
      { path: 'src/a b.c', status: 'M', add: 3, del: 1 },
      { path: 'img.png', status: 'A', add: 0, del: 0 }
    ])
  })
})
