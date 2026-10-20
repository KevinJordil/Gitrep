import { useEffect, useRef, useState } from 'react'
import type { Branch, MergeAdvice, MergeMode, MergePreview, RepoStatus } from '../../shared/types'
import { api } from './api'
import { errorText } from './format'
import { Icon, type IconName } from './icons'
import type { RunOutcome } from './model'
import { useToast } from './toast'

interface Props {
  repo: string
  source: Branch // the dragged branch
  target: Branch // the local branch it was dropped on: the one that changes
  status: RepoStatus | null
  x: number
  y: number
  runOutcome: RunOutcome
  onClose: () => void // must be stable (useCallback)
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

export function MergeMenu({ repo, source, target, status, x, y, runOutcome, onClose }: Props) {
  const notify = useToast()
  const ref = useRef<HTMLDivElement>(null)
  const [preview, setPreview] = useState<MergePreview | null>(null)
  const [advice, setAdvice] = useState<MergeAdvice | null>(null)
  const [asking, setAsking] = useState(false)
  const [step, setStep] = useState<'pick' | 'message'>('pick')
  const [message, setMessage] = useState('')
  const [drafting, setDrafting] = useState(false)
  const [autostash, setAutostash] = useState(true)
  const [prepare, setPrepare] = useState(true)
  const dirty = status ? new Set([...status.staged, ...status.unstaged.filter((f) => f.status !== '?')].map((f) => f.path)).size : 0

  useEffect(() => {
    api.mergePreview(repo, source.name, target.name).then(setPreview, (e: unknown) => {
      notify('error', errorText(e))
      onClose()
    })
  }, [repo, source.name, target.name, notify, onClose])

  useEffect(() => {
    const away = (e: Event) => {
      if (!ref.current?.contains(e.target as Node)) onClose()
    }
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('mousedown', away)
    window.addEventListener('keydown', esc)
    return () => {
      window.removeEventListener('mousedown', away)
      window.removeEventListener('keydown', esc)
    }
  }, [onClose])

  const ask = async (fn: () => Promise<void>, set: (on: boolean) => void) => {
    set(true)
    try {
      await fn()
    } catch (e) {
      notify('error', errorText(e))
    } finally {
      set(false)
    }
  }
  const go = (mode: MergeMode, done: string) => {
    onClose()
    void runOutcome(mode, () => api.integrate(repo, { source: source.name, target: target.name, mode, message, autostash: dirty > 0 && autostash }), done, prepare)
  }

  const incoming = preview?.incoming ?? 0
  const local = preview?.local ?? 0
  const upToDate = !!preview && incoming === 0
  const canFf = !!preview && incoming > 0 && local === 0
  const blocked = !target.current && dirty > 0 // a merge would have to switch branches first
  const checkout = target.current ? '' : ` · checks out ${target.name} first`
  const ops: { icon: IconName; title: string; desc: string; disabled: boolean; run: () => void }[] = [
    {
      icon: 'merge',
      title: `Merge ${source.name} into ${target.name}`,
      desc: upToDate
        ? `${target.name} already contains ${source.name}`
        : blocked
          ? `Commit or stash your changes, or check out ${target.name} first.`
          : `Merge commit, message drafted by Claude · ${plural(incoming, 'commit')} to integrate${checkout}`,
      disabled: !preview || upToDate || blocked,
      run: () => setStep('message')
    },
    {
      icon: 'rebase',
      title: `Rebase ${target.name} onto ${source.name}`,
      desc: local === 0 ? 'Nothing to replay: use fast-forward' : `Replays your ${plural(local, 'commit')} on top of ${source.name} · linear history${checkout}`,
      disabled: !preview || upToDate || local === 0,
      run: () => go('rebase', `${target.name} rebased onto ${source.name}`)
    },
    {
      icon: 'ff',
      title: 'Fast-forward',
      desc: canFf ? `Moves ${target.name} up to ${source.name} · ${plural(incoming, 'commit')}` : upToDate ? 'Already up to date' : 'Not possible: the branches have diverged',
      disabled: !canFf,
      run: () => go('ff', `${target.name} fast-forwarded to ${source.name}`)
    }
  ]

  const left = Math.max(8, Math.min(x - 20, window.innerWidth - 436))
  const top = Math.max(8, Math.min(y + 12, window.innerHeight - 500))
  return (
    <div ref={ref} className="merge-menu" role="dialog" aria-label={`What to do with ${source.name}?`} style={{ left, top }}>
      <div className="mm-head">
        <span className="ref local">{source.name}</span>
        <Icon name="arrow" size={16} stroke={2} />
        <span className={`ref ${target.current ? 'head' : 'local'}`}>{target.name}</span>
      </div>
      {step === 'pick' ? (
        <>
          <div className="mm-ops">
            {ops.map((o) => (
              <button key={o.icon} className="mm-op" disabled={o.disabled} onClick={o.run}>
                <Icon name={o.icon} size={18} />
                <span>
                  <span className="t">{o.title}</span>
                  <span className="d">{o.desc}</span>
                </span>
              </button>
            ))}
          </div>
          <div className="mm-box">
            {advice ? (
              <div className="claude-box">
                <span className="advice-title">
                  <Icon name="sparkle" size={14} /> Claude&apos;s advice{advice.choice ? `: ${advice.choice}` : ''}
                </span>
                {advice.text}
              </div>
            ) : (
              <button className="btn-claude" disabled={asking || !preview || upToDate} onClick={() => void ask(async () => setAdvice(await api.adviseMerge(repo, source.name, target.name)), setAsking)}>
                {asking ? <span className="spin" /> : <Icon name="sparkle" size={14} />}
                {asking ? 'Claude is thinking…' : 'Ask Claude: merge or rebase?'}
              </button>
            )}
            {!preview && <span className="note">Checking for conflicts…</span>}
            {preview && preview.conflicts.length > 0 && (
              <div className="warn-box">
                <Icon name="warn" size={16} stroke={2} />
                <span>
                  Likely conflict in <span className="mono">{preview.conflicts.join(', ')}</span>. Checked in a dry run, without touching your work.
                </span>
              </div>
            )}
            {preview && !upToDate && preview.conflicts.length === 0 && (
              <div className="ok-box">
                <Icon name="check" size={14} stroke={2.4} /> No conflict expected (dry run, your work is untouched).
              </div>
            )}
            {dirty > 0 && (
              <label className="check">
                <input type="checkbox" checked={autostash} onChange={(e) => setAutostash(e.target.checked)} /> Stash the {plural(dirty, 'local change')}, then re-apply them after
              </label>
            )}
            <label className="check">
              <input type="checkbox" checked={prepare} onChange={(e) => setPrepare(e.target.checked)} /> If it conflicts, prepare a resolution with Claude (to review)
            </label>
          </div>
          <span className="mm-foot">Esc to cancel · everything can be undone with Ctrl+Z</span>
        </>
      ) : (
        <div className="mm-box">
          <label className="dialog-field">
            Merge commit message
            <textarea className="field" rows={5} autoFocus value={message} placeholder={`Merge branch '${source.name}' into ${target.name}`} onChange={(e) => setMessage(e.target.value)} />
          </label>
          <div className="mm-actions">
            <button className="btn-claude" disabled={drafting} onClick={() => void ask(async () => setMessage(await api.mergeMessage(repo, source.name, target.name)), setDrafting)}>
              {drafting ? <span className="spin" /> : <Icon name="sparkle" size={14} />}
              {drafting ? 'Claude is writing…' : 'Write with Claude'}
            </button>
            <div className="grow" />
            <button className="btn" onClick={() => setStep('pick')}>
              Back
            </button>
            <button className="btn-primary" onClick={() => go('merge', `Merged ${source.name} into ${target.name}`)}>
              Merge
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
