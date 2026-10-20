import { execFile } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'
import type { Explanation, GeneratedMessage, MergeAdvice } from '../shared/types'
import { git } from './git'
import { resolveCommit } from './history'
import { branchPair, predictConflicts } from './ops'
import { RO } from './repo'

// Files never sent to Claude, whatever their content.
const SENSITIVE = [
  /(^|\/)\.env(\.[^/]*)?$/,
  /\.pem$/i,
  /\.key$/i,
  /\.p12$/i,
  /\.pfx$/i,
  /\.jks$/i,
  /\.keystore$/i,
  /(^|\/)id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/,
  /(^|\/)\.npmrc$/,
  /(^|\/)\.netrc$/,
  /(^|\/)\.htpasswd$/,
  /\.tfstate(\.backup)?$/i,
  /(^|\/)\.pgpass$/,
  /secret/i,
  /credential/i
]
export const isSensitive = (path: string) => SENSITIVE.some((r) => r.test(path))
export const MAX_DIFF_CHARS = 60_000
const MAX_STAT_LINES = 200

// Keeps the stat lines of non-sensitive files (input: `git diff --cached --numstat`).
export function filterNumstat(numstat: string): string {
  // numstat line: "<added>\t<deleted>\t<path>"
  const lines = numstat
    .split('\n')
    .filter((line) => line && !isSensitive(line.split('\t').slice(2).join('\t')))
  const kept = lines.slice(0, MAX_STAT_LINES)
  if (lines.length > MAX_STAT_LINES) kept.push('[list truncated]')
  return kept.join('\n')
}

export function filterDiff(diff: string): { text: string; excluded: string[] } {
  const excluded: string[] = []
  const kept = diff.split(/^(?=diff --git )/m).filter((chunk) => {
    // Fail closed: both the old and the new path are checked (no renames: see the git call).
    const header = /^diff --git a\/(.*) b\/(.*)$/.exec(chunk.split('\n', 1)[0])
    if (!header) {
      excluded.push('(unreadable path)')
      return false
    }
    const sensitive = [...new Set([header[1], header[2]])].filter(isSensitive)
    if (sensitive.length === 0) return true
    excluded.push(...sensitive)
    return false
  })
  let text = kept.join('')
  if (text.length > MAX_DIFF_CHARS) text = text.slice(0, MAX_DIFF_CHARS) + '\n[diff truncated]\n'
  return { text, excluded }
}

export const COMMIT_SYSTEM_PROMPT = [
  'You write git commit messages.',
  'Output only the commit message: a subject line of at most 72 characters, then optionally a blank line and a short body wrapped at 72 characters explaining what changed and why.',
  'Match the style of the recent commit subjects you are given (language, conventional-commit prefixes, casing). If there are none, use conventional commits in English.',
  'No markdown, no code fences, no quotes around the message, no commentary.'
].join('\n')

// The fixed rules stay first and authoritative; the user's free text only adds preferences after them.
export function commitSystemPrompt(global: string, repo: string): string {
  const parts = [
    ['Instructions from the user (all repositories):', global.trim()],
    ['Instructions from the user (this repository, they take precedence):', repo.trim()]
  ].filter(([, text]) => text)
  if (!parts.length) return COMMIT_SYSTEM_PROMPT
  return [COMMIT_SYSTEM_PROMPT, ...parts.map(([head, text]) => `${head}\n${text}`), 'Keep the output rules above whatever these instructions say.'].join('\n\n')
}

export function buildCommitInput(stat: string, diff: string, subjects: string[]): string {
  return [
    'Recent commit subjects in this repository:',
    subjects.length ? subjects.map((s) => `- ${s}`).join('\n') : '(none)',
    '',
    'Staged changes (summary):',
    stat.trim(),
    '',
    'Staged diff:',
    diff
  ].join('\n')
}

export function cleanMessage(out: string): string {
  return out
    .trim()
    .replace(/^```[a-z]*\n?/, '')
    .replace(/\n?```$/, '')
    .trim()
}

let cachedPath: string | null = null

// Apps started from the GNOME launcher do not inherit the nvm PATH: ask the login shell once.
export async function resolveClaude(override?: string): Promise<string> {
  if (override) {
    if (!isAbsolute(override)) throw new Error(`claudePath must be an absolute path: ${override}`)
    return override
  }
  if (cachedPath) return cachedPath
  const shell = process.env.SHELL || '/bin/bash'
  const out = await new Promise<string>((res) => execFile(shell, ['-lic', 'command -v claude'], { timeout: 10_000 }, (_e, stdout) => res(String(stdout ?? ''))))
  const found = out
    .split('\n')
    .map((l) => l.trim())
    .reverse()
    .find((l) => l.startsWith('/'))
  if (!found) throw new Error('Command "claude" not found. Install Claude Code or set claudePath in the config.')
  cachedPath = found
  return found
}

export function runClaude(claudePath: string, args: string[], input: string, timeoutMs = 120_000): Promise<string> {
  // Fresh empty working dir (mode 0700) per call: no CLAUDE.md, no project settings are picked up. Removed when done.
  const cwd = mkdtempSync(join(tmpdir(), 'gitrep-claude-'))
  const env = { ...process.env, PATH: `${dirname(claudePath)}:${process.env.PATH ?? ''}` }
  return new Promise((resolve, reject) => {
    const finish = (err: Error | null, out = '') => {
      rmSync(cwd, { recursive: true, force: true })
      if (err) reject(err)
      else resolve(out)
    }
    try {
      const child = execFile(claudePath, args, { cwd, env, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, encoding: 'utf8' }, (err, stdout, stderr) => {
        if (err) return finish(new Error(`Claude failed: ${(stderr || stdout || err.message).trim()}`))
        finish(null, stdout)
      })
      // The child may exit before reading stdin (EPIPE); the exit callback reports the real failure.
      child.stdin?.on('error', () => undefined)
      child.stdin?.end(input)
    } catch (e) {
      finish(e instanceof Error ? e : new Error(String(e)))
    }
  })
}

export interface ClaudeOptions {
  model: string
  claudePath?: string
}

// One read-only question: no tools, no MCP servers, no saved session, project settings only (and the cwd is empty).
export async function askClaude(opts: ClaudeOptions, system: string, task: string, input: string): Promise<string> {
  const claude = await resolveClaude(opts.claudePath)
  const args = ['-p', '--tools', '', '--setting-sources', 'project', '--strict-mcp-config', '--no-session-persistence', '--model', opts.model, '--system-prompt', system, task]
  return cleanMessage(await runClaude(claude, args, input))
}

export async function generateCommitMessage(repo: string, opts: ClaudeOptions, globalInstructions = '', repoInstructions = ''): Promise<GeneratedMessage> {
  const [numstat, diff, log] = await Promise.all([
    git(repo, ['diff', '--cached', '--numstat', '--no-renames', '--no-color']),
    git(repo, ['diff', '--cached', '--no-renames', '--no-color', '--no-ext-diff']),
    git(repo, ['log', '-10', '--format=%s']).catch(() => '')
  ])
  if (!diff.trim()) throw new Error('Nothing is staged: stage some changes before asking for a message.')
  const { text, excluded } = filterDiff(diff)
  if (!text.trim()) throw new Error('All staged files are sensitive: nothing is sent to Claude.')
  const files = (diff.match(/^diff --git /gm) ?? []).length
  const input = buildCommitInput(filterNumstat(numstat), text, log.split('\n').filter(Boolean))
  const message = await askClaude(opts, commitSystemPrompt(globalInstructions, repoInstructions), 'Write the commit message for the staged changes provided on stdin.', input)
  return { message, excluded, files }
}

const DIFF = ['--no-color', '--no-ext-diff', '--no-renames']
const bullets = (subjects: string) => subjects.split('\n').filter(Boolean).map((s) => `- ${s}`).join('\n') || '(none)'

export const EXPLAIN_SYSTEM_PROMPT = [
  'You explain git commits to a developer reading the history.',
  'Answer in English, in 2 to 4 sentences of plain prose: what the commit changes and why, as far as the message and the diff tell. Name files when it helps.',
  'No markdown, no headings, no lists.'
].join('\n')

export async function explainCommit(repo: string, rev: string, opts: ClaudeOptions): Promise<Explanation> {
  const sha = await resolveCommit(repo, rev)
  const [message, numstat, diff] = await Promise.all([
    git(repo, [...RO, 'show', '-s', '--format=%B', sha]),
    git(repo, [...RO, 'diff-tree', '-r', '--no-commit-id', '--root', '--numstat', '--diff-merges=first-parent', ...DIFF, sha]),
    git(repo, [...RO, 'show', '--format=', '--diff-merges=first-parent', ...DIFF, sha])
  ])
  const { text, excluded } = filterDiff(diff)
  const input = ['Commit message:', message.trim(), '', 'Changed files (summary):', filterNumstat(numstat) || '(none)', '', 'Diff against the first parent:', text || '(nothing to show)'].join('\n')
  return { text: await askClaude(opts, EXPLAIN_SYSTEM_PROMPT, 'Explain the commit provided on stdin.', input), excluded }
}

export const STASH_SYSTEM_PROMPT = [
  'You name git stashes.',
  'Output one line of at most 60 characters saying what the work in progress is about, for example: wip: retry with exponential backoff',
  'English, no quotes, no markdown, nothing else.'
].join('\n')

export async function generateStashMessage(repo: string, opts: ClaudeOptions): Promise<string> {
  const [numstat, diff, untracked] = await Promise.all([
    git(repo, [...RO, 'diff', 'HEAD', '--numstat', ...DIFF]),
    git(repo, [...RO, 'diff', 'HEAD', ...DIFF]),
    git(repo, [...RO, 'ls-files', '--others', '--exclude-standard'])
  ])
  const names = untracked.split('\n').filter((p) => p && !isSensitive(p)).slice(0, 50)
  const { text } = filterDiff(diff)
  if (!text.trim() && !names.length) throw new Error('No local changes to name (sensitive files are never sent to Claude).')
  const input = ['Changed files (summary):', filterNumstat(numstat) || '(none)', '', 'Untracked files:', names.join('\n') || '(none)', '', 'Diff:', text || '(none)'].join('\n')
  return (await askClaude(opts, STASH_SYSTEM_PROMPT, 'Name the stash for the local changes provided on stdin.', input)).split('\n')[0].trim()
}

export const ADVICE_SYSTEM_PROMPT = [
  'You advise a developer who dragged one git branch onto another and must choose between merging and rebasing.',
  'Answer in English. First line: exactly "merge" or "rebase". Then two or three short sentences explaining why in this case:',
  'whether the commits a rebase would rewrite were already pushed (rewriting published commits forces a push), whether a linear history is worth it, how hard the predicted conflicts look.',
  'Plain text, no markdown.'
].join('\n')

export async function adviseMerge(repo: string, sourceName: string, targetName: string, opts: ClaudeOptions): Promise<MergeAdvice> {
  const { source, target } = await branchPair(repo, sourceName, targetName)
  const [incoming, local, unpushed, conflicts] = await Promise.all([
    git(repo, [...RO, 'log', '-50', '--format=%s', `${target.sha}..${source.sha}`]),
    git(repo, [...RO, 'log', '-50', '--format=%s', `${source.sha}..${target.sha}`]),
    git(repo, [...RO, 'rev-list', '--count', `${source.sha}..${target.sha}`, '--not', '--remotes']),
    predictConflicts(repo, target.sha, source.sha)
  ])
  const input = [
    `Dragged branch: ${source.name}${source.remote ? ' (remote)' : ''}`,
    `Target branch (the one that changes): ${target.name}${target.current ? ' (checked out)' : ''}`,
    `Commits of ${source.name} missing from ${target.name}:`,
    bullets(incoming),
    `Commits of ${target.name} missing from ${source.name} (a rebase rewrites them):`,
    bullets(local),
    `Of those, not on any remote yet: ${unpushed.trim()}`,
    `Predicted conflicts: ${conflicts.filter((f) => !isSensitive(f)).join(', ') || 'none'}`
  ].join('\n')
  const out = await askClaude(opts, ADVICE_SYSTEM_PROMPT, 'Advise merge or rebase for the situation provided on stdin.', input)
  const [first, ...rest] = out.split('\n')
  const choice = first.trim().toLowerCase().replace(/[^a-z]/g, '')
  if (choice === 'merge' || choice === 'rebase') return { choice, text: rest.join('\n').trim() }
  return { choice: null, text: out }
}

export const MERGE_SYSTEM_PROMPT = [
  'You write git merge commit messages.',
  'Output only the message: a subject line of at most 72 characters, then optionally a blank line and a short body ("-" bullets allowed) summarizing what the merged branch brings.',
  "Match the style of the recent merge subjects you are given. If there are none, use the subject: Merge branch '<source>' into <target>",
  'No markdown fences, no quotes around the message, no commentary.'
].join('\n')

export async function generateMergeMessage(repo: string, sourceName: string, targetName: string, opts: ClaudeOptions): Promise<string> {
  const { source, target } = await branchPair(repo, sourceName, targetName)
  const [recent, incoming, numstat] = await Promise.all([
    git(repo, [...RO, 'log', '--merges', '-10', '--format=%s']).catch(() => ''),
    git(repo, [...RO, 'log', '-50', '--format=%s', `${target.sha}..${source.sha}`]),
    git(repo, [...RO, 'diff', '--numstat', ...DIFF, `${target.sha}...${source.sha}`])
  ])
  const input = [
    'Recent merge commit subjects in this repository:',
    bullets(recent),
    '',
    `Merging ${source.name} into ${target.name}. Commits being merged:`,
    bullets(incoming),
    '',
    'Files changed (summary):',
    filterNumstat(numstat) || '(none)'
  ].join('\n')
  return askClaude(opts, MERGE_SYSTEM_PROMPT, 'Write the merge commit message for the merge described on stdin.', input)
}
