import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { FILE_HISTORY_LIMIT, type Commit, type FileCommit } from '../../shared/types'
import { api } from './api'
import { Explain } from './CommitPanel'
import { DiffView } from './DiffView'
import { colorFor, errorText, initials, relativeDate, splitPath } from './format'
import { Icon } from './icons'
import type { Focus, RunOp } from './model'
import { useToast } from './toast'

interface Props {
  repo: string
  path: string
  rev: string | null // the history starts at this commit (null: HEAD)
  version: number
  run: RunOp
  onFocus: (f: Focus) => void
}

// The history of one file: the selected commit's diff of it (center), the commits that touched it (right).
export function FileHistory({ repo, path, rev, version, run, onFocus }: Props) {
  const notify = useToast()
  const [follow, setFollow] = useState(true)
  const [history, setHistory] = useState<FileCommit[] | null>(null)
  const [picked, setPicked] = useState<string | null>(null) // null: the newest commit
  const [loading, setLoading] = useState(true)
  const heading = useRef<HTMLSpanElement>(null)

  useEffect(() => heading.current?.focus(), [])

  useEffect(() => {
    let alive = true
    setLoading(true)
    api.fileHistory(repo, path, rev, follow).then(
      (h) => {
        if (!alive) return
        setHistory((old) => (JSON.stringify(old) === JSON.stringify(h) ? old : h))
        setPicked((p) => (h.some((c) => c.sha === p) ? p : null))
        setLoading(false)
      },
      (e: unknown) => {
        if (!alive) return
        setHistory((old) => old ?? []) // a failed refresh keeps what is shown
        setLoading(false)
        notify('error', errorText(e))
      }
    )
    return () => {
      alive = false
    }
  }, [repo, path, rev, follow, version, notify])

  const entry = history?.find((c) => c.sha === picked) ?? history?.[0] ?? null
  const onKeys = (e: KeyboardEvent<HTMLOListElement>) => {
    if (!history?.length) return
    const i = Math.max(0, history.findIndex((c) => c.sha === entry?.sha))
    const n = { ArrowDown: Math.min(i + 1, history.length - 1), ArrowUp: Math.max(i - 1, 0), Home: 0, End: history.length - 1 }[e.key]
    if (n === undefined) return
    e.preventDefault()
    setPicked(history[n].sha)
    ;(e.currentTarget.children[n]?.firstElementChild as HTMLElement | undefined)?.focus()
  }
  const back = () => onFocus(rev ? { kind: 'commit', sha: rev } : { kind: 'wip' })
  const [dir, name] = splitPath(path)
  const count = history ? `${history.length >= FILE_HISTORY_LIMIT ? 'Last ' : ''}${history.length} commit${history.length === 1 ? '' : 's'}` : ''

  return (
    <>
      <section className="center">
        <div className="pane-head">
          <button className="tbtn boxed" onClick={back}>
            <Icon name="back" size={14} stroke={2} /> History
          </button>
          <span className="mono">
            <span className="faint">{dir}</span>
            {name}
          </span>
          {entry && <span className="badge grey">{entry.sha.slice(0, 7)}</span>}
        </div>
        {entry ? (
          <DiffView key={entry.sha} repo={repo} selection={{ path: entry.path, commit: entry.sha, oldPath: entry.oldPath }} version={version} onBack={back} run={run} hideHead />
        ) : (
          <div className="diff-body">
            <span className="faint">{history ? 'No commit touched this file.' : 'Loading…'}</span>
          </div>
        )}
      </section>
      <aside className="right fh-panel">
        <div className="fh-head">
          <div className="fh-title">
            <span ref={heading} tabIndex={-1} className="pane-title">
              File history
            </span>
            <span className="faint">
              {loading && <span className="spin" role="status" aria-label="Loading" />} {count}
            </span>
          </div>
          <label className="check">
            <input type="checkbox" checked={follow} onChange={(e) => {
                setHistory(null)
                setPicked(null)
                setFollow(e.target.checked)
              }} /> Follow renames
          </label>
        </div>
        {entry && <CommitCard repo={repo} commit={entry} onFocus={onFocus} />}
        <ol className={`fh-list ${loading ? 'loading' : ''}`} role="listbox" aria-label={`Commits of ${name}`} onKeyDown={onKeys}>
          {history?.map((c) => (
            <li key={c.sha} role="presentation">
              <button className={`fh-item ${c.sha === entry?.sha ? 'sel' : ''}`} role="option" aria-selected={c.sha === entry?.sha} tabIndex={c.sha === entry?.sha ? 0 : -1} onClick={() => setPicked(c.sha)}>
                <span className="avatar lg" style={{ background: colorFor(c.author) }}>
                  {initials(c.author)}
                </span>
                <span className="fh-text">
                  <span className="fh-msg">{c.subject}</span>
                  <span className="fh-meta">
                    <span className="mono sha">{c.sha.slice(0, 7)}</span>
                    <span>
                      {c.author} · {relativeDate(c.date)}
                    </span>
                  </span>
                  {c.oldPath && <span className="fh-meta">Renamed from {c.oldPath}</span>}
                </span>
                <span className="fh-counts">
                  {c.add ? <span className="add-n">+{c.add}</span> : null}
                  {c.del ? <span className="del-n">−{c.del}</span> : null}
                </span>
              </button>
            </li>
          ))}
        </ol>
      </aside>
    </>
  )
}

interface CardProps {
  repo: string
  commit: Pick<Commit, 'sha' | 'subject' | 'author' | 'date'>
  onFocus: (f: Focus) => void
}

// The selected commit: open it in the graph, ask Claude to explain it.
function CommitCard({ repo, commit, onFocus }: CardProps) {
  return (
    <div className="fh-card">
      <div className="cp-line">
        <span className="cp-sha">{commit.sha.slice(0, 7)}</span>
        <span className="faint">{relativeDate(commit.date)}</span>
      </div>
      <span className="fh-subject">{commit.subject}</span>
      <div className="cp-author">
        <span className="avatar" style={{ background: colorFor(commit.author) }}>
          {initials(commit.author)}
        </span>
        <span>{commit.author}</span>
      </div>
      <div className="fh-actions">
        <button className="head-btn" onClick={() => onFocus({ kind: 'commit', sha: commit.sha })}>
          Show in graph
        </button>
      </div>
      <Explain key={commit.sha} repo={repo} sha={commit.sha} />
    </div>
  )
}
