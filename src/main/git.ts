import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { RepoOperation } from '../shared/types'

export class GitError extends Error {
  constructor(
    readonly args: string[],
    readonly stderr: string,
    readonly code: number | null
  ) {
    super(`git ${args.join(' ')}\n${stderr.trim() || `exit code ${code}`}`)
    this.name = 'GitError'
  }
}

export interface RunOptions {
  input?: string
  env?: Record<string, string>
  okCodes?: number[]
}

// Never prompt (no terminal to answer) and keep git's own messages in English for parsing.
// GIT_LITERAL_PATHSPECS: paths from the renderer are never pathspec magic (`*`, `:(top)`...).
const BASE_ENV = { GIT_TERMINAL_PROMPT: '0', GIT_SSH_COMMAND: 'ssh -o BatchMode=yes -o ConnectTimeout=10', LC_ALL: 'C', GIT_LITERAL_PATHSPECS: '1' }

export function git(cwd: string, args: string[], opts: RunOptions = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      'git',
      // User configs may change diff prefixes (mnemonicPrefix, noprefix): the parsers need a/ b/. showSignature would prepend gpg output to log records.
      ['-c', 'core.quotePath=false', '-c', 'diff.mnemonicPrefix=false', '-c', 'diff.noprefix=false', '-c', 'log.showSignature=false', ...args],
      { cwd, env: { ...process.env, ...BASE_ENV, ...opts.env }, maxBuffer: 256 * 1024 * 1024, encoding: 'utf8' },
      (err, stdout, stderr) => {
        if (!err) return resolve(stdout)
        const code = typeof err.code === 'number' ? err.code : null
        if (code !== null && opts.okCodes?.includes(code)) return resolve(stdout)
        reject(new GitError(args, stderr || err.message, code))
      }
    )
    // git may exit before reading stdin (EPIPE); the exit callback reports the real failure.
    child.stdin?.on('error', () => undefined)
    child.stdin?.end(opts.input ?? '')
  })
}

const queues = new Map<string, Promise<unknown>>()

// Write operations on one repo run one at a time (avoids index.lock races).
export function serialized<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const run = (queues.get(key) ?? Promise.resolve()).catch(() => undefined).then(fn)
  queues.set(key, run)
  return run
}

const gitDirs = new Map<string, string>()

export async function gitDir(repo: string): Promise<string> {
  let dir = gitDirs.get(repo)
  if (!dir) {
    dir = (await git(repo, ['rev-parse', '--absolute-git-dir'])).trim()
    gitDirs.set(repo, dir)
  }
  return dir
}

// The operation git stopped in the middle of, if any.
export async function currentOperation(repo: string): Promise<RepoOperation> {
  const d = await gitDir(repo)
  if (existsSync(join(d, 'rebase-merge')) || existsSync(join(d, 'rebase-apply'))) return 'rebase'
  if (existsSync(join(d, 'MERGE_HEAD'))) return 'merge'
  if (existsSync(join(d, 'CHERRY_PICK_HEAD'))) return 'cherry-pick'
  if (existsSync(join(d, 'REVERT_HEAD'))) return 'revert'
  return null
}
