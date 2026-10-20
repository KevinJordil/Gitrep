import { useEffect, useId, useState } from 'react'
import type { FileChange, RepoStatus, Stash } from '../../shared/types'
import { api } from './api'
import { Dialog } from './Dialog'
import { DiffView } from './DiffView'
import { errorText, relativeDate } from './format'
import { FileIcon, StatusBadge } from './FileIcon'
import { Icon } from './icons'
import type { RunOp, RunOutcome } from './model'
import { useToast } from './toast'

// Tracked changes against the stash's base, then its untracked files (status '?').
function useStashFiles(repo: string, stash: Stash): FileChange[] | null {
  const notify = useToast()
  const [files, setFiles] = useState<FileChange[] | null>(null)
  useEffect(() => {
    let alive = true
    Promise.all([api.commitDetails(repo, stash.sha), stash.untracked ? api.commitDetails(repo, stash.untracked) : null])
      .then(([tracked, extra]) => {
        if (alive) setFiles([...tracked.files, ...(extra?.files ?? []).map((f) => ({ ...f, status: '?' as const }))])
      })
      .catch((e: unknown) => notify('error', errorText(e)))
    return () => {
      alive = false
    }
  }, [repo, stash.sha, stash.untracked, notify])
  return files
}

interface ViewProps {
  repo: string
  stash: Stash
  version: number
  run: RunOp
  onBack: () => void
}

export function StashView({ repo, stash, version, run, onBack }: ViewProps) {
  const files = useStashFiles(repo, stash)
  const [picked, setPicked] = useState<string | null>(null)
  const file = files?.find((f) => f.path === picked) ?? files?.[0] ?? null
  const commit = file?.status === '?' ? stash.untracked : stash.sha
  return (
    <>
      <div className="pane-head">
        <button className="tbtn boxed" onClick={onBack}>
          <Icon name="back" size={14} stroke={2} /> History
        </button>
        <span className="mono faint">{`stash@{${stash.index}}`}</span>
        <span className="pane-title">{stash.message}</span>
      </div>
      <nav className="file-chips" aria-label="Files in the stash">
        {files?.map((f) => (
          <button key={`${f.status}:${f.path}`} className={`fchip ${f === file ? 'on' : ''}`} aria-pressed={f === file} onClick={() => setPicked(f.path)}>
            <StatusBadge status={f.status} />
            <FileIcon path={f.path} />
            <span>{f.path}</span>
            {f.add ? <span className="add-n">+{f.add}</span> : null}
            {f.del ? <span className="del-n">−{f.del}</span> : null}
          </button>
        ))}
        {files?.length === 0 && <span className="faint">This stash holds no file changes.</span>}
      </nav>
      {file && commit && <DiffView key={`${commit}:${file.path}`} repo={repo} selection={{ path: file.path, commit }} version={version} onBack={onBack} run={run} hideHead />}
    </>
  )
}

interface PanelProps {
  repo: string
  stash: Stash
  branch: string | null // checked-out branch
  busy: string | null
  run: RunOp
  runOutcome: RunOutcome
  onNewBranch: () => void
}

export function StashPanel({ repo, stash, branch, busy, run, runOutcome, onNewBranch }: PanelProps) {
  const notify = useToast()
  const files = useStashFiles(repo, stash)
  const [conflicts, setConflicts] = useState<string[]>([])
  useEffect(() => {
    api.stashConflicts(repo, stash.sha).then(setConflicts, (e: unknown) => notify('error', errorText(e)))
  }, [repo, stash.sha, branch, notify])
  const untracked = files?.filter((f) => f.status === '?').length ?? 0
  return (
    <aside className="right commit-panel">
      <div className="cp-head">
        <span className="cp-subject">{stash.message}</span>
        <dl className="facts">
          <dt>Created on</dt>
          <dd>
            {stash.branch ? <span className="mono link">{stash.branch}</span> : 'a detached HEAD'} at <span className="mono link">{stash.base.slice(0, 7)}</span>
          </dd>
          <dt>When</dt>
          <dd>{relativeDate(stash.date)}</dd>
          <dt>Content</dt>
          <dd>{files ? `${files.length} file${files.length === 1 ? '' : 's'}${untracked ? `, ${untracked} untracked` : ''}` : '…'}</dd>
        </dl>
        <div className="stash-actions">
          <button className="btn-primary" disabled={!!busy} onClick={() => void runOutcome('apply', () => api.stashApply(repo, stash.sha, false), 'Stash applied')}>
            Apply
          </button>
          <button className="btn" disabled={!!busy} onClick={() => void runOutcome('pop', () => api.stashApply(repo, stash.sha, true), 'Stash applied and dropped')}>
            Pop
          </button>
          <button className="btn ghost" disabled={!!busy} onClick={onNewBranch}>
            Create branch…
          </button>
          <button className="btn danger" disabled={!!busy} onClick={() => void run('drop', () => api.stashDrop(repo, stash.sha), 'Stash dropped')}>
            Drop
          </button>
        </div>
        <span className="note">Apply keeps the stash. Pop applies it, then drops it. Drop can be undone (Ctrl+Z).</span>
        {conflicts.length > 0 && (
          <div className="warn-box">
            <Icon name="warn" size={16} stroke={2} />
            <span>
              {stash.branch && stash.branch !== branch ? 'Created on another branch. ' : ''}Applying it on <span className="mono">{branch ?? 'HEAD'}</span> will likely conflict in <span className="mono">{conflicts.join(', ')}</span>.
            </span>
          </div>
        )}
      </div>
    </aside>
  )
}

interface DialogProps {
  repo: string
  status: RepoStatus
  run: RunOp
  onClose: () => void
}

export function StashDialog({ repo, status, run, onClose }: DialogProps) {
  const notify = useToast()
  const id = useId()
  const [message, setMessage] = useState('')
  const [untracked, setUntracked] = useState(false)
  const [thinking, setThinking] = useState(false)
  const [busy, setBusy] = useState(false)
  const newFiles = status.unstaged.filter((f) => f.status === '?').length
  const count = new Set([...status.staged, ...status.unstaged.filter((f) => untracked || f.status !== '?')].map((f) => f.path)).size
  const name = async () => {
    setThinking(true)
    try {
      setMessage(await api.stashMessage(repo))
    } catch (e) {
      notify('error', errorText(e))
    } finally {
      setThinking(false)
    }
  }
  const send = async () => {
    setBusy(true)
    const ok = await run('stash', () => api.stashPush(repo, message, untracked), 'Changes stashed')
    setBusy(false)
    if (ok) onClose()
  }
  return (
    <Dialog title="New stash" submit={`Stash ${count} changed file${count === 1 ? '' : 's'}`} busy={busy} canSubmit={count > 0} onSubmit={() => void send()} onClose={onClose}>
      <div className="dialog-row">
        <label htmlFor={id}>Name</label>
        <button type="button" className="btn-claude sm" disabled={thinking} onClick={() => void name()}>
          {thinking ? <span className="spin" /> : <Icon name="sparkle" size={13} />}
          Name with Claude
        </button>
      </div>
      <input id={id} className="field" autoFocus value={message} onChange={(e) => setMessage(e.target.value)} placeholder="Optional: git names it after the last commit" />
      {newFiles > 0 && (
        <label className="check">
          <input type="checkbox" checked={untracked} onChange={(e) => setUntracked(e.target.checked)} /> Include untracked files ({newFiles})
        </label>
      )}
    </Dialog>
  )
}
