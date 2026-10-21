import { open, readFile } from 'node:fs/promises'
import { relative, resolve, sep } from 'node:path'
import { filePatch, MAX_FILE, replaceFile, unfit, utf8Text } from './files'
import { serialized } from './git'
import { record } from './journal'
import { getStatus, insideRepo } from './repo'

const CONFLICTED = 'Use the conflict editor for this file.'
const NOT_UTF8 = 'The file is not a UTF-8 text file.'
const CHANGED = 'The file changed on disk since you opened it.'

// Why the working file cannot be edited (without reading it), or its place on disk.
async function check(repo: string, path: string): Promise<{ reason: string } | { full: string; mode: number }> {
  const root = resolve(repo)
  const full = insideRepo(repo, path)
  const rel = relative(root, full)
  if ((await getStatus(repo)).conflicted.some((f) => f.path === rel.split(sep).join('/'))) return { reason: CONFLICTED }
  const fit = await unfit(root, rel)
  if ('reason' in fit) return { reason: `The file ${fit.reason}.` }
  if (fit.size > MAX_FILE) return { reason: 'The file is too large to edit (over 2 MB).' }
  return { full, mode: fit.mode }
}

// The working file as text, or why it cannot be edited here.
async function load(repo: string, path: string): Promise<{ reason: string } | { text: string; full: string; mode: number }> {
  const c = await check(repo, path)
  if ('reason' in c) return c
  const text = utf8Text(await readFile(c.full))
  if (text === null) return { reason: NOT_UTF8 }
  return { text, ...c }
}

// A light check for the Edit button: the reason it cannot be edited, or null (the content is checked when it is read).
export async function workingFileReason(repo: string, path: string): Promise<string | null> {
  const c = await check(repo, path)
  if ('reason' in c) return c.reason
  // Binary files show a NUL in their first bytes; any other invalid UTF-8 is caught when the file is read.
  const fh = await open(c.full, 'r')
  try {
    const { bytesRead, buffer } = await fh.read(Buffer.alloc(8192), 0, 8192, 0)
    return buffer.subarray(0, bytesRead).includes(0) ? NOT_UTF8 : null
  } finally {
    await fh.close()
  }
}

export async function readWorkingFile(repo: string, path: string): Promise<{ text: string } | { reason: string }> {
  const r = await load(repo, path)
  return 'reason' in r ? r : { text: r.text }
}

// Writes `text` over the file the editor opened with `base`; refused when the disk no longer holds `base`.
// One journal step: Undo puts the previous content back, Redo re-applies the edit.
export async function saveWorkingFile(repo: string, path: string, text: string, base: string): Promise<void> {
  if (typeof text !== 'string' || typeof base !== 'string' || text.includes('\0') || Buffer.byteLength(text) > MAX_FILE) throw new Error('This text cannot be saved')
  const rel = relative(resolve(repo), insideRepo(repo, path)).split(sep).join('/')
  // Unusual names would need quoting in the undo patch, a leading dash could pass for an option.
  if (/["\\\t\n\r]/.test(rel) || rel.startsWith('-')) throw new Error(`Cannot save ${rel}: unusual file name`)
  return serialized(repo, async () => {
    const cur = await load(repo, path)
    if ('reason' in cur) throw new Error(cur.reason)
    if (cur.text !== base) throw new Error(CHANGED)
    if (cur.text === text) return
    const patch = await filePatch(rel, text, cur.text) // undo applies it to go back
    await replaceFile(cur.full, text, cur.mode)
    record(repo, `Edit ${rel}`, { kind: 'patch', patch })
  })
}
