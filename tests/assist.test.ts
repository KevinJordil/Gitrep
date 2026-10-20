import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseRebasePlan, parseSuggestions, proposeRebase, suggestConflict } from '../src/main/assist'
import { MAX_DIFF_CHARS } from '../src/main/claude'
import { git } from '../src/main/git'
import { integrate } from '../src/main/ops'
import type { ConflictHunk, RebaseCommit } from '../src/shared/types'
import { commitAll, makeRepo, tempDir, write } from './helpers'

// Prints a canned answer; keeps the arguments and stdin it got.
async function fakeClaude(answer: string) {
  const dir = await tempDir()
  const path = join(dir, 'claude')
  await writeFile(join(dir, 'answer'), answer)
  await writeFile(path, `#!/bin/sh\nprintf '%s\\n' "$@" > "${dir}/args"\ncat > "${dir}/stdin"\ncat "${dir}/answer"\n`, { mode: 0o755 })
  return { dir, opts: { model: 'haiku', claudePath: path } }
}

// main and feature both rewrite `file`: merging feature into main conflicts.
async function conflicted(file = 'a.txt') {
  const repo = await makeRepo()
  await write(repo, file, 'base\n')
  await commitAll(repo, 'base')
  await git(repo, ['switch', '-q', '-c', 'feature'])
  await write(repo, file, 'feature\n')
  await commitAll(repo, 'f1')
  await git(repo, ['switch', '-q', 'main'])
  await write(repo, file, 'main\n')
  await commitAll(repo, 'm1')
  expect(await integrate(repo, { source: 'feature', target: 'main', mode: 'merge', message: '', autostash: false })).toBe('conflicts')
  return repo
}

const HUNK: ConflictHunk = { before: ['start'], ours: ['main'], base: ['base'], theirs: ['feature'], after: ['end'] }
const ANSWER = ['=== conflict 1', 'confidence: high', 'summary: keep both', 'explanation: Both lines are needed.', '--- resolution', 'main', '  feature', '=== end'].join('\n')

describe('parseSuggestions', () => {
  it('reads one section per conflict, keeps indentation, and leaves missing ones null', () => {
    const out = [ANSWER, '=== conflict 3', 'confidence: sure', 'summary: drop it', 'explanation: Not needed.', '--- resolution', '=== end'].join('\n')
    expect(parseSuggestions(out, 3)).toEqual([
      { lines: ['main', '  feature'], confidence: 'high', summary: 'keep both', explanation: 'Both lines are needed.' },
      null,
      { lines: [], confidence: 'low', summary: 'drop it', explanation: 'Not needed.' }
    ])
  })

  it('strips carriage returns and trailing empty lines from a resolution', () => {
    const out = ['=== conflict 1', 'confidence: high', 'summary: s', 'explanation: e', '--- resolution', 'main\r', 'feature\r', '', '', '=== end'].join('\n')
    expect(parseSuggestions(out, 1)[0]?.lines).toEqual(['main', 'feature'])
  })

  it('ignores a resolution that still has conflict markers, and fails when nothing can be read', () => {
    const bad = ['=== conflict 1', 'confidence: low', 'summary: x', 'explanation: y', '--- resolution', '<<<<<<< HEAD', 'a', '=======', 'b', '>>>>>>> f', '=== end'].join('\n')
    expect(parseSuggestions(bad, 1)).toEqual([null])
    expect(() => parseSuggestions('I cannot help with that.', 1)).toThrow("Claude's answer could not be read: try again")
  })
})

describe('suggestConflict', () => {
  it('sends the three versions with the side names, tools disabled, and parses the answer', async () => {
    const repo = await conflicted()
    const { dir, opts } = await fakeClaude(ANSWER)
    expect(await suggestConflict(repo, 'a.txt', [HUNK], opts)).toEqual([{ lines: ['main', '  feature'], confidence: 'high', summary: 'keep both', explanation: 'Both lines are needed.' }])
    const args = (await readFile(join(dir, 'args'), 'utf8')).split('\n')
    expect(args).toContain('--strict-mcp-config')
    expect(args[args.indexOf('--tools') + 1]).toBe('')
    const stdin = await readFile(join(dir, 'stdin'), 'utf8')
    expect(stdin).toContain('File: a.txt')
    expect(stdin).toContain('Operation: merge')
    expect(stdin).toContain('--- upper (main)\nmain\n--- base\nbase\n--- lower (feature)\nfeature\n--- after\nend')
  })

  it('never sends a sensitive file or a file that is not conflicted', async () => {
    const repo = await conflicted('.env')
    const { dir, opts } = await fakeClaude(ANSWER)
    await expect(suggestConflict(repo, '.env', [HUNK], opts)).rejects.toThrow('.env is a sensitive file: it is never sent to Claude.')
    await expect(suggestConflict(repo, 'other.txt', [HUNK], opts)).rejects.toThrow('Not a conflicted file: other.txt')
    expect(existsSync(join(dir, 'args'))).toBe(false)
  })

  it('refuses a conflict too large to send', async () => {
    const repo = await conflicted()
    const { dir, opts } = await fakeClaude(ANSWER)
    await expect(suggestConflict(repo, 'a.txt', [{ ...HUNK, ours: ['x'.repeat(MAX_DIFF_CHARS)] }], opts)).rejects.toThrow('too large to send to Claude')
    expect(existsSync(join(dir, 'args'))).toBe(false)
  })
})

describe('proposeRebase', () => {
  // main: base. feature: c1 (a.txt), c2 (b.txt and .env), c3 (fixes a.txt).
  async function branch() {
    const repo = await makeRepo()
    await write(repo, 'a.txt', 'base\n')
    await commitAll(repo, 'base')
    await git(repo, ['switch', '-q', '-c', 'feature'])
    await write(repo, 'a.txt', '1\n')
    await commitAll(repo, 'c1')
    await write(repo, 'b.txt', 'b\n')
    await write(repo, '.env', 'TOKEN=1\n')
    await git(repo, ['add', '-A'])
    await git(repo, ['commit', '-q', '-m', 'c2', '-m', 'Adds b.'])
    await write(repo, 'a.txt', '1 fixed\n')
    await commitAll(repo, 'c3')
    await git(repo, ['switch', '-q', 'main'])
    return { repo, shas: (await git(repo, ['rev-list', '--reverse', 'main..feature'])).trim().split('\n') }
  }

  it('sends messages and file stats oldest first, without sensitive files, and maps the plan onto the commits', async () => {
    const { repo, shas } = await branch()
    const answer = [`pick ${shas[0].slice(0, 7)} c1`, `fixup ${shas[2].slice(0, 9)} c3`, `reword ${shas[1].slice(0, 7)} feat: add b`, '---', 'Fold the fix into c1.'].join('\n')
    const { dir, opts } = await fakeClaude(answer)
    expect(await proposeRebase(repo, 'feature', 'main', opts)).toEqual({
      items: [
        { sha: shas[0], action: 'pick' },
        { sha: shas[2], action: 'fixup' },
        { sha: shas[1], action: 'reword', message: 'feat: add b\n\nAdds b.' }
      ],
      explanation: 'Fold the fix into c1.'
    })
    const stdin = await readFile(join(dir, 'stdin'), 'utf8')
    expect(stdin).toContain(`commit ${shas[1].slice(0, 7)} c2\n  message: Adds b.\n  files: b.txt (+1 -0)`)
    expect(stdin.indexOf(`commit ${shas[0].slice(0, 7)}`)).toBeLessThan(stdin.indexOf(`commit ${shas[2].slice(0, 7)}`))
    expect(stdin).not.toContain('.env')
  })

  it('refuses a plan that skips, repeats or misorders commits', () => {
    const commits: RebaseCommit[] = ['aaaa1111', 'bbbb2222'].map((sha, i) => ({ sha, subject: `c${i}`, body: '', author: 'A', date: 0 }))
    expect(() => parseRebasePlan('pick aaaa1 c0\n---\nx', commits)).toThrow("Claude's plan does not use every commit exactly once: try again")
    expect(() => parseRebasePlan('pick aaaa1 c0\npick aaaa c0\n---\nx', commits)).toThrow('exactly once')
    expect(() => parseRebasePlan('fixup bbbb c1\npick aaaa c0\n---\nx', commits)).toThrow('The first commit cannot be squashed or fixed up')
    expect(parseRebasePlan('reword bbbb c1\npick aaaa c0', commits)).toEqual({ items: [{ sha: 'bbbb2222', action: 'pick' }, { sha: 'aaaa1111', action: 'pick' }], explanation: '' })
  })
})
