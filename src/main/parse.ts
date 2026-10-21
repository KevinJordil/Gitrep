import { unquote } from './diff'
import type { Blame, BlameChunk, BlameCommit, Branch, Commit, FileChange, FileCommit, FileStatus, RepoStatus, Stash, Tag } from '../shared/types'

// Parses `git status --porcelain=v2 --branch -z`.
export function parseStatus(out: string): Omit<RepoStatus, 'operation'> {
  const s: Omit<RepoStatus, 'operation'> = { branch: null, head: null, upstream: null, ahead: 0, behind: 0, staged: [], unstaged: [], conflicted: [] }
  const parts = out.split('\0')
  for (let i = 0; i < parts.length; i++) {
    const line = parts[i]
    if (!line) continue
    if (line.startsWith('# ')) {
      const [, key, ...rest] = line.split(' ')
      const value = rest.join(' ')
      if (key === 'branch.oid') s.head = value === '(initial)' ? null : value
      else if (key === 'branch.head') s.branch = value === '(detached)' ? null : value
      else if (key === 'branch.upstream') s.upstream = value
      else if (key === 'branch.ab') {
        const m = /^\+(\d+) -(\d+)$/.exec(value)
        if (m) {
          s.ahead = Number(m[1])
          s.behind = Number(m[2])
        }
      }
      continue
    }
    const kind = line[0]
    if (kind === '?') {
      s.unstaged.push({ path: line.slice(2), status: '?' })
    } else if (kind === '1' || kind === '2') {
      const fields = line.split(' ')
      const xy = fields[1]
      const path = fields.slice(kind === '1' ? 8 : 9).join(' ')
      const change: FileChange = { path, status: xy[0] as FileStatus }
      if (kind === '2') change.origPath = parts[++i]
      if (xy[0] !== '.') s.staged.push(change)
      if (xy[1] !== '.') s.unstaged.push({ path, status: xy[1] as FileStatus })
    } else if (kind === 'u') {
      s.conflicted.push({ path: line.split(' ').slice(10).join(' '), status: 'U' })
    }
  }
  return s
}

// Parses `git diff --numstat -z --no-renames`.
export function parseNumstat(out: string): Record<string, { add: number; del: number }> {
  const result: Record<string, { add: number; del: number }> = {}
  for (const entry of out.split('\0')) {
    if (!entry) continue
    const [add, del, ...path] = entry.split('\t')
    result[path.join('\t')] = { add: add === '-' ? 0 : Number(add), del: del === '-' ? 0 : Number(del) }
  }
  return result
}

const LOG_FIELDS = '%H%x1f%P%x1f%an%x1f%ae%x1f%at%x1f%ct%x1f%D%x1f%s'
export const LOG_FORMAT = `${LOG_FIELDS}%x1e`
// The numstat of each commit follows its fields: the record separator comes first.
export const FILE_LOG_FORMAT = `%x1e${LOG_FIELDS}`

export function parseLog(out: string): Commit[] {
  return out
    .split('\x1e')
    .map((record) => record.replace(/^\n/, ''))
    .filter(Boolean)
    .map(toCommit)
}

function toCommit(record: string): Commit {
  const [sha, parents, author, email, at, ct, refs, ...subject] = record.split('\x1f')
  return { sha, parents: parents ? parents.split(' ') : [], author, email, date: Number(at), committed: Number(ct), refs: refs ? refs.split(', ') : [], subject: subject.join('\x1f') }
}

// Parses `git log -z --numstat --format=FILE_LOG_FORMAT -- <path>`; `path` is the file's name in the newest commit.
// numstat: "add\tdel\tpath", or for a rename "add\tdel\t" then the old and the new path. A merge has none: it keeps the path.
export function parseFileLog(out: string, path: string): FileCommit[] {
  const commits: FileCommit[] = []
  let current = path
  // A file name or subject may itself contain the record separator: a fragment that does not open a commit belongs to the previous record.
  const records: string[] = []
  for (const part of out.split('\x1e')) {
    const fields = part.split('\0')[0].split('\x1f')
    if (fields.length >= 8 && /^[0-9a-f]{40,64}$/.test(fields[0])) records.push(part)
    else if (records.length) records[records.length - 1] += '\x1e' + part
  }
  for (const record of records) {
    const end = record.indexOf('\0')
    const commit = toCommit(record.slice(0, end))
    const parts = record.slice(end + 1).replace(/^\n/, '').split('\0')
    const [add = '', del = '', ...name] = parts[0].split('\t')
    const renamed = parts[0] !== '' && name.join('\t') === ''
    const file = renamed ? parts[2] : name.join('\t') || current
    const oldPath = renamed ? parts[1] : null
    commits.push({ ...commit, path: file, oldPath, add: Number(add) || 0, del: Number(del) || 0 })
    current = oldPath ?? file
  }
  return commits
}

// Parses `git blame --porcelain`: per line a header "<sha> <orig line> <line> [<count>]", the commit's fields the first
// time it appears, then "\t<content>". Adjacent lines of one commit form one chunk. The content comes from the file of
// a possibly hostile repository, so a malformed header, group or known field throws; unknown header fields (ignored,
// unblamable, future ones) are skipped.
const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/

export function parseBlame(out: string): Pick<Blame, 'lines' | 'chunks' | 'commits'> {
  const bad = (why: string): never => {
    throw new Error(`Unexpected blame output (${why})`)
  }
  const lines: string[] = []
  const chunks: BlameChunk[] = []
  const commits: Record<string, BlameCommit> = {}
  let c: BlameCommit | null = null
  let awaitingContent = false
  let pending = 0 // lines still to come in the announced group
  const rows = out.split('\n')
  if (rows[rows.length - 1] === '') rows.pop()
  for (const row of rows) {
    if (c && awaitingContent) {
      if (row.startsWith('\t')) {
        lines.push(row.slice(1))
        awaitingContent = false
        pending--
        const last = chunks[chunks.length - 1]
        if (last?.sha === c.sha) last.count++
        else chunks.push({ sha: c.sha, start: lines.length, count: 1 })
        continue
      }
      const space = row.indexOf(' ')
      const key = space < 0 ? row : row.slice(0, space)
      const value = space < 0 ? '' : row.slice(space + 1)
      if (key === 'author') c.author = value
      else if (key === 'author-mail') c.email = value.replace(/^<|>$/g, '')
      else if (key === 'author-time') {
        if (!/^\d+$/.test(value)) bad('author time')
        c.date = Number(value)
      } else if (key === 'summary') c.subject = value
      else if (key === 'previous') {
        const at = value.indexOf(' ')
        if (at < 0 || !SHA.test(value.slice(0, at)) || at === value.length - 1) bad('previous')
        c.previous = { sha: value.slice(0, at), path: unquote(value.slice(at + 1)) }
      }
      continue
    }
    const header = /^([0-9a-f]+) \d+ (\d+)(?: (\d+))?$/.exec(row)
    if (!header || !SHA.test(header[1]) || Number(header[2]) !== lines.length + 1) bad('header')
    const [, sha, , count] = header!
    if (count !== undefined) {
      if (pending !== 0 || Number(count) < 1) bad('group')
      pending = Number(count)
    } else if (pending <= 0) bad('group')
    c = commits[sha] ??= { sha, author: '', email: '', date: 0, subject: '', previous: null }
    awaitingContent = true
  }
  if (awaitingContent || pending !== 0) bad('truncated')
  return { lines, chunks, commits }
}

export const BRANCH_FORMAT = '%(refname)%1f%(HEAD)%1f%(upstream:short)%1f%(upstream:track)%1f%(objectname)%1f%(committerdate:unix)'

// Parses `git for-each-ref --format=BRANCH_FORMAT refs/heads refs/remotes`.
export function parseBranches(out: string): Branch[] {
  return out
    .split('\n')
    .filter(Boolean)
    .flatMap((line) => {
      const [ref, head, upstream, track, sha, date] = line.split('\x1f')
      const remote = ref.startsWith('refs/remotes/')
      const name = ref.replace(/^refs\/(heads|remotes)\//, '')
      if (remote && name.endsWith('/HEAD')) return []
      const ahead = /ahead (\d+)/.exec(track ?? '')?.[1]
      const behind = /behind (\d+)/.exec(track ?? '')?.[1]
      return [{ name, remote, current: head === '*', upstream: upstream || null, ahead: ahead ? Number(ahead) : 0, behind: behind ? Number(behind) : 0, sha, date: Number(date) }]
    })
}

export const TAG_FORMAT = '%(refname:strip=2)%1f%(objectname)%1f%(*objectname)'

// Parses `git for-each-ref --format=TAG_FORMAT refs/tags`; annotated tags point at their peeled commit.
export function parseTags(out: string): Tag[] {
  return out
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [name, object, peeled] = line.split('\x1f')
      return { name, sha: peeled || object }
    })
}

// Parses `git diff-tree -r -z --raw --numstat --no-renames`: raw entries (":meta STATUS", path) then numstat entries.
export function parseCommitFiles(out: string): FileChange[] {
  const files: FileChange[] = []
  const numstat: string[] = []
  const parts = out.split('\0')
  for (let i = 0; i < parts.length; i++) {
    if (!parts[i]) continue
    if (parts[i].startsWith(':')) files.push({ path: parts[++i], status: parts[i - 1].slice(-1) as FileStatus })
    else numstat.push(parts[i])
  }
  const counts = parseNumstat(numstat.join('\0'))
  return files.map((f) => ({ ...f, ...counts[f.path] }))
}

export const STASH_FORMAT = '%gd%x1f%H%x1f%P%x1f%at%x1f%gs'

// Parses `git stash list --format=STASH_FORMAT`. Subjects: "On <branch>: <message>" or "WIP on <branch>: <sha> <subject>".
export function parseStashes(out: string): Stash[] {
  return out
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [ref, sha, parents, at, subject] = line.split('\x1f')
      const [base, , untracked] = parents.split(' ')
      const m = /^(WIP on|On) ([^:]+): (.*)$/.exec(subject)
      return {
        index: Number(/\{(\d+)\}/.exec(ref)?.[1] ?? 0),
        sha,
        base,
        untracked: untracked ?? null,
        date: Number(at),
        branch: m && m[2] !== '(no branch)' ? m[2] : null,
        message: m?.[1] === 'On' ? m[3] : subject
      }
    })
}
