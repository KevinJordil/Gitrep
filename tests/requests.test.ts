import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { FAKE_TOKEN, startFakeForge, type FakeForge } from '../e2e/fakeForge'
import { saveAccount, type Vault } from '../src/main/accounts'
import { git } from '../src/main/git'
import { forgeInfo, postStep, type ForgeContext } from '../src/main/requests'
import type { ReviewComment } from '../src/shared/types'
import { commitAll, makeRepo, tempDir, write } from './helpers'

const vault: Vault = { unavailable: () => null, encrypt: (t) => Buffer.from(t).reverse(), decrypt: (b) => Buffer.from(b).reverse().toString() }
// A post the forge refuses on purpose: it verifies the head and posts nothing, so the calls that follow are only the posts.
const prime = (repo: string, branch: string, ctx: ForgeContext) => postStep(repo, branch, 'd'.repeat(40), false, { kind: 'summary', body: 'x' }, ctx).catch(() => undefined)
const ADDED: ReviewComment = { path: 'a.c', oldPath: 'a.c', newLine: 3, oldLine: null, body: 'Off by one' }
const CONTEXT: ReviewComment = { path: 'a.c', oldPath: 'a.c', newLine: 5, oldLine: 4, body: 'Context line' }
const DELETED: ReviewComment = { path: 'a.c', oldPath: 'a.c', newLine: null, oldLine: 2, body: 'Why removed?' }

describe('merge and pull requests', () => {
  let fake: FakeForge
  let repo: string
  let head: string
  let ctx: ForgeContext
  beforeAll(async () => {
    fake = await startFakeForge()
    repo = await makeRepo()
    await write(repo, 'a.c', 'one\n')
    await commitAll(repo, 'init')
    await git(repo, ['switch', '-q', '-c', 'feature'])
    await write(repo, 'a.c', 'one\ntwo\n')
    await commitAll(repo, 'two')
    head = (await git(repo, ['rev-parse', 'HEAD'])).trim()
    await git(repo, ['remote', 'add', 'origin', `${fake.url}/team/sub/alpha.git`])
    await git(repo, ['remote', 'add', 'hub', `http://localhost:${fake.port}/acme/beta.git`])
    await git(repo, ['update-ref', 'refs/remotes/hub/topic', head])
    ctx = { accountsFile: join(await tempDir(), 'accounts.json'), vault, chosen: { '127.0.0.1': 'gitlab', localhost: 'github' } }
    fake.mrs.push({ project: 'team/sub/alpha', iid: 7, title: 'Add two', source: 'feature', target: 'main', author: 'Kim', sha: head, base: 'b'.repeat(40) })
    fake.prs.push({ repo: 'acme/beta', number: 45, title: 'Topic', owner: 'acme', branch: 'topic', base: 'main', author: 'octo', sha: head })
  })
  afterAll(() => fake.close())

  it('reports the forge without calling it while no account exists', async () => {
    expect(await forgeInfo(repo, 'feature', ctx)).toEqual({ host: '127.0.0.1', kind: 'gitlab', project: 'team/sub/alpha', url: fake.url, account: null, request: null, error: null })
    expect(await forgeInfo(repo, 'feature', { ...ctx, chosen: {} })).toMatchObject({ kind: null })
    expect(fake.calls).toEqual([])
  })

  it('finds the open merge request of a branch and posts inline discussions with their position', async () => {
    await saveAccount(ctx.accountsFile, vault, '127.0.0.1', 'gitlab', fake.url, FAKE_TOKEN)
    const info = await forgeInfo(repo, 'feature', ctx)
    expect(info?.request).toEqual({ number: 7, title: 'Add two', author: 'Kim', target: 'main', url: 'http://gitlab.test/team/sub/alpha/-/merge_requests/7', head })
    expect(fake.calls.map((c) => c.path)).toContain('/projects/team%2Fsub%2Falpha/merge_requests/7')
    expect(fake.calls.map((c) => c.path)).toContain('/projects/team%2Fsub%2Falpha/merge_requests?state=opened&source_branch=feature&per_page=20&order_by=updated_at&sort=desc')
    await prime(repo, 'feature', ctx)
    fake.calls.length = 0
    for (const comment of [ADDED, CONTEXT, DELETED]) await postStep(repo, 'feature', head, false, { kind: 'comment', comment }, ctx)
    await postStep(repo, 'feature', head, false, { kind: 'summary', body: 'Summary' }, ctx)
    const refs = { position_type: 'text', base_sha: 'b'.repeat(40), start_sha: 'b'.repeat(40), head_sha: head, old_path: 'a.c', new_path: 'a.c' }
    expect(fake.calls.map((c) => [c.path, c.body])).toEqual([
      ['/projects/team%2Fsub%2Falpha/merge_requests/7/discussions', { body: 'Off by one', position: { ...refs, new_line: 3 } }],
      ['/projects/team%2Fsub%2Falpha/merge_requests/7/discussions', { body: 'Context line', position: { ...refs, new_line: 5, old_line: 4 } }],
      ['/projects/team%2Fsub%2Falpha/merge_requests/7/discussions', { body: 'Why removed?', position: { ...refs, old_line: 2 } }],
      ['/projects/team%2Fsub%2Falpha/merge_requests/7/notes', { body: 'Summary' }]
    ])
  })

  it('ignores merge requests from a fork', async () => {
    fake.mrs.unshift({ project: 'team/sub/alpha', iid: 8, title: 'From a fork', source: 'feature', target: 'main', author: 'Lee', sha: head, base: 'b'.repeat(40), fork: true })
    expect((await forgeInfo(repo, 'feature', ctx))?.request?.number).toBe(7)
    fake.mrs.shift()
    await prime(repo, 'feature', ctx) // the next tests post to the primed request
    fake.calls.length = 0
  })

  it('drafts on GitLab, then publishes all at once', async () => {
    fake.calls.length = 0
    await postStep(repo, 'feature', head, true, { kind: 'comment', comment: ADDED }, ctx)
    await postStep(repo, 'feature', head, true, { kind: 'summary', body: 'Summary' }, ctx)
    await postStep(repo, 'feature', head, true, { kind: 'publish' }, ctx)
    expect(fake.calls.map((c) => c.path.split('/merge_requests/7')[1])).toEqual(['/draft_notes', '/draft_notes', '/draft_notes/bulk_publish'])
    expect(fake.calls[0].body).toMatchObject({ note: 'Off by one', position: { position_type: 'text', new_line: 3, new_path: 'a.c' } })
    expect(fake.calls[1].body).toEqual({ note: 'Summary' })
  })

  it('refuses to post when the request moved since the review, or with bad input', async () => {
    await expect(postStep(repo, 'feature', 'c'.repeat(40), false, { kind: 'summary', body: 'x' }, ctx)).rejects.toThrow(`HEAD_MOVED: The request is at ${head.slice(0, 7)} but the review was made on ccccccc`)
    await expect(postStep(repo, 'feature', head, false, { kind: 'comment', comment: { ...ADDED, newLine: 0 } }, ctx)).rejects.toThrow('Invalid comment position')
    await expect(postStep(repo, 'feature', head, false, { kind: 'comment', comment: { ...ADDED, body: '  ' } }, ctx)).rejects.toThrow('Empty comment')
    await expect(forgeInfo(repo, 'nope', ctx)).rejects.toThrow('Unknown branch: nope')
  })

  it('finds the pull request of a remote branch on GitHub and posts comments, a summary review, or one pending review', async () => {
    await saveAccount(ctx.accountsFile, vault, 'localhost', 'github', `http://localhost:${fake.port}`, FAKE_TOKEN)
    const info = await forgeInfo(repo, 'hub/topic', ctx)
    expect(info).toMatchObject({ host: 'localhost', kind: 'github', project: 'acme/beta', request: { number: 45, target: 'main', head } })
    await prime(repo, 'hub/topic', ctx)
    fake.calls.length = 0
    await postStep(repo, 'hub/topic', head, false, { kind: 'comment', comment: ADDED }, ctx)
    await postStep(repo, 'hub/topic', head, false, { kind: 'comment', comment: DELETED }, ctx)
    await postStep(repo, 'hub/topic', head, false, { kind: 'summary', body: 'Summary' }, ctx)
    await postStep(repo, 'hub/topic', head, true, { kind: 'review', body: 'Summary', comments: [ADDED, CONTEXT] }, ctx)
    expect(fake.calls.map((c) => [c.path, c.body])).toEqual([
      ['/repos/acme/beta/pulls/45/comments', { commit_id: head, path: 'a.c', line: 3, side: 'RIGHT', body: 'Off by one' }],
      ['/repos/acme/beta/pulls/45/comments', { commit_id: head, path: 'a.c', line: 2, side: 'LEFT', body: 'Why removed?' }],
      ['/repos/acme/beta/pulls/45/reviews', { commit_id: head, body: 'Summary', event: 'COMMENT' }],
      ['/repos/acme/beta/pulls/45/reviews', { commit_id: head, body: 'Summary', comments: [{ path: 'a.c', line: 3, side: 'RIGHT', body: 'Off by one' }, { path: 'a.c', line: 5, side: 'RIGHT', body: 'Context line' }] }]
    ])
  })

  it('asks the forge again on the first post and refuses when the request moved meanwhile', async () => {
    await forgeInfo(repo, 'feature', ctx)
    fake.mrs[0].sha = 'e'.repeat(40)
    fake.calls.length = 0
    await expect(postStep(repo, 'feature', head, false, { kind: 'summary', body: 'x' }, ctx)).rejects.toThrow('The request is at eeeeeee')
    expect(fake.calls.every((c) => c.method === 'GET')).toBe(true)
    fake.mrs[0].sha = head
  })

  it('surfaces the lookup error at post time and caps the review size', async () => {
    await forgeInfo(repo, 'feature', ctx)
    fake.fail.push({ match: 'merge_requests', status: 401, message: 'bad token', times: 1 })
    await expect(postStep(repo, 'feature', head, false, { kind: 'summary', body: 'x' }, ctx)).rejects.toThrow('rejected the token (401)')
    await expect(postStep(repo, 'hub/topic', head, true, { kind: 'review', body: 'S', comments: Array(201).fill(ADDED) }, ctx)).rejects.toThrow('Unknown step')
    await expect(postStep(repo, 'hub/topic', head, true, null as never, ctx)).rejects.toThrow('Unknown step')
    await expect(postStep(repo, 'hub/topic', head, true, { kind: 'review', body: 'x'.repeat(20001), comments: [] }, ctx)).rejects.toThrow('limited to')
  })

  it('keeps the review working when the lookup fails', async () => {
    fake.fail.push({ match: 'merge_requests', status: 500, message: 'boom', times: 1 })
    expect(await forgeInfo(repo, 'feature', ctx)).toMatchObject({ request: null, error: 'GitLab (127.0.0.1) answered 500: boom' })
  })
})
