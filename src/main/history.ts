import type { CommitDetails, FileDiff, Tag } from '../shared/types'
import { parseDiff } from './diff'
import { git } from './git'
import { LOG_FORMAT, parseCommitFiles, parseLog, parseTags, TAG_FORMAT } from './parse'
import { RO } from './repo'

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

export async function getCommitDiff(repo: string, rev: string, path: string): Promise<FileDiff | null> {
  const sha = await resolveCommit(repo, rev)
  const out = await git(repo, [...RO, 'show', '--format=', '--no-color', '--no-ext-diff', ...FIRST_PARENT, sha, '--', path])
  return parseDiff(out)[0] ?? null
}
