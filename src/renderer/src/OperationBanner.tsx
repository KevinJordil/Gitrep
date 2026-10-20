import type { OperationInfo, RepoStatus } from '../../shared/types'
import { api } from './api'
import { Icon } from './icons'
import type { RunOp, RunOutcome } from './model'

const LABEL = { merge: 'Merge', rebase: 'Rebase', 'cherry-pick': 'Cherry-pick', revert: 'Revert' } as const

interface Props {
  repo: string
  status: RepoStatus
  info: OperationInfo | null
  busy: string | null
  asking: boolean // Claude is preparing resolutions
  inView: boolean // the conflict view is open
  run: RunOp
  runOutcome: RunOutcome
  onShow: () => void
  onResolveAll: () => void
}

// Shown while git waits in the middle of an operation, or after a stash left conflicts.
export function OperationBanner({ repo, status, info, busy, asking, inView, run, runOutcome, onShow, onResolveAll }: Props) {
  const op = status.operation
  const n = status.conflicted.length
  if (!op && !n) return null
  const label = op ? LABEL[op] : null
  const abort = () => {
    if (!label) return
    // Aborting throws away staged resolutions and, for a rebase, every step already replayed.
    if ((status.staged.length > 0 || op === 'rebase') && !window.confirm(`Abort the ${label.toLowerCase()} and discard the conflict resolutions made so far?`)) return
    void run('abort', () => api.abortOperation(repo), `${label} aborted`)
  }
  const steps = info?.steps ?? []
  const at = steps.findIndex((s) => s.state === 'current')
  const step = at < 0 ? steps.filter((s) => s.state === 'done').length : at + 1
  return (
    <div className="op-banner">
      <Icon name="warn" size={18} stroke={2} />
      <span className="op-text" role="status">
        <b>{label ? `${label} in progress` : 'Conflicts after applying a stash'}</b>
        {info && op && op !== 'revert' && (
          <>
            {' of '}
            <span className="mono">{info.theirs.name}</span>
            {op === 'merge' ? ' into ' : ' onto '}
            <span className="mono">{info.ours.name}</span>
          </>
        )}
        {steps.length > 0 && ` · step ${step} of ${steps.length}`}
        {n ? ` · ${n} conflicted file${n === 1 ? '' : 's'}` : ' · no conflicts left: continue when ready'}
      </span>
      <div className="grow" />
      {n > 0 && (
        <button className="btn-claude" disabled={asking} onClick={onResolveAll}>
          {asking ? <span className="spin" /> : <Icon name="sparkle" size={14} />}
          {asking ? 'Claude is resolving…' : 'Resolve all with Claude'}
        </button>
      )}
      {n > 0 && !inView && (
        <button className="op-skip" onClick={onShow}>
          Show conflicts
        </button>
      )}
      {op === 'rebase' && (
        <button className="op-skip" disabled={!!busy} onClick={() => window.confirm('Skip this commit? Its changes and any resolutions staged for it will be dropped.') && void runOutcome('skip', () => api.skipOperation(repo), 'Commit skipped')}>
          Skip this commit
        </button>
      )}
      {label && n === 0 && (
        <button className="op-continue" disabled={!!busy} onClick={() => void runOutcome('continue', () => api.continueOperation(repo), `${label} complete`)}>
          Continue
        </button>
      )}
      {label && (
        <button className="op-abort" disabled={!!busy} onClick={abort}>
          Abort {label.toLowerCase()}
        </button>
      )}
    </div>
  )
}
