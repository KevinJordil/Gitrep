import { execFile } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'
import type { GeneratedMessage } from '../shared/types'
import { git } from './git'

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
const isSensitive = (path: string) => SENSITIVE.some((r) => r.test(path))
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

export async function generateCommitMessage(repo: string, opts: { model: string; claudePath?: string }): Promise<GeneratedMessage> {
  const [numstat, diff, log] = await Promise.all([
    git(repo, ['diff', '--cached', '--numstat', '--no-renames', '--no-color']),
    git(repo, ['diff', '--cached', '--no-renames', '--no-color', '--no-ext-diff']),
    git(repo, ['log', '-10', '--format=%s']).catch(() => '')
  ])
  if (!diff.trim()) throw new Error('Nothing is staged: stage some changes before asking for a message.')
  const { text, excluded } = filterDiff(diff)
  if (!text.trim()) throw new Error('All staged files are sensitive: nothing is sent to Claude.')
  const files = (diff.match(/^diff --git /gm) ?? []).length
  const claude = await resolveClaude(opts.claudePath)
  const args = [
    '-p',
    '--tools',
    '',
    '--setting-sources',
    'project',
    '--strict-mcp-config',
    '--no-session-persistence',
    '--model',
    opts.model,
    '--system-prompt',
    COMMIT_SYSTEM_PROMPT,
    'Write the commit message for the staged changes provided on stdin.'
  ]
  const out = await runClaude(claude, args, buildCommitInput(filterNumstat(numstat), text, log.split('\n').filter(Boolean)))
  return { message: cleanMessage(out), excluded, files }
}
