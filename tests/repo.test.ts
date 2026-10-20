import { existsSync } from 'node:fs'
import { readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { git } from '../src/main/git'
import {
  applyLines,
  commit,
  discard,
  displayFolder,
  fetchRepo,
  getBranches,
  getDiff,
  ALL_REFS,
  getLog,
  getStatus,
  getSync,
  lastMessage,
  mapLimit,
  pull,
  push,
  stage,
  summary,
  switchBranch,
  unstage
} from '../src/main/repo'
import { commitAll, commitAt, lines, makeRepo, tempDir, write } from './helpers'

describe('getStatus', () => {
  it('reports branch, staged, unstaged and untracked files with line counts', async () => {
    const repo = await makeRepo()
    await write(repo, 'a.txt', lines(5))
    await write(repo, 'b.txt', 'b\n')
    await commitAll(repo, 'init')
    await write(repo, 'a.txt', lines(5).replace('line 2', 'LINE 2'))
    await write(repo, 'b.txt', 'b\nb2\n')
    await git(repo, ['add', 'b.txt'])
    await write(repo, 'new.txt', 'n\n')
    const s = await getStatus(repo)
    expect(s.branch).toBe('main')
    expect(s.head).toMatch(/^[0-9a-f]{40}$/)
    expect(s.operation).toBeNull()
    expect(s.unstaged).toEqual([
      { path: 'a.txt', status: 'M', add: 1, del: 1 },
      { path: 'new.txt', status: '?' }
    ])
    expect(s.staged).toEqual([{ path: 'b.txt', status: 'M', add: 1, del: 0 }])
  })

  it('detects a merge in progress and its conflicted files', async () => {
    const repo = await makeRepo()
    await write(repo, 'f.txt', 'base\n')
    await commitAll(repo, 'base')
    await git(repo, ['switch', '-q', '-c', 'other'])
    await write(repo, 'f.txt', 'other\n')
    await commitAll(repo, 'other')
    await git(repo, ['switch', '-q', 'main'])
    await write(repo, 'f.txt', 'main\n')
    await commitAll(repo, 'main')
    await git(repo, ['merge', 'other'], { okCodes: [1] })
    const s = await getStatus(repo)
    expect(s.operation).toBe('merge')
    expect(s.conflicted.map((f) => f.path)).toEqual(['f.txt'])
  })
})

describe('getLog and getBranches', () => {
  it('lists HEAD history newest first, empty before the first commit', async () => {
    const repo = await makeRepo()
    expect(await getLog(repo)).toEqual([])
    await write(repo, 'a', '1\n')
    await commitAll(repo, 'first')
    await write(repo, 'a', '2\n')
    await commitAll(repo, 'second')
    const log = await getLog(repo)
    expect(log.map((c) => c.subject)).toEqual(['second', 'first'])
    expect(log[0].refs).toEqual(['HEAD -> main'])
    expect(log[0].parents).toEqual([log[1].sha])
    expect(log[0].author).toBe('Test User')
  })

  it('lists local branches and marks the current one', async () => {
    const repo = await makeRepo()
    await write(repo, 'a', '1\n')
    await commitAll(repo, 'first')
    await git(repo, ['branch', 'feature/x'])
    const sha = (await git(repo, ['rev-parse', 'HEAD'])).trim()
    expect(await getBranches(repo)).toEqual([
      { name: 'feature/x', remote: false, current: false, upstream: null, ahead: 0, behind: 0, sha, date: expect.any(Number) },
      { name: 'main', remote: false, current: true, upstream: null, ahead: 0, behind: 0, sha, date: expect.any(Number) }
    ])
  })

  async function branchy() {
    const repo = await makeRepo()
    await write(repo, 'a', '1\n')
    await commitAll(repo, 'base')
    await git(repo, ['switch', '-q', '-c', 'feature'])
    await write(repo, 'f', '1\n')
    await commitAll(repo, 'on feature')
    await git(repo, ['switch', '-q', 'main'])
    await write(repo, 'a', '2\n')
    await commitAll(repo, 'on main')
    await write(repo, 'a', '3\n')
    await git(repo, ['stash', 'push', '-q', '-m', 'parked'])
    return repo
  }

  it('lists every branch, without stash commits', async () => {
    const repo = await branchy()
    const log = await getLog(repo)
    expect(log.map((c) => c.subject).sort()).toEqual(['base', 'on feature', 'on main'])
    expect(log[log.length - 1].subject).toBe('base') // parents after children
  })

  it('isolates one branch or hides some, ignoring unknown names', async () => {
    const repo = await branchy()
    expect((await getLog(repo, { only: 'feature', hidden: [] })).map((c) => c.subject)).toEqual(['on feature', 'base'])
    expect((await getLog(repo, { only: null, hidden: ['feature', 'gone'] })).map((c) => c.subject)).toEqual(['on main', 'base'])
    expect((await getLog(repo, { only: 'gone', hidden: [] })).map((c) => c.subject).sort()).toEqual(['base', 'on feature', 'on main'])
  })

  // base (10 days ago) <- m1 (4) <- m2 (2) on main; base <- f1 (3) <- f2 (1) on feature.
  async function interleaved() {
    const repo = await makeRepo()
    await commitAt(repo, 'base', 10)
    await git(repo, ['branch', 'feature'])
    await commitAt(repo, 'm1', 4)
    await commitAt(repo, 'm2', 2)
    await git(repo, ['switch', '-q', 'feature'])
    await commitAt(repo, 'f1', 3)
    await commitAt(repo, 'f2', 1)
    await git(repo, ['switch', '-q', 'main'])
    return repo
  }

  it('lists commits newest first across branches, never a parent before its children', async () => {
    const repo = await interleaved()
    expect((await getLog(repo)).map((c) => c.subject)).toEqual(['f2', 'm2', 'f1', 'm1', 'base'])
  })

  it('gives each branch the committer date of its tip', async () => {
    const repo = await interleaved()
    const now = Date.now() / 1000
    const dates = Object.fromEntries((await getBranches(repo)).map((b) => [b.name, Math.round((now - b.date) / 86400)]))
    expect(dates).toEqual({ feature: 1, main: 2 })
  })

  it('draws only the active branches: recent tips, HEAD, isolated ones; tags are not walked', async () => {
    const repo = await interleaved()
    await git(repo, ['switch', '-q', '-c', 'old', 'main~2'])
    await commitAt(repo, 'old work', 60)
    await git(repo, ['tag', 'v0', 'HEAD'])
    await git(repo, ['switch', '-q', 'main'])
    expect((await getLog(repo, ALL_REFS, 30)).map((c) => c.subject)).toEqual(['f2', 'm2', 'f1', 'm1', 'base'])
    expect((await getLog(repo, ALL_REFS, 90)).map((c) => c.subject)).toContain('old work')
    expect((await getLog(repo, ALL_REFS, 0)).map((c) => c.subject)).toContain('old work')
    expect((await getLog(repo, { only: 'old', hidden: [] }, 30)).map((c) => c.subject)).toEqual(['old work', 'base'])
    expect((await getLog(repo, { only: null, hidden: ['feature'] }, 30)).map((c) => c.subject)).toEqual(['m2', 'm1', 'base'])
    await git(repo, ['switch', '-q', 'old'])
    expect((await getLog(repo, ALL_REFS, 30)).map((c) => c.subject)).toContain('old work') // the checked-out branch
    await git(repo, ['switch', '-q', '--detach', 'old'])
    expect((await getLog(repo, ALL_REFS, 30)).map((c) => c.subject)).toContain('old work') // HEAD
  })
})

describe('getDiff', () => {
  it('refuses untracked paths outside the repo', async () => {
    const repo = await makeRepo()
    await expect(getDiff(repo, '../outside.txt', 'untracked')).rejects.toThrow('outside the repository')
  })

  it('returns unstaged, staged and untracked diffs, null when unchanged', async () => {
    const repo = await makeRepo()
    await write(repo, 'a.txt', 'a\n')
    await commitAll(repo, 'init')
    expect(await getDiff(repo, 'a.txt', 'unstaged')).toBeNull()
    await write(repo, 'a.txt', 'b\n')
    expect((await getDiff(repo, 'a.txt', 'unstaged'))!.hunks[0].lines.map((l) => l.kind)).toEqual(['del', 'add'])
    await stage(repo, ['a.txt'])
    expect((await getDiff(repo, 'a.txt', 'staged'))!.newPath).toBe('a.txt')
    await write(repo, 'u.txt', 'x\ny\n')
    const u = (await getDiff(repo, 'u.txt', 'untracked'))!
    expect(u.isNew).toBe(true)
    expect(u.hunks[0].lines.map((l) => l.text)).toEqual(['x', 'y'])
  })
})

describe('stage, unstage, discard', () => {
  it('stages and unstages, also before the first commit', async () => {
    const repo = await makeRepo()
    await write(repo, 'a.txt', 'a\n')
    await stage(repo, ['a.txt'])
    expect((await getStatus(repo)).staged.map((f) => f.path)).toEqual(['a.txt'])
    await unstage(repo, ['a.txt'])
    const s = await getStatus(repo)
    expect(s.staged).toEqual([])
    expect(s.unstaged.map((f) => f.path)).toEqual(['a.txt'])
    await stage(repo, ['a.txt'])
    await git(repo, ['commit', '-q', '-m', 'x'])
    await write(repo, 'a.txt', 'b\n')
    await stage(repo, ['a.txt'])
    await unstage(repo, ['a.txt'])
    expect((await getStatus(repo)).unstaged.map((f) => f.status)).toEqual(['M'])
  })

  it('stages a deletion', async () => {
    const repo = await makeRepo()
    await write(repo, 'a.txt', 'a\n')
    await commitAll(repo, 'init')
    await rm(join(repo, 'a.txt'))
    await stage(repo, ['a.txt'])
    expect((await getStatus(repo)).staged).toEqual([{ path: 'a.txt', status: 'D', add: 0, del: 1 }])
  })

  it('discards tracked and untracked changes and refuses paths outside the repo', async () => {
    const repo = await makeRepo()
    await write(repo, 'a.txt', 'a\n')
    await commitAll(repo, 'init')
    await write(repo, 'a.txt', 'changed\n')
    await write(repo, 'tmp/new.txt', 'n\n')
    await discard(repo, (await getStatus(repo)).unstaged)
    expect(await readFile(join(repo, 'a.txt'), 'utf8')).toBe('a\n')
    expect(existsSync(join(repo, 'tmp'))).toBe(false)
    await expect(discard(repo, [{ path: '../evil', status: '?' }])).rejects.toThrow('outside the repository')
    await expect(discard(repo, [{ path: '.git/x', status: '?' }])).rejects.toThrow('outside the repository')
  })

  it('keeps ignored files when discarding an untracked folder', async () => {
    const repo = await makeRepo()
    await write(repo, '.gitignore', '.env\n')
    await commitAll(repo, 'init')
    await write(repo, 'tmp/a.txt', 'a\n')
    await write(repo, 'tmp/.env', 'S=1\n')
    await discard(repo, (await getStatus(repo)).unstaged)
    expect(existsSync(join(repo, 'tmp/a.txt'))).toBe(false)
    expect(existsSync(join(repo, 'tmp/.env'))).toBe(true)
  })

  it('treats paths literally and ignores the renderer status', async () => {
    const repo = await makeRepo()
    await write(repo, 'a.txt', 'a\n')
    await commitAll(repo, 'init')
    await write(repo, 'a.txt', 'changed\n')
    await discard(repo, [{ path: '*', status: 'M' }])
    expect(await readFile(join(repo, 'a.txt'), 'utf8')).toBe('changed\n')
    await discard(repo, [{ path: 'a.txt', status: '?' }])
    expect(await readFile(join(repo, 'a.txt'), 'utf8')).toBe('a\n')
  })
})

describe('applyLines', () => {
  async function setup() {
    const repo = await makeRepo()
    await write(repo, 'f.txt', lines(20))
    await commitAll(repo, 'init')
    await write(repo, 'f.txt', lines(20, (i) => (i === 3 ? 'three' : i === 15 ? 'fifteen' : `line ${i}`)))
    const diff = (await getDiff(repo, 'f.txt', 'unstaged'))!
    return { repo, diff }
  }
  const indexOf = (repo: string) => git(repo, ['show', ':f.txt'])

  it('stages one whole hunk', async () => {
    const { repo, diff } = await setup()
    expect(diff.hunks).toHaveLength(2)
    await applyLines(repo, diff, 0, null, 'stage')
    const index = await indexOf(repo)
    expect(index).toContain('three')
    expect(index).not.toContain('fifteen')
  })

  it('stages only the selected line', async () => {
    const { repo, diff } = await setup()
    const add = diff.hunks[0].lines.findIndex((l) => l.kind === 'add')
    await applyLines(repo, diff, 0, [add], 'stage')
    expect(await indexOf(repo)).toContain('line 3\nthree\n')
  })

  it('unstages one hunk of the staged diff', async () => {
    const { repo } = await setup()
    await stage(repo, ['f.txt'])
    const staged = (await getDiff(repo, 'f.txt', 'staged'))!
    await applyLines(repo, staged, 1, null, 'unstage')
    const index = await indexOf(repo)
    expect(index).toContain('three')
    expect(index).not.toContain('fifteen')
  })

  it('unstages a single selected deletion', async () => {
    const { repo } = await setup()
    await stage(repo, ['f.txt'])
    const staged = (await getDiff(repo, 'f.txt', 'staged'))!
    const del = staged.hunks[0].lines.findIndex((l) => l.kind === 'del')
    await applyLines(repo, staged, 0, [del], 'unstage')
    expect(await indexOf(repo)).toContain('line 3\nthree\n')
  })

  it('rejects a stale diff', async () => {
    const { repo, diff } = await setup()
    await write(repo, 'f.txt', lines(20, (i) => (i === 3 ? 'THREE' : `line ${i}`)))
    await expect(applyLines(repo, diff, 0, null, 'stage')).rejects.toThrow('has changed')
  })

  it('discards one hunk in the working tree', async () => {
    const { repo, diff } = await setup()
    await applyLines(repo, diff, 1, null, 'discard')
    const content = await readFile(join(repo, 'f.txt'), 'utf8')
    expect(content).toContain('three')
    expect(content).toContain('line 15')
    expect(content).not.toContain('fifteen')
  })
})

describe('commit', () => {
  it('commits from stdin keeping # lines, then amends', async () => {
    const repo = await makeRepo()
    await write(repo, 'a', '1\n')
    await stage(repo, ['a'])
    await commit(repo, 'feat: first\n\n#42 keep this line\n', false)
    expect(await lastMessage(repo)).toBe('feat: first\n\n#42 keep this line')
    await write(repo, 'b', '2\n')
    await stage(repo, ['b'])
    await commit(repo, 'feat: first, amended\n', true)
    const log = await getLog(repo)
    expect(log).toHaveLength(1)
    expect(log[0].subject).toBe('feat: first, amended')
  })

  it('rejects an empty message', async () => {
    const repo = await makeRepo()
    await expect(commit(repo, '   ', false)).rejects.toThrow('Empty')
  })
})

describe('remote operations', () => {
  async function setupRemote() {
    const remote = await tempDir()
    await git(remote, ['init', '-q', '--bare', '-b', 'main'])
    const a = await tempDir()
    await git(a, ['clone', '-q', remote, '.'])
    await write(a, 'f', '1\n')
    await commitAll(a, 'one')
    return { remote, a }
  }

  it('first push sets the upstream; fetch and pull update another clone', async () => {
    const { remote, a } = await setupRemote()
    await push(a)
    expect((await getStatus(a)).upstream).toBe('origin/main')
    const b = await tempDir()
    await git(b, ['clone', '-q', remote, '.'])
    await write(a, 'f', '2\n')
    await commitAll(a, 'two')
    await push(a)
    await fetchRepo(b)
    expect((await getStatus(b)).behind).toBe(1)
    await pull(b)
    expect((await getLog(b))[0].subject).toBe('two')
  })

  it('switches to a local branch and to a remote branch', async () => {
    const { remote, a } = await setupRemote()
    await push(a)
    await git(a, ['switch', '-q', '-c', 'feature'])
    await push(a)
    const b = await tempDir()
    await git(b, ['clone', '-q', remote, '.'])
    await switchBranch(b, 'origin/feature', true)
    expect((await getStatus(b)).branch).toBe('feature')
    await switchBranch(b, 'main', false)
    expect((await getStatus(b)).branch).toBe('main')
  })

  it('rejects a branch name starting with a dash', async () => {
    const { a } = await setupRemote()
    await expect(switchBranch(a, '--detach', false)).rejects.toThrow('Invalid branch name')
  })

  it('refuses to push a detached HEAD', async () => {
    const { a } = await setupRemote()
    await git(a, ['switch', '-q', '--detach'])
    await expect(push(a)).rejects.toThrow('Detached HEAD')
  })
})

describe('getSync', () => {
  async function pushed() {
    const remote = await tempDir()
    await git(remote, ['init', '-q', '--bare', '-b', 'main'])
    const a = await tempDir()
    await git(a, ['clone', '-q', remote, '.'])
    await write(a, 'f', '1\n')
    await commitAll(a, 'one')
    await push(a)
    return { remote, a }
  }
  const head = async (repo: string) => (await git(repo, ['rev-parse', 'HEAD'])).trim()

  it('lists a local commit ahead of origin as outgoing', async () => {
    const { a } = await pushed()
    expect(await getSync(a)).toEqual({ outgoing: [], incoming: [], upstream: 'origin/main' })
    await write(a, 'f', '2\n')
    await commitAll(a, 'two')
    expect(await getSync(a)).toEqual({ outgoing: [await head(a)], incoming: [], upstream: 'origin/main' })
  })

  it('lists the commits of a branch without upstream that no remote has', async () => {
    const { a } = await pushed()
    await git(a, ['switch', '-q', '-c', 'feature'])
    await write(a, 'f', '2\n')
    await commitAll(a, 'two')
    expect(await getSync(a)).toEqual({ outgoing: [await head(a)], incoming: [], upstream: null })
  })

  it('lists a commit pushed by another clone and fetched as incoming', async () => {
    const { remote, a } = await pushed()
    const b = await tempDir()
    await git(b, ['clone', '-q', remote, '.'])
    await write(b, 'f', '2\n')
    await commitAll(b, 'two')
    await push(b)
    await fetchRepo(a)
    expect(await getSync(a)).toEqual({ outgoing: [], incoming: [await head(b)], upstream: 'origin/main' })
  })

  it('reports nothing outgoing when the repository has no remote at all', async () => {
    const repo = await makeRepo()
    for (const m of ['one', 'two', 'three']) {
      await write(repo, 'f', `${m}\n`)
      await commitAll(repo, m)
    }
    expect(await getSync(repo)).toEqual({ outgoing: [], incoming: [], upstream: null })
  })

  it('has nothing to sync in a repository without remote commits or when detached', async () => {
    const repo = await makeRepo()
    expect(await getSync(repo)).toEqual({ outgoing: [], incoming: [], upstream: null })
    await write(repo, 'f', '1\n')
    await commitAll(repo, 'one')
    await git(repo, ['switch', '-q', '--detach'])
    expect(await getSync(repo)).toMatchObject({ incoming: [], upstream: null })
  })
})

describe('summary and helpers', () => {
  it('summarises a repo', async () => {
    const repo = await makeRepo()
    await write(repo, 'a', '1\n')
    await commitAll(repo, 'first')
    await write(repo, 'a', '2\n')
    const s = await summary(repo)
    expect(s.error).toBeNull()
    expect(s.lastCommit).toMatchObject({ subject: 'first', author: 'Test User' })
    expect(s.status!.unstaged).toHaveLength(1)
    expect(s.stashCount).toBe(0)
    expect(s.fetchError).toBeNull()
  })

  it('reports a missing folder instead of throwing', async () => {
    const s = await summary('/nonexistent/gitrep-repo')
    expect(s.status).toBeNull()
    expect(s.error).toContain('not found')
  })

  it('shortens the home folder', () => {
    expect(displayFolder('/home/k/workspace/x', '/home/k')).toBe('~/workspace')
    expect(displayFolder('/home/k/x', '/home/k')).toBe('~')
    expect(displayFolder('/opt/x', '/home/k')).toBe('/opt')
  })

  it('mapLimit keeps order and bounds concurrency', async () => {
    let active = 0
    let peak = 0
    const out = await mapLimit([1, 2, 3, 4, 5], 2, async (n) => {
      active++
      peak = Math.max(peak, active)
      await new Promise((r) => setTimeout(r, 10))
      active--
      return n * 10
    })
    expect(out).toEqual([10, 20, 30, 40, 50])
    expect(peak).toBe(2)
  })
})
