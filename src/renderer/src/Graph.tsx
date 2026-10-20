import { memo, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { GRAPH_LIMIT, type Branch, type Commit, type GraphScope } from '../../shared/types'
import { colorFor, initials, laneColor, parseRef, relativeDate } from './format'
import { dragBranch, dropOnBranch, type DropBranch } from './dnd'
import { searchCommits, splitMatch, type GraphRow, type SearchField, type Segment } from './graph'
import { Icon } from './icons'
import type { Focus } from './model'

const ROW_H = 34
const MID = ROW_H / 2
const LANE_W = 20
const X0 = 24 // centre of the first lane
const MAX_LANES = 12 // Limit: wider graphs are clipped; add horizontal scrolling if a repo needs more
const laneX = (lane: number) => X0 + lane * LANE_W

export function graphWidth(rows: GraphRow[]): number {
  const lanes = Math.min(MAX_LANES, Math.max(1, ...rows.map((r) => r.width)))
  return Math.max(86, laneX(lanes - 1) + 22)
}

function segmentPath(s: Segment): string {
  const [y1, y2] = s.kind === 'through' ? [0, ROW_H] : s.kind === 'top' ? [0, MID] : [MID, ROW_H]
  const x1 = laneX(s.from)
  const x2 = laneX(s.to)
  if (x1 === x2) return `M${x1} ${y1}V${y2}`
  const ym = (y1 + y2) / 2
  return `M${x1} ${y1}C${x1} ${ym} ${x2} ${ym} ${x2} ${y2}`
}

type Dot = 'commit' | 'merge' | 'head' | 'wip'

function Lanes({ row, width, dot, selected }: { row: GraphRow; width: number; dot: Dot; selected: boolean }) {
  const cx = laneX(row.lane)
  const color = laneColor(row.color)
  return (
    <svg className="lanes" width={width} height={ROW_H} aria-hidden="true">
      {row.segments.map((s, i) => (
        <path key={i} d={segmentPath(s)} stroke={laneColor(s.color)} strokeWidth={2} fill="none" strokeDasharray={s.dashed ? '3 3' : undefined} />
      ))}
      {(selected || dot === 'head') && <circle cx={cx} cy={MID} r={9.5} fill="none" stroke={selected ? 'var(--text)' : color} strokeOpacity={selected ? 0.5 : 0.35} strokeWidth={2} />}
      {dot === 'wip' && <circle cx={cx} cy={MID} r={6} fill="var(--bg)" stroke={color} strokeWidth={2} strokeDasharray="2.5 2" />}
      {dot === 'merge' && <circle cx={cx} cy={MID} r={5.5} fill="var(--bg)" stroke={color} strokeWidth={2.5} />}
      {(dot === 'commit' || dot === 'head') && <circle cx={cx} cy={MID} r={dot === 'head' ? 6 : 5.5} fill={color} />}
    </svg>
  )
}

interface PillProps {
  text: string
  color: string
  remoteNames: ReadonlySet<string>
  branches?: Branch[] // with onDrop: branch pills can be dragged, local ones accept drops
  onDrop?: DropBranch
}

export function RefPill({ text, color, remoteNames, branches = [], onDrop }: PillProps) {
  const ref = parseRef(text, remoteNames)
  const branch = onDrop && ref.kind !== 'tag' ? branches.find((b) => b.name === ref.label && b.remote === (ref.kind === 'remote')) : undefined
  const dnd = branch && onDrop ? { ...dragBranch(branch), ...(branch.remote ? {} : dropOnBranch(branch, branches, onDrop)) } : {}
  return (
    <span className={`ref ${ref.kind}`} style={{ '--c': color } as CSSProperties} title={branch ? 'Drag onto another branch to merge or rebase' : undefined} {...dnd}>
      {ref.kind === 'head' && <Icon name="check" size={11} stroke={2.6} />}
      {ref.kind === 'remote' && <Icon name="cloud" size={12} stroke={2.2} />}
      {ref.kind === 'tag' && <Icon name="tag" size={11} stroke={2.2} />}
      {ref.label}
    </span>
  )
}

// The usual choices, plus a value set by hand in the config file.
const when = (t: number) => new Date(t * 1000).toLocaleString('en-GB')
// The column shows when the commit landed (the graph's order); a rebase keeps the older author date.
const dateTitle = (c: Commit) => (c.committed === c.date ? when(c.committed) : `Committed ${when(c.committed)}\nWritten ${when(c.date)}`)

const dayChoices = (current: number) => [...new Set([30, 90, current])].filter((d) => d > 0).sort((a, b) => a - b)

const SEARCH_FIELDS: [SearchField, string][] = [
  ['all', 'All fields'],
  ['message', 'Message'],
  ['author', 'Author'],
  ['sha', 'SHA']
]

function Highlight({ text, query, current }: { text: string; query: string; current: boolean }) {
  const parts = query ? splitMatch(text, query) : null
  if (!parts) return <>{text}</>
  return (
    <>
      {parts[0]}
      <mark className={current ? 'cur' : ''}>{parts[1]}</mark>
      {parts[2]}
    </>
  )
}

interface RowProps {
  commit: Commit
  row: GraphRow
  width: number
  head: boolean
  selected: boolean
  remoteNames: ReadonlySet<string>
  branches: Branch[]
  match: string // the search query when this row matches, else ''
  field: SearchField
  current: boolean // the current search match
  dim: boolean // a search is active and this row does not match
  onSelect: (sha: string) => void
  onMenu: (c: Commit, x: number, y: number) => void
  onDrop: DropBranch
}

const CommitRow = memo(function CommitRow({ commit: c, row, width, head, selected, remoteNames, branches, match, field, current, dim, onSelect, onMenu, onDrop }: RowProps) {
  const merge = c.parents.length > 1
  const hl = (f: SearchField) => (field === 'all' || field === f ? match : '')
  return (
    <div
      className={`row ${selected ? 'sel' : ''} ${dim ? 'dim' : ''}`}
      data-sha={c.sha}
      role="button"
      tabIndex={0}
      aria-pressed={selected}
      onClick={() => onSelect(c.sha)}
      onContextMenu={(e) => {
        e.preventDefault()
        onSelect(c.sha)
        onMenu(c, e.clientX, e.clientY)
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') onSelect(c.sha)
        if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) {
          e.preventDefault()
          const r = e.currentTarget.getBoundingClientRect()
          onSelect(c.sha)
          onMenu(c, r.left + width + 40, r.bottom)
        }
      }}
    >
      <Lanes row={row} width={width} dot={head ? 'head' : merge ? 'merge' : 'commit'} selected={selected} />
      <span className="msg">
        {c.refs.map((r) => (
          <RefPill key={r} text={r} color={laneColor(row.color)} remoteNames={remoteNames} branches={branches} onDrop={onDrop} />
        ))}
        <span className="s" style={{ color: merge ? 'var(--muted)' : undefined }}>
          <Highlight text={c.subject} query={hl('message')} current={current} />
        </span>
      </span>
      <span className="c-author">
        <span className="avatar" style={{ background: colorFor(c.author) }}>
          {initials(c.author)}
        </span>
        <Highlight text={c.author} query={hl('author')} current={current} />
      </span>
      <span className="c-date" title={dateTitle(c)}>
        {relativeDate(c.committed)}
      </span>
      <span className="c-sha">
        <Highlight text={c.sha.slice(0, 7)} query={hl('sha')} current={current} />
      </span>
    </div>
  )
})

interface Props {
  repoName: string
  active: boolean
  commits: Commit[]
  rows: GraphRow[] // one per commit, plus the work-in-progress row first when `wip` is set
  wip: string | null // label of the work-in-progress row
  head: string | null
  focus: Focus
  branches: Branch[]
  scope: GraphScope
  activeDays: number // 0 = every branch
  remoteNames: ReadonlySet<string>
  onFocus: (f: Focus) => void
  onScope: (s: GraphScope) => void
  onActiveDays: (days: number) => void
  onMenu: (c: Commit, x: number, y: number) => void // must be stable (useCallback)
  onDrop: DropBranch // must be stable (useCallback)
}

export function Graph({ repoName, active, commits, rows, wip, head, focus, branches, scope, activeDays, remoteNames, onFocus, onScope, onActiveDays, onMenu, onDrop }: Props) {
  const list = useRef<HTMLDivElement>(null)
  const input = useRef<HTMLInputElement>(null)
  const [query, setQuery] = useState('')
  const [field, setField] = useState<SearchField>('all')
  const [cur, setCur] = useState(0)
  const width = graphWidth(rows)
  const offset = wip ? 1 : 0
  const focused = focus.kind === 'commit' ? focus.sha : null
  const select = useCallback((sha: string) => onFocus({ kind: 'commit', sha }), [onFocus])
  const matches = useMemo(() => searchCommits(commits, query, field), [commits, query, field])
  const matchSet = useMemo(() => new Set(matches), [matches])
  const k = Math.min(cur, matches.length - 1) // current match, -1 when none
  const currentSha = k >= 0 ? commits[matches[k]].sha : null
  const searching = query.trim() !== ''

  // The first press selects the highlighted match, the next ones move to the next/previous match.
  const go = (delta: number) => {
    if (k < 0) return
    const next = focused === currentSha ? (k + delta + matches.length) % matches.length : k
    setCur(next)
    select(commits[matches[next]].sha)
  }

  useEffect(() => {
    if (focused) list.current?.querySelector(`[data-sha="${focused}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [focused])

  useEffect(() => {
    if (currentSha) list.current?.querySelector(`[data-sha="${currentSha}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [currentSha])

  useEffect(() => {
    if (!active) return
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
        e.preventDefault()
        input.current?.focus()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [active])

  return (
    <>
      <div className="pane-head">
        <span className="pane-title">History</span>
        <span className="faint">{repoName}</span>
        {scope.only && (
          <span className="scope-chip">
            Only <span className="mono">{scope.only}</span>
            <button aria-label="Show all branches" title="Show all branches" onClick={() => onScope({ only: null, hidden: [] })}>
              <Icon name="close" size={11} stroke={2.4} />
            </button>
          </span>
        )}
        {scope.hidden.length > 0 && (
          <span className="scope-chip" title={scope.hidden.join(', ')}>
            {scope.hidden.length} hidden
            <button aria-label="Show hidden branches" title="Show hidden branches" onClick={() => onScope({ only: null, hidden: [] })}>
              <Icon name="close" size={11} stroke={2.4} />
            </button>
          </span>
        )}
        <div className="grow" />
        <label className={`searchbox ${searching ? 'on' : ''}`}>
          <Icon name="search" size={13} stroke={2} />
          <span className="sr-only">Search the history</span>
          <input
            ref={input}
            value={query}
            placeholder="Search: message, author, SHA"
            onChange={(e) => {
              setQuery(e.target.value)
              setCur(0)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') go(e.shiftKey ? -1 : 1)
              if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                e.preventDefault()
                go(e.key === 'ArrowDown' ? 1 : -1)
              }
              if (e.key === 'Escape') setQuery('')
            }}
          />
          {searching && <span className="count">{matches.length ? `${k + 1} / ${matches.length}` : 'No match'}</span>}
          {searching && (
            <>
              <button className="nav" aria-label="Previous match" disabled={!matches.length} onClick={() => go(-1)}>
                <Icon name="up" size={12} stroke={2.4} />
              </button>
              <button className="nav" aria-label="Next match" disabled={!matches.length} onClick={() => go(1)}>
                <Icon name="down" size={12} stroke={2.4} />
              </button>
            </>
          )}
        </label>
        <select className="select" aria-label="Search in" value={field} onChange={(e) => setField(e.target.value as SearchField)}>
          {SEARCH_FIELDS.map(([f, label]) => (
            <option key={f} value={f}>
              In: {label}
            </option>
          ))}
        </select>
        {!scope.only && (
          // "days:N" cannot be a branch name (git refuses ':' in ref names).
          <select
            className="select"
            aria-label="Branches shown"
            value={`days:${activeDays}`}
            onChange={(e) => (e.target.value.startsWith('days:') ? onActiveDays(Number(e.target.value.slice(5))) : onScope({ only: e.target.value, hidden: [] }))}
          >
            {dayChoices(activeDays).map((d) => (
              <option key={d} value={`days:${d}`}>
                Active branches ({d} days)
              </option>
            ))}
            <option value="days:0">All branches</option>
            {branches.map((b) => (
              <option key={`${b.remote}:${b.name}`} value={b.name}>
                Only {b.name}
              </option>
            ))}
          </select>
        )}
        <span className="faint">{commits.length >= GRAPH_LIMIT ? `Last ${GRAPH_LIMIT}` : `${commits.length} commit${commits.length === 1 ? '' : 's'}`}</span>
      </div>
      <div className="cols" style={{ paddingLeft: width }}>
        <span style={{ flex: 1 }}>Message</span>
        <span className="c-author">Author</span>
        <span className="c-date">Date</span>
        <span className="c-sha">SHA</span>
      </div>
      <div className="scroll graph-rows" ref={list}>
        {wip && rows[0] && (
          <div className={`row wip ${focus.kind === 'wip' ? 'sel' : ''}`} role="button" tabIndex={0} aria-pressed={focus.kind === 'wip'} onClick={() => onFocus({ kind: 'wip' })} onKeyDown={(e) => e.key === 'Enter' && onFocus({ kind: 'wip' })}>
            <Lanes row={rows[0]} width={width} dot="wip" selected={false} />
            <span className="msg">
              <span className="wip-tag">WIP</span>
              <span className="s muted">{wip}</span>
            </span>
            <span className="c-author" />
            <span className="c-date">now</span>
            <span className="c-sha" />
          </div>
        )}
        {commits.map((c, i) => (
          <CommitRow
            key={c.sha}
            commit={c}
            row={rows[i + offset]}
            width={width}
            head={c.sha === head}
            selected={c.sha === focused}
            remoteNames={remoteNames}
            branches={branches}
            match={matchSet.has(i) ? query : ''}
            field={field}
            current={c.sha === currentSha}
            dim={searching && !matchSet.has(i)}
            onSelect={select}
            onMenu={onMenu}
            onDrop={onDrop}
          />
        ))}
        {commits.length === 0 && <span className="faint" style={{ padding: 14 }}>No commits yet.</span>}
      </div>
    </>
  )
}
