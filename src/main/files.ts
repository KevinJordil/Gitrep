import { chmod, lstat, mkdtemp, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, sep } from 'node:path'
import { git } from './git'

export const MAX_FILE = 2 * 1024 * 1024

// The text of a file read as bytes, or null when it is not lossless UTF-8 or holds a NUL.
export function utf8Text(bytes: Buffer): string | null {
  if (bytes.includes(0)) return null
  const text = bytes.toString('utf8')
  return Buffer.from(text, 'utf8').equals(bytes) ? text : null
}

// The patch that turns `from` into `to` for one file, with the repository path in its headers (for the undo journal).
export async function filePatch(path: string, from: string, to: string): Promise<Buffer> {
  const dir = await mkdtemp(join(tmpdir(), 'gitrep-fix-'))
  try {
    await Promise.all([writeFile(join(dir, 'from'), from), writeFile(join(dir, 'to'), to)])
    const out = await git(dir, ['diff', '--no-index', '--no-color', '--no-ext-diff', '--', 'from', 'to'], { okCodes: [1] })
    return Buffer.from(`diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n${out.slice(out.indexOf('\n@@') + 1)}`)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

// Why a path cannot be written: a symbolic link on the way (it could lead outside the repository), not a regular file, gone.
export async function unfit(root: string, rel: string): Promise<{ reason: string } | { mode: number; size: number }> {
  let cur = root
  let last
  try {
    for (const part of rel.split(sep)) {
      cur = join(cur, part)
      last = await lstat(cur)
      if (last.isSymbolicLink()) return { reason: 'is a symbolic link' }
    }
  } catch {
    return { reason: 'the file no longer exists' }
  }
  if (!last?.isFile()) return { reason: 'is not a regular file' }
  return { mode: last.mode & 0o7777, size: last.size }
}

// Replaces a file through a temporary file in the same directory, keeping its mode.
export async function replaceFile(full: string, content: Buffer | string, mode: number): Promise<void> {
  const tmp = join(dirname(full), `.${basename(full)}.gitrep-${process.pid}.tmp`)
  try {
    await writeFile(tmp, content, { mode })
    await chmod(tmp, mode)
    await rename(tmp, full)
  } catch (e) {
    await rm(tmp, { force: true })
    throw e
  }
}
