import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react'
import type { RebaseAction, RebasePlan, RepoStatus } from '../../shared/types'
import { api } from './api'
import { errorText } from './format'
import { Icon } from './icons'
import type { RunOutcome } from './model'
import { applyPlan, move, movedRows, result, rowsOf, setRow, summary, targetOf, toRequest, validate, type Row } from './rebase'
import { useToast } from './toast'

const ACTIONS: [RebaseAction, string][] = [
  ['pick', 'Pick'],
  ['reword', 'Reword'],
  ['squash', 'Squash ↓'],
  ['fixup', 'Fixup ↓'],
  ['drop', 'Drop']
]

interface Props {
  repo: string
  branch: string
  upstream: string
  status: RepoStatus | null
  busy: string | null
  runOutcome: RunOutcome
  onClose: () => void // must be stable (useCallback); also called once the rebase has run
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

// Interactive rebase editor (center) and its expected result (right). Nothing runs until "Start rebase".
export function InteractiveRebase({ repo, branch, upstream, status, busy, runOutcome, onClose }: Props) {
  const notify = useToast()
  const [plan, setPlan] = useState<RebasePlan | null>(null)
  const [rows, setRows] = useState<Row[]>([])
  const [explanation, setExplanation] = useState<string | null>(null)
  const [asking, setAsking] = useState(false)
  const [autostash, setAutostash] = useState(true)
  const planRef = useRef<RebasePlan | null>(null)
  const [dragged, setDragged] = useState<number | null>(null)

  const [stale, setStale] = useState(false) // main refused the list: the commits changed under the editor
  const [announce, setAnnounce] = useState('')
  const alive = useRef(true)
  const refocus = useRef<{ sha: string; field: 'select' | 'input' } | null>(null)
  const listRef = useRef<HTMLOListElement>(null)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  // After a keyboard move the row is a different element position: put the focus back on the same control.
  useLayoutEffect(() => {
    const f = refocus.current
    if (!f) return
    refocus.current = null
    listRef.current?.querySelector<HTMLElement>(`[data-sha="${f.sha}"] ${f.field}`)?.focus()
  }, [rows])

  const load = useCallback(() => {
    let cancelled = false
    api.rebaseCommits(repo, branch, upstream).then(
      (p) => {
        if (cancelled || !alive.current) return
        setPlan(p)
        setRows(rowsOf(p))
        setExplanation(null)
        setStale(false)
      },
      (e: unknown) => {
        if (cancelled || !alive.current) return
        notify('error', errorText(e))
        onClose()
      }
    )
    return () => {
      cancelled = true
    }
  }, [repo, branch, upstream, notify, onClose])
  useEffect(() => load(), [load])

  planRef.current = plan
  if (!plan)
    return (
      <>
        <section className="center">
          <div className="pane-head">
            <span className="pane-title">Interactive rebase</span>
            <span className="faint">Loading…</span>
          </div>
        </section>
        <aside className="right" />
      </>
    )

  const propose = async () => {
    setAsking(true)
    try {
      const p = await api.proposeRebase(repo, branch, upstream)
      if (!alive.current || planRef.current !== plan) return
      setRows(applyPlan(rowsOf(plan), p))
      setExplanation(p.explanation)
    } catch (e) {
      notify('error', errorText(e))
    } finally {
      setAsking(false)
    }
  }
  const onKey = (i: number) => (e: KeyboardEvent) => {
    if (!e.altKey || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return
    e.preventDefault()
    const to = i + (e.key === 'ArrowUp' ? -1 : 1)
    if (to < 0 || to >= rows.length) return
    refocus.current = { sha: rows[i].sha, field: e.currentTarget.tagName === 'INPUT' ? 'input' : 'select' }
    setRows(move(rows, i, to))
    setAnnounce(`Moved "${rows[i].subject}" to position ${to + 1} of ${rows.length}`)
  }
  const moved = movedRows(rows)
  const after = result(rows)
  const counts = summary(rows)
  const problem = validate(rows)
  const dirty = status ? new Set([...status.staged, ...status.unstaged.filter((f) => f.status !== '?')].map((f) => f.path)).size : 0
  const start = () =>
    void runOutcome(
      'rebase',
      async () => {
        try {
          return await api.interactiveRebase(repo, toRequest(branch, upstream, rows, dirty > 0 && autostash))
        } catch (e) {
          if (alive.current && errorText(e).includes('reload the interactive rebase')) setStale(true)
          throw e
        }
      },
      `${branch} rebased`
    ).then((ok) => ok && onClose())
  const chips: [number, string, string][] = [
    [counts.squashed, 'squashed', 'var(--pink)'],
    [counts.dropped, 'dropped', 'var(--red)'],
    [counts.renamed, 'renamed', 'var(--accent)'],
    [counts.moved, 'moved', 'var(--muted)']
  ]

  return (
    <>
      <section className="center">
        <div className="pane-head ri-head">
          <span className="ri-title">Interactive rebase</span>
          <span className="muted">
            <span className="mono ri-branch">{branch}</span> onto <span className="mono link">{plan.ontoLabel}</span> <span className="faint">({plan.onto.slice(0, 7)})</span>
          </span>
          <div className="grow" />
          <span className="faint">{plural(rows.length, 'commit')} · newest first · drag to reorder</span>
          <button className="btn-claude" disabled={asking} onClick={() => void propose()}>
            {asking ? <span className="spin" /> : <Icon name="sparkle" size={14} />}
            {asking ? 'Claude is thinking…' : 'Propose with Claude'}
          </button>
        </div>
        <div className="scroll">
          <span className="sr-only" aria-live="polite">
            {announce}
          </span>
          {stale && (
            <section className="ri-plan">
              <span>The commits of {branch} changed since this list was loaded.</span>
              <button className="btn ghost" onClick={load}>
                Reload
              </button>
            </section>
          )}
          {explanation !== null && (
            <section className="ri-plan">
              <Icon name="sparkle" size={16} />
              <span>
                <b>Plan proposed by Claude, already applied below.</b> {explanation}
              </span>
              <button
                className="btn ghost"
                onClick={() => {
                  setRows(rowsOf(plan))
                  setExplanation(null)
                }}
              >
                Back to the original plan
              </button>
            </section>
          )}
          <div className="ri-cols">
            <span className="ri-handle" />
            <span className="ri-action-col">Action</span>
            <span className="ri-sha">SHA</span>
            <span>Message</span>
          </div>
          <ol className="ri-list" ref={listRef}>
            {rows.map((r, i) => {
              const target = r.action === 'squash' || r.action === 'fixup' ? targetOf(rows, i) : null
              const note = target ? `melded into ${target.sha.slice(0, 7)}` : r.action === 'drop' ? 'will be dropped' : moved.has(r.sha) ? 'moved' : ''
              return (
                <li
                  key={r.sha}
                  data-sha={r.sha}
                  className={`ri-row ${r.action} ${dragged !== null && dragged !== i ? 'target' : ''}`}
                  draggable
                  onDragStart={(e) => {
                    e.dataTransfer.effectAllowed = 'move'
                    setDragged(i)
                  }}
                  onDragEnd={() => setDragged(null)}
                  onDragOver={(e) => dragged !== null && e.preventDefault()}
                  onDrop={(e) => {
                    e.preventDefault()
                    if (dragged !== null) setRows((rs) => move(rs, dragged, i))
                    setDragged(null)
                  }}
                >
                  <span className="ri-handle" title="Drag to move, or Alt+↑ / Alt+↓">
                    <Icon name="grip" size={16} stroke={2.6} />
                  </span>
                  <span className="ri-action-col">
                    <select className={`ri-action ra-${r.action}`} aria-label={`Action for ${r.sha.slice(0, 7)}`} value={r.action} onKeyDown={onKey(i)} onChange={(e) => setRows((rs) => setRow(rs, i, { action: e.target.value as RebaseAction }))}>
                      {ACTIONS.map(([a, label]) => (
                        <option key={a} value={a}>
                          {label}
                        </option>
                      ))}
                    </select>
                  </span>
                  <span className="ri-sha">{r.sha.slice(0, 7)}</span>
                  <span className="ri-msg">
                    {r.action === 'reword' ? (
                      <input className="ri-input" aria-label={`New message for ${r.sha.slice(0, 7)}`} value={r.message} onKeyDown={onKey(i)} onChange={(e) => setRows((rs) => setRow(rs, i, { message: e.target.value }))} />
                    ) : (
                      <span className="s">{r.subject}</span>
                    )}
                    {note && <span className={`ri-note ${target ? 'meld' : r.action === 'drop' ? 'drop' : 'moved'}`}>{note}</span>}
                  </span>
                </li>
              )
            })}
          </ol>
        </div>
      </section>
      <aside className="right">
        <div className="right-head">
          <span className="pane-title">Expected result</span>
          <span className="faint">
            {plural(rows.length, 'commit')} → {after.length}
          </span>
        </div>
        <div className="scroll rp-body">
          <ol className="rp-list">
            {after.map((c, k) => (
              <li key={c.sha}>
                <span className="rp-rail">
                  <span className="l" style={{ background: k ? 'var(--amber)' : 'transparent' }} />
                  <span className="dot" style={{ background: 'var(--amber)' }} />
                  <span className="l grow" style={{ background: 'var(--amber)' }} />
                </span>
                <span className="rp-text">
                  <span className="s">{c.subject}</span>
                  <span className="faint">{c.note}</span>
                </span>
              </li>
            ))}
            <li className="base">
              <span className="rp-rail">
                <span className="l" style={{ background: 'var(--accent)' }} />
                <span className="dot" style={{ background: 'var(--accent)' }} />
              </span>
              <span className="rp-text">
                <span className="s">{plan.ontoLabel}</span>
                <span className="faint">{plan.onto.slice(0, 7)} · base</span>
              </span>
            </li>
          </ol>
          <ul className="rp-chips">
            {chips
              .filter(([n]) => n > 0)
              .map(([n, label, c]) => (
                <li key={label} style={{ color: c, background: `color-mix(in srgb, ${c} 8%, transparent)`, borderColor: `color-mix(in srgb, ${c} 25%, transparent)` }}>
                  {n} {label}
                </li>
              ))}
          </ul>
          {plan.pushed > 0 && (
            <div className="warn-box">
              <Icon name="warn" size={16} stroke={2} />
              <span>
                {plan.pushed} of these commits {plan.pushed === 1 ? 'is' : 'are'} already on a remote. After the rebase, push with <span className="mono">--force-with-lease</span>.
              </span>
            </div>
          )}
          {dirty > 0 && (
            <label className="check">
              <input type="checkbox" checked={autostash} onChange={(e) => setAutostash(e.target.checked)} /> Stash the {plural(dirty, 'local change')}, then re-apply them after
            </label>
          )}
          {problem && <span className="note err">{problem}</span>}
        </div>
        <div className="op-foot">
          <div className="cv-row">
            <button className="btn ri-cancel" onClick={onClose}>
              Cancel
            </button>
            <button className="btn-primary ri-start" disabled={!!problem || !!busy} onClick={start}>
              Start rebase
            </button>
          </div>
          <span className="note">Can be undone in one click afterwards (Ctrl+Z).</span>
        </div>
      </aside>
    </>
  )
}
