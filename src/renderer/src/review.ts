import type { Branch, FixRequest, ForgeInfo, ForgeKind, PostStep, RepoEntry, Review, ReviewComment, ReviewFinding, ReviewPrompt, ReviewRequest, Settings, Severity } from '../../shared/types'

export const FORGE_NAME = { gitlab: 'GitLab', github: 'GitHub' } as const

// "!12" on GitLab, "#12" on GitHub; "MR" / "PR" for the copy.
export const requestLabel = (info: ForgeInfo) => (info.request ? `${info.kind === 'github' ? '#' : '!'}${info.request.number}` : '')
export const requestWord = (info: ForgeInfo) => (info.kind === 'github' ? 'PR' : 'MR')
export const requestName = (info: ForgeInfo) => (info.kind === 'github' ? 'Pull request' : 'Merge request')

// The branch to compare with: the request's target, else develop, main or master; the remote-tracking copy first (it is what the forge compares with).
export function defaultBase(branches: Branch[], branch: string, target?: string): string {
  const names = new Set(branches.map((b) => b.name))
  const remote = branches.find((b) => b.name === branch)?.remote ? branch.split('/')[0] : 'origin'
  for (const t of [target, 'develop', 'main', 'master']) {
    if (!t) continue
    for (const n of [`${remote}/${t}`, t]) if (n !== branch && names.has(n)) return n
  }
  return branches.find((b) => b.name !== branch && !b.remote)?.name ?? branches.find((b) => b.name !== branch)?.name ?? ''
}

export interface PromptChoice {
  key: string // 'repo' or 'global:<name>'
  prompt: ReviewPrompt
  repo: boolean // the repository's own prompt
}

// The repository's own prompt first (its default), then the global ones (the first is the default elsewhere).
export function promptChoices(settings: Settings, entry?: RepoEntry): PromptChoice[] {
  const own = entry?.reviewPrompt ? [{ key: 'repo', prompt: entry.reviewPrompt, repo: true }] : []
  return [...own, ...settings.reviewPrompts.map((p) => ({ key: `global:${p.name}`, prompt: p, repo: false }))]
}

export type ReviewMode = 'branch' | 'request' // fixes in my working tree, or comments posted to the merge / pull request

export interface ReviewSession {
  started: number // a new value for each review: the screen starts over
  review: Review
  request: ReviewRequest // what Re-run sends again
  mode: ReviewMode
  forge: ForgeInfo | null
}

// What the user did with a finding: kept or ignored, the comment text, the fix text (null: no fix).
export interface FindingEdit {
  keep: boolean
  body: string
  fix: string | null
}

// What the review screen remembers while another view is shown.
export interface ReviewUi {
  edits: Record<number, FindingEdit>
  severity: Severity | 'all'
  query: string
  allFiles: boolean
  selected: number | null
  post: PostState // kept here: the posting goes on while another view is shown
}

export const SEVERITIES: Severity[] = ['critical', 'important', 'minor']
export const SEVERITY_LABEL: Record<Severity, string> = { critical: 'Critical', important: 'Important', minor: 'Minor' }
export const SEVERITY_CLASS: Record<Severity, string> = { critical: 'crit', important: 'imp', minor: 'min' }

export const initialEdits = (findings: ReviewFinding[]): Record<number, FindingEdit> => Object.fromEntries(findings.map((f) => [f.id, { keep: true, body: f.body, fix: f.fix ? f.fix.lines.join('\n') : null }]))

// Most severe first, then by file and line: the order of the list and of "next finding".
export const sortFindings = (findings: ReviewFinding[]): ReviewFinding[] =>
  [...findings].sort((a, b) => SEVERITIES.indexOf(a.severity) - SEVERITIES.indexOf(b.severity) || a.path.localeCompare(b.path) || a.endLine - b.endLine)

export function visibleFindings(findings: ReviewFinding[], severity: Severity | 'all', query: string): ReviewFinding[] {
  const q = query.trim().toLowerCase()
  return sortFindings(findings).filter((f) => (severity === 'all' || f.severity === severity) && (!q || `${f.path} ${f.title} ${f.body}`.toLowerCase().includes(q)))
}

export const countBy = (findings: ReviewFinding[]): Record<Severity, number> => ({
  critical: findings.filter((f) => f.severity === 'critical').length,
  important: findings.filter((f) => f.severity === 'important').length,
  minor: findings.filter((f) => f.severity === 'minor').length
})

// The fixes of the kept findings, with the edited replacement text.
export function keptFixes(review: Review, edits: Record<number, FindingEdit>): FixRequest[] {
  return review.findings.flatMap((f) => {
    const e = edits[f.id]
    if (!f.fix || !e?.keep || e.fix === null) return []
    return [{ id: f.id, path: f.path, line: f.line, endLine: f.endLine, original: f.fix.original, lines: e.fix === '' ? [] : e.fix.split('\n') }]
  })
}

export const shortPath = (path: string) => path.slice(path.lastIndexOf('/') + 1)
export const where = (f: ReviewFinding) => `${f.path}:${f.endLine}`

export const newUi = (review: Review): ReviewUi => ({ edits: initialEdits(review.findings), severity: 'all', query: '', allFiles: false, selected: sortFindings(review.findings)[0]?.id ?? null, post: { id: 0, summary: null, draft: true, steps: null, posting: false, moved: false } })

// "Automated review (prompt). 1 critical, 2 minor." from the kept findings: the default summary comment.
export function defaultSummary(review: Review, edits: Record<number, FindingEdit>): string {
  const counts = countBy(review.findings.filter((f) => edits[f.id]?.keep))
  const parts = SEVERITIES.filter((s) => counts[s]).map((s) => `${counts[s]} ${s}`)
  return `Automated review (${review.prompt}). ${parts.length ? `${parts.join(', ')}.` : 'Nothing to report.'}`
}

// The kept findings as inline comments, with their edited text. Empty comments are left out.
export function keptComments(review: Review, edits: Record<number, FindingEdit>): { label: string; comment: ReviewComment }[] {
  return sortFindings(review.findings).flatMap((f) => {
    const e = edits[f.id]
    const file = review.files.find((x) => x.newPath === f.path)
    if (!e?.keep || !e.body.trim() || !file) return []
    return [{ label: `${shortPath(f.path)}:${f.endLine}`, comment: { path: file.newPath, oldPath: file.oldPath || file.newPath, newLine: f.anchor.newNo, oldLine: f.anchor.oldNo, body: e.body.trim() } }]
  })
}

export interface PlannedStep {
  label: string
  step: PostStep
}

// What Post sends, in order. GitHub pending review: everything in one call, submitted later on GitHub.
// GitLab draft: draft notes, then one publish (only once every other step went through).
export function postPlan(kind: ForgeKind, draft: boolean, summary: string, comments: { label: string; comment: ReviewComment }[]): PlannedStep[] {
  const body = summary.trim()
  if (kind === 'github' && draft) return comments.length || body ? [{ label: `Pending review (${comments.length} comment${comments.length === 1 ? '' : 's'})`, step: { kind: 'review', body, comments: comments.map((c) => c.comment) } }] : []
  const steps: PlannedStep[] = comments.map((c) => ({ label: c.label, step: { kind: 'comment', comment: c.comment } }))
  if (body) steps.unshift({ label: 'Summary comment', step: { kind: 'summary', body } })
  if (kind === 'gitlab' && draft && steps.length) steps.push({ label: 'Publish the draft review', step: { kind: 'publish' } })
  return steps
}

export interface PostStepState extends PlannedStep {
  state: 'todo' | 'run' | 'done' | 'fail' | 'skip'
  error?: string
}

// Posting to a request. summary: null until edited (then it follows the kept findings). id: tells a stale loop from the current one.
export interface PostState {
  id: number
  summary: string | null
  draft: boolean
  steps: PostStepState[] | null
  posting: boolean
  moved: boolean // the forge head is no longer the reviewed one
}

// A skipped step counts as complete: the draft is published and the posting ends without it.
export function postStatus(steps: PostStepState[]) {
  const n = (s: PostStepState['state']) => steps.filter((x) => x.state === s).length
  return { done: n('done'), skipped: n('skip'), failed: n('fail'), todo: n('todo'), finished: steps.every((x) => x.state === 'done' || x.state === 'skip') }
}

// The main process prefixes this to its refusal when the forge head is not the reviewed one.
export const HEAD_MOVED = 'HEAD_MOVED:'
export const MOVED_TEXT = 'The request moved since this review: re-run the review.'
export const isMoved = (e: unknown) => (e instanceof Error ? e.message : String(e)).includes(HEAD_MOVED)
