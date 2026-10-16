import type { FileDiff, Hunk } from '../shared/types'

const ESCAPES: Record<string, string> = { t: '\t', n: '\n', '"': '"', '\\': '\\' }

// git quotes unusual paths C-style. Limitation: octal escapes (\303…) are not decoded; with core.quotePath=false they only appear for control characters.
function cleanPath(raw: string): string {
  let p = raw.replace(/\t$/, '')
  if (p.startsWith('"') && p.endsWith('"')) p = p.slice(1, -1).replace(/\\(.)/g, (_, c: string) => ESCAPES[c] ?? c)
  return p.replace(/^[ab]\//, '')
}

export function parseDiff(text: string): FileDiff[] {
  const files: FileDiff[] = []
  let file: FileDiff | null = null
  let hunk: Hunk | null = null
  let oldNo = 0
  let newNo = 0
  for (const line of text.split('\n')) {
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(.*) b\/(.*)$/.exec(line)
      file = { oldPath: m?.[1] ?? '', newPath: m?.[2] ?? '', headerLines: [line], hunks: [], binary: false, isNew: false, isDeleted: false }
      files.push(file)
      hunk = null
      continue
    }
    if (!file) continue
    const h = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line)
    if (h) {
      hunk = {
        header: line,
        oldStart: Number(h[1]),
        oldLines: h[2] === undefined ? 1 : Number(h[2]),
        newStart: Number(h[3]),
        newLines: h[4] === undefined ? 1 : Number(h[4]),
        lines: []
      }
      file.hunks.push(hunk)
      oldNo = hunk.oldStart
      newNo = hunk.newStart
      continue
    }
    if (!hunk) {
      file.headerLines.push(line)
      if (line.startsWith('new file mode')) file.isNew = true
      else if (line.startsWith('deleted file mode')) file.isDeleted = true
      else if (line.startsWith('Binary files') || line === 'GIT binary patch') file.binary = true
      else if (line.startsWith('--- ') && line !== '--- /dev/null') file.oldPath = cleanPath(line.slice(4))
      else if (line.startsWith('+++ ') && line !== '+++ /dev/null') file.newPath = cleanPath(line.slice(4))
      continue
    }
    const sign = line[0]
    if (sign === ' ') hunk.lines.push({ kind: 'context', text: line.slice(1), oldNo: oldNo++, newNo: newNo++ })
    else if (sign === '-') hunk.lines.push({ kind: 'del', text: line.slice(1), oldNo: oldNo++, newNo: null })
    else if (sign === '+') hunk.lines.push({ kind: 'add', text: line.slice(1), oldNo: null, newNo: newNo++ })
    else if (sign === '\\') {
      const last = hunk.lines[hunk.lines.length - 1]
      if (last) last.noNewline = true
    }
  }
  return files
}

// Builds a one-hunk patch keeping only the selected changed lines (same rules as `git add -p`).
// Limitation: a "\ No newline" line that ends up in the middle of the patch makes git apply fail with a clear error; acceptable for an edge case.
export function buildPatch(file: FileDiff, hunkIndex: number, selected: number[] | null, reverse: boolean): string {
  const hunk = file.hunks[hunkIndex]
  if (!hunk) throw new Error(`Hunk ${hunkIndex} not found`)
  const pick = selected ? new Set(selected) : null
  const body: string[] = []
  let oldCount = 0
  let newCount = 0
  let changes = 0
  hunk.lines.forEach((l, i) => {
    const sel = !pick || pick.has(i)
    let prefix: string | null
    if (l.kind === 'context') prefix = ' '
    else if (l.kind === 'add') prefix = sel ? '+' : reverse ? ' ' : null
    else prefix = sel ? '-' : reverse ? null : ' '
    if (prefix === null) return
    if (prefix !== ' ') changes++
    if (prefix !== '+') oldCount++
    if (prefix !== '-') newCount++
    body.push(prefix + l.text)
    if (l.noNewline) body.push('\\ No newline at end of file')
  })
  if (!changes) throw new Error('No changed line selected')
  return [...file.headerLines, `@@ -${hunk.oldStart},${oldCount} +${hunk.newStart},${newCount} @@`, ...body, ''].join('\n')
}
