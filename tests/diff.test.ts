import { describe, expect, it } from 'vitest'
import { buildPatch, parseDiff } from '../src/main/diff'
import { git } from '../src/main/git'
import { makeRepo, write } from './helpers'

const MODIFIED = [
  'diff --git a/a b.txt b/a b.txt',
  'index 0ff3bbb..d1810ac 100644',
  '--- a/a b.txt\t',
  '+++ b/a b.txt\t',
  '@@ -1,4 +1,4 @@ ctx',
  ' 1',
  '-2',
  '+two',
  ' 3',
  ' 4',
  '@@ -10,2 +10,3 @@',
  ' 10',
  '+10.5',
  ' 11',
  ''
].join('\n')

describe('parseDiff', () => {
  it('parses headers, hunks and line numbers; strips the trailing tab of paths with spaces', () => {
    const [f] = parseDiff(MODIFIED)
    expect(f.oldPath).toBe('a b.txt')
    expect(f.newPath).toBe('a b.txt')
    expect(f.headerLines).toHaveLength(4)
    expect(f.hunks).toHaveLength(2)
    expect(f.hunks[0]).toMatchObject({ header: '@@ -1,4 +1,4 @@ ctx', oldStart: 1, oldLines: 4, newStart: 1, newLines: 4 })
    expect(f.hunks[0].lines).toEqual([
      { kind: 'context', text: '1', oldNo: 1, newNo: 1 },
      { kind: 'del', text: '2', oldNo: 2, newNo: null },
      { kind: 'add', text: 'two', oldNo: null, newNo: 2 },
      { kind: 'context', text: '3', oldNo: 3, newNo: 3 },
      { kind: 'context', text: '4', oldNo: 4, newNo: 4 }
    ])
    expect(f.hunks[1].lines[1]).toEqual({ kind: 'add', text: '10.5', oldNo: null, newNo: 11 })
  })

  it('flags new, deleted and binary files and the no-newline marker', () => {
    const text = [
      'diff --git a/n.txt b/n.txt',
      'new file mode 100644',
      'index 0000000..3e75765',
      '--- /dev/null',
      '+++ b/n.txt',
      '@@ -0,0 +1 @@',
      '+new',
      '\\ No newline at end of file',
      'diff --git a/d.txt b/d.txt',
      'deleted file mode 100644',
      '--- a/d.txt',
      '+++ /dev/null',
      '@@ -1 +0,0 @@',
      '-gone',
      'diff --git a/img.png b/img.png',
      'index 1..2 100644',
      'Binary files a/img.png and b/img.png differ',
      ''
    ].join('\n')
    const [n, d, b] = parseDiff(text)
    expect(n).toMatchObject({ newPath: 'n.txt', isNew: true, isDeleted: false, binary: false })
    expect(n.hunks[0].lines[0]).toEqual({ kind: 'add', text: 'new', oldNo: null, newNo: 1, noNewline: true })
    expect(d).toMatchObject({ oldPath: 'd.txt', isDeleted: true })
    expect(b).toMatchObject({ newPath: 'img.png', binary: true, hunks: [] })
  })

  it('returns an empty list for empty output', () => {
    expect(parseDiff('')).toEqual([])
  })
})

describe('buildPatch', () => {
  const [file] = parseDiff(MODIFIED)
  const header = ['diff --git a/a b.txt b/a b.txt', 'index 0ff3bbb..d1810ac 100644', '--- a/a b.txt\t', '+++ b/a b.txt\t']

  it('keeps the whole hunk when selected is null', () => {
    expect(buildPatch(file, 0, null, false)).toBe([...header, '@@ -1,4 +1,4 @@', ' 1', '-2', '+two', ' 3', ' 4', ''].join('\n'))
  })

  it('forward: unselected deletions become context, unselected additions are dropped', () => {
    expect(buildPatch(file, 0, [2], false)).toBe([...header, '@@ -1,4 +1,5 @@', ' 1', ' 2', '+two', ' 3', ' 4', ''].join('\n'))
  })

  it('reverse: unselected additions become context, unselected deletions are dropped', () => {
    expect(buildPatch(file, 0, [1], true)).toBe([...header, '@@ -1,5 +1,4 @@', ' 1', '-2', ' two', ' 3', ' 4', ''].join('\n'))
  })

  it('refuses a selection without any changed line', () => {
    expect(() => buildPatch(file, 0, [0], false)).toThrow('No changed line')
  })

  it('refuses an unknown hunk', () => {
    expect(() => buildPatch(file, 5, null, false)).toThrow('not found')
  })

  it('keeps the new file mode line so a staged new file can be unstaged', () => {
    const [n] = parseDiff(
      ['diff --git a/n.txt b/n.txt', 'new file mode 100644', 'index 0000000..3e75765', '--- /dev/null', '+++ b/n.txt', '@@ -0,0 +1 @@', '+new', ''].join('\n')
    )
    const patch = buildPatch(n, 0, null, true)
    expect(patch).toContain('new file mode 100644')
    expect(patch).toContain('+new')
  })

  it('keeps the deleted file mode line so a deletion can be discarded', () => {
    const [d] = parseDiff(
      ['diff --git a/d.txt b/d.txt', 'deleted file mode 100644', 'index 1..0000000', '--- a/d.txt', '+++ /dev/null', '@@ -1 +0,0 @@', '-gone', ''].join('\n')
    )
    const patch = buildPatch(d, 0, null, true)
    expect(patch).toContain('deleted file mode 100644')
    expect(patch).toContain('-gone')
  })

  it('builds a selection spanning two changes in one hunk', () => {
    const [t] = parseDiff(
      ['diff --git a/t.txt b/t.txt', '--- a/t.txt', '+++ b/t.txt', '@@ -1,3 +1,3 @@', '-a', '+A', ' mid', '-b', '+B', ''].join('\n')
    )
    // selects '-a' and '+B': '+A' is dropped and '-b' becomes context
    expect(buildPatch(t, 0, [0, 4], false)).toBe(
      ['diff --git a/t.txt b/t.txt', '--- a/t.txt', '+++ b/t.txt', '@@ -1,3 +1,3 @@', '-a', ' mid', ' b', '+B', ''].join('\n')
    )
  })
})

describe('buildPatch with real git', () => {
  it('unstages a staged new file without corrupting the index', async () => {
    const repo = await makeRepo()
    await write(repo, 'new.txt', 'hello\n')
    await git(repo, ['add', 'new.txt'])
    const [file] = parseDiff(await git(repo, ['diff', '--cached', '--no-renames']))
    await git(repo, ['apply', '--cached', '--recount', '-R', '-'], { input: buildPatch(file, 0, null, true) })
    const status = await git(repo, ['status', '--porcelain'])
    expect(status).toBe('?? new.txt\n')
    expect(status).not.toContain('dev/null')
  })
})
