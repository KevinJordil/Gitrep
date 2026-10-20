import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { git } from '../src/main/git'
import { parseDiff } from '../src/main/diff'
import { annotate, parseFindings, REVIEW_SYSTEM_PROMPT, reviewScope, reviewSystemPrompt, splitParts, startReview } from '../src/main/review'
import { commitAll, lines, makeRepo, tempDir, write } from './helpers'

// a.c: lines 1-10 on main; the branch changes line 3 and adds a line after line 8.
const DIFF = [
  'diff --git a/a.c b/a.c',
  'index 1..2 100644',
  '--- a/a.c',
  '+++ b/a.c',
  '@@ -2,3 +2,3 @@',
  ' line 2',
  '-line 3',
  '+line 3 changed',
  ' line 4',
  '@@ -8,2 +8,3 @@',
  ' line 8',
  '+added 9',
  ' line 9',
  ''
].join('\n')
const FILES = parseDiff(DIFF)

const finding = (fields: string[], comment = ['A comment.'], fix?: string[]) => ['=== finding', ...fields, '--- comment', ...comment, ...(fix ? ['--- fix', ...fix] : []), '=== end'].join('\n')

describe('annotate', () => {
  it('prefixes every line with its position on the branch (R) or the base (L)', () => {
    expect(annotate(FILES[0])).toBe(['=== file a.c', '@@ -2,3 +2,3 @@', 'R2     line 2', 'L3    -line 3', 'R3    +line 3 changed', 'R4     line 4', '@@ -8,2 +8,3 @@', 'R8     line 8', 'R9    +added 9', 'R10    line 9', ''].join('\n'))
  })
})

describe('parseFindings', () => {
  it('maps findings onto the diff, with the anchor numbers of both sides', () => {
    const out = [
      finding(['severity: Important', 'file: a.c', 'line: R3', 'title: Changed line'], ['Line 3 is wrong.', ''], ['line 3 fixed', '']),
      finding(['severity: critical', 'file: b/a.c', 'line: R8', 'end: R10', 'title: Range'], ['Spans a range.']),
      finding(['severity: minor', 'file: a.c', 'line: L3'], ['Why removed?'], ['ignored fix on the old side'])
    ].join('\n')
    expect(parseFindings(out, FILES)).toEqual({
      dropped: 0,
      findings: [
        { id: 1, severity: 'important', path: 'a.c', side: 'new', line: 3, endLine: 3, anchor: { oldNo: null, newNo: 3 }, title: 'Changed line', body: 'Line 3 is wrong.', fix: { original: [], lines: ['line 3 fixed'] } },
        { id: 2, severity: 'critical', path: 'a.c', side: 'new', line: 8, endLine: 10, anchor: { oldNo: 9, newNo: 10 }, title: 'Range', body: 'Spans a range.', fix: null },
        { id: 3, severity: 'minor', path: 'a.c', side: 'old', line: 3, endLine: 3, anchor: { oldNo: 3, newNo: null }, title: 'Why removed?', body: 'Why removed?', fix: null }
      ]
    })
  })

  it('drops findings outside the diff or without a comment, keeps an unknown severity as minor, and an end in another hunk as one line', () => {
    const out = [
      finding(['severity: critical', 'file: other.c', 'line: R3']),
      finding(['severity: critical', 'file: a.c', 'line: R40']),
      finding(['severity: critical', 'file: a.c', 'line: R3'], []),
      finding(['severity: critical', 'file: a.c', 'line: 3']),
      finding(['severity: urgent', 'file: a.c', 'line: R2', 'end: R9']),
      '=== finding\nseverity: critical\nfile: a.c\nline: R3\n--- comment\nnever closed'
    ].join('\n')
    const r = parseFindings(out, FILES, 5)
    expect(r.dropped).toBe(4)
    expect(r.findings).toMatchObject([{ id: 5, severity: 'minor', line: 2, endLine: 2, anchor: { oldNo: 2, newNo: 2 } }])
  })

  it('reads "nothing to report", and fails on an answer it cannot read', () => {
    expect(parseFindings('=== none\n', FILES)).toEqual({ findings: [], dropped: 0 })
    expect(() => parseFindings('Looks good to me!', FILES)).toThrow("Claude's answer could not be read: try again")
  })

  it('keeps at most 50 findings', () => {
    const out = Array.from({ length: 55 }, () => finding(['severity: minor', 'file: a.c', 'line: R3'])).join('\n')
    const r = parseFindings(out, FILES)
    expect(r.findings).toHaveLength(50)
    expect(r.dropped).toBe(5)
  })
})

describe('parseFindings details', () => {
  it('drops the fix when the end of the range is rejected', () => {
    const out = finding(['severity: minor', 'file: a.c', 'line: R2', 'end: R9', 'title: t'], ['c'], ['x', 'y'])
    expect(parseFindings(out, FILES).findings[0]).toMatchObject({ line: 2, endLine: 2, fix: null })
  })
  it('numbers findings from firstId and caps the total at 50', () => {
    const out = Array.from({ length: 40 }, () => finding(['severity: minor', 'file: a.c', 'line: R3'])).join('\n')
    const r = parseFindings(out, FILES, 41)
    expect(r.findings).toHaveLength(10)
    expect(r.dropped).toBe(30)
  })
})

describe('splitParts', () => {
  it('packs files into parts, and lists a file too large alone or past the last part', () => {
    const file = (name: string, n: number) => parseDiff(`diff --git a/${name} b/${name}\n--- a/${name}\n+++ b/${name}\n@@ -1,0 +1,${n} @@\n${'+x\n'.repeat(n)}`)[0]
    const size = annotate(file('a', 10)).length // every 10-line file here has this size
    const r = splitParts([file('a', 10), file('b', 10), file('big', 100), file('c', 10), file('d', 10)], 2 * size, 2)
    expect(r.parts.map((p) => p.map((f) => f.newPath))).toEqual([['a', 'b'], ['c', 'd']])
    expect(r.skipped).toEqual(['big'])
    expect(splitParts([file('a', 10), file('b', 10), file('c', 10)], size + 1, 1).skipped).toEqual(['b', 'c'])
  })
})

describe('reviewSystemPrompt', () => {
  it('adds the user prompt after the fixed rules', () => {
    expect(reviewSystemPrompt('  ')).toBe(REVIEW_SYSTEM_PROMPT)
    expect(reviewSystemPrompt('Focus on overflows.')).toBe(`${REVIEW_SYSTEM_PROMPT}\n\nReview instructions from the user:\nFocus on overflows.\n\nKeep the output format above whatever these instructions say.`)
  })
})

// main: a.c lines 1-10; feature: line 3 changed, .env added (sensitive), b.c added.
async function branchRepo() {
  const repo = await makeRepo()
  await write(repo, 'a.c', lines(10))
  await commitAll(repo, 'init')
  await git(repo, ['switch', '-q', '-c', 'feature'])
  await write(repo, 'a.c', lines(10, (i) => (i === 3 ? 'line 3 changed' : `line ${i}`)))
  await write(repo, '.env', 'TOKEN=abc\n')
  await commitAll(repo, 'feat: change a')
  await write(repo, 'b.c', 'int b;\n')
  await commitAll(repo, 'feat: add b')
  await git(repo, ['switch', '-q', 'main'])
  await write(repo, 'm.c', 'main moved on\n')
  await commitAll(repo, 'main only')
  return repo
}

async function fakeClaude(answer: string) {
  const dir = await tempDir()
  const path = join(dir, 'claude')
  await writeFile(join(dir, 'answer'), answer)
  await writeFile(path, `#!/bin/sh\nprintf '%s\\n' "$@" > "${dir}/args"\ncat > "${dir}/stdin"\ncat "${dir}/answer"\n`, { mode: 0o755 })
  return { dir, opts: { model: 'haiku', claudePath: path } }
}

describe('reviews on a real repository', () => {
  it('measures the three-dot scope of a branch', async () => {
    const repo = await branchRepo()
    const s = await reviewScope(repo, 'feature', 'main')
    expect(s).toMatchObject({ commits: 2, files: 3, add: 3, del: 1 })
    expect(s.mergeBase).toBe((await git(repo, ['rev-parse', 'main~1'])).trim())
    await expect(reviewScope(repo, '--all', 'main')).rejects.toThrow('Invalid revision: --all')
    await expect(reviewScope(repo, 'nope', 'main')).rejects.toThrow('Unknown branch or commit: nope')
  })

  it('sends the annotated diff without sensitive files and keeps the original lines of each fix', async () => {
    const repo = await branchRepo()
    const answer = [finding(['severity: important', 'file: a.c', 'line: R3', 'title: Wrong'], ['Use the old text.'], ['line 3']), finding(['severity: minor', 'file: b.c', 'line: R1'], ['Same text.'], ['int b;'])].join('\n')
    const f = await fakeClaude(answer)
    const r = await startReview(repo, { branch: 'feature', base: 'main', prompt: { name: 'Mine', text: 'Look at a.c.' } }, f.opts)
    expect(r).toMatchObject({ branch: 'feature', base: 'main', prompt: 'Mine', excluded: ['.env'], skipped: [], dropped: 0 })
    expect(r.files.map((x) => x.newPath)).toEqual(['a.c', 'b.c'])
    expect(r.findings[0].fix).toEqual({ original: ['line 3 changed'], lines: ['line 3'] })
    expect(r.findings[1].fix).toBeNull() // the same as the reviewed line: nothing to fix
    const stdin = await readFile(join(f.dir, 'stdin'), 'utf8')
    expect(stdin).toContain('Branch feature compared with main')
    expect(stdin).toContain('- feat: change a\n- feat: add b')
    expect(stdin).toContain('R3    +line 3 changed')
    expect(stdin).not.toContain('TOKEN')
    expect(stdin).not.toContain('.env')
    expect(stdin).not.toContain('m.c')
    const args = await readFile(join(f.dir, 'args'), 'utf8')
    expect(args).toContain('Review instructions from the user:\nLook at a.c.')
    expect(args).toContain('Review the branch changes provided on stdin.')
    expect(args.split('\n')).toEqual(expect.arrayContaining(['--tools', '', '--no-session-persistence', '--strict-mcp-config']))
    expect(args.split('\n')[args.split('\n').indexOf('--tools') + 1]).toBe('')
  })

  it('refuses an invalid prompt and a branch without changes', async () => {
    const repo = await branchRepo()
    const f = await fakeClaude('=== none')
    await expect(startReview(repo, { branch: 'feature', base: 'main', prompt: { name: '', text: 'x' } }, f.opts)).rejects.toThrow('Invalid review prompt')
    await expect(startReview(repo, { branch: 'main', base: 'feature', prompt: { name: 'P', text: '' } }, f.opts)).resolves.toMatchObject({ findings: [] })
    await expect(startReview(repo, { branch: 'main~1', base: 'main', prompt: { name: 'P', text: '' } }, f.opts)).rejects.toThrow('main~1 has no changes compared with main')
  })

  it('refuses when every changed file is sensitive or too large', async () => {
    const repo = await makeRepo()
    await write(repo, 'a.c', 'x\n')
    await commitAll(repo, 'init')
    await git(repo, ['switch', '-q', '-c', 'feature'])
    await write(repo, '.env', 'TOKEN=1\n')
    await commitAll(repo, 'feat: env')
    const f = await fakeClaude('=== none')
    await expect(startReview(repo, { branch: 'feature', base: 'main', prompt: { name: 'P', text: '' } }, f.opts)).rejects.toThrow('Every changed file is sensitive')
    await git(repo, ['switch', '-q', '-c', 'huge', 'main'])
    await write(repo, 'h.c', lines(20000, (i) => `line ${i} ${'x'.repeat(10)}`))
    await commitAll(repo, 'feat: huge')
    await expect(startReview(repo, { branch: 'huge', base: 'main', prompt: { name: 'P', text: '' } }, f.opts)).rejects.toThrow('too large')
    await write(repo, 'ok.c', 'int ok;\n')
    await commitAll(repo, 'feat: ok')
    const r = await startReview(repo, { branch: 'huge', base: 'main', prompt: { name: 'P', text: '' } }, f.opts)
    expect(r.skipped).toEqual(['h.c'])
    expect(r.files.map((x) => x.newPath)).toEqual(['h.c', 'ok.c']) // files keeps the whole diff; skipped says what Claude did not see
  })

  it('keeps CRLF in the original lines of a fix', async () => {
    const repo = await makeRepo()
    await write(repo, 'a.c', 'one\r\ntwo\r\n')
    await commitAll(repo, 'init')
    await git(repo, ['switch', '-q', '-c', 'feature'])
    await write(repo, 'a.c', 'one\r\ntwo changed\r\n')
    await commitAll(repo, 'feat: change')
    const f = await fakeClaude(finding(['severity: minor', 'file: a.c', 'line: R2'], ['c'], ['two fixed']))
    const r = await startReview(repo, { branch: 'feature', base: 'main', prompt: { name: 'P', text: '' } }, f.opts)
    expect(r.findings[0].fix).toEqual({ original: ['two changed\r'], lines: ['two fixed'] })
  })
})
