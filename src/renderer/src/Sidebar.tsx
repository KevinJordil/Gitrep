import { useState } from 'react'
import { isActive } from '../../shared/branches'
import type { Branch, GraphScope, Stash, Tag } from '../../shared/types'
import { dragBranch, dropOnBranch, type DropBranch } from './dnd'
import { laneColor } from './format'
import { Icon } from './icons'
import type { Focus } from './model'

interface Props {
  branches: Branch[]
  tags: Tag[]
  stashes: Stash[]
  colors: ReadonlyMap<string, number> // commit sha -> graph lane color
  focus: Focus
  scope: GraphScope
  activeDays: number // branches not active over that many days fold under "N older branches"; 0 = no folding
  onSwitch: (b: Branch) => void
  onFocus: (f: Focus) => void
  onScope: (s: GraphScope) => void
  onDrop: DropBranch
  onDelete: (b: Branch) => void
}

function Title({ title, count }: { title: string; count: number }) {
  return (
    <div className="side-title">
      <span>{title}</span>
      <span className="mono">{count}</span>
    </div>
  )
}

export function Sidebar({ branches, tags, stashes, colors, focus, scope, activeDays, onSwitch, onFocus, onScope, onDrop, onDelete }: Props) {
  const [unfolded, setUnfolded] = useState<string[]>([]) // titles of the sections showing their older branches
  const dot = (sha: string, fallback: string) => {
    const c = colors.get(sha)
    return c === undefined ? fallback : laneColor(c)
  }
  const focused = focus.kind === 'commit' ? focus.sha : null
  const groups: [string, Branch[]][] = [
    ['Local branches', branches.filter((b) => !b.remote)],
    ['Remote', branches.filter((b) => b.remote)]
  ]
  const isRecent = isActive(branches, activeDays)
  const active = (b: Branch) => isRecent(b) || scope.only === b.name // an isolated branch is never folded
  const branchItem = (b: Branch) => {
    const isolated = scope.only === b.name
    const hidden = scope.hidden.includes(b.name)
    const off = hidden || (!!scope.only && !isolated)
    return (
      <div
        key={b.name}
        className={`side-item br ${b.current ? 'current' : ''} ${focused === b.sha ? 'sel' : ''} ${off ? 'off' : ''}`}
        title={b.current ? 'Current branch' : 'Double-click to switch to this branch'}
        onDoubleClick={() => !b.current && onSwitch(b)}
        {...dragBranch(b)}
        {...(b.remote ? {} : dropOnBranch(b, branches, onDrop))}
      >
        <span className="dot" style={{ background: dot(b.sha, b.remote ? 'var(--faint)' : 'var(--accent)') }} />
        <button className="name" title={b.name} onClick={() => onFocus({ kind: 'commit', sha: b.sha })}>
          {b.name}
        </button>
        <span className="faint">{[b.ahead ? `↑${b.ahead}` : '', b.behind ? `↓${b.behind}` : ''].join(' ').trim()}</span>
        {/* Over the end of the row, not beside the name: shown on hover and keyboard focus, or while a toggle is on. */}
        <span className="side-actions">
          <button
            className={`sbtn ${hidden ? 'on' : ''}`}
            aria-label={`${hidden ? 'Show' : 'Hide'} ${b.name}`}
            aria-pressed={hidden}
            disabled={b.current}
            title={b.current ? 'The checked-out branch is always shown' : hidden ? 'Show this branch' : 'Hide this branch'}
            onClick={() => onScope({ only: null, hidden: hidden ? scope.hidden.filter((h) => h !== b.name) : [...scope.hidden, b.name] })}
          >
            <Icon name={hidden ? 'eyeOff' : 'eye'} size={13} stroke={2} />
          </button>
          <button
            className={`sbtn ${isolated ? 'on' : ''}`}
            aria-label={`${isolated ? 'Stop isolating' : 'Isolate'} ${b.name}`}
            aria-pressed={isolated}
            title={isolated ? 'Show all branches' : 'Show only this branch'}
            onClick={() => onScope({ only: isolated ? null : b.name, hidden: [] })}
          >
            <Icon name="target" size={13} stroke={2} />
          </button>
          {!b.remote && !b.current && (
            <button className="sbtn" aria-label={`Delete ${b.name}`} title="Delete this branch (Ctrl+Z restores it)" onClick={() => onDelete(b)}>
              <Icon name="trash" size={13} stroke={2} />
            </button>
          )}
        </span>
      </div>
    )
  }
  return (
    <aside className="sidebar">
      {groups.map(([title, list]) => {
        const older = list.filter((b) => !active(b))
        const open = unfolded.includes(title)
        return (
          <section key={title}>
            <Title title={title} count={list.length} />
            {list.filter(active).map(branchItem)}
            {older.length > 0 && (
              <button className="side-more" aria-expanded={open} onClick={() => setUnfolded(open ? unfolded.filter((t) => t !== title) : [...unfolded, title])}>
                <Icon name={open ? 'up' : 'down'} size={12} stroke={2.2} />
                {older.length} older branch{older.length === 1 ? '' : 'es'}
              </button>
            )}
            {open && older.map(branchItem)}
          </section>
        )
      })}
      <section>
        <Title title="Stashes" count={stashes.length} />
        {stashes.map((s) => {
          const selected = focus.kind === 'stash' && focus.sha === s.sha
          return (
            <div key={s.sha} className={`side-item sans ${selected ? 'sel' : ''}`} title={`stash@{${s.index}}`}>
              <span className="dot sq" style={{ background: selected ? 'var(--accent)' : undefined }} />
              <button className="name" onClick={() => onFocus({ kind: 'stash', sha: s.sha })}>
                {s.message}
              </button>
              <span className="faint mono">{s.branch ?? ''}</span>
            </div>
          )
        })}
      </section>
      <section>
        <Title title="Tags" count={tags.length} />
        {tags.map((t) => (
          <div key={t.name} className={`side-item ${focused === t.sha ? 'sel' : ''}`}>
            <span className="dot sq" />
            <button className="name" onClick={() => onFocus({ kind: 'commit', sha: t.sha })}>
              {t.name}
            </button>
          </div>
        ))}
      </section>
    </aside>
  )
}
