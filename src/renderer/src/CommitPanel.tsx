import { useEffect, useState } from 'react'
import type { CommitDetails, Explanation } from '../../shared/types'
import { api } from './api'
import { fileMenuProps } from './FileMenu'
import { colorFor, errorText, initials, laneColor, splitPath } from './format'
import { RefPill } from './Graph'
import { FileIcon, StatusBadge } from './FileIcon'
import { Icon } from './icons'
import type { Focus, Selection } from './model'
import { useToast } from './toast'

interface Props {
  repo: string
  sha: string
  autoExplain: boolean // ask Claude as soon as the panel opens
  selection: Selection | null
  colors: ReadonlyMap<string, number>
  remoteNames: ReadonlySet<string>
  onSelect: (s: Selection) => void
  onFocus: (f: Focus) => void
  onFileMenu: (path: string, rev: string, x: number, y: number) => void
}

export function CommitPanel({ repo, sha, autoExplain, selection, colors, remoteNames, onSelect, onFocus, onFileMenu }: Props) {
  const notify = useToast()
  const [details, setDetails] = useState<CommitDetails | null>(null)

  useEffect(() => {
    let alive = true
    api
      .commitDetails(repo, sha)
      .then((d) => alive && setDetails(d))
      .catch((e: unknown) => notify('error', errorText(e)))
    return () => {
      alive = false
    }
  }, [repo, sha, notify])

  const copy = () =>
    api
      .copyText(sha)
      .then(() => notify('info', `Copied ${sha.slice(0, 7)}`))
      .catch((e: unknown) => notify('error', errorText(e)))

  if (!details)
    return (
      <aside className="right">
        <div className="right-head">
          <span className="faint">Loading…</span>
        </div>
      </aside>
    )
  const color = laneColor(colors.get(sha) ?? 1)
  const merge = details.parents.length > 1
  return (
    <aside className="right commit-panel">
      <div className="cp-head">
        <div className="cp-line">
          <span className="cp-sha">{sha.slice(0, 7)}</span>
          <button className="iconbtn sm" aria-label="Copy the full SHA" title="Copy SHA" onClick={() => void copy()}>
            <Icon name="copy" size={12} stroke={2} />
          </button>
          <div className="grow" />
          {details.refs.map((r) => (
            <RefPill key={r} text={r} color={color} remoteNames={remoteNames} />
          ))}
          <button className="tab-close" aria-label="Close the commit details" title="Back to the changes" onClick={() => onFocus({ kind: 'wip' })}>
            <Icon name="close" size={12} stroke={2} />
          </button>
        </div>
        <span className="cp-subject">{details.subject}</span>
        {details.body && <span className="cp-body">{details.body}</span>}
        <div className="cp-author">
          <span className="avatar lg" style={{ background: colorFor(details.author) }}>
            {initials(details.author)}
          </span>
          <span>{details.author}</span>
          <span className="faint">· {new Date(details.date * 1000).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })}</span>
        </div>
        {details.parents.length > 0 && (
          <span className="cp-parents">
            {merge ? 'Parents' : 'Parent'}
            {details.parents.map((p) => (
              <button key={p} className="link mono" onClick={() => onFocus({ kind: 'commit', sha: p })}>
                {p.slice(0, 7)}
              </button>
            ))}
          </span>
        )}
      </div>
      <Explain repo={repo} sha={sha} auto={autoExplain} />
      <div className="cp-files">
        <span className="cp-files-title">
          {details.files.length} file{details.files.length === 1 ? '' : 's'} changed{merge ? ' (against the first parent)' : ''}
        </span>
        {details.files.map((f) => {
          const [dir, name] = splitPath(f.path)
          return (
            <button
              key={f.path}
              className={`file ${selection?.commit === sha && selection.path === f.path ? 'sel' : ''}`}
              title={f.path}
              onClick={() => onSelect({ path: f.path, commit: sha })}
              {...fileMenuProps((x, y) => onFileMenu(f.path, sha, x, y))}
            >
              <StatusBadge status={f.status} />
              <FileIcon path={f.path} />
              <span className="path">
                <span className="faint">{dir}</span>
                {name}
              </span>
              {f.add ? <span className="add-n">+{f.add}</span> : null}
              {f.del ? <span className="del-n">−{f.del}</span> : null}
            </button>
          )
        })}
      </div>
    </aside>
  )
}

// "Explain this commit": asks Claude on click, or at once when `auto` (key it by sha: the answer belongs to one commit).
export function Explain({ repo, sha, auto = false }: { repo: string; sha: string; auto?: boolean }) {
  const notify = useToast()
  const [explanation, setExplanation] = useState<Explanation | null>(null)
  const [thinking, setThinking] = useState(false)

  const explain = async () => {
    setThinking(true)
    try {
      setExplanation(await api.explainCommit(repo, sha))
    } catch (e) {
      notify('error', errorText(e))
    } finally {
      setThinking(false)
    }
  }
  // Opened from the context menu's "Explain with Claude" (the panel is re-created for each request).
  useEffect(() => {
    if (auto) void explain()
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="cp-explain">
      <button className="btn-claude" disabled={thinking} onClick={() => void explain()}>
        {thinking ? <span className="spin" /> : <Icon name="sparkle" size={14} />}
        {thinking ? 'Claude is reading…' : 'Explain this commit'}
      </button>
      {explanation && (
        <div className="claude-box">
          {explanation.text}
          {explanation.excluded.length > 0 && <span className="note"> Not sent (sensitive): {explanation.excluded.join(', ')}.</span>}
        </div>
      )}
    </div>
  )
}
