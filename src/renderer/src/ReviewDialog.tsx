import { useEffect, useId, useMemo, useRef, useState } from 'react'
import type { Branch, ForgeInfo, ForgeKind, RepoEntry, ReviewScope, Settings } from '../../shared/types'
import type { AccountSuggestion } from './AccountsDialog'
import { api } from './api'
import { Dialog } from './Dialog'
import { Icon } from './icons'
import { errorText } from './format'
import { defaultBase, FORGE_NAME, promptChoices, requestLabel, requestName, requestWord, type ReviewSession } from './review'

interface Props {
  repo: string
  repoName: string
  branch: string // the branch to review
  branches: Branch[]
  settings: Settings
  entry?: RepoEntry
  onStart: (s: ReviewSession) => void
  onEditPrompts: () => void
  onSettings: (patch: Partial<Settings>) => Promise<boolean>
  accountsVersion: number // looks again when an account changes
  onAccounts: (suggest: AccountSuggestion | null) => void
  onClose: () => void
}

// Start a review: what is compared, with which prompt. Claude runs while the dialog waits.
export function ReviewDialog({ repo, repoName, branch, branches, settings, entry, onStart, onEditPrompts, onSettings, accountsVersion, onAccounts, onClose }: Props) {
  const id = useId()
  const [base, setBase] = useState(() => defaultBase(branches, branch))
  const baseTouched = useRef(false)
  const [forge, setForge] = useState<ForgeInfo | null | undefined>(undefined) // undefined: looking; null: not on a forge
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

  // The forge of the branch's remote and its open request, again when the user names the forge or adds an account.
  const { forgeHosts } = settings
  const forgeHostsKey = JSON.stringify(forgeHosts) // stable across settings saves
  useEffect(() => {
    let live = true
    setForge(undefined)
    api.forgeInfo(repo, branch).then(
      (f) => {
        if (!live) return
        setForge(f)
        if (f?.request && !baseTouched.current) setBase(defaultBase(branches, branch, f.request.target))
      },
      () => live && setForge(null)
    )
    return () => {
      live = false
    }
  }, [repo, branch, branches, forgeHostsKey, accountsVersion])

  useEffect(() => {
    if (!base) return setScope('No other branch to compare with.')
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
          <select
            className="field mono"
            value={base}
            onChange={(e) => {
              baseTouched.current = true
              setBase(e.target.value)
            }}
          >
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
        {scope === null ? (
          'Measuring…'
        ) : typeof scope === 'string' ? (
          <span className="err">{scope}</span>
        ) : (
          <>
            {scope.commits} commit{scope.commits === 1 ? '' : 's'} · {scope.files} file{scope.files === 1 ? '' : 's'} · <span className="add-n">+{scope.add}</span> <span className="del-n">−{scope.del}</span> · merge base <span className="mono">{scope.mergeBase.slice(0, 7)}</span>
          </>
        )}
      </div>
      <ForgeBox forge={forge} onKind={(host, kind) => void onSettings({ forgeHosts: { ...forgeHosts, [host]: kind } })} onAccounts={onAccounts} />
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

interface ForgeBoxProps {
  forge: ForgeInfo | null | undefined
  onKind: (host: string, kind: ForgeKind) => void
  onAccounts: (suggest: AccountSuggestion | null) => void
}

// Where the branch lives and what is open there: the forge to name, the account to add, or the request found.
function ForgeBox({ forge, onKind, onAccounts }: ForgeBoxProps) {
  if (forge === undefined) return <div className="note">Looking for a merge or pull request…</div>
  if (forge === null) return null
  const { host, kind } = forge
  if (!kind)
    return (
      <div className="detect">
        <span className="grow">
          GitRep does not know which forge <span className="mono">{host}</span> is.
        </span>
        <button type="button" className="btn sm" onClick={() => onKind(host, 'gitlab')}>
          GitLab
        </button>
        <button type="button" className="btn sm" onClick={() => onKind(host, 'github')}>
          GitHub
        </button>
      </div>
    )
  const word = kind === 'github' ? 'pull' : 'merge'
  if (!forge.account)
    return (
      <div className="detect">
        <span className="grow">
          No {FORGE_NAME[kind]} account for <span className="mono">{host}</span>: add one to find its {word} requests and post comments.
        </span>
        <button type="button" className="btn sm" onClick={() => onAccounts({ host, kind, url: forge.url })}>
          Accounts…
        </button>
      </div>
    )
  if (forge.error) return <div className="note err">{forge.error}</div>
  const r = forge.request
  if (!r)
    return (
      <div className="note">
        No open {word} request for this branch on <span className="mono">{host}</span>.
      </div>
    )
  return (
    <div className="detect" role="status">
      <Icon name="merge" size={16} />
      <div>
        {requestName(forge)} <b>{requestLabel(forge)}</b> is open for this branch on <span className="mono">{host}</span>
        <div className="faint">
          “{r.title}” · target {r.target}
          {r.author ? ` · by ${r.author}` : ''}
        </div>
      </div>
    </div>
  )
}

// The menu entry that starts a review of a branch (sidebar and graph menus). The caller closes its menu.
// forge: what the branch's remote has open, when already looked up (adds "Review MR !n").
export function ReviewMenuItems({ hint, forge, onReview }: { hint?: string; forge?: ForgeInfo | null; onReview: () => void }) {
  return (
    <>
      <div className="menu-sep" role="separator" />
      <button role="menuitem" className="menu-item claude" onClick={onReview}>
        <span>Review with Claude…</span>
        {hint && <span className="hint">{hint}</span>}
      </button>
      {forge?.request && forge.kind && (
        <button role="menuitem" className="menu-item claude" onClick={onReview}>
          <span>
            Review {requestWord(forge)} {requestLabel(forge)}
          </span>
          <span className="hint">{FORGE_NAME[forge.kind]}</span>
        </button>
      )}
    </>
  )
}
