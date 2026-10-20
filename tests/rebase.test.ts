import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { git } from '../src/main/git'
import { undoState } from '../src/main/journal'
import { continueOperation } from '../src/main/ops'
import { interactiveRebase, rebaseCommits } from '../src/main/rebase'
import { getStatus, push, stage } from '../src/main/repo'
import { undo } from '../src/main/undo'
import type { RebaseAction, RebaseItem } from '../src/shared/types'
import { commitAll, makeRepo, tempDir, write } from './helpers'

const rev = async (repo: string, r = 'HEAD') => (await git(repo, ['rev-parse', r])).trim()
const subjects = async (repo: string, range = 'feature') => (await git(repo, ['log', '--format=%s', range])).trim().split('\n')
const read = (repo: string, f: string) => readFile(join(repo, f), 'utf8')

// main: base. feature: c1 (a.txt "1"), c2 (adds b.txt), c3 (a.txt "1 fixed"), c4 "wip: debug" (adds d.txt). main checked out.
async function setup() {
  const repo = await makeRepo()
  await write(repo, 'a.txt', 'base\n')
  await commitAll(repo, 'base')
  await git(repo, ['switch', '-q', '-c', 'feature'])
  for (const [file, content, message] of [
    ['a.txt', '1\n', 'c1'],
    ['b.txt', 'b\n', 'c2'],
    ['a.txt', '1 fixed\n', 'c3'],
    ['d.txt', 'd\n', 'wip: debug']
  ]) {
    await write(repo, file, content)
    await commitAll(repo, message)
  }
  await git(repo, ['switch', '-q', 'main'])
  const shas = (await git(repo, ['rev-list', '--reverse', 'main..feature'])).trim().split('\n') // oldest first
  return { repo, shas }
}

// Items oldest first, from (index into shas, action[, message]).
const items = (shas: string[], plan: [number, RebaseAction, string?][]): RebaseItem[] => plan.map(([i, action, message]) => ({ sha: shas[i], action, ...(message ? { message } : {}) }))
const run = (repo: string, list: RebaseItem[], autostash = false) => interactiveRebase(repo, { branch: 'feature', upstream: 'main', items: list, autostash })

describe('rebaseCommits', () => {
  it('lists the commits of the branch after the base, newest first', async () => {
    const { repo, shas } = await setup()
    const plan = await rebaseCommits(repo, 'feature', 'main')
    expect(plan).toMatchObject({ branch: 'feature', onto: await rev(repo, 'main'), ontoLabel: 'main', pushed: 0 })
    expect(plan.commits.map((c) => c.subject)).toEqual(['wip: debug', 'c3', 'c2', 'c1'])
    expect(plan.commits[3]).toMatchObject({ sha: shas[0], body: '', author: 'Test User' })
    const from = await rebaseCommits(repo, 'feature', shas[1])
    expect(from.ontoLabel).toBe(shas[1].slice(0, 7))
    expect(from.commits).toHaveLength(2)
  })

  it('counts the commits already on a remote', async () => {
    const { repo, shas } = await setup()
    const remote = await tempDir()
    await git(remote, ['init', '-q', '--bare'])
    await git(repo, ['remote', 'add', 'origin', remote])
    await git(repo, ['push', '-q', 'origin', `${shas[1]}:refs/heads/feature`])
    await git(repo, ['fetch', '-q', 'origin'])
    expect((await rebaseCommits(repo, 'feature', 'main')).pushed).toBe(2)
  })

  it('refuses ranges with merge commits, empty ranges and branches that are not local', async () => {
    const { repo } = await setup()
    await expect(rebaseCommits(repo, 'main', 'feature')).rejects.toThrow('Nothing to rebase: main has no commit after feature')
    await expect(rebaseCommits(repo, 'origin/x', 'main')).rejects.toThrow('Not a local branch: origin/x')
    await git(repo, ['switch', '-q', '-c', 'side', 'main'])
    await write(repo, 's.txt', 's\n')
    await commitAll(repo, 's')
    await git(repo, ['merge', '-q', '--no-ff', '-m', 'merge feature', 'feature'])
    await expect(rebaseCommits(repo, 'side', 'main')).rejects.toThrow('merge commits')
  })
})

describe('interactiveRebase', () => {
  it('reorders, folds a fix into its commit and drops another, then undo restores the branch', async () => {
    const { repo, shas } = await setup()
    const before = await rev(repo, 'feature')
    expect(await run(repo, items(shas, [[1, 'pick'], [0, 'pick'], [2, 'fixup'], [3, 'drop']]))).toBe('done')
    expect(await subjects(repo)).toEqual(['c1', 'c2', 'base'])
    expect(await git(repo, ['show', 'feature:a.txt'])).toBe('1 fixed\n')
    expect(await git(repo, ['ls-tree', '--name-only', 'feature'])).not.toContain('d.txt')
    expect((await git(repo, ['branch', '--show-current'])).trim()).toBe('feature') // switched to the branch
    expect(undoState(repo).undo).toBe('Interactive rebase of feature')
    await undo(repo)
    expect(await rev(repo, 'feature')).toBe(before)
    expect((await git(repo, ['branch', '--show-current'])).trim()).toBe('main')
  })

  it('rewords and squashes with the messages given, keeping lines that start with #', async () => {
    const { repo, shas } = await setup()
    await run(repo, items(shas, [[0, 'reword', 'feat: one\n\n#12 explained'], [1, 'squash', 'feat: two'], [2, 'pick'], [3, 'reword', 'chore: debug']]))
    expect(await subjects(repo)).toEqual(['chore: debug', 'c3', 'feat: one', 'base'])
    expect((await git(repo, ['log', '-1', '--format=%B', 'feature~2'])).trim()).toBe('feat: one\n\n#12 explained\n\nfeat: two')
    expect(await git(repo, ['ls-tree', '--name-only', 'feature~2'])).toContain('b.txt')
  })

  it('stops on conflicts, then continue finishes it (messages included) and journals it once', async () => {
    const { repo, shas } = await setup()
    // c3 rewrites the line c1 created: replaying it first conflicts.
    let outcome = await run(repo, items(shas, [[2, 'reword', 'fix: first'], [0, 'pick'], [1, 'pick'], [3, 'pick']]))
    expect(outcome).toBe('conflicts')
    expect(undoState(repo).undo).toBeNull()
    // c3 on base conflicts, then c1 on c3's result.
    for (const content of ['1 fixed\n', 'one\n']) {
      expect(outcome).toBe('conflicts')
      await write(repo, 'a.txt', content)
      await stage(repo, ['a.txt'])
      outcome = await continueOperation(repo)
    }
    expect(outcome).toBe('done')
    expect((await getStatus(repo)).operation).toBeNull()
    expect(await subjects(repo)).toEqual(['wip: debug', 'c2', 'c1', 'fix: first', 'base'])
    expect(undoState(repo).undo).toBe('Interactive rebase of feature')
  })

  it('validates the list of commits and the actions', async () => {
    const { repo, shas } = await setup()
    await expect(run(repo, items(shas, [[0, 'pick'], [1, 'pick'], [2, 'pick']]))).rejects.toThrow('The list of commits changed: reload the interactive rebase')
    await expect(run(repo, items(shas, [[0, 'squash'], [1, 'pick'], [2, 'pick'], [3, 'pick']]))).rejects.toThrow('The first commit cannot be squashed or fixed up: pick it or reword it')
    await expect(run(repo, items(shas, [[0, 'drop'], [1, 'drop'], [2, 'drop'], [3, 'drop']]))).rejects.toThrow('Keep at least one commit')
    await expect(run(repo, items(shas, [[0, 'edit' as RebaseAction], [1, 'pick'], [2, 'pick'], [3, 'pick']]))).rejects.toThrow('Invalid action: edit')
    await expect(run(repo, items(shas, [[0, 'reword', ' '], [1, 'pick'], [2, 'pick'], [3, 'pick']]))).rejects.toThrow('Empty commit message')
    expect(await subjects(repo)).toEqual(['wip: debug', 'c3', 'c2', 'c1', 'base'])
  })

  it('stashes local changes when asked', async () => {
    const { repo, shas } = await setup()
    await write(repo, 'n.txt', 'local\n')
    await stage(repo, ['n.txt'])
    await expect(run(repo, items(shas, [[0, 'pick'], [1, 'pick'], [2, 'pick'], [3, 'drop']]))).rejects.toThrow()
    expect(await run(repo, items(shas, [[0, 'pick'], [1, 'pick'], [2, 'pick'], [3, 'drop']]), true)).toBe('done')
    expect(await subjects(repo)).toEqual(['c3', 'c2', 'c1', 'base'])
    expect(existsSync(join(repo, 'd.txt'))).toBe(false)
    expect(await read(repo, 'n.txt')).toBe('local\n')
  })
})

describe('push', () => {
  it('pushes with --force-with-lease only when asked', async () => {
    const remote = await tempDir()
    await git(remote, ['init', '-q', '--bare', '-b', 'main'])
    const repo = await makeRepo()
    await write(repo, 'a.txt', 'a\n')
    await commitAll(repo, 'a')
    await git(repo, ['remote', 'add', 'origin', remote])
    await push(repo)
    await git(repo, ['commit', '-q', '--amend', '-m', 'a, amended'])
    await expect(push(repo)).rejects.toThrow(/rejected/)
    await push(repo, true)
    expect((await git(remote, ['log', '-1', '--format=%s', 'main'])).trim()).toBe('a, amended')
    expect(await read(repo, 'a.txt')).toBe('a\n')
  })
})

describe('hardening', () => {
  it('never runs a command smuggled in a commit body', async () => {
    const { repo, shas } = await setup()
    const marker = join(await tempDir(), 'pwned')
    await git(repo, ['switch', '-q', 'feature'])
    await write(repo, 'e.txt', 'e\n')
    await git(repo, ['add', '-A'])
    await git(repo, ['commit', '-q', '-m', 'evil', '-m', `x\x1e${shas[0]}\nexec touch ${marker}\x1f y\x1f z`])
    await git(repo, ['switch', '-q', 'main'])
    const plan = await rebaseCommits(repo, 'feature', 'main')
    expect(plan.commits).toHaveLength(5)
    const list = plan.commits.map((c) => ({ sha: c.sha, action: 'pick' as RebaseAction })).reverse()
    await run(repo, list)
    expect(existsSync(marker)).toBe(false)
  })

  it('rewords with an apostrophe in the message and the git dir path, and rejects NUL and huge messages', async () => {
    const { repo, shas } = await setup()
    await expect(run(repo, items(shas, [[0, 'reword', 'a\0b'], [1, 'pick'], [2, 'pick'], [3, 'pick']]))).rejects.toThrow('Invalid commit message')
    await expect(run(repo, items(shas, [[0, 'reword', 'x'.repeat(70000)], [1, 'pick'], [2, 'pick'], [3, 'pick']]))).rejects.toThrow('too long')
    expect(await run(repo, items(shas, [[0, 'reword', "it's fine"], [1, 'pick'], [2, 'pick'], [3, 'pick']]))).toBe('done')
    expect((await git(repo, ['log', '-1', '--format=%s', 'feature~3'])).trim()).toBe("it's fine")
  })

  it('keeps the previous message when a reworded commit is dropped as empty', async () => {
    const repo = await makeRepo()
    await write(repo, 'a.txt', 'base\n')
    await commitAll(repo, 'base')
    await git(repo, ['switch', '-q', '-c', 'topic'])
    await write(repo, 'a2.txt', 'a\n')
    await commitAll(repo, 'A original')
    await write(repo, 'x.txt', 'x\n')
    await commitAll(repo, 'B original')
    await git(repo, ['switch', '-q', 'main'])
    await write(repo, 'x.txt', 'x\n')
    await commitAll(repo, 'main adds x')
    const shas = (await git(repo, ['rev-list', '--reverse', 'main..topic'])).trim().split('\n')
    expect(await interactiveRebase(repo, { branch: 'topic', upstream: 'main', items: items(shas, [[0, 'pick'], [1, 'reword', 'B reworded']]), autostash: false })).toBe('done')
    expect(await subjects(repo, 'topic')).toEqual(['A original', 'main adds x', 'base'])
  })

  it('journals a rebase that stops without conflicts once continued, and undo restores the branch', async () => {
    const { repo, shas } = await setup()
    const before = await rev(repo, 'feature')
    await git(repo, ['config', 'commit.gpgsign', 'true'])
    await git(repo, ['config', 'gpg.program', 'false']) // the amend of the reword cannot sign: the rebase stops
    await expect(run(repo, items(shas, [[0, 'reword', 'c1 reworded'], [1, 'pick'], [2, 'pick'], [3, 'pick']]))).rejects.toThrow()
    expect((await getStatus(repo)).operation).toBe('rebase')
    await git(repo, ['config', 'commit.gpgsign', 'false'])
    await git(repo, ['rebase', '--edit-todo']).catch(() => undefined)
    expect(await continueOperation(repo)).toBe('done')
    expect(undoState(repo).undo).toBe('Interactive rebase of feature')
    await undo(repo)
    expect(await rev(repo, 'feature')).toBe(before)
  })

  it('refuses to autostash when unticked even if rebase.autoStash is set', async () => {
    const { repo, shas } = await setup()
    await git(repo, ['config', 'rebase.autoStash', 'true'])
    await git(repo, ['switch', '-q', 'feature'])
    await write(repo, 'a.txt', 'local change\n')
    await expect(run(repo, items(shas, [[0, 'pick'], [1, 'pick'], [2, 'pick'], [3, 'drop']]))).rejects.toThrow()
    expect(await read(repo, 'a.txt')).toBe('local change\n')
  })
})
