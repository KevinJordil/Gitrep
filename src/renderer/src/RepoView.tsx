import { useCallback, useEffect, useRef, useState } from 'react'
import type { Branch, Commit, RepoStatus } from '../../shared/types'
import { api } from './api'
import { ChangesPanel } from './ChangesPanel'
import { DiffView } from './DiffView'
import { colorFor, errorText, initials, parseRef, relativeDate } from './format'
import { Icon, type IconName } from './icons'
import type { RunOp, Selection } from './model'
import { useToast } from './toast'

interface Props {
  path: string
  active: boolean
  onBranch: (path: string, label: string) => void
}

export function RepoView({ path, active, onBranch }: Props) {
  const notify = useToast()
  const [status, setStatus] = useState<RepoStatus | null>(null)
  const [log, setLog] = useState<Commit[]>([])
  const [branches, setBranches] = useState<Branch[]>([])
  const [selection, setSelection] = useState<Selection | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [version, setVersion] = useState(0)
  const lastError = useRef('')
  const lastStatus = useRef('')

  const report = useCallback(
    (e: unknown) => {
      const text = errorText(e)
      if (text !== lastError.current) notify('error', text)
      lastError.current = text
    },
    [notify]
  )

  // force: reload even when the status JSON is unchanged (an open diff may be stale). Polls do not force.
  const refreshStatus = useCallback(async (force = false) => {
    try {
      const s = await api.status(path)
      lastError.current = ''
      const json = JSON.stringify(s)
      if (!force && json === lastStatus.current) return
      lastStatus.current = json
      setStatus(s)
      setVersion((v) => v + 1)
      onBranch(path, s.branch ?? 'Detached HEAD')
    } catch (e) {
      report(e)
    }
  }, [path, onBranch, report])

  const refreshAll = useCallback(async () => {
    await refreshStatus(true)
    try {
      const [l, b] = await Promise.all([api.log(path), api.branches(path)])
      setLog(l)
      setBranches(b)
    } catch (e) {
      report(e)
    }
  }, [path, refreshStatus, report])

  useEffect(() => {
    if (active) void refreshAll()
  }, [active, refreshAll])

  useEffect(() => {
    if (!active) return
    const timer = setInterval(() => {
      if (document.hasFocus()) void refreshStatus()
    }, 5000)
    const off = api.onRepoChanged((r) => {
      if (r === path) void refreshAll()
    })
    const onFocus = () => void refreshAll()
    window.addEventListener('focus', onFocus)
    return () => {
      clearInterval(timer)
      off()
      window.removeEventListener('focus', onFocus)
    }
  }, [active, path, refreshAll, refreshStatus])

  // Keep the open diff on the file when it moves between staged and unstaged; close it when the file is clean.
  useEffect(() => {
    if (!selection || !status) return
    const inStaged = status.staged.find((f) => f.path === selection.path)
    const inUnstaged = status.unstaged.find((f) => f.path === selection.path)
    const here = selection.side === 'staged' ? inStaged : inUnstaged
    if (here) return
    if (selection.side !== 'staged' && inStaged) setSelection({ path: selection.path, side: 'staged' })
    else if (selection.side === 'staged' && inUnstaged) setSelection({ path: selection.path, side: inUnstaged.status === '?' ? 'untracked' : 'unstaged' })
    else setSelection(null)
  }, [status, selection])

  const run = useCallback<RunOp>(
    async (label, fn, done) => {
      setBusy(label)
      try {
        await fn()
        if (done) notify('info', done)
        return true
      } catch (e) {
        notify('error', errorText(e))
        return false
      } finally {
        setBusy(null)
        void refreshAll()
      }
    },
    [notify, refreshAll]
  )

  const branchLabel = status ? (status.branch ?? `Detached HEAD (${status.head?.slice(0, 7) ?? '?'})`) : '…'
  const remoteNames = new Set(branches.filter((b) => b.remote).map((b) => b.name))
  const changes = status ? status.staged.length + status.unstaged.length + status.conflicted.length : 0

  return (
    <>
      <div className="toolbar">
        <span className="branch-pill">
          <Icon name="branch" size={16} stroke={2} />
          {branchLabel}
        </span>
        <ToolButton icon="fetch" label="Fetch" busy={busy === 'fetch'} disabled={!!busy} onClick={() => void run('fetch', () => api.fetch(path), 'Fetch complete')} />
        <ToolButton icon="pull" label="Pull" count={status?.behind ? `↓${status.behind}` : ''} busy={busy === 'pull'} disabled={!!busy} onClick={() => void run('pull', () => api.pull(path), 'Pull complete')} />
        <ToolButton icon="push" label="Push" count={status?.ahead ? `↑${status.ahead}` : ''} busy={busy === 'push'} disabled={!!busy} onClick={() => void run('push', () => api.push(path), 'Push complete')} />
        <div className="grow" />
        <button className="tbtn boxed" onClick={() => api.openInCode(path).catch((e) => notify('error', errorText(e)))}>
          <Icon name="code" /> VS Code
        </button>
        <button className="tbtn boxed" onClick={() => api.openTerminal(path).catch((e) => notify('error', errorText(e)))}>
          <Icon name="terminal" /> Terminal
        </button>
      </div>
      <div className="panes">
        <Sidebar branches={branches} onSwitch={(b) => void run('switch', () => api.switchBranch(path, b.name, b.remote), `Switched to branch ${b.remote ? b.name.replace(/^[^/]+\//, '') : b.name}`)} />
        <section className="center">
          {selection ? (
            <DiffView key={`${selection.path}:${selection.side}`} repo={path} selection={selection} version={version} onBack={() => setSelection(null)} run={run} />
          ) : (
            <History log={log} changes={changes} remoteNames={remoteNames} />
          )}
        </section>
        <ChangesPanel repo={path} status={status} selection={selection} onSelect={setSelection} run={run} busy={busy} />
      </div>
    </>
  )
}

interface ToolButtonProps {
  icon: IconName
  label: string
  count?: string
  busy: boolean
  disabled: boolean
  onClick: () => void
}

function ToolButton({ icon, label, count, busy, disabled, onClick }: ToolButtonProps) {
  return (
    <button className="tbtn" disabled={disabled} onClick={onClick}>
      {busy ? <span className="spin" /> : <Icon name={icon} />}
      <span>{label}</span>
      {count ? <span className="count">{count}</span> : null}
    </button>
  )
}

function Sidebar({ branches, onSwitch }: { branches: Branch[]; onSwitch: (b: Branch) => void }) {
  const groups: [string, Branch[]][] = [
    ['Local branches', branches.filter((b) => !b.remote)],
    ['Remote', branches.filter((b) => b.remote)]
  ]
  return (
    <aside className="sidebar">
      {groups.map(([title, list]) => (
        <section key={title}>
          <div className="side-title">
            <span>{title}</span>
            <span className="mono">{list.length}</span>
          </div>
          {list.map((b) => (
            <button key={b.name} className={`side-item ${b.current ? 'current' : ''}`} title={b.current ? 'Current branch' : 'Double-click to switch to this branch'} onDoubleClick={() => !b.current && onSwitch(b)}>
              <span className="dot" style={{ background: b.current ? 'var(--amber)' : b.remote ? 'var(--faint)' : 'var(--accent)' }} />
              <span className="name">{b.name}</span>
              <span className="faint">{[b.ahead ? `↑${b.ahead}` : '', b.behind ? `↓${b.behind}` : ''].join(' ').trim()}</span>
            </button>
          ))}
        </section>
      ))}
    </aside>
  )
}

function History({ log, changes, remoteNames }: { log: Commit[]; changes: number; remoteNames: ReadonlySet<string> }) {
  return (
    <>
      <div className="pane-head">
        <span className="pane-title">History</span>
        <span className="faint">{log.length >= 300 ? 'Last 300 commits' : `${log.length} commit${log.length === 1 ? '' : 's'}`}</span>
      </div>
      <div className="cols">
        <span style={{ flex: 1 }}>Message</span>
        <span className="c-author">Author</span>
        <span className="c-date">Date</span>
        <span className="c-sha">SHA</span>
      </div>
      <div className="scroll">
        {changes > 0 && (
          <div className="row wip">
            <span className="msg">
              <span className="wip-tag">WIP</span>
              <span className="s muted">
                {changes} modified file{changes === 1 ? '' : 's'}
              </span>
            </span>
            <span className="c-author" />
            <span className="c-date">now</span>
            <span className="c-sha" />
          </div>
        )}
        {log.map((c) => (
          <div key={c.sha} className="row">
            <span className="msg">
              {c.refs.map((r) => {
                const ref = parseRef(r, remoteNames)
                return (
                  <span key={r} className={`ref ${ref.kind}`}>
                    {ref.kind === 'remote' && <Icon name="cloud" size={12} stroke={2.2} />}
                    {ref.kind === 'tag' && <Icon name="tag" size={11} stroke={2.2} />}
                    {ref.label}
                  </span>
                )
              })}
              <span className="s" style={{ color: c.parents.length > 1 ? 'var(--muted)' : undefined }}>
                {c.subject}
              </span>
            </span>
            <span className="c-author">
              <span className="avatar" style={{ background: colorFor(c.author) }}>
                {initials(c.author)}
              </span>
              {c.author}
            </span>
            <span className="c-date" title={new Date(c.date * 1000).toLocaleString('en-GB')}>
              {relativeDate(c.date)}
            </span>
            <span className="c-sha">{c.sha.slice(0, 7)}</span>
          </div>
        ))}
      </div>
    </>
  )
}
