import { memo, useCallback, useEffect, useRef, type CSSProperties } from 'react'
import { GRAPH_LIMIT, type Commit } from '../../shared/types'
import { colorFor, initials, laneColor, parseRef, relativeDate } from './format'
import type { GraphRow, Segment } from './graph'
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

export function RefPill({ text, color, remoteNames }: { text: string; color: string; remoteNames: ReadonlySet<string> }) {
  const ref = parseRef(text, remoteNames)
  return (
    <span className={`ref ${ref.kind}`} style={{ '--c': color } as CSSProperties}>
      {ref.kind === 'head' && <Icon name="check" size={11} stroke={2.6} />}
      {ref.kind === 'remote' && <Icon name="cloud" size={12} stroke={2.2} />}
      {ref.kind === 'tag' && <Icon name="tag" size={11} stroke={2.2} />}
      {ref.label}
    </span>
  )
}

interface RowProps {
  commit: Commit
  row: GraphRow
  width: number
  head: boolean
  selected: boolean
  remoteNames: ReadonlySet<string>
  onSelect: (sha: string) => void
}

const CommitRow = memo(function CommitRow({ commit: c, row, width, head, selected, remoteNames, onSelect }: RowProps) {
  const merge = c.parents.length > 1
  return (
    <div
      className={`row ${selected ? 'sel' : ''}`}
      data-sha={c.sha}
      role="button"
      tabIndex={0}
      aria-pressed={selected}
      onClick={() => onSelect(c.sha)}
      onKeyDown={(e) => e.key === 'Enter' && onSelect(c.sha)}
    >
      <Lanes row={row} width={width} dot={head ? 'head' : merge ? 'merge' : 'commit'} selected={selected} />
      <span className="msg">
        {c.refs.map((r) => (
          <RefPill key={r} text={r} color={laneColor(row.color)} remoteNames={remoteNames} />
        ))}
        <span className="s" style={{ color: merge ? 'var(--muted)' : undefined }}>
          {c.subject}
        </span>
      </span>
      <span className="c-author">
        <span className="avatar" style={{ background: colorFor(c.author) }}>
          {initials(c.author)}
        </span>
        {c.author}
      </span>
      <span className="c-date" title={new Date(c.date * 1000).toLocaleString('en-GB')}>
        {relativeDate(c.date)}
      </span>
      <span className="c-sha">{c.sha.slice(0, 7)}</span>
    </div>
  )
})

interface Props {
  repoName: string
  commits: Commit[]
  rows: GraphRow[] // one per commit, plus the work-in-progress row first when `wip` is set
  wip: string | null // label of the work-in-progress row
  head: string | null
  focus: Focus
  remoteNames: ReadonlySet<string>
  onFocus: (f: Focus) => void
}

export function Graph({ repoName, commits, rows, wip, head, focus, remoteNames, onFocus }: Props) {
  const list = useRef<HTMLDivElement>(null)
  const width = graphWidth(rows)
  const offset = wip ? 1 : 0
  const focused = focus.kind === 'commit' ? focus.sha : null
  const select = useCallback((sha: string) => onFocus({ kind: 'commit', sha }), [onFocus])

  useEffect(() => {
    if (focused) list.current?.querySelector(`[data-sha="${focused}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [focused])

  return (
    <>
      <div className="pane-head">
        <span className="pane-title">History</span>
        <span className="faint">{repoName}</span>
        <div className="grow" />
        <span className="faint">{commits.length >= GRAPH_LIMIT ? `Last ${GRAPH_LIMIT} commits` : `${commits.length} commit${commits.length === 1 ? '' : 's'}`}</span>
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
          <CommitRow key={c.sha} commit={c} row={rows[i + offset]} width={width} head={c.sha === head} selected={c.sha === focused} remoteNames={remoteNames} onSelect={select} />
        ))}
        {commits.length === 0 && <span className="faint" style={{ padding: 14 }}>No commits yet.</span>}
      </div>
    </>
  )
}
