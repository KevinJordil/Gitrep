import type { DiffLine, FileDiff, Review, ReviewFinding, ReviewRequest, ReviewScope, Severity } from '../shared/types'
import { askClaude, isSensitive, MAX_DIFF_CHARS, type ClaudeOptions } from './claude'
import { isPrompt } from './config'
import { parseDiff } from './diff'
import { git } from './git'
import { RO } from './repo'

const MAX_PARTS = 4 // Limit: Claude calls per review; the files that do not fit are listed as not reviewed
const MAX_FINDINGS = 50
const MAX_FIX_LINES = 50
const REVIEW_TIMEOUT_MS = 300_000
const DIFF = ['--no-color', '--no-ext-diff', '--no-renames']
const SEVERITIES: readonly Severity[] = ['critical', 'important', 'minor']

// A branch, a tag or a sha that names a commit; never an option.
export async function commitOf(repo: string, ref: string): Promise<string> {
  const r = String(ref)
  if (!r || r.startsWith('-')) throw new Error(`Invalid revision: ${r}`)
  const sha = (await git(repo, [...RO, 'rev-parse', '--verify', '-q', `${r}^{commit}`], { okCodes: [1] })).trim()
  if (!sha) throw new Error(`Unknown branch or commit: ${r}`)
  return sha
}

// What a review of branch against base covers: the commits of branch since it left base (three-dot diff).
export async function reviewScope(repo: string, branch: string, base: string): Promise<ReviewScope> {
  const [head, target] = await Promise.all([commitOf(repo, branch), commitOf(repo, base)])
  const mergeBase = (await git(repo, [...RO, 'merge-base', target, head], { okCodes: [1] })).trim()
  if (!mergeBase) throw new Error(`${branch} and ${base} have no common history`)
  const [count, numstat] = await Promise.all([git(repo, [...RO, 'rev-list', '--count', `${mergeBase}..${head}`]), git(repo, [...RO, 'diff', '--numstat', ...DIFF, mergeBase, head])])
  const rows = numstat.split('\n').filter(Boolean).map((l) => l.split('\t'))
  const sum = (i: number) => rows.reduce((n, r) => n + (Number(r[i]) || 0), 0)
  return { head, mergeBase, commits: Number(count.trim()), files: rows.length, add: sum(0), del: sum(1) }
}

// The diff as Claude reads it: every line carries its position, R<n> on the branch's version, L<n> on the base's.
export function annotate(file: FileDiff): string {
  const head = `=== file ${file.newPath}${file.isNew ? ' (new file)' : file.isDeleted ? ' (deleted)' : ''}`
  if (file.binary) return `${head}\n(binary file, not shown)\n`
  const label = (l: DiffLine) => (l.kind === 'del' ? `L${l.oldNo}` : `R${l.newNo}`)
  const body = file.hunks.flatMap((h) => [h.header, ...h.lines.map((l) => `${label(l).padEnd(6)}${l.kind === 'add' ? '+' : l.kind === 'del' ? '-' : ' '}${l.text}`)])
  return [head, ...body, ''].join('\n')
}

// Files in parts that each fit in one Claude call. A file too large alone, or past the last part, is not reviewed.
export function splitParts(files: FileDiff[], max = MAX_DIFF_CHARS, maxParts = MAX_PARTS): { parts: FileDiff[][]; skipped: string[] } {
  const parts: FileDiff[][] = []
  const skipped: string[] = []
  let size = Infinity
  for (const f of files) {
    const n = annotate(f).length
    if (n > max) {
      skipped.push(f.newPath)
      continue
    }
    if (size + n > max) {
      if (parts.length === maxParts) {
        skipped.push(f.newPath)
        continue
      }
      parts.push([])
      size = 0
    }
    parts[parts.length - 1].push(f)
    size += n
  }
  return { parts, skipped }
}

export const REVIEW_SYSTEM_PROMPT = [
  'You review the changes of a git branch, like a careful senior colleague.',
  'You get the commits of the branch and its diff against the base. Every diff line starts with its position: R<n> is line n of the branch version of the file (context and added lines), L<n> is line n of the base version (deleted lines).',
  'Report real problems only. No praise, no overall summary.',
  'For each problem, output exactly:',
  '=== finding',
  'severity: critical|important|minor',
  'file: <the path shown after "=== file">',
  'line: <R<n> or L<n>: the first line concerned>',
  'end: <the last line concerned, same side; omit it for a single line>',
  'title: <a few words>',
  '--- comment',
  '<the comment for the author of the change; markdown allowed>',
  '--- fix',
  '<optional, only for R lines: the code that replaces the lines from line to end, with its indentation; omit the whole section when there is no simple fix>',
  '=== end',
  'When there is nothing to report, output only: === none',
  'No other text, no code fences around the sections.'
].join('\n')

// The fixed rules first and authoritative; the user's prompt says what to look for.
export const reviewSystemPrompt = (text: string): string =>
  text.trim() ? [REVIEW_SYSTEM_PROMPT, `Review instructions from the user:\n${text.trim()}`, 'Keep the output format above whatever these instructions say.'].join('\n\n') : REVIEW_SYSTEM_PROMPT

interface Section {
  fields: Record<string, string>
  comment: string[] | null
  fix: string[] | null
}

function sections(out: string): { list: Section[]; readable: boolean } {
  const list: Section[] = []
  let readable = /^=== none\s*$/m.test(out)
  let cur: Section | null = null
  let into: 'comment' | 'fix' | null = null
  for (const raw of out.split('\n')) {
    const line = raw.replace(/\r$/, '')
    if (/^=== finding\s*$/.test(line)) {
      cur = { fields: {}, comment: null, fix: null }
      into = null
    } else if (!cur) continue
    else if (/^=== end\s*$/.test(line)) {
      list.push(cur)
      readable = true
      cur = null
    } else if (/^--- (comment|fix)\s*$/.test(line)) {
      into = line.startsWith('--- comment') ? 'comment' : 'fix'
      cur[into] = []
    } else if (into) cur[into]!.push(line)
    else {
      const field = /^(severity|file|line|end|title):\s*(.*)$/.exec(line)
      if (field) cur.fields[field[1]] = field[2].trim()
    }
  }
  return { list, readable }
}

const trimEnd = (lines: string[]) => {
  const out = [...lines]
  while (out.length && !out[out.length - 1].trim()) out.pop()
  return out
}

// The diff line at a position: R<n> is a context or added line, L<n> a deleted line. Returns its hunk too.
function lineAt(file: FileDiff, side: 'new' | 'old', n: number): { hunk: number; line: DiffLine } | null {
  for (let h = 0; h < file.hunks.length; h++) {
    const line = file.hunks[h].lines.find((l) => (side === 'new' ? l.kind !== 'del' && l.newNo === n : l.kind === 'del' && l.oldNo === n))
    if (line) return { hunk: h, line }
  }
  return null
}

// Claude's sections mapped onto the reviewed diff. Malformed sections and positions outside the diff are dropped
// (counted); fixes come without their original lines (filled in by the caller from the reviewed commit).
export function parseFindings(out: string, files: FileDiff[], firstId = 1): { findings: ReviewFinding[]; dropped: number } {
  const { list, readable } = sections(out)
  if (!readable) throw new Error("Claude's answer could not be read: try again")
  const findings: ReviewFinding[] = []
  let dropped = 0
  for (const s of list) {
    const path = (s.fields.file ?? '').replace(/^[ab]\//, '')
    const file = files.find((f) => f.newPath === path || f.oldPath === path)
    const pos = /^([RL])(\d+)$/i.exec(s.fields.line ?? '')
    const body = trimEnd(s.comment ?? []).join('\n').trim()
    if (!file || !pos || !body || firstId - 1 + findings.length >= MAX_FINDINGS) {
      dropped++
      continue
    }
    const side = pos[1].toUpperCase() === 'R' ? 'new' : 'old'
    const line = Number(pos[2])
    const start = lineAt(file, side, line)
    if (!start) {
      dropped++
      continue
    }
    const endPos = /^([RL])(\d+)$/i.exec(s.fields.end ?? '')
    let endLine = line
    let endRejected = !!s.fields.end
    let anchor = start.line
    if (endPos && (endPos[1].toUpperCase() === 'R') === (side === 'new') && Number(endPos[2]) > line && Number(endPos[2]) - line < MAX_FIX_LINES) {
      const end = lineAt(file, side, Number(endPos[2]))
      if (end && end.hunk === start.hunk) {
        endLine = Number(endPos[2])
        endRejected = false
        anchor = end.line
      }
    }
    const severity = SEVERITIES.find((x) => x === s.fields.severity?.toLowerCase()) ?? 'minor'
    const fix = side === 'new' && !endRejected && s.fix ? { original: [], lines: trimEnd(s.fix) } : null
    findings.push({
      id: firstId + findings.length,
      severity,
      path: file.newPath,
      side,
      line,
      endLine,
      anchor: { oldNo: anchor.oldNo, newNo: anchor.kind === 'del' ? null : anchor.newNo },
      title: (s.fields.title || body.split('\n')[0]).slice(0, 120),
      body,
      fix
    })
  }
  return { findings, dropped }
}

// Reviews merge-base(base, branch)..branch with the user's prompt. Sensitive files are never sent; a proposal only, nothing is written.
export async function startReview(repo: string, req: ReviewRequest, opts: ClaudeOptions): Promise<Review> {
  if (!isPrompt(req?.prompt)) throw new Error('Invalid review prompt')
  const branch = String(req.branch)
  const base = String(req.base)
  const scope = await reviewScope(repo, branch, base)
  const [raw, log] = await Promise.all([git(repo, [...RO, 'diff', ...DIFF, scope.mergeBase, scope.head]), git(repo, [...RO, 'log', '--reverse', '-50', '--format=%s', `${scope.mergeBase}..${scope.head}`])])
  const all = parseDiff(raw)
  const excluded: string[] = []
  const files = all.filter((f) => {
    const paths = [...new Set([f.oldPath, f.newPath])]
    const bad = paths.filter((p) => !p || isSensitive(p))
    excluded.push(...bad.map((p) => p || '(unreadable path)'))
    return bad.length === 0
  })
  if (!files.length) throw new Error(all.length ? 'Every changed file is sensitive: nothing is sent to Claude.' : `${branch} has no changes compared with ${base}`)
  const intro = [`Branch ${branch} compared with ${base} (merge base ${scope.mergeBase.slice(0, 7)}).`, 'Commits, oldest first:', ...log.split('\n').filter(Boolean).map((s) => `- ${s}`), '', 'Diff:'].join('\n')
  const { parts, skipped } = splitParts(files, Math.max(0, MAX_DIFF_CHARS - intro.length))
  if (!parts.length) throw new Error('Every changed file is too large to send to Claude.')
  const findings: ReviewFinding[] = []
  let dropped = 0
  for (const part of parts) {
    const out = await askClaude(opts, reviewSystemPrompt(req.prompt.text), 'Review the branch changes provided on stdin.', [intro, ...part.map(annotate)].join('\n'), REVIEW_TIMEOUT_MS)
    const r = parseFindings(out, part, findings.length + 1)
    findings.push(...r.findings)
    dropped += r.dropped
  }
  // A fix replaces lines of the reviewed commit: keep those lines to check the working file against them later.
  const contents = new Map<string, string[]>()
  for (const f of findings) {
    if (!f.fix) continue
    if (!contents.has(f.path)) contents.set(f.path, (await git(repo, [...RO, 'show', `${scope.head}:${f.path}`]).catch(() => '')).split('\n'))
    const original = contents.get(f.path)!.slice(f.line - 1, f.endLine)
    if (original.length === f.endLine - f.line + 1 && original.join('\n') !== f.fix.lines.join('\n')) f.fix.original = original
    else f.fix = null
  }
  return { branch, base, head: scope.head, mergeBase: scope.mergeBase, prompt: req.prompt.name, files, findings, excluded, skipped, dropped }
}
