import type { Commit } from '../../shared/types'

export interface GraphNode {
  sha: string
  parents: string[]
  wip?: boolean // the uncommitted-changes row: its edges are drawn dashed
  dashed?: boolean // a commit not pushed yet: only the edges to its parents are dashed
}

// One piece of line inside a row, in lane numbers. y: top = 0, dot = middle, bottom = row height.
// 'through': top of `from` to bottom of `to` (from === to: lanes never move sideways).
// 'top': top of `from` to the dot (a child line arriving). 'bottom': the dot to the bottom of `to` (a parent line leaving).
export interface Segment {
  kind: 'through' | 'top' | 'bottom'
  from: number
  to: number
  color: number
  dashed: boolean
}

export interface GraphRow {
  lane: number
  color: number
  segments: Segment[]
  width: number // lanes used by this row
}

// Lays out commits listed newest first in topological order (`git log --topo-order`).
// A lane waits for one sha; a commit takes the leftmost lane waiting for it, the other waiting lanes merge into it.
// Its first parent continues in the same lane, other parents get a free lane (or join the lane already waiting).
// Parents outside the list (history cap) end the line.
export function layoutGraph(nodes: GraphNode[]): GraphRow[] {
  const known = new Set(nodes.map((n) => n.sha))
  const lanes: (string | null)[] = []
  const colors: number[] = []
  const dashed: boolean[] = []
  let nextColor = 0
  const free = () => {
    const i = lanes.indexOf(null)
    return i < 0 ? lanes.length : i
  }
  return nodes.map((n) => {
    const segments: Segment[] = []
    let lane = lanes.indexOf(n.sha)
    const hasChild = lane >= 0
    if (!hasChild) {
      lane = free()
      lanes[lane] = n.sha
      colors[lane] = nextColor++
      dashed[lane] = false
    }
    for (let c = 0; c < lanes.length; c++) {
      if (lanes[c] === null) continue
      if (lanes[c] !== n.sha) segments.push({ kind: 'through', from: c, to: c, color: colors[c], dashed: dashed[c] })
      else if (c !== lane || hasChild) segments.push({ kind: 'top', from: c, to: lane, color: colors[c], dashed: dashed[c] })
      if (c !== lane && lanes[c] === n.sha) lanes[c] = null
    }
    const color = colors[lane]
    lanes[lane] = null // the first parent takes it back below
    n.parents
      .filter((p) => known.has(p))
      .forEach((p, i) => {
        let target = i === 0 ? lane : lanes.indexOf(p)
        if (target < 0) {
          target = free()
          colors[target] = nextColor++
        }
        if (lanes[target] !== p) {
          lanes[target] = p
          dashed[target] = !!(n.wip || n.dashed)
        }
        segments.push({ kind: 'bottom', from: lane, to: target, color: colors[target], dashed: !!(n.wip || n.dashed) })
      })
    while (lanes.length && lanes[lanes.length - 1] === null) {
      lanes.pop()
      colors.pop()
      dashed.pop()
    }
    const width = Math.max(lane, ...segments.map((s) => Math.max(s.from, s.to))) + 1
    return { lane, color, segments, width }
  })
}

// Strict ancestors of `head` among the loaded commits: where "Rebase interactively from here" is possible.
export function ancestorsOf(head: string | null, commits: Commit[]): Set<string> {
  const parents = new Map(commits.map((c) => [c.sha, c.parents]))
  const out = new Set<string>()
  const todo = [...((head && parents.get(head)) || [])]
  while (todo.length) {
    const sha = todo.pop()!
    if (out.has(sha)) continue
    out.add(sha)
    todo.push(...(parents.get(sha) ?? []))
  }
  return out
}

export type SearchField = 'all' | 'message' | 'author' | 'sha'

// Indexes of the commits matching the query (case-insensitive; SHA matches by prefix).
export function searchCommits(commits: Commit[], query: string, field: SearchField): number[] {
  const q = query.trim().toLowerCase()
  if (!q) return []
  const out: number[] = []
  commits.forEach((c, i) => {
    const hit =
      ((field === 'all' || field === 'message') && c.subject.toLowerCase().includes(q)) ||
      ((field === 'all' || field === 'author') && c.author.toLowerCase().includes(q)) ||
      ((field === 'all' || field === 'sha') && c.sha.startsWith(q))
    if (hit) out.push(i)
  })
  return out
}

// Splits text around the first case-insensitive occurrence of the query, for <mark>; null when absent.
export function splitMatch(text: string, query: string): [before: string, match: string, after: string] | null {
  const q = query.trim().toLowerCase()
  const i = q ? text.toLowerCase().indexOf(q) : -1
  return i < 0 ? null : [text.slice(0, i), text.slice(i, i + q.length), text.slice(i + q.length)]
}
