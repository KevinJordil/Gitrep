import type { RepoStatus } from '../../shared/types'
import { api } from './api'
import { Icon } from './icons'
import type { RunOp, RunOutcome } from './model'

const LABEL = { merge: 'Merge', rebase: 'Rebase', 'cherry-pick': 'Cherry-pick', revert: 'Revert' } as const

interface Props {
  repo: string
  status: RepoStatus
  busy: string | null
  run: RunOp
  runOutcome: RunOutcome
  onCode: () => void
}

// Shown while git waits in the middle of an operation, or after a stash left conflicts. Resolution itself happens in VS Code.
export function OperationBanner({ repo, status, busy, run, runOutcome, onCode }: Props) {
  const op = status.operation
  const files = status.conflicted.map((f) => f.path)
  if (!op && !files.length) return null
  const label = op ? LABEL[op] : null
  const abort = () => {
    if (!label) return
    // Aborting throws away staged resolutions and, for a rebase, every step already replayed.
    if ((status.staged.length > 0 || op === 'rebase') && !window.confirm(`Abort the ${label.toLowerCase()} and discard the conflict resolutions made so far?`)) return
    void run('abort', () => api.abortOperation(repo), `${label} aborted`)
  }
  return (
    <div className="op-banner" role="status">
      <Icon name="warn" size={18} stroke={2} />
      <span className="op-text">
        <b>{label ? `${label} in progress` : 'Conflicts after applying a stash'}</b>
        {files.length ? ` · ${files.length} conflicted file${files.length === 1 ? '' : 's'}: ` : ' · no conflicts left: continue when ready'}
        {files.length > 0 && <span className="mono">{files.length > 3 ? `${files.slice(0, 3).join(', ')}…` : files.join(', ')}</span>}
        {files.length > 0 && op && ' · resolve, stage, then continue'}
      </span>
      <div className="grow" />
      <button className="tbtn boxed" onClick={onCode}>
        <Icon name="code" /> Open in VS Code
      </button>
      {label && (
        <button className="op-continue" disabled={!!busy || files.length > 0} title={files.length ? 'Resolve and stage the conflicted files first' : undefined} onClick={() => void runOutcome('continue', () => api.continueOperation(repo), `${label} complete`)}>
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
