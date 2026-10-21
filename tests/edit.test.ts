import { chmod, mkdir, readdir, readFile, stat, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { readWorkingFile, saveWorkingFile, workingFileReason } from '../src/main/edit'
import { getHeadDiff } from '../src/main/repo'
import { git } from '../src/main/git'
import { undoState } from '../src/main/journal'
import { redo, undo } from '../src/main/undo'
import { commitAll, makeRepo, tempDir, write } from './helpers'

async function setup() {
  const repo = await makeRepo()
  await write(repo, 'a.txt', 'one\ntwo\n')
  await commitAll(repo, 'init')
  return repo
}
const disk = (repo: string, f = 'a.txt') => readFile(join(repo, f), 'utf8')

describe('readWorkingFile', () => {
  it('reads a normal file and an untracked one', async () => {
    const repo = await setup()
    await write(repo, 'new.txt', 'fresh')
    expect(await readWorkingFile(repo, 'a.txt')).toEqual({ text: 'one\ntwo\n' })
    expect(await readWorkingFile(repo, 'new.txt')).toEqual({ text: 'fresh' })
  })

  it('refuses symlinks, also through a symlinked directory', async () => {
    const repo = await setup()
    const out = await tempDir()
    await write(out, 'x.txt', 'secret')
    await symlink(join(repo, 'a.txt'), join(repo, 'link.txt'))
    await symlink(out, join(repo, 'dir'))
    expect(await readWorkingFile(repo, 'link.txt')).toHaveProperty('reason')
    expect(await readWorkingFile(repo, 'dir/x.txt')).toHaveProperty('reason')
  })

  it('refuses non-UTF-8, NUL, too large, missing and outside paths', async () => {
    const repo = await setup()
    await writeFile(join(repo, 'bad.bin'), Buffer.from([0x66, 0xff, 0x6f]))
    await writeFile(join(repo, 'nul.bin'), Buffer.from('a\0b'))
    await writeFile(join(repo, 'big.txt'), 'x'.repeat(2 * 1024 * 1024 + 1))
    for (const f of ['bad.bin', 'nul.bin', 'big.txt', 'gone.txt']) expect(await readWorkingFile(repo, f)).toHaveProperty('reason')
    await expect(readWorkingFile(repo, '../x')).rejects.toThrow('outside')
  })

  it('refuses a conflicted file', async () => {
    const repo = await setup()
    await git(repo, ['switch', '-q', '-c', 'other'])
    await write(repo, 'a.txt', 'other\ntwo\n')
    await commitAll(repo, 'other')
    await git(repo, ['switch', '-q', 'main'])
    await write(repo, 'a.txt', 'main\ntwo\n')
    await commitAll(repo, 'main')
    await git(repo, ['merge', 'other'], { okCodes: [1] })
    expect(await readWorkingFile(repo, 'a.txt')).toEqual({ reason: 'Use the conflict editor for this file.' })
    await expect(saveWorkingFile(repo, 'a.txt', 'x', await disk(repo))).rejects.toThrow('conflict editor')
  })
})

describe('saveWorkingFile', () => {
  it('writes exactly what was typed (CRLF, no final newline) and keeps the mode', async () => {
    const repo = await setup()
    await chmod(join(repo, 'a.txt'), 0o755)
    await saveWorkingFile(repo, 'a.txt', 'one\r\nthree', 'one\ntwo\n')
    expect(await disk(repo)).toBe('one\r\nthree')
    expect((await stat(join(repo, 'a.txt'))).mode & 0o777).toBe(0o755)
  })

  it('refuses when the disk changed since the editor opened it', async () => {
    const repo = await setup()
    await write(repo, 'a.txt', 'changed\n')
    await expect(saveWorkingFile(repo, 'a.txt', 'mine', 'one\ntwo\n')).rejects.toThrow('The file changed on disk since you opened it.')
    expect(await disk(repo)).toBe('changed\n')
  })

  it('refuses a symlink, invalid text and an outside path', async () => {
    const repo = await setup()
    await symlink(join(repo, 'a.txt'), join(repo, 'link.txt'))
    await expect(saveWorkingFile(repo, 'link.txt', 'x', 'one\ntwo\n')).rejects.toThrow('symbolic link')
    await expect(saveWorkingFile(repo, 'a.txt', 'a\0b', 'one\ntwo\n')).rejects.toThrow()
    await expect(saveWorkingFile(repo, '../x', 'x', '')).rejects.toThrow('outside')
  })

  it('is one journal step: undo restores the content, redo re-applies it', async () => {
    const repo = await setup()
    await saveWorkingFile(repo, 'a.txt', 'one\r\nthree', 'one\ntwo\n')
    expect(undoState(repo).undo).toBe('Edit a.txt')
    await undo(repo)
    expect(await disk(repo)).toBe('one\ntwo\n')
    await redo(repo)
    expect(await disk(repo)).toBe('one\r\nthree')
  })

  it('edits an untracked file, undo included', async () => {
    const repo = await setup()
    await mkdir(join(repo, 'd'))
    await write(repo, 'd/new.txt', 'fresh\n')
    await saveWorkingFile(repo, 'd/new.txt', 'fresh\nmore\n', 'fresh\n')
    expect(await disk(repo, 'd/new.txt')).toBe('fresh\nmore\n')
    await undo(repo)
    expect(await disk(repo, 'd/new.txt')).toBe('fresh\n')
  })
})

describe('workingFileReason and getHeadDiff', () => {
  it('gives the reason without reading the file, null when it can be edited', async () => {
    const repo = await setup()
    await symlink(join(repo, 'a.txt'), join(repo, 'link.txt'))
    expect(await workingFileReason(repo, 'a.txt')).toBeNull()
    expect(await workingFileReason(repo, 'link.txt')).toEqual(expect.any(String))
    await writeFile(join(repo, 'nul.bin'), Buffer.from('a\0b'))
    expect(await workingFileReason(repo, 'nul.bin')).toMatch(/UTF-8/)
    expect(await workingFileReason(repo, 'missing.txt')).toBe('The file no longer exists.')
  })

  it('does not read the whole file: invalid UTF-8 without a NUL passes the light check, the read refuses it', async () => {
    const repo = await setup()
    await writeFile(join(repo, 'latin.txt'), Buffer.from([0x66, 0xff, 0x6f]))
    expect(await workingFileReason(repo, 'latin.txt')).toBeNull()
    expect(await readWorkingFile(repo, 'latin.txt')).toHaveProperty('reason')
  })

  it('refuses unusual names with a reason, for the check and for the save', async () => {
    const repo = await setup()
    await write(repo, '-dash.txt', 'x\n')
    await write(repo, 'tab\there.txt', 'x\n')
    expect(await workingFileReason(repo, '-dash.txt')).toMatch(/unusual file name/)
    expect(await workingFileReason(repo, 'tab\there.txt')).toMatch(/unusual file name/)
    await expect(saveWorkingFile(repo, '-dash.txt', 'y', 'x\n')).rejects.toThrow('unusual file name')
  })

  it('a conflicted file is found by the index, not by the status', async () => {
    const repo = await setup()
    await git(repo, ['switch', '-q', '-c', 'other'])
    await write(repo, 'a.txt', 'other\ntwo\n')
    await commitAll(repo, 'other')
    await git(repo, ['switch', '-q', 'main'])
    await write(repo, 'a.txt', 'main\ntwo\n')
    await commitAll(repo, 'main')
    await git(repo, ['merge', 'other'], { okCodes: [1] })
    expect(await workingFileReason(repo, 'a.txt')).toBe('Use the conflict editor for this file.')
  })

  it('leaves no temporary file behind after a save', async () => {
    const repo = await setup()
    await saveWorkingFile(repo, 'a.txt', 'new\n', 'one\ntwo\n')
    expect((await readdir(repo)).filter((f) => f.includes('.tmp'))).toEqual([])
  })

  it('a literal name with a glob character is diffed alone', async () => {
    const repo = await setup()
    await write(repo, 'a*b.txt', 'star\n')
    await write(repo, 'axb.txt', 'x\n')
    await commitAll(repo, 'files')
    await write(repo, 'a*b.txt', 'star2\n')
    await write(repo, 'axb.txt', 'x2\n')
    const d = await getHeadDiff(repo, 'a*b.txt')
    expect(d?.hunks.flatMap((h) => h.lines.filter((l) => l.kind === 'add').map((l) => l.text))).toEqual(['star2'])
  })

  it('diffs against HEAD whatever is staged, and an untracked file is all added', async () => {
    const repo = await setup()
    await write(repo, 'a.txt', 'one\nTWO\n')
    await git(repo, ['add', 'a.txt'])
    await write(repo, 'a.txt', 'one\nTWO\nthree\n')
    const d = await getHeadDiff(repo, 'a.txt')
    expect(d?.hunks.flatMap((h) => h.lines.filter((l) => l.kind === 'add').map((l) => l.text))).toEqual(['TWO', 'three'])
    await write(repo, 'new.txt', 'x\ny\n')
    expect((await getHeadDiff(repo, 'new.txt'))?.hunks[0].lines.filter((l) => l.kind === 'add')).toHaveLength(2)
  })
})
