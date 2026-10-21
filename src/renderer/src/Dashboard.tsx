import { useCallback, useEffect, useRef, useState } from 'react'
import type { RepoSummary } from '../../shared/types'
import { api } from './api'
import { unsavedOf } from './unsaved'
import { changeCount, errorText, groupByFolder, matchesFilter, relativeDate, type DashFilter } from './format'
import { Icon } from './icons'
import { useToast } from './toast'

const FILTERS: [DashFilter, string][] = [
  ['all', 'All'],
  ['dirty', 'Modified'],
  ['push', 'To push'],
  ['behind', 'Behind'],
  ['attention', 'Needs attention']
]
const OPERATIONS = { merge: 'Merge in progress', rebase: 'Rebase in progress', 'cherry-pick': 'Cherry-pick in progress', revert: 'Revert in progress' } as const

interface Props {
  repoCount: number
  onOpen: (path: string) => void
  onAdd: () => void
  onChanged: () => void
}

export function Dashboard({ repoCount, onOpen, onAdd, onChanged }: Props) {
  const notify = useToast()
  const [items, setItems] = useState<RepoSummary[]>([])
  const [filter, setFilter] = useState<DashFilter>('all')
  const [text, setText] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [loaded, setLoaded] = useState(false)
  const seq = useRef(0)

  const load = useCallback(async () => {
    try {
      const n = ++seq.current
      const list = await api.summaries()
      if (n === seq.current) {
        setItems(list)
        setLoaded(true)
      }
    } catch (e) {
      notify('error', errorText(e))
    }
  }, [notify])

  useEffect(() => {
    void load()
  }, [load, repoCount])

  useEffect(() => {
    const timer = setInterval(() => {
      if (document.hasFocus()) void load()
    }, 60_000)
    const onFocus = () => void load()
    window.addEventListener('focus', onFocus)
    return () => {
      clearInterval(timer)
      window.removeEventListener('focus', onFocus)
    }
  }, [load])

  const act = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key)
    try {
      await fn()
    } catch (e) {
      notify('error', errorText(e))
    } finally {
      setBusy(null)
      void load()
    }
  }
  const launch = (fn: () => Promise<void>) => fn().catch((e: unknown) => notify('error', errorText(e)))
  const remove = (r: RepoSummary) => {
    const open = unsavedOf(r.path)
    if (open) return notify('error', `Save or discard your edits to ${open.path} first.`)
    if (!window.confirm(`Remove ${r.name} from GitRep? The folder is not deleted.`)) return
    void act(`rm:${r.path}`, async () => {
      await api.removeRepo(r.path)
      onChanged()
    })
  }

  const needle = text.trim().toLowerCase()
  const visible = items.filter((r) => matchesFilter(r, filter) && (!needle || r.path.toLowerCase().includes(needle)))
  const groups = groupByFolder(visible)

  return (
    <main className="dash">
      <div className="dash-bar">
        <nav className="chips" aria-label="Filters">
          {FILTERS.map(([f, label]) => (
            <button key={f} className={`chip ${filter === f ? 'on' : ''}`} aria-pressed={filter === f} onClick={() => setFilter(f)}>
              {label} <span className="n">{items.filter((r) => matchesFilter(r, f)).length}</span>
            </button>
          ))}
        </nav>
        <div className="grow" />
        <label className="searchbox">
          <Icon name="search" size={14} />
          <span className="sr-only">Filter repositories</span>
          <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Filter by name or path" />
        </label>
        <button className="tbtn boxed" disabled={busy === 'fetchAll'} onClick={() => void act('fetchAll', () => api.fetchAll())}>
          {busy === 'fetchAll' ? <span className="spin" /> : <Icon name="fetch" size={15} />} Fetch all
        </button>
        <button className="btn-add" onClick={onAdd}>
          <Icon name="plus" size={15} stroke={2} /> Add repository
        </button>
      </div>
      {repoCount === 0 ? (
        <div className="empty">
          <span>No repositories yet.</span>
          <button className="btn-add" onClick={onAdd}>
            <Icon name="plus" size={15} stroke={2} /> Add repository
          </button>
        </div>
      ) : (
        <div className="dash-list">
          {groups.map((g) => (
            <section key={g.folder} className="folder">
              <div className="folder-head">
                <Icon name="folder" size={15} />
                <span className="mono">{g.folder}</span>
                <span className="faint">
                  {g.items.length} {g.items.length === 1 ? 'repository' : 'repositories'}
                </span>
              </div>
              {g.items.map((r) => (
                <RepoRow key={r.path} r={r} busy={busy} onOpen={onOpen} onFetch={() => void act(`fetch:${r.path}`, () => api.fetch(r.path))} onCode={() => launch(() => api.openInCode(r.path))} onTerminal={() => launch(() => api.openTerminal(r.path))} onRemove={() => remove(r)} />
              ))}
            </section>
          ))}
          {loaded && groups.length === 0 && <span className="faint">No matching repository.</span>}
          <span className="faint" style={{ fontSize: 12 }}>
            {loaded ? 'Refreshed automatically every minute · background fetch every 10 min' : 'Loading…'}
          </span>
        </div>
      )}
    </main>
  )
}

interface RowProps {
  r: RepoSummary
  busy: string | null
  onOpen: (path: string) => void
  onFetch: () => void
  onCode: () => void
  onTerminal: () => void
  onRemove: () => void
}

function RepoRow({ r, busy, onOpen, onFetch, onCode, onTerminal, onRemove }: RowProps) {
  const st = r.status
  const untracked = st?.unstaged.filter((f) => f.status === '?').length ?? 0
  const unstaged = (st?.unstaged.length ?? 0) - untracked
  const staged = st?.staged.length ?? 0
  const conflicts = st?.conflicted.length ?? 0
  const dot = matchesFilter(r, 'attention') ? 'var(--red)' : changeCount(r) ? 'var(--amber)' : st?.behind ? 'var(--accent)' : 'var(--faint)'
  const fetching = busy === `fetch:${r.path}`
  return (
    <div className="repo-row">
      <div className="rc-name">
        <span className="dot" style={{ background: dot }} />
        <span style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
          <button className="n" onClick={() => onOpen(r.path)}>
            {r.name}
          </button>
          <span className="p">
            {r.folder}/{r.name}
          </span>
        </span>
      </div>
      <span className="rc-branch">
        <Icon name="branch" size={14} stroke={2} />
        {st ? (st.branch ?? `Detached HEAD (${st.head?.slice(0, 7) ?? '?'})`) : '—'}
      </span>
      <span className="rc-state">
        {r.error && (
          <span className="badge err" title={r.error}>
            Error: {r.error.trim().split('\n').pop()}
          </span>
        )}
        {st?.operation && <span className="badge red">{OPERATIONS[st.operation]}</span>}
        {conflicts > 0 && <span className="badge red">{conflicts} conflicted</span>}
        {unstaged > 0 && (
          <span className="badge amber">
            {unstaged} modified
          </span>
        )}
        {untracked > 0 && <span className="badge amber">{untracked} untracked</span>}
        {staged > 0 && (
          <span className="badge blue">
            {staged} staged
          </span>
        )}
        {r.stashCount > 0 && <span className="badge grey">{r.stashCount} stash</span>}
        {r.fetchError && (
          <span className="badge err" title={r.fetchError}>
            Fetch failed
          </span>
        )}
        {st && !st.operation && changeCount(r) === 0 && <span className="badge plain">Clean</span>}
      </span>
      <span className="rc-sync">
        {st?.ahead ? <span style={{ color: 'var(--amber)' }}>↑{st.ahead}</span> : null}
        {st?.behind ? <span style={{ color: 'var(--accent)' }}>↓{st.behind}</span> : null}
      </span>
      <span className="rc-last">
        <span className="s">{r.lastCommit?.subject ?? 'No commits'}</span>
        {r.lastCommit && (
          <span className="faint" style={{ fontSize: 11.5 }}>
            {relativeDate(r.lastCommit.date)} · {r.lastCommit.author}
          </span>
        )}
      </span>
      <span className="rc-actions">
        <button className="btn" onClick={() => onOpen(r.path)}>
          Open
        </button>
        <button className="iconbtn" aria-label={`Open ${r.name} in VS Code`} title="VS Code" onClick={onCode}>
          <Icon name="code" size={15} />
        </button>
        <button className="iconbtn" aria-label={`Open a terminal in ${r.name}`} title="Terminal" onClick={onTerminal}>
          <Icon name="terminal" size={15} />
        </button>
        <button className="iconbtn" aria-label={`Fetch ${r.name}`} title="Fetch" disabled={fetching} onClick={onFetch}>
          {fetching ? <span className="spin" /> : <Icon name="fetch" size={15} />}
        </button>
        <button className="iconbtn" aria-label={`Remove ${r.name} from the list`} title="Remove from list" onClick={onRemove}>
          <Icon name="close" size={14} />
        </button>
      </span>
    </div>
  )
}
