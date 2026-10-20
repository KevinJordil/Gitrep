import { hasConflictMarkers } from '../shared/conflicts'
import type { Confidence, ConflictHunk, ConflictSuggestion } from '../shared/types'
import { askClaude, isSensitive, MAX_DIFF_CHARS, type ClaudeOptions } from './claude'
import { getOperationInfo } from './conflicts'
import { getStatus } from './repo'

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
