import { useId, useState, type KeyboardEvent, type ReactNode } from 'react'
import { MAX_INSTRUCTIONS, type DiffSide, type FileChange, type RepoStatus } from '../../shared/types'
import { api } from './api'
import { errorText, splitPath } from './format'
import { FileIcon, StatusBadge } from './FileIcon'
import { Dialog } from './Dialog'
import { Icon } from './icons'
import type { RunOp, Selection } from './model'
import { useToast } from './toast'

interface Props {
  repo: string
  name: string
  instructions: { global: string; repo: string } // commit message instructions saved in the config
  onInstructions: (global?: string, repo?: string) => Promise<boolean> // only the texts given are saved
  status: RepoStatus | null
  selection: Selection | null
  onSelect: (s: Selection) => void
  onConflict: (path: string) => void // opens the conflict view on that file
  run: RunOp
  busy: string | null
}

const pathsOf = (files: FileChange[]) => files.flatMap((f) => (f.origPath ? [f.path, f.origPath] : [f.path]))

export function ChangesPanel({ repo, name, instructions, onInstructions, status, selection, onSelect, onConflict, run, busy }: Props) {
  const notify = useToast()
  const [summary, setSummary] = useState('')
  const [body, setBody] = useState('')
  const [amend, setAmend] = useState(false)
  const [thinking, setThinking] = useState(false)
  const [note, setNote] = useState('')
  const [editing, setEditing] = useState(false)

  const staged = status?.staged ?? []
  const unstaged = status?.unstaged ?? []
  const conflicted = status?.conflicted ?? []
  const total = staged.length + unstaged.length + conflicted.length
  const branch = status ? (status.branch ?? 'Detached HEAD') : '…'

  const discard = (files: FileChange[]) => {
    const what = files.length === 1 ? files[0].path : `${files.length} files`
    if (!window.confirm(`Discard the changes to ${what}? Ctrl+Z can bring them back while GitRep is open (not for very large changes).`)) return
    void run('discard', async () => {
      if (!(await api.discard(repo, files))) notify('info', 'Discarded. Too large to be undone.')
    })
  }

  const fill = (message: string) => {
    const [first = '', ...rest] = message.split('\n')
    setSummary(first.trim())
    setBody(rest.join('\n').replace(/^\n+/, ''))
  }

  const generate = async () => {
    setThinking(true)
    setNote('')
    try {
      const r = await api.generateMessage(repo)
      fill(r.message)
      setNote(`Suggested by Claude from ${r.files} staged file${r.files === 1 ? '' : 's'}. You can edit it.${r.excluded.length ? ` Not sent (sensitive): ${r.excluded.join(', ')}.` : ''}`)
    } catch (e) {
      notify('error', errorText(e))
    } finally {
      setThinking(false)
    }
  }

  const toggleAmend = async (on: boolean) => {
    setAmend(on)
    if (!on || summary.trim() || body.trim()) return
    try {
      fill(await api.lastMessage(repo))
    } catch (e) {
      notify('error', errorText(e))
    }
  }

  const message = body.trim() ? `${summary.trim()}\n\n${body.trim()}\n` : `${summary.trim()}\n`
  const operation = status?.operation ?? null // committing mid-operation would land inside the replay
  const canCommit = !busy && !operation && summary.trim() !== '' && (amend || staged.length > 0) && conflicted.length === 0
  const commit = async () => {
    if (!canCommit) return
    const ok = await run('commit', () => api.commit(repo, message, amend), amend ? 'Commit amended' : 'Commit created')
    if (!ok) return
    setSummary('')
    setBody('')
    setAmend(false)
    setNote('')
  }
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault()
      void commit()
    }
  }

  const stageBtn = (f: FileChange) => (
    <button className="fbtn" aria-label={`Stage ${f.path}`} title="Stage" onClick={() => void run('stage', () => api.stage(repo, [f.path]))}>
      <Icon name="plus" size={12} stroke={2.4} />
    </button>
  )

  return (
    <aside className="right">
      <div className="right-head">
        <span className="pane-title">Changes</span>
        <span className="faint">
          {total} file{total === 1 ? '' : 's'}
        </span>
      </div>
      <div className="scroll">
        {conflicted.length > 0 && (
          <FileGroup title="Conflicts" files={conflicted} side="unstaged" selection={null} onSelect={(s) => onConflict(s.path)} hint="Click a file to resolve it, or stage it as it is." buttons={stageBtn} />
        )}
        <FileGroup
          title="Unstaged"
          files={unstaged}
          side="unstaged"
          selection={selection}
          onSelect={onSelect}
          action={unstaged.length ? { label: 'Stage all', run: () => void run('stage', () => api.stage(repo, pathsOf(unstaged))) } : undefined}
          buttons={(f) => (
            <>
              <button className="fbtn" aria-label={`Discard changes to ${f.path}`} title="Discard" onClick={() => discard([f])}>
                <Icon name="discard" size={12} stroke={2.2} />
              </button>
              {stageBtn(f)}
            </>
          )}
        />
        <FileGroup
          title="Staged"
          files={staged}
          side="staged"
          selection={selection}
          onSelect={onSelect}
          action={staged.length ? { label: 'Unstage all', run: () => void run('unstage', () => api.unstage(repo, pathsOf(staged))) } : undefined}
          buttons={(f) => (
            <button className="fbtn" aria-label={`Unstage ${f.path}`} title="Unstage" onClick={() => void run('unstage', () => api.unstage(repo, pathsOf([f])))}>
              <Icon name="minus" size={12} stroke={2.4} />
            </button>
          )}
        />
      </div>
      <form
        className="commit-form"
        onSubmit={(e) => {
          e.preventDefault()
          void commit()
        }}
      >
        <div className="commit-head">
          <label htmlFor={`summary-${repo}`} style={{ fontWeight: 500 }}>
            Commit message
          </label>
          <button type="button" className="icon-btn" aria-label="Commit message instructions" title="Commit message instructions" onClick={() => setEditing(true)}>
            <Icon name="sliders" size={14} />
            {(instructions.global.trim() || instructions.repo.trim()) && <span className="dot" aria-hidden />}
          </button>
          <button type="button" className="btn-claude" disabled={thinking || staged.length === 0} title={staged.length === 0 ? 'Stage some changes first' : undefined} onClick={() => void generate()}>
            {thinking ? <span className="spin" /> : <Icon name="sparkle" size={14} />}
            {thinking ? 'Claude is writing…' : 'Generate with Claude'}
          </button>
        </div>
        <input id={`summary-${repo}`} className="field" value={summary} onChange={(e) => setSummary(e.target.value)} onKeyDown={onKey} placeholder="Summary" />
        <label htmlFor={`body-${repo}`} className="sr-only">
          Description
        </label>
        <textarea id={`body-${repo}`} className="field" rows={6} value={body} onChange={(e) => setBody(e.target.value)} onKeyDown={onKey} placeholder="Description" />
        {note && <span className="note">{note}</span>}
        {operation && <span className="note">Finish the {operation} with Continue in the banner.</span>}
        <label className="check">
          <input type="checkbox" checked={amend} disabled={!!operation} onChange={(e) => void toggleAmend(e.target.checked)} /> Amend last commit
        </label>
        <button type="submit" className="btn-primary" disabled={!canCommit}>
          {busy === 'commit' ? 'Commit…' : `Commit to ${branch}`}
        </button>
      </form>
      {editing && <InstructionsDialog name={name} initial={instructions} onSave={onInstructions} onClose={() => setEditing(false)} />}
    </aside>
  )
}

interface InstructionsProps {
  name: string
  initial: { global: string; repo: string }
  onSave: (global?: string, repo?: string) => Promise<boolean>
  onClose: () => void
}

function InstructionsDialog({ name, initial, onSave, onClose }: InstructionsProps) {
  const [repoText, setRepoText] = useState(initial.repo)
  const [globalText, setGlobalText] = useState(initial.global)
  const [busy, setBusy] = useState(false)
  const id = useId()
  const save = async () => {
    setBusy(true)
    const ok = await onSave(globalText !== initial.global ? globalText : undefined, repoText !== initial.repo ? repoText : undefined)
    setBusy(false)
    if (ok) onClose()
  }
  const field = (label: string, text: string, set: (t: string) => void, key: string, focus = false) => (
    <div className="dialog-field">
      <label htmlFor={`${id}-${key}`}>{label}</label>
      <textarea id={`${id}-${key}`} className="field" rows={5} maxLength={MAX_INSTRUCTIONS} autoFocus={focus} value={text} onChange={(e) => set(e.target.value)} />
      <span className="note counter">
        {text.length} / {MAX_INSTRUCTIONS}
      </span>
    </div>
  )
  return (
    <Dialog title="Commit message instructions" submit="Save" busy={busy} onSubmit={() => void save()} onClose={onClose}>
      {field(`This repository (${name})`, repoText, setRepoText, 'repo', true)}
      {field('All repositories', globalText, setGlobalText, 'global')}
      <span className="note">Added to the instructions Claude follows when it writes a commit message. Stored in GitRep on this computer, not in the repository.</span>
    </Dialog>
  )
}

interface GroupProps {
  title: string
  files: FileChange[]
  side: 'staged' | 'unstaged'
  selection: Selection | null
  onSelect?: (s: Selection) => void
  action?: { label: string; run: () => void }
  hint?: string
  buttons: (f: FileChange) => ReactNode
}

function FileGroup({ title, files, side, selection, onSelect, action, hint, buttons }: GroupProps) {
  return (
    <section className="fgroup">
      <div className="fgroup-head">
        <span>
          {title} <span className="mono faint">{files.length}</span>
        </span>
        {action && (
          <button className="small-btn" onClick={action.run}>
            {action.label}
          </button>
        )}
      </div>
      {hint && <span className="fgroup-hint">{hint}</span>}
      {files.map((f) => {
        const [dir, name] = splitPath(f.path)
        const target: DiffSide = side === 'staged' ? 'staged' : f.status === '?' ? 'untracked' : 'unstaged'
        const selected = selection?.path === f.path && selection.side === target
        return (
          <div key={`${side}:${f.path}`} className={`file ${selected ? 'sel' : ''}`} title={f.origPath ? `${f.origPath} → ${f.path}` : f.path}>
            <StatusBadge status={f.status} />
            <FileIcon path={f.path} />
            <button className="path" disabled={!onSelect} onClick={() => onSelect?.({ path: f.path, side: target })}>
              <span className="faint">{dir}</span>
              {name}
            </button>
            {f.add ? <span className="add-n">+{f.add}</span> : null}
            {f.del ? <span className="del-n">−{f.del}</span> : null}
            {buttons(f)}
          </div>
        )
      })}
    </section>
  )
}
