import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { hasConflictMarkers } from '../shared/conflicts'
import type { ConflictFile, ConflictSide, OperationInfo, RebaseStep } from '../shared/types'
import { isSensitive } from './claude'
import { currentOperation, git, gitDir, serialized } from './git'
import { handOverCommand, run, withClaudeOnPath } from './launch'
import { getStatus, insideRepo, RO } from './repo'

const MAX_TEXT = 1024 * 1024 // Limit: bigger conflicted files are resolved by taking one side
const read = (file: string) => readFile(file, 'utf8').then((s) => s.trim(), () => '')
const short = (sha: string) => sha.slice(0, 7)

async function subject(repo: string, sha: string): Promise<string> {
  return (await git(repo, [...RO, 'log', '-1', '--format=%s', sha]).catch(() => '')).trim()
}

// Local branches first, then remote ones, pointing at a commit.
async function branchAt(repo: string, sha: string): Promise<string | null> {
  const out = await git(repo, [...RO, 'for-each-ref', '--points-at', sha, '--format=%(refname:short)', 'refs/heads', 'refs/remotes'])
  return out.split('\n').find(Boolean) ?? null
}

// Kept steps of a git-rebase-todo file (exec lines are the app's own message steps: hidden).
const STEP_ACTIONS = new Set(['pick', 'p', 'reword', 'r', 'edit', 'e', 'squash', 's', 'fixup', 'f'])
function parseSteps(text: string): { sha: string; subject: string }[] {
  return text.split('\n').flatMap((line) => {
    const words = line.trim().split(/\s+/)
    if (!STEP_ACTIONS.has(words[0])) return []
    if (words[1]?.startsWith('-')) words.splice(1, 1) // fixup -C / -c
    return words[1] ? [{ sha: words[1], subject: words.slice(2).join(' ') }] : []
  })
}

// Who is on each side of the conflict, by name (never "ours/theirs"), and the steps of a rebase.
// Upper side = stage 2 = HEAD; lower side = stage 3 = what is being merged, picked or replayed.
export async function getOperationInfo(repo: string): Promise<OperationInfo> {
  const [operation, dir, head, branch] = await Promise.all([
    currentOperation(repo),
    gitDir(repo),
    git(repo, ['rev-parse', 'HEAD']).then((s) => s.trim()),
    git(repo, ['symbolic-ref', '-q', '--short', 'HEAD'], { okCodes: [1] }).then((s) => s.trim())
  ])
  const checkedOut: ConflictSide = { name: branch || short(head), detail: `${short(head)} · checked out` }
  if (operation === 'rebase') {
    const state = join(dir, (await read(join(dir, 'rebase-merge', 'onto'))) ? 'rebase-merge' : 'rebase-apply')
    const [headName, onto, done, todo, replayed] = await Promise.all([...['head-name', 'onto', 'done', 'git-rebase-todo'].map((f) => read(join(state, f))), read(join(dir, 'REBASE_HEAD'))])
    const doneSteps = parseSteps(done)
    const lastDone = parseSteps(done.split('\n').pop() ?? '').length > 0 // stopped on that step
    const steps: RebaseStep[] = [
      ...doneSteps.map((s, i): RebaseStep => ({ ...s, state: lastDone && i === doneSteps.length - 1 ? 'current' : 'done' })),
      ...parseSteps(todo).map((s): RebaseStep => ({ ...s, state: 'todo' }))
    ]
    return {
      operation,
      ours: { name: (await branchAt(repo, onto)) ?? short(onto), detail: `${short(onto)} · the base you rebase onto` },
      theirs: { name: headName.replace(/^refs\/heads\//, '') || 'detached HEAD', detail: replayed ? `${short(replayed)} · your commit being replayed` : 'your commits being replayed' },
      steps
    }
  }
  if (operation === 'merge') {
    const [mergeHead, message] = await Promise.all([read(join(dir, 'MERGE_HEAD')), read(join(dir, 'MERGE_MSG'))])
    const sha = mergeHead.split('\n')[0]
    const named = /^Merge (?:remote-tracking )?branch '([^']+)'/.exec(message)?.[1]
    return { operation, ours: checkedOut, theirs: { name: named ?? (await branchAt(repo, sha)) ?? short(sha), detail: `${short(sha)} · being merged` }, steps: [] }
  }
  if (operation === 'cherry-pick' || operation === 'revert') {
    const sha = await read(join(dir, operation === 'cherry-pick' ? 'CHERRY_PICK_HEAD' : 'REVERT_HEAD'))
    const name = operation === 'cherry-pick' ? short(sha) : `revert of ${short(sha)}`
    return { operation, ours: checkedOut, theirs: { name, detail: await subject(repo, sha) }, steps: [] }
  }
  return { operation: null, ours: checkedOut, theirs: { name: 'stash', detail: 'stashed changes' }, steps: [] }
}

// Renderer paths must be in the repository and actually conflicted.
async function conflicted(repo: string, path: string): Promise<string> {
  const p = String(path)
  const full = insideRepo(repo, p)
  if (!(await getStatus(repo)).conflicted.some((f) => f.path === p)) throw new Error(`Not a conflicted file: ${p}`)
  return full
}

// Index stages of a conflicted path: 1 base, 2 upper side (HEAD), 3 lower side. A missing side deleted the file.
async function stages(repo: string, path: string): Promise<Set<string>> {
  const out = await git(repo, [...RO, 'ls-files', '-u', '-z', '--', path])
  return new Set(out.split('\0').filter(Boolean).map((e) => e.split('\t')[0].split(' ')[2]))
}

// git does not write markers into a binary file (it keeps the upper side): look at the two sides' blobs.
async function binaryBlob(repo: string, spec: string): Promise<boolean> {
  if (Number((await git(repo, [...RO, 'cat-file', '-s', spec])).trim()) > MAX_TEXT) return true
  return (await git(repo, [...RO, 'cat-file', 'blob', spec])).slice(0, 8000).includes('\0')
}

export async function getConflictFile(repo: string, path: string): Promise<ConflictFile> {
  const full = await conflicted(repo, path)
  const s = await stages(repo, path)
  const base = { path, ours: s.has('2'), theirs: s.has('3') }
  const buf = await readFile(full).catch(() => null)
  if (!base.ours || !base.theirs || !buf) return { ...base, kind: 'deleted', text: '' }
  const binary = (await Promise.all(['2', '3'].map((n) => binaryBlob(repo, `:${n}:${path}`)))).some(Boolean)
  if (binary || buf.length > MAX_TEXT) return { ...base, kind: 'binary', text: '' }
  const text = buf.toString('utf8')
  // Bytes that do not survive a UTF-8 round trip (Latin-1…) must not be rewritten by resolveFile.
  if (!Buffer.from(text, 'utf8').equals(buf)) return { ...base, kind: 'binary', text: '' }
  return { ...base, kind: 'text', text }
}

// Writes the resolved content (made from `source`, the file as it was read) and stages it. A result that still has markers is refused.
export async function resolveFile(repo: string, path: string, content: string, source: string): Promise<void> {
  const full = await conflicted(repo, path)
  const text = String(content)
  if (hasConflictMarkers(text)) throw new Error('The result still has conflict markers: resolve every block first')
  await serialized(repo, async () => {
    // The file the result was made from must still be the one on disk (Claude Code or an editor may have changed it).
    if ((await readFile(full, 'utf8').catch(() => null)) !== String(source)) throw new Error('The file changed on disk. Review it again.')
    await writeFile(full, text)
    await git(repo, ['add', '--', path])
  })
}

// Takes one side's whole file (binary files, delete/modify conflicts, "take all"): checkout + add, or rm when that side deleted it.
export async function resolveSide(repo: string, path: string, side: 'ours' | 'theirs'): Promise<void> {
  if (side !== 'ours' && side !== 'theirs') throw new Error(`Invalid side: ${side}`)
  await conflicted(repo, path)
  await serialized(repo, async () => {
    if (!(await stages(repo, path)).has(side === 'ours' ? '2' : '3')) return void (await git(repo, ['rm', '-q', '--', path]))
    await git(repo, ['checkout', `--${side}`, '--', path])
    await git(repo, ['add', '--', path])
  })
}

// Names, subjects and paths come from the repository: no control characters or newlines may reach the prompt.
const clean = (s: string) => s.replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 200)
const MAX_FILES = 50

// What Claude Code is told when the conflict is handed over to it in a terminal.
export function handOverContext(info: OperationInfo, files: string[]): string {
  const current = info.steps.find((s) => s.state === 'current')
  const shown = files.filter((f) => !isSensitive(f))
  const hidden = files.length - shown.length
  const listed = shown.slice(0, MAX_FILES).map(clean).join(', ') + (shown.length > MAX_FILES ? ` and ${shown.length - MAX_FILES} more` : '') + (hidden ? ` and ${hidden} other files` : '')
  return [
    `${info.operation ? `A ${info.operation} stopped on conflicts` : 'Applying a stash left conflicts'} in this git repository.`,
    `Upper side (stage 2, HEAD): ${clean(info.ours.name)} (${clean(info.ours.detail)}).`,
    `Lower side (stage 3): ${clean(info.theirs.name)} (${clean(info.theirs.detail)}).`,
    ...(current ? [`Commit being replayed: ${short(current.sha)} ${clean(current.subject)}`] : []),
    `Conflicted files: ${listed}`,
    'Resolve every conflict keeping the intent of both sides and remove the conflict markers. Build the project and run its tests, then stage each resolved file with git add.',
    'Do not commit, do not run --continue, --skip or --abort, do not push: the developer reviews the result and continues in GitRep.'
  ].join('\n')
}

// Claude Code in a terminal at the repository, started with the conflict's context as its first message.
// GITREP_TERMINAL replaces the terminal (end-to-end runs record what would be started).
export async function handOver(repo: string, claudePath: string): Promise<void> {
  const [info, status] = await Promise.all([getOperationInfo(repo), getStatus(repo)])
  if (!status.conflicted.length) throw new Error('No conflicted file to hand over')
  const context = handOverContext(info, status.conflicted.map((f) => f.path))
  const env = withClaudeOnPath(process.env, claudePath)
  const term = process.env.GITREP_TERMINAL
  if (term) return run([{ cmd: term, args: [claudePath, context] }], repo, env)
  await run(handOverCommand(process.platform, repo, claudePath, context), repo, env).catch((e) => {
    throw new Error(`Could not open a terminal for the hand-over (Linux: gnome-terminal, macOS: Terminal, Windows: Windows Terminal or cmd): ${e instanceof Error ? e.message : e}`)
  })
}
