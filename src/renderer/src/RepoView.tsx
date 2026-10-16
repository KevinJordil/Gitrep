import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Branch, Commit, GraphScope, RepoStatus, Stash, Tag } from '../../shared/types'
import { api } from './api'
import { ChangesPanel } from './ChangesPanel'
import { DiffView } from './DiffView'
import { errorText } from './format'
import { Graph } from './Graph'
import { layoutGraph, type GraphNode } from './graph'
import { Icon, type IconName } from './icons'
import type { Focus, RunOp, Selection } from './model'
import { Sidebar } from './Sidebar'
import { useToast } from './toast'

const ALL: GraphScope = { only: null, hidden: [] }
const WIP = 'WIP' // sha of the work-in-progress graph row (never a real sha)

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
  const [tags, setTags] = useState<Tag[]>([])
  const [stashes, setStashes] = useState<Stash[]>([])
  const [focus, setFocus] = useState<Focus>({ kind: 'wip' })
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
      const [l, b, t, s] = await Promise.all([api.log(path, ALL), api.branches(path), api.tags(path), api.stashes(path)])
      setLog(l)
      setBranches(b)
      setTags(t)
      setStashes(s)
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

  const focusOn = useCallback((f: Focus) => {
    setFocus(f)
    setSelection(null)
  }, [])

  const changes = status ? status.staged.length + status.unstaged.length + status.conflicted.length : 0
  const hasWip = changes > 0
  const head = status?.head ?? null
  const nodes = useMemo<GraphNode[]>(() => (hasWip ? [{ sha: WIP, parents: head ? [head] : [], wip: true }, ...log] : log), [log, hasWip, head])
  const rows = useMemo(() => layoutGraph(nodes), [nodes])
  const colors = useMemo(() => new Map(nodes.map((n, i) => [n.sha, rows[i].color])), [nodes, rows])
  const remoteNames = useMemo(() => new Set(branches.filter((b) => b.remote).map((b) => b.name)), [branches])
  const staged = status?.staged.length ?? 0
  const wipLabel = hasWip ? `${changes} modified file${changes === 1 ? '' : 's'}${staged ? ` · ${staged} staged` : ''}` : null
  const branchLabel = status ? (status.branch ?? `Detached HEAD (${status.head?.slice(0, 7) ?? '?'})`) : '…'

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
        <Sidebar
          branches={branches}
          tags={tags}
          stashes={stashes}
          colors={colors}
          focus={focus}
          onFocus={focusOn}
          onSwitch={(b) => void run('switch', () => api.switchBranch(path, b.name, b.remote), `Switched to branch ${b.remote ? b.name.replace(/^[^/]+\//, '') : b.name}`)}
        />
        <section className="center">
          {selection ? (
            <DiffView key={`${selection.path}:${selection.side}`} repo={path} selection={selection} version={version} onBack={() => setSelection(null)} run={run} />
          ) : (
            <Graph repoName={path.split('/').pop() ?? path} commits={log} rows={rows} wip={wipLabel} head={head} focus={focus} remoteNames={remoteNames} onFocus={focusOn} />
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
