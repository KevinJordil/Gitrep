import { chmod, mkdir, readFile, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { prepareFixes } from '../src/main/fixes'
import { git } from '../src/main/git'
import { undoState } from '../src/main/journal'
import { getStatus } from '../src/main/repo'
import { redo, undo } from '../src/main/undo'
import type { FixRequest } from '../src/shared/types'
import { commitAll, lines, makeRepo, tempDir, write } from './helpers'

// feature checked out, a.c = line 1..10 committed.
async function setup() {
  const repo = await makeRepo()
  await write(repo, 'a.c', lines(10))
  await write(repo, 'b.c', 'int b;\r\nint c;\r\n')
  await commitAll(repo, 'init')
  await git(repo, ['switch', '-q', '-c', 'feature'])
  return repo
}

const fix = (id: number, line: number, endLine: number, lines: string[], path = 'a.c'): FixRequest => ({ id, path, line, endLine, original: Array.from({ length: endLine - line + 1 }, (_, i) => `line ${line + i}`), lines })
const read = (repo: string, f = 'a.c') => readFile(join(repo, f), 'utf8')

describe('prepareFixes', () => {
  it('writes the fixes as unstaged changes, bottom-up, journaled as one step that undo and redo replay', async () => {
    const repo = await setup()
    const r = await prepareFixes(repo, 'feature', [fix(1, 2, 2, ['line 2 fixed']), fix(2, 7, 8, ['line 7-8 merged']), fix(3, 4, 4, [])])
    expect(r).toEqual({ applied: [1, 3, 2], skipped: [] })
    expect(await read(repo)).toBe(lines(10, (i) => (i === 2 ? 'line 2 fixed' : `line ${i}`)).replace('line 4\n', '').replace('line 7\nline 8\n', 'line 7-8 merged\n'))
    const s = await getStatus(repo)
    expect(s.staged).toEqual([])
    expect(s.unstaged.map((f) => f.path)).toEqual(['a.c'])
    expect(undoState(repo).undo).toBe('Prepare 3 review fixes')
    await undo(repo)
    expect(await read(repo)).toBe(lines(10))
    await redo(repo)
    expect(await read(repo)).toContain('line 7-8 merged')
  })

  it('skips a fix already applied, so preparing twice does not repeat an append', async () => {
    const repo = await setup()
    const append = fix(1, 10, 10, ['line 10', 'added'])
    expect((await prepareFixes(repo, 'feature', [append])).applied).toEqual([1])
    expect((await prepareFixes(repo, 'feature', [append])).skipped).toEqual([{ id: 1, path: 'a.c', reason: 'already applied' }])
    expect((await read(repo)).match(/added/g)).toHaveLength(1)
  })

  it('skips a fix whose lines changed, keeps the other unstaged changes of the file, keeps CRLF line ends', async () => {
    const repo = await setup()
    await write(repo, 'a.c', lines(10, (i) => (i === 5 ? 'line 5 edited by me' : `line ${i}`)))
    const r = await prepareFixes(repo, 'feature', [fix(1, 5, 5, ['x']), fix(2, 9, 9, ['line 9 fixed']), { id: 3, path: 'b.c', line: 2, endLine: 2, original: ['int c;'], lines: ['long c;'] }])
    expect(r).toEqual({ applied: [2, 3], skipped: [{ id: 1, path: 'a.c', reason: 'the lines changed since the review' }] })
    const a = await read(repo)
    expect(a).toContain('line 5 edited by me')
    expect(a).toContain('line 9 fixed')
    expect(await read(repo, 'b.c')).toBe('int b;\r\nlong c;\r\n')
    await undo(repo)
    expect(await read(repo)).toBe(lines(10, (i) => (i === 5 ? 'line 5 edited by me' : `line ${i}`)))
    expect(await read(repo, 'b.c')).toBe('int b;\r\nint c;\r\n')
  })

  it('accepts originals that keep their carriage return', async () => {
    const repo = await setup()
    const r = await prepareFixes(repo, 'feature', [{ id: 1, path: 'b.c', line: 1, endLine: 2, original: ['int b;\r', 'int c;\r'], lines: ['int d;'] }])
    expect(r.applied).toEqual([1])
    expect(await read(repo, 'b.c')).toBe('int d;\r\n')
  })

  it('skips overlapping fixes, missing files and no-op fixes', async () => {
    const repo = await setup()
    const r = await prepareFixes(repo, 'feature', [fix(1, 3, 5, ['a']), fix(2, 5, 6, ['b']), fix(3, 1, 1, ['x'], 'gone.c'), fix(4, 8, 8, ['line 8'])])
    expect(r.applied).toEqual([2])
    expect(r.skipped).toEqual([
      { id: 4, path: 'a.c', reason: 'nothing to change' },
      { id: 1, path: 'a.c', reason: 'overlaps another fix' },
      { id: 3, path: 'gone.c', reason: 'no longer exists' }
    ])
  })

  it('refuses when the branch is not checked out, and bad input', async () => {
    const repo = await setup()
    await expect(prepareFixes(repo, 'main', [fix(1, 2, 2, ['x'])])).rejects.toThrow('Check out main first')
    await expect(prepareFixes(repo, 'feature', [fix(1, 2, 2, ['x'], '../out.c')])).rejects.toThrow('Path outside the repository')
    await expect(prepareFixes(repo, 'feature', [{ ...fix(1, 2, 3, ['x']), original: ['one'] }])).rejects.toThrow('Invalid fix')
    await expect(prepareFixes(repo, 'feature', [])).rejects.toThrow('No fixes to prepare')
    expect(await read(repo)).toBe(lines(10))
  })

  it('skips symbolic links and never writes through them', async () => {
    const repo = await setup()
    const out = await tempDir()
    await write(out, 'outside.c', lines(10))
    await symlink(join(out, 'outside.c'), join(repo, 'link.c'))
    await symlink(out, join(repo, 'dirlink'))
    const r = await prepareFixes(repo, 'feature', [fix(1, 2, 2, ['x'], 'link.c'), fix(2, 2, 2, ['x'], 'dirlink/outside.c')])
    expect(r).toEqual({ applied: [], skipped: [{ id: 1, path: 'link.c', reason: 'is a symbolic link' }, { id: 2, path: 'dirlink/outside.c', reason: 'is a symbolic link' }] })
    expect(await readFile(join(out, 'outside.c'), 'utf8')).toBe(lines(10))
    expect(undoState(repo).undo).toBeNull()
  })

  it('skips files that are not UTF-8 text', async () => {
    const repo = await setup()
    const latin = Buffer.from('line 1\nline 2 \xe9\nline 3\n', 'latin1')
    await writeFile(join(repo, 'l.c'), latin)
    await writeFile(join(repo, 'n.c'), Buffer.from('line 1\0\nline 2\n'))
    const r = await prepareFixes(repo, 'feature', [fix(1, 1, 1, ['x'], 'l.c'), fix(2, 2, 2, ['x'], 'n.c')])
    expect(r.applied).toEqual([])
    expect(r.skipped.map((s) => s.reason)).toEqual(['not a UTF-8 text file', 'not a UTF-8 text file'])
    expect(await readFile(join(repo, 'l.c'))).toEqual(latin)
  })

  it('restores the written files and journals nothing when a write fails', async () => {
    const repo = await setup()
    await write(repo, 'sub/z.c', lines(10))
    await commitAll(repo, 'sub')
    await chmod(join(repo, 'sub'), 0o555)
    try {
      await expect(prepareFixes(repo, 'feature', [fix(1, 2, 2, ['x']), fix(2, 2, 2, ['y'], 'sub/z.c')])).rejects.toThrow()
    } finally {
      await chmod(join(repo, 'sub'), 0o755)
    }
    expect(await read(repo)).toBe(lines(10))
    expect(await read(repo, 'sub/z.c')).toBe(lines(10))
    expect(undoState(repo).undo).toBeNull()
    expect((await getStatus(repo)).unstaged).toEqual([])
  })

  it('caps line length, total size and file size', async () => {
    const repo = await setup()
    await expect(prepareFixes(repo, 'feature', [fix(1, 2, 2, ['x'.repeat(2001)])])).rejects.toThrow('Invalid fix')
    const many = Array.from({ length: 30 }, (_, i) => fix(i + 1, 1, 1, ['y'.repeat(2000)], `f${i}.c`))
    await expect(prepareFixes(repo, 'feature', many.map((f) => ({ ...f, lines: Array(100).fill('y'.repeat(1900)) })))).rejects.toThrow('Too much')
    await writeFile(join(repo, 'big.c'), 'line 1\n' + 'x'.repeat(2 * 1024 * 1024))
    const r = await prepareFixes(repo, 'feature', [fix(1, 1, 1, ['z'], 'big.c')])
    expect(r.skipped).toEqual([{ id: 1, path: 'big.c', reason: 'too large' }])
  })

  it('treats ./a.c and a.c as one file, accepts spaces, rejects dashes and carriage returns', async () => {
    const repo = await setup()
    await write(repo, 'my dir/my file.c', lines(3))
    await commitAll(repo, 'space')
    const r = await prepareFixes(repo, 'feature', [fix(1, 2, 2, ['A'], './a.c'), fix(2, 2, 2, ['B']), fix(3, 2, 2, ['S'], 'my dir/my file.c')])
    expect(r.applied).toEqual([1, 3])
    expect(r.skipped).toEqual([{ id: 2, path: 'a.c', reason: 'overlaps another fix' }])
    await undo(repo)
    expect(await read(repo)).toBe(lines(10))
    expect(await read(repo, 'my dir/my file.c')).toBe(lines(3))
    await expect(prepareFixes(repo, 'feature', [fix(1, 2, 2, ['x'], '-a.c')])).rejects.toThrow('unusual file name')
    await expect(prepareFixes(repo, 'feature', [fix(1, 2, 2, ['x'], 'a\r.c')])).rejects.toThrow('unusual file name')
  })

  it('does not see a phantom line after the final newline', async () => {
    const repo = await setup()
    const r = await prepareFixes(repo, 'feature', [{ id: 1, path: 'a.c', line: 11, endLine: 11, original: [''], lines: ['extra'] }])
    expect(r.applied).toEqual([])
    expect(r.skipped).toHaveLength(1)
    expect(await read(repo)).toBe(lines(10))
  })

  it('handles files without a trailing newline and fixes deleting every line', async () => {
    const repo = await setup()
    await write(repo, 'n.c', 'line 1\nline 2')
    await commitAll(repo, 'n')
    const r = await prepareFixes(repo, 'feature', [fix(1, 2, 2, ['last']), fix(2, 1, 1, ['first'], 'n.c'), fix(3, 1, 10, [])].map((f, i) => (i === 0 ? { ...f, path: 'n.c' } : f)))
    expect(r.applied.sort()).toEqual([1, 2, 3])
    expect(await read(repo, 'n.c')).toBe('first\nlast')
    expect(await read(repo)).toBe('')
    await undo(repo)
    expect(await read(repo)).toBe(lines(10))
    expect(await read(repo, 'n.c')).toBe('line 1\nline 2')
  })

  it('fails Undo without corrupting the file when the user edited it since', async () => {
    const repo = await setup()
    await prepareFixes(repo, 'feature', [fix(1, 2, 2, ['fixed'])])
    const edited = (await read(repo)).replace('fixed', 'fixed by hand')
    await write(repo, 'a.c', edited)
    await expect(undo(repo)).rejects.toThrow()
    expect(await read(repo)).toBe(edited)
  })
})
