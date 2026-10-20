import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseSuggestions, suggestConflict } from '../src/main/assist'
import { MAX_DIFF_CHARS } from '../src/main/claude'
import { git } from '../src/main/git'
import { integrate } from '../src/main/ops'
import type { ConflictHunk } from '../src/shared/types'
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
