import { memo, useMemo, useState } from 'react'
import type { Blame, BlameCommit } from '../../shared/types'
import { blameRows, heatOf, type BlameRow } from './blame'
import { colorFor, initials, relativeDate } from './format'

// Limit: longer files draw this many lines until "Show all" (each line is a DOM row).
// ponytail: no virtualization: 3000 rows by default, up to 50 000 (the blame cap) after "Show all"; `content-visibility: auto`
// keeps painting cheap. Window the rows if "Show all" proves too slow.
const MAX_ROWS = 3000

interface Props {
  blame: Blame
  active: string | null // the commit whose lines are highlighted (hovered or focused, else chosen)
  chosen: string | null // the commit of the chunk clicked
  onHover: (sha: string | null) => void
  onChoose: (sha: string) => void
}

interface RowProps {
  row: BlameRow
  commit: BlameCommit
  color: string | undefined
  current: boolean
  onHover: (sha: string | null) => void
  onChoose: (sha: string) => void
}

const Row = memo(function Row({ row: r, commit: c, color, current, onHover, onChoose }: RowProps) {
  return (
    <div className={`bl-line ${r.first ? 'first' : ''}`} data-sha={r.sha} onMouseEnter={() => onHover(r.sha)} onClick={() => onChoose(r.sha)}>
      <span className="bl-heat" style={{ background: color }} />
      <span className="bl-info">
        {r.first && (
          <button className="bl-commit" title={`${c.sha.slice(0, 7)} ${c.subject}`} aria-current={current || undefined} onFocus={() => onHover(r.sha)} onBlur={() => onHover(null)}>
            <span className="avatar sm" style={{ background: colorFor(c.author) }}>
              {initials(c.author)}
            </span>
            <span className="mono sha">{c.sha.slice(0, 7)}</span>
            <span className="bl-msg">{c.subject}</span>
            <span className="bl-age">{relativeDate(c.date)}</span>
          </button>
        )}
      </span>
      <span className="bl-no">{r.n}</span>
      <span className="bl-code">{r.text}</span>
    </div>
  )
})

// The file with, on the first line of each chunk, the commit that last changed it; the bar on the left is its age.
// The highlight of the active commit is a CSS rule on `data-sha` (a sha is hex, safe in a selector): hovering re-renders
// no row.
export function BlameView({ blame, active, chosen, onHover, onChoose }: Props) {
  const [all, setAll] = useState(false)
  const heat = useMemo(() => heatOf(Object.values(blame.commits)), [blame])
  const rows = useMemo(() => blameRows(blame, all ? Infinity : MAX_ROWS), [blame, all])
  const lines = useMemo(
    () => rows.map((r) => <Row key={r.n} row={r} commit={blame.commits[r.sha]} color={heat.get(r.sha)} current={r.first && r.sha === chosen} onHover={onHover} onChoose={onChoose} />),
    [rows, blame, heat, chosen, onHover, onChoose]
  )

  return (
    <div className="blame" onMouseLeave={() => onHover(null)}>
      {active && /^[0-9a-f]+$/.test(active) && (
        <style>{`.bl-line[data-sha="${active}"] { background: color-mix(in srgb, var(--amber) 7%, transparent); } .bl-line[data-sha="${active}"] :is(.bl-msg, .bl-code) { color: var(--text); }`}</style>
      )}
      {rows.length === 0 && <span className="faint bl-empty">Empty file.</span>}
      {lines}
      {rows.length < blame.lines.length && (
        <button className="btn bl-all" onClick={() => setAll(true)}>
          Show all {blame.lines.length} lines
        </button>
      )}
    </div>
  )
}
