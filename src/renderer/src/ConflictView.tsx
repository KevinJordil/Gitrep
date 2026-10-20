import { useEffect, useRef, useState } from 'react'
import type { ConflictFile, ConflictSuggestion, OperationInfo, RepoStatus } from '../../shared/types'
import { api } from './api'
import { errorText, splitPath } from './format'
import { FileIcon, StatusBadge } from './FileIcon'
import { Icon } from './icons'
import type { RunOp, RunOutcome, Selection } from './model'
import { applySuggestions, blocksOf, edit, hunkOf, newDraft, takeAll, takeSide, textOf, type Draft, type Origin } from './resolve'
import { useToast } from './toast'

const OP_LABEL = { merge: 'merge', rebase: 'rebase', 'cherry-pick': 'cherry-pick', revert: 'revert' } as const
const CONTEXT = 3 // lines shown around a block in the side panels
const CONFIDENCE = { high: 'green', medium: 'amber', low: 'red' } as const

interface ViewProps {
  repo: string
  path: string | null // the conflicted file shown; null when none is left
  info: OperationInfo
  draft: Draft | undefined
  version: number // bumped by every refresh: the file is read again
  busy: string | null
  run: RunOp
  onDraft: (path: string, d: Draft) => void
}

// Center of the conflict view: both sides of the current block, Claude, and the editable result.
export function ConflictView({ repo, path, info, draft, version, busy, run, onDraft }: ViewProps) {
  const notify = useToast()
  const [file, setFile] = useState<ConflictFile | null>(null)
  const [current, setCurrent] = useState(0)
  const [suggestion, setSuggestion] = useState<{ start: number; s: ConflictSuggestion } | null>(null)
  const [asking, setAsking] = useState(false)
  const latest = useRef({ path, source: draft?.source })
  latest.current = { path, source: draft?.source }

  useEffect(() => {
    setSuggestion(null)
    setCurrent(0)
  }, [path])
  useEffect(() => {
    if (!path) return
    let alive = true
    api.conflictFile(repo, path).then(
      (f) => alive && setFile((old) => (old && JSON.stringify(old) === JSON.stringify(f) ? old : f)),
      (e: unknown) => notify('error', errorText(e))
    )
    return () => {
      alive = false
    }
  }, [repo, path, version, notify])

  // A draft made from another version of the file is stale (the file changed on disk): start again from the file.
  useEffect(() => {
    if (file?.kind === 'text' && draft?.source !== file.text) onDraft(file.path, newDraft(file.text))
  }, [file, draft, onDraft])

  if (!path)
    return (
      <div className="empty">
        <Icon name="check" size={22} stroke={2.4} />
        <span>{info.operation ? `No conflicted file left: continue the ${OP_LABEL[info.operation]} from the right panel.` : 'No conflicted file left.'}</span>
      </div>
    )
  const [dir, name] = splitPath(path)
  const head = (
    <span className="mono">
      <span className="faint">{dir}</span>
      {name}
    </span>
  )
  if (!file || file.path !== path || (file.kind === 'text' && draft?.source !== file.text))
    return (
      <div className="pane-head">
        {head}
        <span className="faint">Loading…</span>
      </div>
    )

  const side = (which: 'ours' | 'theirs') => () => void run('resolve', () => api.resolveSide(repo, path, which), `${path}: took ${info[which].name}`)
  if (file.kind !== 'text' || !draft)
    return (
      <>
        <div className="pane-head">
          {head}
          <span className="badge red">{file.kind === 'binary' ? 'Binary file' : 'Deleted on one side'}</span>
        </div>
        <div className="cv-body">
          <div className="cv-whole">
            <span>{file.kind === 'binary' ? 'This file cannot be merged line by line: keep one side\'s version.' : 'One side deleted this file, the other changed it: keep the file or delete it.'}</span>
            <div className="cv-row">
              {(['ours', 'theirs'] as const).map((w) => (
                <button key={w} className={`cv-take ${w}`} disabled={!!busy} onClick={side(w)}>
                  {file[w] ? `Keep ${info[w].name}'s version` : `Delete it, as ${info[w].name} did`}
                </button>
              ))}
            </div>
          </div>
        </div>
      </>
    )

  const blocks = blocksOf(draft)
  const i = Math.min(current, Math.max(blocks.length - 1, 0))
  const block = blocks[i]
  const shown = suggestion && block && suggestion.start === block.start ? suggestion.s : null
  const ask = async () => {
    if (!block) return
    setAsking(true)
    const asked = { path, source: draft.source }
    try {
      const [s] = await api.suggestConflict(repo, path, [hunkOf(draft, block)])
      // The file or its draft changed while Claude was thinking: the proposal no longer fits.
      if (asked.path !== latest.current.path || asked.source !== latest.current.source) return
      if (s) setSuggestion({ start: block.start, s })
      else notify('error', 'Claude proposed nothing for this block')
    } catch (e) {
      notify('error', errorText(e))
    } finally {
      setAsking(false)
    }
  }
  const apply = () => {
    if (!shown) return
    // Only this block: its note is numbered like the block.
    onDraft(path, applySuggestions(draft, blocks.map((_, k) => (k === i ? shown : null))))
    setSuggestion(null)
  }
  const lines = (which: 'ours' | 'theirs') => {
    if (!block) return []
    const before = draft.lines.slice(Math.max(0, block.start - CONTEXT), block.start)
    const after = draft.lines.slice(block.end, block.end + CONTEXT)
    let n = block.start - before.length
    return [...before.map((t) => ({ t, hl: false })), ...block[which].map((t) => ({ t, hl: true })), ...after.map((t) => ({ t, hl: false }))].map((l) => ({ ...l, n: ++n }))
  }
  const markers = blocks.length > 0
  const tag = (o: Origin) => (o === 'ours' ? info.ours.name : o === 'theirs' ? info.theirs.name : o === 'claude' ? 'Claude' : o === 'common' ? '' : o)

  return (
    <>
      <div className="pane-head">
        {head}
        <span className={`badge ${markers ? 'red' : 'grey'}`}>{markers ? `Conflict ${i + 1} of ${blocks.length}` : 'No conflict left'}</span>
        {blocks.length > 1 && (
          <>
            <button className="iconbtn sm" aria-label="Previous conflict" onClick={() => setCurrent((i + blocks.length - 1) % blocks.length)}>
              <Icon name="up" size={14} stroke={2} />
            </button>
            <button className="iconbtn sm" aria-label="Next conflict" onClick={() => setCurrent((i + 1) % blocks.length)}>
              <Icon name="down" size={14} stroke={2} />
            </button>
          </>
        )}
        <div className="grow" />
        <button className="small-btn" disabled={!markers} onClick={() => onDraft(path, takeAll(draft, 'ours'))}>
          Take all from {info.ours.name}
        </button>
        <button className="small-btn" disabled={!markers} onClick={() => onDraft(path, takeAll(draft, 'theirs'))}>
          Take all from {info.theirs.name}
        </button>
      </div>
      <div className="cv-body">
        {block ? (
          <>
            <div className="cv-sides">
              {(['ours', 'theirs'] as const).map((w) => (
                <section key={w} className={`cv-side ${w}`} aria-label={info[w].name}>
                  <div className="cv-side-head">
                    <span className="dot" />
                    <span className="cv-name">{info[w].name}</span>
                    <span className="faint">{info[w].detail}</span>
                    <div className="grow" />
                    <button className={`cv-take ${w}`} onClick={() => onDraft(path, takeSide(draft, block, w))}>
                      Take this block
                    </button>
                  </div>
                  <div className="cv-code">
                    {lines(w).map((l, k) => (
                      <div key={k} className={l.hl ? 'hl' : ''}>
                        <span className="n">{l.n}</span>
                        <span className="t">{l.t}</span>
                      </div>
                    ))}
                  </div>
                </section>
              ))}
            </div>
            <div className="cv-row">
              <button className="small-btn" onClick={() => onDraft(path, takeSide(draft, block, 'both'))}>
                Take both ({info.ours.name} first)
              </button>
            </div>
          </>
        ) : (
          <div className="cv-whole">Every block of this file is resolved: check the result, then mark it as resolved.</div>
        )}
        <section className="cv-claude">
          <Icon name="sparkle" size={18} />
          <div className="cv-claude-text">
            {shown ? (
              <>
                <span className="cv-claude-title">
                  Claude&apos;s suggestion: {shown.summary}
                  <span className={`badge ${CONFIDENCE[shown.confidence]}`}>{shown.confidence[0].toUpperCase() + shown.confidence.slice(1)} confidence</span>
                </span>
                <span>{shown.explanation}</span>
              </>
            ) : draft.notes.length ? (
              <>
                <span className="cv-claude-title">Proposed by Claude, already in the result below</span>
                {draft.notes.map((n) => (
                  <span key={n}>{n}</span>
                ))}
              </>
            ) : (
              <span>Claude can propose a resolution for this block, with an explanation. Nothing is applied until you click.</span>
            )}
          </div>
          <div className="cv-row">
            {shown ? (
              <>
                <button className="btn-primary sm" onClick={apply}>
                  Apply to result
                </button>
                <button className="btn ghost" onClick={() => setSuggestion(null)}>
                  Dismiss
                </button>
              </>
            ) : (
              <button className="btn-claude" disabled={asking || !block} onClick={() => void ask()}>
                {asking ? <span className="spin" /> : <Icon name="sparkle" size={14} />}
                {asking ? 'Claude is thinking…' : 'Suggest with Claude'}
              </button>
            )}
          </div>
          <div className="cv-handover">
            <button className="btn-claude" disabled={!!busy} onClick={() => void run('handover', () => api.handOver(repo), 'Claude Code opened in a terminal: review its changes here, then continue')}>
              <Icon name="terminal" size={14} /> Hand over to Claude Code
            </button>
            <span>Opens a terminal in the repository with the conflict&apos;s context. Claude Code can edit the files, build and run the tests; you review and continue here.</span>
          </div>
        </section>
        <section className="cv-result">
          <div className="cv-result-head">
            <b>Result</b>
            <span className="faint">editable · the left bar shows where each line comes from</span>
            <div className="grow" />
            <button className="btn-primary sm" disabled={markers || !!busy} title={markers ? 'Resolve every conflict block first' : undefined} onClick={() => void run('resolve', () => api.resolveFile(repo, path, textOf(draft), draft.source), `${path} marked as resolved`)}>
              Mark as resolved
            </button>
          </div>
          <div className="cv-editor">
            <div className="cv-gutter" aria-hidden="true">
              {draft.origins.map((o, k) => (
                <span key={k} className={`o-${o}`}>
                  {k + 1}
                </span>
              ))}
            </div>
            <textarea className="cv-text" aria-label="Result" wrap="off" spellCheck={false} value={draft.lines.join('\n')} style={{ height: draft.lines.length * 21 + 12 }} onChange={(e) => onDraft(path, edit(draft, e.target.value))} />
            <div className="cv-tags" aria-hidden="true">
              {draft.origins.map((o, k) => (
                <span key={k} className={`o-${o}`}>
                  {tag(o)}
                </span>
              ))}
            </div>
          </div>
        </section>
      </div>
    </>
  )
}

interface PanelProps {
  repo: string
  status: RepoStatus
  info: OperationInfo
  path: string | null
  busy: string | null
  runOutcome: RunOutcome
  onPath: (path: string) => void
  onSelect: (s: Selection) => void
}

const STEP = { done: ['✓', 'applied'], current: ['!', 'conflict'], todo: ['', 'pending'] } as const

// Right panel of the conflict view: rebase steps, conflicted and merged files, Continue.
export function OperationPanel({ repo, status, info, path, busy, runOutcome, onPath, onSelect }: PanelProps) {
  const op = info.operation
  const files = (title: string, list: RepoStatus['staged'], conflict: boolean) => (
    <section className="fgroup">
      <div className="fgroup-head">
        <span>
          {title} <span className="mono faint">{list.length}</span>
        </span>
      </div>
      {list.map((f) => {
        const [dir, name] = splitPath(f.path)
        return (
          <div key={f.path} className={`file ${conflict ? 'conflict' : ''} ${conflict && f.path === path ? 'sel' : ''}`}>
            {conflict ? <StatusBadge status="U" /> : <span className="st st-added" title="Resolved">✓</span>}
            <FileIcon path={f.path} />
            <button className="path" onClick={() => (conflict ? onPath(f.path) : onSelect({ path: f.path, side: 'staged' }))}>
              <span className="faint">{dir}</span>
              {name}
            </button>
          </div>
        )
      })}
    </section>
  )
  return (
    <aside className="right">
      {info.steps.length > 0 && (
        <div className="op-steps">
          <span className="pane-title">Rebase steps</span>
          <ol>
            {info.steps.map((s, k) => (
              <li key={`${k}:${s.sha}`} className={`step ${s.state}`}>
                <span className="step-icon">{STEP[s.state][0]}</span>
                <span className="step-text">
                  <span className="msg">{s.subject}</span>
                  <span className="mono faint">
                    {s.sha.slice(0, 7)} · {STEP[s.state][1]}
                  </span>
                </span>
              </li>
            ))}
          </ol>
        </div>
      )}
      <div className="scroll">
        {files('Conflicted', status.conflicted, true)}
        {files('Merged automatically', status.staged, false)}
      </div>
      <div className="op-foot">
        {op ? (
          <>
            <button className="btn-primary" disabled={!!busy || status.conflicted.length > 0} onClick={() => void runOutcome('continue', () => api.continueOperation(repo), `${OP_LABEL[op][0].toUpperCase()}${OP_LABEL[op].slice(1)} complete`)}>
              Continue {OP_LABEL[op]}
            </button>
            <span className="note">Available when every conflict is resolved. Abort puts everything back as before the {OP_LABEL[op]}.</span>
          </>
        ) : (
          <span className="note">Conflicts left by applying a stash: resolved files are staged, the stash is kept.</span>
        )}
      </div>
    </aside>
  )
}
