import { useEffect, useState } from 'react'
import type { FileDiff, Hunk, LineAction } from '../../shared/types'
import { api } from './api'
import { changeGroups, errorText, splitPath } from './format'
import { Icon } from './icons'
import type { RunOp, Selection } from './model'
import { useToast } from './toast'

const MAX_LINES = 4000
const SIDE_LABEL = { unstaged: 'Unstaged', staged: 'Staged', untracked: 'Untracked' } as const

interface Props {
  repo: string
  selection: Selection
  version: number
  onBack: () => void
  run: RunOp
}

export function DiffView({ repo, selection, version, onBack, run }: Props) {
  const notify = useToast()
  const { path, side } = selection
  const [diff, setDiff] = useState<FileDiff | null | undefined>(undefined)
  const [picked, setPicked] = useState<Record<number, number[]>>({})
  const [showAll, setShowAll] = useState(false)

  useEffect(() => {
    let alive = true
    api
      .diff(repo, path, side)
      .then((d) => {
        if (!alive) return
        // Background refreshes often return the same diff: keep the displayed one and the ticked lines.
        setDiff((old) => {
          if (old !== undefined && JSON.stringify(old) === JSON.stringify(d)) return old
          setPicked({})
          return d
        })
      })
      .catch((e: unknown) => notify('error', errorText(e)))
    return () => {
      alive = false
    }
  }, [repo, path, side, version, notify])

  const partial = !!diff && !diff.binary && !diff.isNew && !diff.isDeleted && side !== 'untracked'
  const primary: LineAction = side === 'staged' ? 'unstage' : 'stage'
  const primaryVerb = primary === 'stage' ? 'Stage' : 'Unstage'

  // hunk === null → apply the checkbox selection (bottom-up so earlier hunk positions stay valid).
  const apply = async (action: LineAction, hunk: number | null, lines: number[] | null) => {
    if (!diff) return
    if (action === 'discard' && !window.confirm('Permanently discard these changes?')) return
    const targets: [number, number[] | null][] =
      hunk !== null
        ? [[hunk, lines]]
        : Object.entries(picked)
            .map(([h, ls]): [number, number[]] => [Number(h), ls])
            .sort((a, b) => b[0] - a[0])
    await run(action, async () => {
      for (const [h, ls] of targets) await api.applyLines(repo, diff, h, ls, action)
    })
  }

  const toggle = (hunk: number, line: number) =>
    setPicked((p) => {
      const set = new Set(p[hunk] ?? [])
      if (set.has(line)) set.delete(line)
      else set.add(line)
      const next = { ...p }
      if (set.size) next[hunk] = [...set].sort((a, b) => a - b)
      else delete next[hunk]
      return next
    })

  const pickedCount = Object.values(picked).reduce((n, ls) => n + ls.length, 0)
  const hunks = diff?.hunks ?? []
  let used = 0
  const shown = hunks
    .map((h, i) => ({ h, i }))
    .filter(({ h, i }) => {
      used += h.lines.length
      return showAll || i === 0 || used <= MAX_LINES
    })
  const [dir, name] = splitPath(path)

  return (
    <>
      <div className="pane-head">
        <button className="tbtn boxed" onClick={onBack}>
          <Icon name="back" size={14} stroke={2} /> History
        </button>
        <span className="mono">
          <span className="faint">{dir}</span>
          {name}
        </span>
        <span className={`badge ${side === 'staged' ? 'blue' : 'amber'}`}>{SIDE_LABEL[side]}</span>
      </div>
      <div className="diff-body">
        {diff === undefined && <span className="faint">Loading…</span>}
        {diff === null && <span className="faint">No changes to display.</span>}
        {diff?.binary && <div className="banner">Binary file: no preview.</div>}
        {diff && !diff.binary && !partial && <div className="banner">This file can only be staged as a whole: use the buttons in the right panel.</div>}
        {shown.map(({ h, i }) => (
          <section key={`${i}:${h.header}`} className="hunk">
            <div className="hunk-head">
              <span className="h">{h.header}</span>
              {partial && (
                <button className="btn-claude" onClick={() => void apply(primary, i, null)}>
                  <Icon name={primary === 'stage' ? 'plus' : 'minus'} size={12} stroke={2.4} /> {primaryVerb} hunk
                </button>
              )}
              {partial && side === 'unstaged' && (
                <button className="small-btn" onClick={() => void apply('discard', i, null)}>
                  Discard hunk
                </button>
              )}
            </div>
            <Lines hunk={h} index={i} partial={partial} verb={primaryVerb} icon={primary === 'stage' ? 'plus' : 'minus'} picked={picked[i] ?? []} onToggle={toggle} onGroup={(lines) => void apply(primary, i, lines)} />
          </section>
        ))}
        {shown.length < hunks.length && (
          <button className="btn" style={{ alignSelf: 'flex-start' }} onClick={() => setShowAll(true)}>
            Show {hunks.length - shown.length} remaining hunks
          </button>
        )}
      </div>
      {pickedCount > 0 && (
        <div className="selbar">
          <span>
            <b>
              {pickedCount} line{pickedCount === 1 ? '' : 's'}
            </b>{' '}
            selected
          </span>
          <button className="btn-primary" style={{ height: 30 }} onClick={() => void apply(primary, null, null)}>
            {primaryVerb} lines
          </button>
          {side === 'unstaged' && (
            <button className="btn" onClick={() => void apply('discard', null, null)}>
              Discard lines
            </button>
          )}
          <button className="tab-close" aria-label="Clear selection" onClick={() => setPicked({})}>
            <Icon name="close" size={14} stroke={2} />
          </button>
        </div>
      )}
    </>
  )
}

interface LinesProps {
  hunk: Hunk
  index: number
  partial: boolean
  verb: string
  icon: 'plus' | 'minus'
  picked: number[]
  onToggle: (hunk: number, line: number) => void
  onGroup: (lines: number[]) => void
}

function Lines({ hunk, index, partial, verb, icon, picked, onToggle, onGroup }: LinesProps) {
  const groupAt = new Map(changeGroups(hunk.lines).map((g) => [g[0], g]))
  const sel = new Set(picked)
  return (
    <div className="lines">
      {hunk.lines.map((l, i) => {
        const group = groupAt.get(i)
        return (
          <div key={i} className={`line ${l.kind} ${sel.has(i) ? 'sel' : ''}`}>
            <span className="g">
              {partial && group && (
                <button className="gbtn" aria-label={`${verb} this block of ${group.length} line${group.length === 1 ? '' : 's'}`} title={`${verb} ${group.length} line${group.length === 1 ? '' : 's'}`} onClick={() => onGroup(group)}>
                  <Icon name={icon} size={11} stroke={3} />
                </button>
              )}
            </span>
            <span className="cb">{partial && l.kind !== 'context' && <input type="checkbox" aria-label={`Select line ${l.newNo ?? l.oldNo}`} checked={sel.has(i)} onChange={() => onToggle(index, i)} />}</span>
            <span className="no">{l.oldNo ?? ''}</span>
            <span className="no">{l.newNo ?? ''}</span>
            <span className="sg">{l.kind === 'add' ? '+' : l.kind === 'del' ? '−' : ''}</span>
            <span className="t">{l.text}</span>
          </div>
        )
      })}
    </div>
  )
}
