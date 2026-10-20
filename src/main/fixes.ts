import { chmod, lstat, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import type { FixRequest, FixResult } from '../shared/types'
import { git, serialized } from './git'
import { record } from './journal'
import { getStatus, insideRepo } from './repo'

const MAX_FIXES = 50
const MAX_LINE = 2000
const MAX_TEXT = 200_000 // characters, replacements and originals together
const MAX_FILE = 2 * 1024 * 1024
const MAX_UNDO_PATCH = 20 * 1024 * 1024 // same limit as discarding changes
const lineList = (v: unknown): v is string[] => Array.isArray(v) && v.length <= 200 && v.every((l) => typeof l === 'string' && l.length <= MAX_LINE && !l.includes('\n'))
const noCr = (l: string) => l.replace(/\r$/, '')

// The patch that turns `from` into `to` for one file, with the repository path in its headers (for the undo journal).
async function filePatch(path: string, from: string, to: string): Promise<Buffer> {
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
async function unfit(root: string, rel: string): Promise<{ reason: string } | { mode: number; size: number }> {
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
async function replaceFile(full: string, content: Buffer | string, mode: number): Promise<void> {
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

interface Planned {
  full: string
  mode: number
  before: Buffer
  after: string
  patch: Buffer
  done: number[]
}

// Writes the kept fixes into the working files of the checked-out branch, as unstaged changes (nothing is staged or committed).
// A fix whose lines no longer read as reviewed is skipped, never forced. One journal entry: Undo puts every file back.
// Every file is planned first, then written; when a write fails the files already written are put back.
export async function prepareFixes(repo: string, branch: string, fixes: FixRequest[]): Promise<FixResult> {
  if (!Array.isArray(fixes) || !fixes.length || fixes.length > MAX_FIXES) throw new Error('No fixes to prepare')
  const root = resolve(repo)
  let text = 0
  const paths = new Map<FixRequest, string>() // the normalised path of each fix
  for (const f of fixes) {
    if (!f || !Number.isInteger(f.id) || typeof f.path !== 'string' || !Number.isInteger(f.line) || f.line < 1 || !Number.isInteger(f.endLine) || f.endLine < f.line || !lineList(f.original) || !lineList(f.lines) || f.original.length !== f.endLine - f.line + 1) throw new Error('Invalid fix')
    const rel = relative(root, insideRepo(repo, f.path))
    // Unusual names would need quoting in the undo patch, a leading dash could pass for an option.
    if (/["\\\t\n\r]/.test(rel) || rel.startsWith('-') || /["\\\t\n\r]/.test(f.path) || f.path.startsWith('-')) throw new Error(`Cannot prepare a fix in ${f.path}: unusual file name`)
    paths.set(f, rel.split(sep).join('/'))
    text += f.original.join('').length + f.lines.join('').length
  }
  if (text > MAX_TEXT) throw new Error('Too much text to prepare in one go: keep fewer fixes')
  return serialized(repo, async () => {
    const status = await getStatus(repo)
    if (status.branch !== branch) throw new Error(`Check out ${branch} first: fixes are written to its working files`)
    if (status.operation) throw new Error(`A ${status.operation} is in progress: continue or abort it first`)
    if (status.conflicted.length) throw new Error('Resolve the conflicted files first')
    const result: FixResult = { applied: [], skipped: [] }
    const plan: Planned[] = []
    for (const path of new Set(paths.values())) {
      const mine = fixes.filter((f) => paths.get(f) === path).sort((a, b) => b.line - a.line) // bottom-up: earlier line numbers stay valid
      const skipAll = (reason: string) => mine.forEach((f) => result.skipped.push({ id: f.id, path, reason }))
      const full = insideRepo(repo, path)
      const fit = await unfit(root, relative(root, full))
      if ('reason' in fit) {
        skipAll(fit.reason)
        continue
      }
      if (fit.size > MAX_FILE) {
        skipAll('too large')
        continue
      }
      const before = await readFile(full).catch(() => null)
      const content = before?.toString('utf8')
      if (!before || before.includes(0) || !Buffer.from(content!, 'utf8').equals(before)) {
        skipAll('not a UTF-8 text file')
        continue
      }
      const skip = (f: FixRequest, reason: string) => result.skipped.push({ id: f.id, path, reason })
      // Split on \n only: each line keeps its own \r, so CRLF and mixed files are written back as they were.
      const lines = content!.split('\n')
      const count = lines.length - (lines[lines.length - 1] === '' ? 1 : 0) // the empty piece after the final newline is not a line
      let floor = Infinity // first line of the lowest fix applied so far: a fix reaching it overlaps
      const done: number[] = []
      for (const f of mine) {
        if (f.lines.map(noCr).join('\n') === f.original.map(noCr).join('\n')) skip(f, 'nothing to change')
        else if (f.endLine >= floor) skip(f, 'overlaps another fix')
        else if (f.endLine > count || lines.slice(f.line - 1, f.endLine).map(noCr).join('\n') !== f.original.map(noCr).join('\n')) skip(f, 'the lines changed since the review')
        else {
          const cr = lines[f.line - 1].endsWith('\r') ? '\r' : ''
          lines.splice(f.line - 1, f.endLine - f.line + 1, ...f.lines.map((l) => noCr(l) + cr))
          floor = f.line
          done.push(f.id)
        }
      }
      if (!done.length) continue
      const after = lines.join('\n')
      plan.push({ full, mode: fit.mode, before, after, patch: await filePatch(path, after, content!), done: done.reverse() }) // patch reversed: undo applies it to go back
    }
    if (!plan.length) return result
    if (plan.reduce((n, p) => n + p.patch.length, 0) > MAX_UNDO_PATCH) throw new Error('These fixes are too large to be undone: prepare fewer of them')
    const written: Planned[] = []
    try {
      for (const p of plan) {
        await replaceFile(p.full, p.after, p.mode)
        written.push(p)
      }
    } catch (e) {
      for (const p of written) await replaceFile(p.full, p.before, p.mode).catch(() => undefined)
      throw e
    }
    for (const p of plan) result.applied.push(...p.done)
    record(repo, `Prepare ${result.applied.length} review fix${result.applied.length === 1 ? '' : 'es'}`, { kind: 'patch', patch: Buffer.concat(plan.map((p) => p.patch)) })
    return result
  })
}
