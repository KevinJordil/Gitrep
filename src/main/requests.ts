import type { AccountInfo, ForgeInfo, ForgeKind, ForgeRequest, PostStep, ReviewComment } from '../shared/types'
import { accountFor, listAccounts, type Vault } from './accounts'
import { defaultUrl, forgeKind, forgeRequest, parseRemote } from './forge'
import { git } from './git'
import { getBranches, RO } from './repo'

export interface ForgeContext {
  accountsFile: string
  vault: Vault
  chosen: Record<string, ForgeKind> // settings.forgeHosts
}

interface DiffRefs {
  base_sha: string
  start_sha: string
  head_sha: string
}

// The request found for a branch, kept for the posts that follow (one lookup per review, not per comment).
interface Target {
  account: AccountInfo
  project: string
  request: ForgeRequest | null
  refs: DiffRefs | null // GitLab only
  verified: number // when a post last checked the forge head, 0 before
}

const targets = new Map<string, Target>()
const VERIFY_TTL = 30_000 // a post within this delay of the last check trusts it
const MAX_COMMENTS = 200
const MAX_BODY = 20_000
const key = (repo: string, branch: string) => `${repo}\0${branch}`

// The remote a branch lives on and its name there: a remote-tracking branch's own remote, a local branch's upstream, else origin.
async function remoteOf(repo: string, branch: string): Promise<{ remote: string; name: string } | null> {
  const b = (await getBranches(repo)).find((x) => x.name === branch)
  if (!b) throw new Error(`Unknown branch: ${branch}`)
  const remotes = (await git(repo, [...RO, 'remote'])).split('\n').filter(Boolean)
  const split = (full: string) => {
    const remote = remotes.filter((r) => full.startsWith(`${r}/`)).sort((x, y) => y.length - x.length)[0]
    return remote ? { remote, name: full.slice(remote.length + 1) } : null
  }
  if (b.remote) return split(b.name)
  const up = b.upstream ? split(b.upstream) : null
  if (up) return up
  const remote = remotes.includes('origin') ? 'origin' : remotes[0]
  return remote ? { remote, name: b.name } : null
}

interface GitLabMr {
  iid: number
  title: string
  target_branch: string
  web_url: string
  sha: string
  author?: { username?: string; name?: string }
  diff_refs?: DiffRefs | null
  source_project_id?: number
  target_project_id?: number
}

interface GitHubPr {
  number: number
  title: string
  html_url: string
  user?: { login?: string }
  base: { ref: string }
  head: { sha: string }
}

const segments = (project: string) => project.split('/').map(encodeURIComponent).join('/')

async function lookup(account: AccountInfo, token: string, project: string, name: string): Promise<Pick<Target, 'request' | 'refs'>> {
  if (account.kind === 'gitlab') {
    const base = `/projects/${encodeURIComponent(project)}/merge_requests`
    const all = await forgeRequest<GitLabMr[]>(account, token, 'GET', `${base}?state=opened&source_branch=${encodeURIComponent(name)}&per_page=20&order_by=updated_at&sort=desc`)
    // Merge requests from forks are not looked up; the most recently updated of the others is the one reviewed.
    const list = all.filter((m) => m.source_project_id === m.target_project_id)
    if (!list.length) return { request: null, refs: null }
    // The list has no diff_refs: they come with the single merge request.
    const mr = await forgeRequest<GitLabMr>(account, token, 'GET', `${base}/${list[0].iid}`)
    const refs = mr.diff_refs ?? null
    return { request: { number: mr.iid, title: mr.title, author: mr.author?.name || mr.author?.username || '', target: mr.target_branch, url: mr.web_url, head: refs?.head_sha ?? mr.sha }, refs }
  }
  // Pull requests from the same repository only (head owner = project owner): fork pull requests are not looked up.
  const owner = project.split('/')[0]
  const list = await forgeRequest<GitHubPr[]>(account, token, 'GET', `/repos/${segments(project)}/pulls?state=open&head=${encodeURIComponent(`${owner}:${name}`)}&per_page=20&sort=updated&direction=desc`)
  const pr = list[0] // the most recently updated

  return { request: pr ? { number: pr.number, title: pr.title, author: pr.user?.login ?? '', target: pr.base.ref, url: pr.html_url, head: pr.head.sha } : null, refs: null }
}

// The forge of the branch's remote and, when an account exists, the open request. verified: 0 for a display lookup, else when a post checks it (a failed lookup then throws).
async function resolve(repo: string, branch: string, ctx: ForgeContext, verified = 0): Promise<ForgeInfo | null> {
  const where = await remoteOf(repo, branch)
  if (!where) return null
  const remote = parseRemote((await git(repo, [...RO, 'remote', 'get-url', where.remote])).trim())
  if (!remote) return null
  const account = listAccounts(ctx.accountsFile).find((a) => a.host === remote.host) ?? null
  const info: ForgeInfo = { host: remote.host, kind: account?.kind ?? forgeKind(remote.host, ctx.chosen), project: remote.project, url: account?.url ?? defaultUrl(remote), account, request: null, error: null }
  targets.delete(key(repo, branch)) // a failed or empty lookup leaves nothing to post to
  const found = account && accountFor(ctx.accountsFile, ctx.vault, account.host)
  if (!found) return info
  try {
    const t = await lookup(found.account, found.token, remote.project, where.name)
    if (t.request) targets.set(key(repo, branch), { account: found.account, project: remote.project, ...t, verified })
    info.request = t.request
  } catch (e) {
    if (verified) throw e
    info.error = e instanceof Error ? e.message : String(e)
  }
  return info
}

export const forgeInfo = (repo: string, branch: string, ctx: ForgeContext) => resolve(repo, String(branch), ctx)

const isLine = (v: unknown) => v === null || (Number.isInteger(v) && (v as number) > 0)

function body(text: unknown): string {
  const b = String(text ?? '').trim()
  if (!b) throw new Error('Empty comment')
  if (b.length > MAX_BODY) throw new Error(`A comment is limited to ${MAX_BODY} characters`)
  return b
}

function comment(c: ReviewComment): ReviewComment {
  if (!c || typeof c.path !== 'string' || !c.path || typeof c.oldPath !== 'string' || !c.oldPath || !isLine(c.newLine) || !isLine(c.oldLine) || (c.newLine === null && c.oldLine === null)) throw new Error('Invalid comment position')
  return { path: c.path, oldPath: c.oldPath, newLine: c.newLine, oldLine: c.oldLine, body: body(c.body) }
}

// GitLab: the new side of an added line, the old side of a deleted line, both for a context line.
const position = (c: ReviewComment, refs: DiffRefs) => ({
  position_type: 'text',
  base_sha: refs.base_sha,
  start_sha: refs.start_sha,
  head_sha: refs.head_sha,
  old_path: c.oldPath,
  new_path: c.path,
  ...(c.newLine !== null ? { new_line: c.newLine } : {}),
  ...(c.oldLine !== null ? { old_line: c.oldLine } : {})
})

const githubComment = (c: ReviewComment) => ({ path: c.newLine !== null ? c.path : c.oldPath, line: c.newLine ?? c.oldLine, side: c.newLine !== null ? 'RIGHT' : 'LEFT', body: c.body })

// Posts one step of a review. head: the commit the review was made on; the forge must still be there, or line numbers would be wrong.
export async function postStep(repo: string, branch: string, head: string, draft: boolean, step: PostStep, ctx: ForgeContext): Promise<void> {
  if (!step || typeof step !== 'object') throw new Error('Unknown step')
  let t = targets.get(key(repo, branch))
  // The first step of a review, or one long after the last check, asks the forge again: the request may have moved.
  if (!t || Date.now() - t.verified > VERIFY_TTL) {
    await resolve(repo, branch, ctx, Date.now())
    t = targets.get(key(repo, branch))
  }
  if (!t?.request) throw new Error(`No open merge or pull request found for ${branch}`)
  const req = t.request
  if (!/^[0-9a-f]{40}$/.test(String(head)) || req.head !== head) throw new Error(`HEAD_MOVED: The request is at ${req.head.slice(0, 7)} but the review was made on ${String(head).slice(0, 7)}: push or fetch, re-run the review, then post.`)
  const found = accountFor(ctx.accountsFile, ctx.vault, t.account.host)
  if (!found) throw new Error(`No account for ${t.account.host}: add one in Accounts`)
  const { account, token } = found
  const post = (path: string, data?: unknown) => forgeRequest(account, token, 'POST', path, data)
  if (account.kind === 'gitlab') {
    const base = `/projects/${encodeURIComponent(t.project)}/merge_requests/${req.number}`
    if (step.kind === 'publish') return void (await post(`${base}/draft_notes/bulk_publish`))
    if (step.kind !== 'comment') throw new Error('Unknown step')
    if (!t.refs) throw new Error('GitLab gave no diff references for this merge request: try again later')
    const c = comment(step.comment)
    return void (await post(draft ? `${base}/draft_notes` : `${base}/discussions`, draft ? { note: c.body, position: position(c, t.refs) } : { body: c.body, position: position(c, t.refs) }))
  }
  const base = `/repos/${segments(t.project)}/pulls/${req.number}`
  if (step.kind === 'comment') return void (await post(`${base}/comments`, { commit_id: head, ...githubComment(comment(step.comment)) }))
  if (step.kind !== 'review' || !Array.isArray(step.comments) || step.comments.length > MAX_COMMENTS) throw new Error('Unknown step')
  // No event: the review stays pending, for the user to submit on GitHub.
  await post(`${base}/reviews`, { commit_id: head, body: step.body ? body(step.body) : '', comments: step.comments.map((c) => githubComment(comment(c))) })
}
