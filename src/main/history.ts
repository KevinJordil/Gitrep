import { FILE_HISTORY_LIMIT, type Blame, type CommitDetails, type FileCommit, type FileDiff, type Tag } from '../shared/types'
import { parseDiff } from './diff'
import { git } from './git'
import { FILE_LOG_FORMAT, LOG_FORMAT, parseBlame, parseCommitFiles, parseFileLog, parseLog, parseTags, TAG_FORMAT } from './parse'
import { insideRepo, RO } from './repo'

// Every revision coming from the renderer goes through here: no option injection, must name an existing commit.
export async function resolveCommit(repo: string, rev: string): Promise<string> {
  if (typeof rev !== 'string' || !rev || rev.startsWith('-')) throw new Error(`Invalid revision: ${rev}`)
  const sha = (await git(repo, ['rev-parse', '--verify', '--quiet', '--end-of-options', `${rev}^{commit}`], { okCodes: [1] })).trim()
  if (!sha) throw new Error(`Unknown commit: ${rev}`)
  return sha
}

export async function getTags(repo: string): Promise<Tag[]> {
  return parseTags(await git(repo, [...RO, 'for-each-ref', '--sort=-creatordate', `--format=${TAG_FORMAT}`, 'refs/tags']))
}

// Merge commits are shown against their first parent (what the merge brought in), root commits against nothing.
const FIRST_PARENT = ['--no-renames', '--diff-merges=first-parent']

export async function getCommitDetails(repo: string, rev: string): Promise<CommitDetails> {
  const sha = await resolveCommit(repo, rev)
  const [head, body, files] = await Promise.all([
    git(repo, [...RO, 'show', '-s', `--format=${LOG_FORMAT}`, sha]),
    git(repo, [...RO, 'show', '-s', '--format=%b', sha]),
    git(repo, [...RO, 'diff-tree', '-r', '-z', '--no-commit-id', '--root', '--raw', '--numstat', ...FIRST_PARENT, sha])
  ])
  return { ...parseLog(head)[0], body: body.trim(), files: parseCommitFiles(files) }
}

// oldPath: the file's path before this commit renamed it; the diff then shows the rename and its edits, not an added file.
export async function getCommitDiff(repo: string, rev: string, path: string, oldPath: string | null = null): Promise<FileDiff | null> {
  const sha = await resolveCommit(repo, rev)
  insideRepo(repo, path)
  if (oldPath !== null) insideRepo(repo, oldPath)
  const opts = oldPath === null ? FIRST_PARENT : ['-M', '--diff-merges=first-parent']
  const out = await git(repo, [...RO, 'show', '--format=', '--no-color', '--no-ext-diff', ...opts, sha, '--', ...(oldPath === null ? [] : [oldPath]), path])
  const files = parseDiff(out)
  return files.find((f) => f.newPath === path) ?? files[0] ?? null
}

// The commits that touched a file, newest first, from `rev` (null: HEAD; nothing before the first commit).
// follow: through renames. log.follow=false so a user's config cannot turn it on.
// ponytail: --follow scans the whole history (the output is capped, the time is not); the UI shows a loading state.
export async function getFileHistory(repo: string, path: string, rev: string | null, follow: boolean): Promise<FileCommit[]> {
  insideRepo(repo, path)
  const start = rev === null ? (await git(repo, ['rev-parse', '--verify', '--quiet', 'HEAD'], { okCodes: [1] })).trim() : await resolveCommit(repo, rev)
  if (!start) return []
  const args = ['-c', 'log.follow=false', 'log', `-n${FILE_HISTORY_LIMIT}`, '-z', '--numstat', '-M', ...(follow ? ['--follow'] : []), `--format=${FILE_LOG_FORMAT}`, start, '--', path]
  return parseFileLog(await git(repo, [...RO, ...args]), path)
}

// Limit: bigger files are not blamed (git blame's time grows with the file size times its history).
const MAX_BLAME_BYTES = 4 * 1024 * 1024
const MAX_BLAME_LINES = 50_000

// Who last changed each line of `path` as of `rev` (null: HEAD), parsed once. git follows renames of the whole file.
export async function getBlame(repo: string, rev: string | null, path: string): Promise<Blame> {
  insideRepo(repo, path)
  const sha = await resolveCommit(repo, rev ?? 'HEAD')
  const size = await git(repo, [...RO, 'cat-file', '-s', `${sha}:${path}`]).catch((e: Error) => {
    throw /Not a valid object name|does not exist|exists on disk, but not in/.test(e.message) ? new Error(`${path} does not exist in ${sha.slice(0, 7)}`) : e
  })
  if (Number(size) > MAX_BLAME_BYTES) throw new Error(`${path} is too large to blame (${(Number(size) / 1048576).toFixed(1)} MB, the limit is 4 MB)`)
  const blame = parseBlame(await git(repo, [...RO, 'blame', '--porcelain', '--no-ignore-revs-file', sha, '--', path]))
  if (blame.lines.length > MAX_BLAME_LINES) throw new Error(`This file is too long to blame here (${blame.lines.length} lines).`)
  if (blame.lines.some((l) => l.includes('\0'))) throw new Error(`${path} is a binary file: nothing to blame`)
  return { sha, path, ...blame }
}
