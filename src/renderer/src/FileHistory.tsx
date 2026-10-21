import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { FILE_HISTORY_LIMIT, type Blame, type Commit, type FileCommit } from '../../shared/types'
import { api } from './api'
import { BlameView } from './Blame'
import { Explain } from './CommitPanel'
import { DiffView } from './DiffView'
import { colorFor, errorText, initials, relativeDate, splitPath } from './format'
import { Icon } from './icons'
import type { FileView, Focus, RunOp } from './model'
import { useToast } from './toast'

interface Props {
  repo: string
  path: string
  rev: string | null // the history starts at this commit (null: HEAD), and the blame by default
  view: FileView // shown first
  version: number
  run: RunOp
  onFocus: (f: Focus) => void
}

// A file at a revision: the commit and the file's path in it.
type Target = { rev: string; path: string }

// The history of one file (right) and, in the center, the selected commit's diff of it or the file's blame.
export function FileHistory({ repo, path, rev, view: initialView, version, run, onFocus }: Props) {
  const notify = useToast()
  const [view, setView] = useState<FileView>(initialView)
  const [follow, setFollow] = useState(true)
  const [history, setHistory] = useState<FileCommit[] | null>(null)
  const [picked, setPicked] = useState<string | null>(null) // null: the newest commit
  const [loading, setLoading] = useState(true)
  const heading = useRef<HTMLSpanElement>(null)
  const [at, setAt] = useState<Target | null>(null) // the revision blamed (null: where the view started)
  const [blamed, setBlamed] = useState<{ key: string; blame: Blame | null; error: string } | null>(null)
  const [chosen, setChosen] = useState<string | null>(null) // the commit of the chunk clicked
  const [hover, setHover] = useState<string | null>(null)
  const list = useRef<HTMLOListElement>(null)
  const blamedKey = useRef<string | null>(null) // key of the blame shown

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

  // Blame once per revision and path; a blame of HEAD is redone when the repository changes.
  const target = { rev: at?.rev ?? rev, path: at?.path ?? path }
  const key = `${target.rev}:${target.path}`
  const tick = target.rev === null ? version : 0
  useEffect(() => {
    if (view !== 'blame') return
    let alive = true
    api.blame(repo, target.rev, target.path).then(
      (b) => alive && setBlamed((old) => (old?.key === key && old.blame?.sha === b.sha ? old : { key, blame: b, error: '' })),
      (e: unknown) => {
        if (!alive) return
        // a failed refresh of the blame already shown keeps it
        setBlamed((old) => (old?.key === key && old.blame ? old : { key, blame: null, error: errorText(e) }))
        if (blamedKey.current === key) notify('error', errorText(e))
      }
    )
    return () => {
      alive = false
    }
  }, [repo, view, key, tick]) // eslint-disable-line react-hooks/exhaustive-deps

  const blame = blamed?.key === key ? blamed : null
  blamedKey.current = blame?.blame ? key : null
  const entry = history?.find((c) => c.sha === picked) ?? history?.[0] ?? null
  const choice = chosen ? (blame?.blame?.commits[chosen] ?? null) : null
  const mark = view === 'blame' ? (hover ?? chosen) : null // marked in the list too
  // The commit selected in the list (also its tab stop): in Diff mode the one shown, in Blame mode the one requested
  // (not the one loaded, so quick arrow presses never jump back); the newest when that one is not in the list (HEAD
  // when it did not touch the file, a parent from "Blame at parent").
  const wanted = view === 'blame' ? at?.rev : picked
  const selected = (history?.find((c) => c.sha === wanted) ?? history?.[0])?.sha
  const current = selected

  useEffect(() => {
    if (mark) list.current?.querySelector(`[data-sha="${mark}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [mark])

  // Picking a commit shows its diff of the file and blames the file as it was then.
  const pick = (c: FileCommit) => {
    setPicked(c.sha)
    blameAt({ rev: c.sha, path: c.path })
  }
  const blameAt = (t: Target | null) => {
    setAt(t)
    setChosen(null)
    setHover(null)
  }
  const onKeys = (e: KeyboardEvent<HTMLOListElement>) => {
    if (!history?.length) return
    const i = Math.max(0, history.findIndex((c) => c.sha === current))
    const n = { ArrowDown: Math.min(i + 1, history.length - 1), ArrowUp: Math.max(i - 1, 0), Home: 0, End: history.length - 1 }[e.key]
    if (n === undefined) return
    e.preventDefault()
    pick(history[n])
    ;(e.currentTarget.children[n]?.firstElementChild as HTMLElement | undefined)?.focus()
  }
  const back = () => onFocus(rev ? { kind: 'commit', sha: rev } : { kind: 'wip' })
  const [dir, name] = splitPath(path)
  const start = rev ? rev.slice(0, 7) : 'HEAD'
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
          <div className="seg" role="group" aria-label="File view">
            {(['diff', 'blame'] as const).map((v) => (
              <button key={v} aria-pressed={view === v} onClick={() => setView(v)}>
                {v === 'diff' ? 'Diff' : 'Blame'}
              </button>
            ))}
          </div>
          {view === 'diff' && entry && <span className="badge grey">{entry.sha.slice(0, 7)}</span>}
          <div className="grow" />
          {view === 'blame' && (
            <>
              <span className="heat-legend">
                recent <span className="heat-bar" /> old
              </span>
              <span className="badge plain">
                Revision: {at ? at.rev.slice(0, 7) : start}
                {target.path !== path && ` · ${target.path}`}
              </span>
              {at && (
                <button className="head-btn" onClick={() => blameAt(null)}>
                  Back to {start}
                </button>
              )}
            </>
          )}
        </div>
        {view === 'blame' ? (
          blame?.blame ? (
            <BlameView blame={blame.blame} active={hover ?? chosen} chosen={chosen} onHover={setHover} onChoose={setChosen} />
          ) : (
            <div className="diff-body">{blame ? <div className="banner">{blame.error}</div> : <span className="faint">Loading…</span>}</div>
          )
        ) : entry ? (
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
            <input
              type="checkbox"
              checked={follow}
              onChange={(e) => {
                setHistory(null)
                setPicked(null)
                blameAt(null)
                setFollow(e.target.checked)
              }}
            />{' '}
            Follow renames
          </label>
        </div>
        {view === 'diff' && entry && <CommitCard repo={repo} commit={entry} onFocus={onFocus} />}
        {view === 'blame' && choice && (
          <CommitCard repo={repo} commit={choice} onFocus={onFocus}>
            <button
              className="head-btn"
              disabled={!choice.previous}
              title={choice.previous ? `The file before this commit (${choice.previous.sha.slice(0, 7)})` : 'This commit created these lines'}
              onClick={() => choice.previous && blameAt({ rev: choice.previous.sha, path: choice.previous.path })}
            >
              Blame at parent
            </button>
          </CommitCard>
        )}
        {view === 'blame' && !choice && <span className="fh-hint">Click a line to see its commit.</span>}
        <ol ref={list} className={`fh-list ${loading ? 'loading' : ''}`} role="listbox" aria-label={`Commits of ${name}`} onKeyDown={onKeys}>
          {history?.map((c) => (
            <li key={c.sha} role="presentation" data-sha={c.sha}>
              <button
                className={`fh-item ${c.sha === selected ? 'sel' : ''} ${c.sha === mark ? 'hl' : ''}`}
                role="option"
                aria-selected={c.sha === selected}
                tabIndex={c.sha === current ? 0 : -1}
                onClick={() => pick(c)}
              >
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
  children?: ReactNode // more actions
}

// The selected commit: open it in the graph, ask Claude to explain it.
function CommitCard({ repo, commit, onFocus, children }: CardProps) {
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
        {children}
      </div>
      <Explain key={commit.sha} repo={repo} sha={commit.sha} />
    </div>
  )
}
