import { describe, expect, it } from 'vitest'
import { parseBlame, parseBranches, parseCommitFiles, parseFileLog, parseLog, parseNumstat, parseStatus, parseTags } from '../src/main/parse'

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

describe('parseFileLog', () => {
  // One commit: the log fields, then (except for a merge) its numstat entry for the file.
  const rec = (sha: string, subject: string, numstat: string[]) =>
    `\x1e${sha.padEnd(40, '0')}\x1fp1\x1fAda\x1fada@example.com\x1f100\x1f200\x1f\x1f${subject}\0` + (numstat.length ? `\n${numstat.join('\0')}\0` : '')

  it('reads the path, the rename and the counts of each commit, newest first', () => {
    const out = rec('c4', 'edit', ['2\t1\tsrc/new name.c']) + rec('c3', 'rename', ['0\t0\t', 'old.c', 'src/new name.c']) + rec('d2', 'merge', []) + rec('c1', 'add', ['-\t-\told.c'])
    expect(parseFileLog(out, 'src/new name.c').map((c) => [c.sha.slice(0, 2), c.subject, c.path, c.oldPath, c.add, c.del])).toEqual([
      ['c4', 'edit', 'src/new name.c', null, 2, 1],
      ['c3', 'rename', 'src/new name.c', 'old.c', 0, 0],
      ['d2', 'merge', 'old.c', null, 0, 0],
      ['c1', 'add', 'old.c', null, 0, 0]
    ])
    expect(parseFileLog(out, 'x')[0]).toMatchObject({ parents: ['p1'], author: 'Ada', email: 'ada@example.com', date: 100, committed: 200, refs: [] })
    expect(parseFileLog('', 'x')).toEqual([])
  })

  const sha = 'a'.repeat(40)
  it('keeps a record separator inside a file name or a subject and never emits a bogus commit', () => {
    const f = (subject: string, name: string) => `\x1e${sha}\x1fp1\x1fAda\x1fada@example.com\x1f100\x1f200\x1f\x1f${subject}\0\n1\t0\t${name}\0`
    expect(parseFileLog(f('s', 'a\x1eb.txt') + f('x\x1ey', 'c.txt'), 'a\x1eb.txt').map((c) => [c.subject, c.path])).toEqual([
      ['s', 'a\x1eb.txt'],
      ['x\x1ey', 'c.txt']
    ])
    expect(parseFileLog('\x1ejunk\0\n1\t0\tz\0', 'z')).toEqual([])
  })
})

describe('parseBlame', () => {
  const a = 'a'.repeat(40)
  const b = 'b'.repeat(40)
  const head = (n: number) => [`${a} 1 1 ${n}`, 'author Ada', 'author-mail <ada@example.com>', 'author-time 100', 'summary s', 'filename f']

  it('reads every line with its commit, each commit once, and merges adjacent lines into chunks', () => {
    const out = [
      `${a} 1 1 2`, 'author Ada', 'author-mail <ada@example.com>', 'author-time 100', 'author-tz +0000', 'committer Ada', 'summary first', 'boundary', 'filename old.c', '\tone',
      `${a} 2 2`, '\ttwo',
      `${b} 3 3 1`, 'author Bob', 'author-mail <bob@example.com>', 'author-time 200', 'summary second line', `previous ${a} old name.c`, 'filename new.c', '\t\tthree',
      `${a} 3 4 1`, '\tfour',
      ''
    ].join('\n')
    expect(parseBlame(out)).toEqual({
      lines: ['one', 'two', '\tthree', 'four'],
      chunks: [
        { sha: a, start: 1, count: 2 },
        { sha: b, start: 3, count: 1 },
        { sha: a, start: 4, count: 1 }
      ],
      commits: {
        [a]: { sha: a, author: 'Ada', email: 'ada@example.com', date: 100, subject: 'first', previous: null },
        [b]: { sha: b, author: 'Bob', email: 'bob@example.com', date: 200, subject: 'second line', previous: { sha: a, path: 'old name.c' } }
      }
    })
    expect(parseBlame('')).toEqual({ lines: [], chunks: [], commits: {} })
  })

  it('keeps control characters and header-looking text in a line as content', () => {
    const out = [...head(2), '\tx\x1b[31m\x07\r', `${a} 2 2`, `\t${b} 9 9 1`, ''].join('\n')
    expect(parseBlame(out).lines).toEqual(['x\x1b[31m\x07\r', `${b} 9 9 1`])
  })

  it('skips unknown header fields', () => {
    const out = [`${a} 1 1 1`, 'author Ada', 'ignored', 'unblamable', 'future-field x', 'summary s', '\tx', ''].join('\n')
    expect(parseBlame(out)).toMatchObject({ lines: ['x'], commits: { [a]: { author: 'Ada', subject: 's' } } })
  })

  it('refuses malformed output', () => {
    const bad = (s: string) => expect(() => parseBlame(s)).toThrow('Unexpected blame output')
    bad('\tno header\n')
    bad(`${'z'.repeat(40)} 1 1 1\n\tx\n`)
    bad(`${'a'.repeat(7)} 1 1 1\n\tx\n`)
    bad(`${a} 1 1 1\nprevious nothex path\n\tx\n`)
    bad(`${a} 1 1 1\nauthor-time soon\n\tx\n`)
    bad(`${a} 1 1 2\n\tx\n`) // announced two lines, got one
  })
})
