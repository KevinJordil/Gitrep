import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { InteractiveRebaseRequest, OpOutcome, RebaseAction, RebaseCommit, RebaseItem, RebasePlan } from '../shared/types'
import { git, gitDir, serialized } from './git'
import { resolveCommit } from './history'
import { tracked } from './journal'
import { ensureIdle, mayConflict } from './ops'
import { getBranches, RO } from './repo'

const MAX_COMMITS = 200 // Limit: longer ranges are rebased in a terminal
const ACTIONS: readonly RebaseAction[] = ['pick', 'reword', 'squash', 'fixup', 'drop']
// NUL cannot appear in a commit message, so with -z the output is a flat list of fixed-size records.
const COMMIT_FORMAT = '%H%x00%s%x00%an%x00%at%x00%b'
const FIELDS = 5
const SHA = /^[0-9a-f]{40,64}$/
const MAX_MESSAGE = 64 * 1024

export const messageOf = (c: RebaseCommit): string => (c.body ? `${c.subject}\n\n${c.body}` : c.subject)

// The commits an interactive rebase of `branch` onto `upstream` replays (upstream..branch), newest first.
export async function rebaseCommits(repo: string, branch: string, upstream: string): Promise<RebasePlan> {
  const branches = await getBranches(repo)
  const local = branches.find((b) => b.name === branch && !b.remote)
  if (!local) throw new Error(`Not a local branch: ${branch}`)
  const onto = await resolveCommit(repo, upstream)
  const range = `${onto}..${local.sha}`
  const ontoLabel = branches.find((b) => b.name === upstream)?.name ?? branches.find((b) => b.sha === onto && !b.remote)?.name ?? onto.slice(0, 7)
  const [log, merges, unpushed] = await Promise.all([
    git(repo, [...RO, 'log', '-z', `--format=${COMMIT_FORMAT}`, range]),
    git(repo, [...RO, 'rev-list', '--count', '--min-parents=2', range]),
    git(repo, [...RO, 'rev-list', '--count', range, '--not', '--remotes'])
  ])
  const fields = log.split('\0')
  if (fields[fields.length - 1] === '') fields.pop()
  if (fields.length % FIELDS) throw new Error('Unexpected git log output: cannot read the commits')
  const commits: RebaseCommit[] = []
  for (let k = 0; k < fields.length; k += FIELDS) {
    const [sha, subject, author, date, body] = fields.slice(k, k + FIELDS)
    if (!SHA.test(sha.replace(/^\n/, ''))) throw new Error('Unexpected git log output: invalid commit id')
    commits.push({ sha: sha.replace(/^\n/, ''), subject, author, date: Number(date), body: body.trim() })
  }
  if (Number(merges.trim()) > 0) throw new Error('The range contains merge commits: an interactive rebase would flatten them')
  if (!commits.length) throw new Error(`Nothing to rebase: ${branch} has no commit after ${ontoLabel}`)
  if (commits.length > MAX_COMMITS) throw new Error(`Too many commits (${commits.length}): an interactive rebase here handles up to ${MAX_COMMITS}`)
  return { branch, onto, ontoLabel, commits, pushed: commits.length - Number(unpushed.trim()) }
}

// The renderer's list must be exactly the commits of the range, each with a known action and a usable message.
export function validateItems(commits: RebaseCommit[], items: RebaseItem[]): RebaseItem[] {
  const list = (Array.isArray(items) ? items : []).map((i) => ({ sha: String(i?.sha), action: i?.action, message: i?.message === undefined ? undefined : String(i.message) }))
  const wanted = commits.map((c) => c.sha).sort()
  const got = list.map((i) => i.sha).sort()
  if (wanted.length !== got.length || wanted.some((s, k) => s !== got[k])) throw new Error('The list of commits changed: reload the interactive rebase')
  for (const i of list) {
    if (!ACTIONS.includes(i.action)) throw new Error(`Invalid action: ${i.action}`)
    if (i.message !== undefined) {
      if (i.message.includes('\0')) throw new Error('Invalid commit message')
      if (i.message.length > MAX_MESSAGE) throw new Error('Commit message too long')
      if ((i.action === 'reword' || i.action === 'squash') && !i.message.trim()) throw new Error('Empty commit message')
    }
  }
  const kept = list.filter((i) => i.action !== 'drop')
  if (!kept.length) throw new Error('Keep at least one commit')
  if (kept[0].action === 'squash' || kept[0].action === 'fixup') throw new Error('The first commit cannot be squashed or fixed up: pick it or reword it')
  return list
}

const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`

// git's todo list. Squash and fixup are both written as fixup; a group whose message changes (reword, squash)
// is followed by an exec that amends it with the message from a file: git never opens an editor.
async function writeTodo(dir: string, commits: RebaseCommit[], items: RebaseItem[]): Promise<string> {
  await rm(dir, { recursive: true, force: true })
  await mkdir(dir, { recursive: true })
  const bySha = new Map(commits.map((c) => [c.sha, c]))
  const lines: string[] = []
  let group: { message: string; changed: boolean } | null = null
  let files = 0
  const close = async () => {
    if (!group?.changed) return
    const file = join(dir, `message-${++files}.txt`)
    await writeFile(file, group.message.trim() + '\n')
    lines.push(`exec git commit --amend --no-verify --cleanup=whitespace -F ${quote(file)}`)
  }
  for (const item of items) {
    const c = bySha.get(item.sha)!
    if (!SHA.test(c.sha)) throw new Error('Invalid commit id')
    const subject = c.subject.replace(/[\x00-\x1f\x7f]/g, ' ')
    if (item.action === 'drop') {
      lines.push(`drop ${c.sha} ${subject}`)
      continue
    }
    if (item.action === 'squash' || item.action === 'fixup') {
      lines.push(`fixup ${c.sha} ${subject}`)
      if (item.action === 'squash') group = { message: `${group!.message.trim()}\n\n${item.message ?? messageOf(c)}`, changed: true }
      continue
    }
    await close()
    lines.push(`pick ${c.sha} ${subject}`)
    const message = item.action === 'reword' && item.message !== undefined ? item.message : messageOf(c)
    group = { message, changed: message.trim() !== messageOf(c).trim() }
  }
  await close()
  const todo = join(dir, 'todo')
  await writeFile(todo, lines.join('\n') + '\n')
  return todo
}

// Interactive rebase of `branch` onto `upstream` with the user's list (oldest first). Journaled as one operation.
export async function interactiveRebase(repo: string, req: InteractiveRebaseRequest): Promise<OpOutcome> {
  return serialized(repo, async () => {
    await ensureIdle(repo)
    const plan = await rebaseCommits(repo, String(req?.branch), String(req?.upstream))
    const list = validateItems(plan.commits, req?.items)
    const todo = await writeTodo(join(await gitDir(repo), 'gitrep-rebase'), plan.commits, list)
    const args = ['rebase', '-i', '--empty=drop', ...(req.autostash ? ['--autostash'] : []), plan.onto, plan.branch]
    // git runs the sequence editor with its own todo file as argument: ours replaces it.
    return tracked(repo, `Interactive rebase of ${plan.branch}`, 'keep', () => mayConflict(repo, args, { GIT_SEQUENCE_EDITOR: `cp ${quote(todo)}` }))
  })
}
