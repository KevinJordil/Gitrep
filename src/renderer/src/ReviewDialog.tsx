import { useEffect, useId, useMemo, useRef, useState } from 'react'
import type { Branch, RepoEntry, ReviewScope, Settings } from '../../shared/types'
import { api } from './api'
import { Dialog } from './Dialog'
import { errorText } from './format'
import { defaultBase, promptChoices, type ReviewSession } from './review'

interface Props {
  repo: string
  repoName: string
  branch: string // the branch to review
  branches: Branch[]
  settings: Settings
  entry?: RepoEntry
  onStart: (s: ReviewSession) => void
  onEditPrompts: () => void
  onClose: () => void
}

// Start a review: what is compared, with which prompt. Claude runs while the dialog waits.
export function ReviewDialog({ repo, repoName, branch, branches, settings, entry, onStart, onEditPrompts, onClose }: Props) {
  const id = useId()
  const [base, setBase] = useState(() => defaultBase(branches, branch))
  const [scope, setScope] = useState<ReviewScope | string | null>(null) // string: why it cannot be measured
  const choices = useMemo(() => promptChoices(settings, entry), [settings, entry])
  const [key, setKey] = useState(choices[0]?.key ?? '')
  const choice = choices.find((c) => c.key === key) ?? choices[0]
  const first = choices[0]?.key
  useEffect(() => setKey(first ?? ''), [first]) // a new default (the repository's own prompt was just added): select it
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false // closed while Claude works: the answer is dropped
    }
  }, [])

  useEffect(() => {
    if (!base) return
    let live = true
    setScope(null)
    api.reviewScope(repo, branch, base).then(
      (s) => live && setScope(s),
      (e: unknown) => live && setScope(errorText(e))
    )
    return () => {
      live = false
    }
  }, [repo, branch, base])

  const start = async () => {
    if (!choice) return
    setBusy(true)
    setError('')
    const request = { branch, base, prompt: choice.prompt }
    try {
      const review = await api.startReview(repo, request)
      if (alive.current) onStart({ started: Date.now(), review, request, mode: 'branch', forge: null })
    } catch (e) {
      if (alive.current) setError(errorText(e))
    } finally {
      if (alive.current) setBusy(false)
    }
  }

  const others = choices.filter((c) => c.key !== choice?.key)
  const ready = typeof scope === 'object' && scope !== null && scope.commits > 0
  return (
    <Dialog title="Review with Claude" submit={busy ? 'Reviewing…' : 'Start review'} wide busy={busy} canSubmit={ready && !!choice} onSubmit={() => void start()} onClose={onClose}>
      <div className="two-col">
        <label className="dialog-field">
          Branch
          <input className="field mono" value={branch} readOnly />
        </label>
        <span className="arrow" aria-hidden>
          →
        </span>
        <label className="dialog-field">
          Compare with
          <select className="field mono" value={base} onChange={(e) => setBase(e.target.value)}>
            {branches
              .filter((b) => b.name !== branch)
              .map((b) => (
                <option key={b.name} value={b.name}>
                  {b.name}
                </option>
              ))}
          </select>
        </label>
      </div>
      <div className="scope" role="status">
        {!base ? (
          'No other branch to compare with.'
        ) : scope === null ? (
          'Measuring…'
        ) : typeof scope === 'string' ? (
          <span className="err">{scope}</span>
        ) : (
          <>
            {scope.commits} commit{scope.commits === 1 ? '' : 's'} · {scope.files} file{scope.files === 1 ? '' : 's'} · <span className="add-n">+{scope.add}</span> <span className="del-n">−{scope.del}</span> · merge base <span className="mono">{scope.mergeBase.slice(0, 7)}</span>
          </>
        )}
      </div>
      <div className="dialog-field">
        <div className="lbl-row">
          <label htmlFor={`${id}-prompt`}>Review prompt</label>
          <span className="grow" />
          {choice?.repo && <span className="badge blue">Repo override</span>}
        </div>
        <select id={`${id}-prompt`} className="field" value={choice?.key ?? ''} onChange={(e) => setKey(e.target.value)}>
          {choices.map((c) => (
            <option key={c.key} value={c.key}>
              {c.repo ? `${c.prompt.name} · ${repoName}` : c.prompt.name}
            </option>
          ))}
        </select>
        <div className="prompt-pre">{choice?.prompt.text || 'No instructions: Claude looks for real problems only.'}</div>
        <div className="lbl-row note">
          {others.length > 0 && <span>Other prompts: {others.map((c) => `${c.prompt.name} (${c.repo ? 'this repository' : 'global'})`).join(' · ')}</span>}
          <span className="grow" />
          <button type="button" className="lnk" onClick={onEditPrompts}>
            Edit prompts…
          </button>
        </div>
      </div>
      {busy && <div className="note">Claude is reading the changes. This can take a minute.</div>}
      {error && <div className="note err">{error}</div>}
    </Dialog>
  )
}

// The menu entry that starts a review of a branch (graph menu). The caller closes its menu.
export function ReviewMenuItems({ hint, onReview }: { hint?: string; onReview: () => void }) {
  return (
    <>
      <div className="menu-sep" role="separator" />
      <button role="menuitem" className="menu-item claude" onClick={onReview}>
        <span>Review with Claude…</span>
        {hint && <span className="hint">{hint}</span>}
      </button>
    </>
  )
}
