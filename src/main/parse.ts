import type { Branch, Commit, FileChange, FileStatus, RepoStatus } from '../shared/types'

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

export const BRANCH_FORMAT = '%(refname)%1f%(HEAD)%1f%(upstream:short)%1f%(upstream:track)'

// Parses `git for-each-ref --format=BRANCH_FORMAT refs/heads refs/remotes`.
export function parseBranches(out: string): Branch[] {
  return out
    .split('\n')
    .filter(Boolean)
    .flatMap((line) => {
      const [ref, head, upstream, track] = line.split('\x1f')
      const remote = ref.startsWith('refs/remotes/')
      const name = ref.replace(/^refs\/(heads|remotes)\//, '')
      if (remote && name.endsWith('/HEAD')) return []
      const ahead = /ahead (\d+)/.exec(track ?? '')?.[1]
      const behind = /behind (\d+)/.exec(track ?? '')?.[1]
      return [{ name, remote, current: head === '*', upstream: upstream || null, ahead: ahead ? Number(ahead) : 0, behind: behind ? Number(behind) : 0 }]
    })
}
