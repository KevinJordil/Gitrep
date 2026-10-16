import type { Branch, Stash, Tag } from '../../shared/types'
import { laneColor } from './format'
import type { Focus } from './model'

interface Props {
  branches: Branch[]
  tags: Tag[]
  stashes: Stash[]
  colors: ReadonlyMap<string, number> // commit sha -> graph lane color
  focus: Focus
  onSwitch: (b: Branch) => void
  onFocus: (f: Focus) => void
}

function Title({ title, count }: { title: string; count: number }) {
  return (
    <div className="side-title">
      <span>{title}</span>
      <span className="mono">{count}</span>
    </div>
  )
}

export function Sidebar({ branches, tags, stashes, colors, focus, onSwitch, onFocus }: Props) {
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
          {list.map((b) => (
            <div
              key={b.name}
              className={`side-item ${b.current ? 'current' : ''} ${focused === b.sha ? 'sel' : ''}`}
              title={b.current ? 'Current branch' : 'Double-click to switch to this branch'}
              onDoubleClick={() => !b.current && onSwitch(b)}
            >
              <span className="dot" style={{ background: dot(b.sha, b.remote ? 'var(--faint)' : 'var(--accent)') }} />
              <button className="name" onClick={() => onFocus({ kind: 'commit', sha: b.sha })}>
                {b.name}
              </button>
              <span className="faint">{[b.ahead ? `↑${b.ahead}` : '', b.behind ? `↓${b.behind}` : ''].join(' ').trim()}</span>
            </div>
          ))}
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
