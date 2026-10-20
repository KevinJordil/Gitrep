import { hasConflictMarkers } from '../shared/conflicts'
import type { Confidence, ConflictHunk, ConflictSuggestion, RebaseAction, RebaseCommit, RebaseItem, RebaseProposal } from '../shared/types'
import { askClaude, filterNumstat, isSensitive, MAX_DIFF_CHARS, type ClaudeOptions } from './claude'
import { getOperationInfo } from './conflicts'
import { git } from './git'
import { rebaseCommits, validateItems } from './rebase'
import { getStatus, RO } from './repo'

const MAX_HUNKS = 50
const CONFIDENCE: readonly Confidence[] = ['high', 'medium', 'low']
const strings = (x: unknown): string[] => (Array.isArray(x) ? x.map(String) : [])

export const CONFLICT_SYSTEM_PROMPT = [
  'You resolve git conflicts.',
  'For each numbered conflict you get the lines before it, the upper version, the common ancestor (base) when known, the lower version and the lines after it.',
  'Write the lines that replace the whole conflict: keep the intent of both sides when they are compatible, otherwise pick what fits the surrounding code. Never output conflict markers.',
  'For each conflict, output exactly:',
  '=== conflict <n>',
  'confidence: high|medium|low',
  'summary: <a few words>',
  'explanation: <one or two sentences>',
  '--- resolution',
  '<the resolved lines, possibly none>',
  '=== end',
  'No markdown, no code fences, nothing else.'
].join('\n')

// Claude's sections, by conflict number (null: none, or unusable). Throws when nothing could be read.
export function parseSuggestions(out: string, count: number): (ConflictSuggestion | null)[] {
  const result: (ConflictSuggestion | null)[] = Array(count).fill(null)
  let found = false
  let n = -1
  let lines: string[] | null = null
  let fields: Record<string, string> = {}
  for (const line of out.split('\n')) {
    const start = /^=== conflict (\d+)\s*$/.exec(line)
    if (start) {
      n = Number(start[1]) - 1
      lines = null
      fields = {}
    } else if (n < 0) continue
    else if (line.trim() === '=== end') {
      found = true
      const confidence = CONFIDENCE.find((c) => c === fields.confidence?.toLowerCase()) ?? 'low'
      if (n < count && lines && !hasConflictMarkers(lines.join('\n'))) result[n] = { lines, confidence, summary: fields.summary ?? '', explanation: fields.explanation ?? '' }
      n = -1
    } else if (lines) lines.push(line)
    else if (line.trim() === '--- resolution') lines = []
    else {
      const field = /^(confidence|summary|explanation):\s*(.*)$/.exec(line)
      if (field) fields[field[1]] = field[2].trim()
    }
  }
  if (!found) throw new Error("Claude's answer could not be read: try again")
  return result
}

const section = (title: string, lines: string[]) => [`--- ${title}`, ...lines]

// Proposals for the conflict blocks of one file, in block order. Only a proposal: nothing is written.
export async function suggestConflict(repo: string, path: string, hunks: ConflictHunk[], opts: ClaudeOptions): Promise<(ConflictSuggestion | null)[]> {
  const file = String(path)
  if (isSensitive(file)) throw new Error(`${file} is a sensitive file: it is never sent to Claude.`)
  if (!(await getStatus(repo)).conflicted.some((f) => f.path === file)) throw new Error(`Not a conflicted file: ${file}`)
  if (!Array.isArray(hunks) || !hunks.length || hunks.length > MAX_HUNKS) throw new Error('Nothing to resolve in this file')
  const info = await getOperationInfo(repo)
  const input = [
    `File: ${file}`,
    `Operation: ${info.operation ?? 'stash apply'}`,
    `Upper side: ${info.ours.name} (${info.ours.detail})`,
    `Lower side: ${info.theirs.name} (${info.theirs.detail})`,
    ...hunks.flatMap((h, i) => [
      '',
      `=== conflict ${i + 1}`,
      ...section('before', strings(h?.before)),
      ...section(`upper (${info.ours.name})`, strings(h?.ours)),
      ...(Array.isArray(h?.base) ? section('base', strings(h.base)) : ['--- base: unknown']),
      ...section(`lower (${info.theirs.name})`, strings(h?.theirs)),
      ...section('after', strings(h?.after))
    ])
  ].join('\n')
  if (input.length > MAX_DIFF_CHARS) throw new Error('This conflict is too large to send to Claude: resolve it here or hand it over to Claude Code.')
  const out = await askClaude(opts, CONFLICT_SYSTEM_PROMPT, `Resolve the ${hunks.length} conflict${hunks.length === 1 ? '' : 's'} provided on stdin.`, input)
  return parseSuggestions(out, hunks.length)
}

export const REBASE_SYSTEM_PROMPT = [
  'You plan interactive git rebases that tidy a branch before it is shared.',
  'You get the commits of the branch, oldest first, with their message and the files they change.',
  'Output the new todo list, oldest first, one line per commit, every commit exactly once:',
  'pick <sha> <subject>  keeps the commit',
  'reword <sha> <new subject>  keeps it with a clearer subject',
  'squash <sha>  melds it into the previous kept commit, keeping both messages',
  'fixup <sha>  melds it into the previous kept commit, dropping its message',
  'drop <sha>  removes it (debug code, work reverted later)',
  'You may reorder lines, for example to put a fix right after the commit it fixes. The first line must be pick or reword. Match the style of the recent subjects.',
  'Then a line with only ---, then two or three sentences explaining the plan.',
  'No markdown, no code fences.'
].join('\n')

const ACTION_LINE = /^(pick|reword|squash|fixup|drop)\s+([0-9a-f]{4,40})\b\s*(.*)$/

// Claude's todo list mapped onto the commits (oldest first); every commit exactly once, else an error.
export function parseRebasePlan(out: string, commits: RebaseCommit[]): RebaseProposal {
  const invalid = () => new Error("Claude's plan does not use every commit exactly once: try again")
  const [todo, ...rest] = out.split(/^---\s*$/m)
  const items: RebaseItem[] = []
  for (const line of todo.split('\n')) {
    const m = ACTION_LINE.exec(line.trim())
    if (!m) continue
    const found = commits.filter((c) => c.sha.startsWith(m[2]))
    if (found.length !== 1 || items.some((i) => i.sha === found[0].sha)) throw invalid()
    const c = found[0]
    const subject = m[3].trim()
    const action = m[1] as RebaseAction
    if (action !== 'reword') items.push({ sha: c.sha, action })
    else if (subject && subject !== c.subject) items.push({ sha: c.sha, action, message: c.body ? `${subject}\n\n${c.body}` : subject })
    else items.push({ sha: c.sha, action: 'pick' })
  }
  if (items.length !== commits.length) throw invalid()
  validateItems(commits, items)
  return { items, explanation: rest.join('---').trim() }
}

// A rebase plan for the branch, applied by the renderer to its list for review. Commit contents are not sent: messages and file stats only.
export async function proposeRebase(repo: string, branch: string, upstream: string, opts: ClaudeOptions): Promise<RebaseProposal> {
  const plan = await rebaseCommits(repo, String(branch), String(upstream))
  const oldest = [...plan.commits].reverse()
  const [recent, ...stats] = await Promise.all([
    git(repo, [...RO, 'log', '-20', '--format=%s', plan.onto]),
    ...oldest.map((c) => git(repo, [...RO, 'diff-tree', '-r', '--no-commit-id', '--numstat', '--no-renames', c.sha]))
  ])
  const files = (numstat: string) =>
    filterNumstat(numstat)
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        const [add, del, ...path] = l.split('\t')
        return path.length ? `${path.join('\t')} (+${add} -${del})` : l
      })
      .join(', ')
  const input = [
    'Recent commit subjects before the branch (style reference):',
    recent.split('\n').filter(Boolean).map((s) => `- ${s}`).join('\n') || '(none)',
    '',
    `Commits of ${plan.branch} after ${plan.ontoLabel}, oldest first:`,
    ...oldest.flatMap((c, i) => [
      '',
      `commit ${c.sha.slice(0, 7)} ${c.subject}`,
      ...(c.body ? [`  message: ${c.body.split('\n').filter((l) => l.trim()).slice(0, 20).join(' / ')}`] : []),
      `  files: ${files(stats[i]) || '(none shown)'}`
    ])
  ].join('\n')
  if (input.length > MAX_DIFF_CHARS) throw new Error('Too many commits to send to Claude: plan this rebase by hand')
  const out = await askClaude(opts, REBASE_SYSTEM_PROMPT, 'Plan the interactive rebase of the commits provided on stdin.', input)
  return parseRebasePlan(out, plan.commits)
}
