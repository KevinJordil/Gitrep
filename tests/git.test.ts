import { describe, expect, it } from 'vitest'
import { git, GitError, serialized } from '../src/main/git'
import { makeRepo } from './helpers'

describe('git', () => {
  it('returns stdout', async () => {
    expect(await git(process.cwd(), ['--version'])).toMatch(/^git version/)
  })

  it('throws a GitError carrying args, stderr and exit code', async () => {
    const repo = await makeRepo()
    const err = await git(repo, ['rev-parse', 'nope']).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(GitError)
    expect((err as GitError).message).toContain('git rev-parse nope')
    expect((err as GitError).code).toBe(128)
  })

  it('treats okCodes as success', async () => {
    const repo = await makeRepo()
    await expect(git(repo, ['rev-parse', '--verify', '-q', 'HEAD'], { okCodes: [1] })).resolves.toBe('')
  })

  it('passes input on stdin', async () => {
    const repo = await makeRepo()
    const sha = (await git(repo, ['hash-object', '--stdin'], { input: 'hello\n' })).trim()
    expect(sha).toBe('ce013625030ba8dba906f756967f9e9ca394464a')
  })
})

describe('serialized', () => {
  it('runs tasks with the same key one after another', async () => {
    const order: number[] = []
    const slow = serialized('k', async () => {
      await new Promise((r) => setTimeout(r, 30))
      order.push(1)
    })
    const fast = serialized('k', async () => {
      order.push(2)
    })
    await Promise.all([slow, fast])
    expect(order).toEqual([1, 2])
  })

  it('keeps the queue alive after a failure', async () => {
    await serialized('k2', async () => {
      throw new Error('boom')
    }).catch(() => undefined)
    await expect(serialized('k2', async () => 42)).resolves.toBe(42)
  })
})
