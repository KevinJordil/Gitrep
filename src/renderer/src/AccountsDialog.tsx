import { useEffect, useState, type KeyboardEvent } from 'react'
import type { AccountInfo, ForgeKind } from '../../shared/types'
import { api } from './api'
import { Dialog } from './Dialog'
import { errorText } from './format'
import { Icon } from './icons'
import { FORGE_NAME } from './review'

// The forge of the repository the dialog was opened from, offered when it has no account yet.
export interface AccountSuggestion {
  host: string
  kind: ForgeKind
  url: string
}

interface Row {
  host: string // '' until the instance address of a new GitLab row is typed
  kind: ForgeKind
  url: string
  token: string
  saved: AccountInfo | null
  busy: boolean
  message: string
  shown: boolean // the token in clear
  confirm: boolean // Remove asked, waiting for Confirm
}

const row = (host: string, kind: ForgeKind, url: string, saved: AccountInfo | null = null): Row => ({ host, kind, url, token: '', saved, busy: false, message: '', shown: false, confirm: false })

// GitHub and the repository's own forge are always offered; "Add another GitLab instance" adds an empty row.
export function accountRows(saved: AccountInfo[], suggest: AccountSuggestion | null): Row[] {
  const rows = saved.map((a) => row(a.host, a.kind, a.url, a))
  if (suggest && !saved.some((a) => a.host === suggest.host)) rows.unshift(row(suggest.host, suggest.kind, suggest.url))
  if (!rows.some((r) => r.host === 'github.com')) rows.push(row('github.com', 'github', 'https://github.com'))
  return rows
}

const hostOf = (url: string) => {
  try {
    return new URL(url).hostname
  } catch {
    return ''
  }
}

interface Props {
  suggest: AccountSuggestion | null
  onChanged: () => void // an account was saved or removed
  onClose: () => void
}

export function AccountsDialog({ suggest, onChanged, onClose }: Props) {
  const [rows, setRows] = useState<Row[] | null>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    api.accounts().then(
      (list) => setRows(accountRows(list, suggest)),
      (e: unknown) => setError(errorText(e))
    )
  }, [suggest])

  const set = (i: number, patch: Partial<Row>) => setRows((all) => all && all.map((r, j) => (j === i ? { ...r, ...patch } : r)))
  // A typed token is tested and, when it works, stored; without one the stored token is tested again.
  const test = async (i: number) => {
    const r = rows![i]
    const host = r.host || hostOf(r.url)
    set(i, { busy: true, message: '' })
    try {
      const saved = r.token.trim() ? await api.saveAccount(host, r.kind, r.url, r.token) : await api.testAccount(host)
      set(i, { busy: false, saved, host, url: saved.url, token: '' })
      onChanged()
    } catch (e) {
      set(i, { busy: false, message: errorText(e) })
    }
  }
  // Enter tests the row instead of closing the dialog.
  const enterTests = (e: KeyboardEvent<HTMLInputElement>, i: number) => {
    if (e.key !== 'Enter') return
    e.preventDefault()
    void test(i)
  }
  const remove = async (i: number) => {
    const r = rows![i]
    try {
      await api.removeAccount(r.host)
      set(i, { saved: null, message: '', confirm: false })
      onChanged()
    } catch (e) {
      set(i, { message: errorText(e) })
    }
  }

  return (
    <Dialog title="Accounts" submit="Done" wide cancel={false} onSubmit={onClose} onClose={onClose} foot="Tokens are stored encrypted on this computer and only sent to their forge.">
      <span className="note">Used to read and comment on merge and pull requests.</span>
      <div className="note err" aria-live="polite">{error}</div>
      {rows?.map((r, i) => {
        const name = FORGE_NAME[r.kind]
        return (
          <section key={i} className="acc" aria-label={`${name} ${r.host || 'new instance'}`}>
            <div className="acc-top">
              <span className={`forge-ico ${r.kind === 'gitlab' ? 'gl' : 'gh'}`} aria-hidden>
                {r.kind === 'gitlab' ? 'GL' : 'GH'}
              </span>
              <b>{name}</b>
              <span className="badge grey">{r.host === 'github.com' ? 'github.com' : r.host ? `${r.host} · self-hosted` : 'self-hosted'}</span>
              <span className="grow" />
              {r.saved ? (
                <span className="ok">
                  <Icon name="check" size={12} stroke={2.4} /> Connected{r.saved.user ? ` as @${r.saved.user}` : ''}
                </span>
              ) : (
                <span className="err">Not configured</span>
              )}
            </div>
            <div className="two-col">
              {r.host !== 'github.com' && (
                <label className="dialog-field">
                  Instance URL
                  <input className="field" value={r.url} placeholder="https://gitlab.example.com" readOnly={!!r.saved} onChange={(e) => set(i, { url: e.target.value })} onKeyDown={(e) => enterTests(e, i)} />
                </label>
              )}
              <div className="dialog-field">
                <label htmlFor={`tok-${i}`}>Personal access token</label>
                <span className="tokrow">
                  <input
                    id={`tok-${i}`}
                    className="field"
                    type={r.shown ? 'text' : 'password'}
                    autoComplete="off"
                    spellCheck={false}
                    placeholder={r.saved ? 'Stored: type a new token to replace it' : r.kind === 'gitlab' ? 'glpat-…' : 'github_pat_… (fine-grained) or ghp_…'}
                    value={r.token}
                    onChange={(e) => set(i, { token: e.target.value })}
                    onKeyDown={(e) => enterTests(e, i)}
                  />
                  <button type="button" className="iconbtn" aria-label={r.shown ? 'Hide token' : 'Show token'} onClick={() => set(i, { shown: !r.shown })}>
                    <Icon name={r.shown ? 'eyeOff' : 'eye'} size={14} />
                  </button>
                </span>
              </div>
            </div>
            <div className="acc-foot">
              {r.kind === 'gitlab' ? (
                <span className="note">
                  Required scope: <span className="mono">api</span>
                </span>
              ) : (
                <span className="note">
                  Required: <b>Pull requests: Read and write</b>, <b>Contents: Read</b> (fine-grained token on the repositories you review)
                </span>
              )}
              <span className="grow" />
              <button type="button" className="btn sm" disabled={r.busy || (!r.token.trim() && !r.saved) || (!r.host && !hostOf(r.url))} onClick={() => void test(i)}>
                {r.busy && <span className="spin" />} Test connection
              </button>
              {r.saved && !r.confirm && (
                <button type="button" className="btn sm" onClick={() => set(i, { confirm: true })}>
                  Remove
                </button>
              )}
              {r.saved && r.confirm && (
                <>
                  <span className="note">Remove the token for {r.host}?</span>
                  <button type="button" className="btn sm" onClick={() => void remove(i)}>
                    Confirm
                  </button>
                  <button type="button" className="btn sm" onClick={() => set(i, { confirm: false })}>
                    Cancel
                  </button>
                </>
              )}
            </div>
            <div className="note err acc-msg" aria-live="polite">{r.message}</div>
          </section>
        )
      })}
      <button type="button" className="lnk btnlink" onClick={() => setRows((all) => [...(all ?? []), row('', 'gitlab', 'https://')])}>
        <Icon name="plus" size={12} stroke={2} /> Add another GitLab instance
      </button>
    </Dialog>
  )
}
