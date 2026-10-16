import type { Branch, Commit, FileChange, FileStatus, RepoStatus, Stash, Tag } from '../shared/types'

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

export const LOG_FORMAT = '%H%x1f%P%x1f%an%x1f%ae%x1f%at%x1f%D%x1f%s%x1e'

export function parseLog(out: string): Commit[] {
  return out
    .split('\x1e')
    .map((record) => record.replace(/^\n/, ''))
    .filter(Boolean)
    .map((record) => {
      const [sha, parents, author, email, at, refs, subject] = record.split('\x1f')
      return { sha, parents: parents ? parents.split(' ') : [], author, email, date: Number(at), refs: refs ? refs.split(', ') : [], subject }
    })
}

export const BRANCH_FORMAT = '%(refname)%1f%(HEAD)%1f%(upstream:short)%1f%(upstream:track)%1f%(objectname)'

// Parses `git for-each-ref --format=BRANCH_FORMAT refs/heads refs/remotes`.
export function parseBranches(out: string): Branch[] {
  return out
    .split('\n')
    .filter(Boolean)
    .flatMap((line) => {
      const [ref, head, upstream, track, sha] = line.split('\x1f')
      const remote = ref.startsWith('refs/remotes/')
      const name = ref.replace(/^refs\/(heads|remotes)\//, '')
      if (remote && name.endsWith('/HEAD')) return []
      const ahead = /ahead (\d+)/.exec(track ?? '')?.[1]
      const behind = /behind (\d+)/.exec(track ?? '')?.[1]
      return [{ name, remote, current: head === '*', upstream: upstream || null, ahead: ahead ? Number(ahead) : 0, behind: behind ? Number(behind) : 0, sha }]
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
