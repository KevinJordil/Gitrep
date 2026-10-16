import type { Branch, GraphScope, Stash, Tag } from '../../shared/types'
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
  onSwitch: (b: Branch) => void
  onFocus: (f: Focus) => void
  onScope: (s: GraphScope) => void
}

function Title({ title, count }: { title: string; count: number }) {
  return (
    <div className="side-title">
      <span>{title}</span>
      <span className="mono">{count}</span>
    </div>
  )
}

export function Sidebar({ branches, tags, stashes, colors, focus, scope, onSwitch, onFocus, onScope }: Props) {
  const dot = (sha: string, fallback: string) => {
    const c = colors.get(sha)
    return c === undefined ? fallback : laneColor(c)
  }
  const focused = focus.kind === 'commit' ? focus.sha : null
  const groups: [string, Branch[]][] = [
    ['Local branches', branches.filter((b) => !b.remote)],
    ['Remote', branches.filter((b) => b.remote)]
  ]
  return (
    <aside className="sidebar">
      {groups.map(([title, list]) => (
        <section key={title}>
          <Title title={title} count={list.length} />
          {list.map((b) => {
            const isolated = scope.only === b.name
            const hidden = scope.hidden.includes(b.name)
            const off = hidden || (!!scope.only && !isolated)
            return (
              <div
                key={b.name}
                className={`side-item br ${b.current ? 'current' : ''} ${focused === b.sha ? 'sel' : ''} ${off ? 'off' : ''}`}
                title={b.current ? 'Current branch' : 'Double-click to switch to this branch'}
                onDoubleClick={() => !b.current && onSwitch(b)}
              >
                <span className="dot" style={{ background: dot(b.sha, b.remote ? 'var(--faint)' : 'var(--accent)') }} />
                <button className="name" onClick={() => onFocus({ kind: 'commit', sha: b.sha })}>
                  {b.name}
                </button>
                <span className="faint">{[b.ahead ? `↑${b.ahead}` : '', b.behind ? `↓${b.behind}` : ''].join(' ').trim()}</span>
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
              </div>
            )
          })}
        </section>
      ))}
      <section>
        <Title title="Stashes" count={stashes.length} />
        {stashes.map((s) => (
          <div key={s.sha} className="side-item sans" title={`stash@{${s.index}}`}>
            <span className="dot sq" />
            <span className="name">{s.message}</span>
            <span className="faint mono">{s.branch ?? ''}</span>
          </div>
        ))}
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
