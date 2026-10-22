import { useEffect, useMemo, useState } from 'react'
import type { DiffSide, FileDiff, Hunk, LineAction } from '../../shared/types'
import { api } from './api'
import { changeGroups, errorText, splitPath } from './format'
import { fullListing } from './fullListing'
import { FileEditor } from './FileEditor'
import { langFor } from './fileTypes'
import type { Token } from './highlight'
import { Icon } from './icons'
import type { FileView, RunOp, Selection } from './model'
import { useToast } from './toast'
import { useLeaveGuard } from './unsaved'

const MAX_LINES = 4000
let rememberedFull = false // the setting, kept for the next file
const SIDE_LABEL = { unstaged: 'Unstaged', staged: 'Staged', untracked: 'Untracked' } as const

interface Props {
  repo: string
  selection: Selection
  version: number
  onBack: () => void
  run: RunOp
  onChanged?: () => void // the working tree changed behind the repository watcher (a saved edit): refresh
  gone?: boolean // the file no longer has changes in git (an editor with unsaved edits stays open)
  hideHead?: boolean // the parent shows its own header (stash view, file history)
  onFile?: (path: string, rev: string | null, view: FileView) => void // opens the file's history or blame (at this commit, or HEAD)
}

export function DiffView({ repo, selection, version, onBack, run, onChanged, gone = false, hideHead = false, onFile }: Props) {
  const notify = useToast()
  const { path } = selection
  const commit = selection.commit ?? null // a file of a commit: read-only
  const oldPath = selection.commit ? (selection.oldPath ?? null) : null
  const side: DiffSide = selection.side ?? 'unstaged'
  const [diff, setDiff] = useState<FileDiff | null | undefined>(undefined)
  const [picked, setPicked] = useState<Record<number, number[]>>({})
  const [showAll, setShowAll] = useState(false)
  const [full, setFull] = useState(rememberedFull)
  useEffect(() => {
    api.getConfig().then((c) => setFull((rememberedFull = c.settings.diffFullFile)), () => undefined)
  }, [])
  const setFullFile = (on: boolean) => {
    setFull((rememberedFull = on))
    api.updateSettings({ diffFullFile: on }).catch((e: unknown) => notify('error', errorText(e)))
  }
  // The whole file for Full file: the new side, the old one for a deleted file. `key` tells whose content it is.
  const wholeKey = `${repo}\0${path}\0${side}\0${commit ?? ''}`
  const [whole, setWhole] = useState<{ key: string; text?: string; reason?: string } | null>(null)
  const deleted = !!diff?.isDeleted
  useEffect(() => {
    if (!full || !diff || diff.binary) return
    const deleted = diff.isDeleted
    let alive = true
    const at = commit ? (deleted ? `${commit}^` : commit) : deleted ? (side === 'staged' ? 'HEAD' : 'index') : side === 'staged' ? 'index' : 'worktree'
    api.fileAtSide(repo, path, at).then(
      (r) => alive && setWhole({ key: wholeKey, ...r }),
      (e: unknown) => alive && (setWhole({ key: wholeKey, reason: errorText(e) }), notify('error', errorText(e)))
    )
    return () => {
      alive = false
    }
  }, [full, diff, repo, path, side, commit, version, wholeKey, notify])
  const text = full && whole?.key === wholeKey ? whole.text : undefined
  const segments = useMemo(() => (diff ? (text === undefined ? diff.hunks.map((hunk, index) => ({ index: index as number | null, hunk })) : fullListing(text, diff.hunks, deleted ? 'old' : 'new')) : []), [diff, text, deleted])
  const listed = useMemo(() => (diff ? { ...diff, hunks: segments.map((s) => s.hunk) } : diff), [diff, segments])
  const colored = useHighlight(listed, path)
  const { guard, dialog: leaveDialog } = useLeaveGuard()
  // Edit mode: the working file as opened (a new `n` reloads the editor), and why it cannot be edited, if it cannot.
  const editable = !commit && !hideHead
  const [opened, setOpened] = useState<{ text: string; n: number } | null>(null)
  const [reason, setReason] = useState<string | null>(null)
  useEffect(() => {
    if (!editable || opened) return
    let alive = true
    api.workingFileReason(repo, path).then((r) => alive && setReason(r), () => undefined)
    return () => {
      alive = false
    }
  }, [editable, opened, repo, path, version])
  const openEditor = async () => {
    try {
      const r = await api.readWorkingFile(repo, path)
      if ('reason' in r) {
        setReason(r.reason)
        notify('error', r.reason)
      } else setOpened((o) => ({ text: r.text, n: (o?.n ?? 0) + 1 }))
    } catch (e) {
      notify('error', errorText(e))
    }
  }

  useEffect(() => {
    setDiff(undefined)
    setShowAll(false)
  }, [side])
  useEffect(() => {
    let alive = true
    const load = commit ? api.commitDiff(repo, commit, path, oldPath) : api.diff(repo, path, side)
    load
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
  }, [repo, path, side, commit, oldPath, version, notify])

  const partial = !commit && !!diff && !diff.binary && !diff.isNew && !diff.isDeleted && side !== 'untracked'
  const primary: LineAction = side === 'staged' ? 'unstage' : 'stage'
  const primaryVerb = primary === 'stage' ? 'Stage' : 'Unstage'

  // hunk === null → apply the checkbox selection (bottom-up so earlier hunk positions stay valid).
  const apply = async (action: LineAction, hunk: number | null, lines: number[] | null) => {
    if (!diff) return
    if (action === 'discard' && !window.confirm('Discard these changes? Ctrl+Z can bring them back while GitRep is open (not for very large changes).')) return
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
  let used = 0
  const shown = segments
    .map((s, at) => ({ ...s, at }))
    .filter(({ hunk, at }) => {
      used += hunk.lines.length
      return showAll || at === 0 || used <= MAX_LINES
    })
  const fullToggle = (
    <div className="seg" role="group" aria-label="Whole file">
      <button aria-pressed={full} title="Show every line of the file around the changes" onClick={() => setFullFile(!full)}>
        Full file
      </button>
    </div>
  )
  const [dir, name] = splitPath(path)

  return (
    <>
      {!hideHead && (
        <div className="pane-head">
          <button className="tbtn boxed" onClick={onBack}>
            <Icon name="back" size={14} stroke={2} /> History
          </button>
          <span className="mono">
            <span className="faint">{dir}</span>
            {name}
          </span>
          {commit ? <span className="badge grey">{commit.slice(0, 7)}</span> : <span className={`badge ${side === 'staged' ? 'blue' : 'amber'}`}>{SIDE_LABEL[side]}</span>}
          {editable && (
            <div className="seg" role="group" aria-label="Diff or edit">
              <button aria-pressed={!opened} onClick={() => opened && guard(repo, () => setOpened(null))}>
                Diff
              </button>
              <button aria-pressed={!!opened} disabled={!opened && reason !== null} title={reason ?? undefined} onClick={() => !opened && void openEditor()}>
                Edit
              </button>
            </div>
          )}
          {!opened && fullToggle}
          <div className="grow" />
          {onFile && side !== 'untracked' && (
            <>
              <button className="head-btn" onClick={() => onFile(path, commit, 'diff')}>
                File history
              </button>
              <button className="head-btn" onClick={() => onFile(path, commit, 'blame')}>
                Blame
              </button>
            </>
          )}
        </div>
      )}
      {leaveDialog}
      {opened ? (
        <FileEditor key={opened.n} repo={repo} path={path} initial={opened.text} version={version} gone={gone} onSaved={onChanged} onReload={() => void openEditor()} />
      ) : (
      <div className={`diff-body ${text === undefined ? '' : 'full'}`}>
        {hideHead && <div style={{ alignSelf: 'flex-start' }}>{fullToggle}</div>}
        {full && whole?.key === wholeKey && whole.reason && <div className="banner">{whole.reason}</div>}
        {diff === undefined && <span className="faint">Loading…</span>}
        {diff === null && <span className="faint">No changes to display.</span>}
        {diff && oldPath && (
          <div className="banner">
            Renamed from <span className="mono">{oldPath}</span>
          </div>
        )}
        {diff?.binary && <div className="banner">Binary file: no preview.</div>}
        {diff && !diff.binary && !partial && !commit && <div className="banner">This file can only be staged as a whole: use the buttons in the right panel.</div>}
        {shown.map(({ hunk: h, index: i, at }) => (
          <section key={`${at}:${h.header}`} className="hunk">
            {i !== null && (
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
            )}
            <Lines hunk={h} index={i ?? -1} tokens={colored?.[at]} partial={partial && i !== null} verb={primaryVerb} icon={primary === 'stage' ? 'plus' : 'minus'} picked={picked[i ?? -1] ?? []} onToggle={toggle} onGroup={(lines) => void apply(primary, i ?? -1, lines)} />
          </section>
        ))}
        {shown.length < segments.length && (
          <button className="btn" style={{ alignSelf: 'flex-start' }} onClick={() => setShowAll(true)}>
            Show {segments.length - shown.length} remaining {text === undefined ? 'hunks' : 'parts of the file'}
          </button>
        )}
      </div>
      )}
      {!opened && pickedCount > 0 && (
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

// Syntax colors of the diff, computed after the plain diff is shown; null until then, or without a grammar.
export function useHighlight(diff: FileDiff | null | undefined, path: string): (Token[] | null)[][] | null {
  const [done, setDone] = useState<{ diff: FileDiff; lines: (Token[] | null)[][] } | null>(null)
  useEffect(() => {
    const lang = langFor(path)
    if (!diff || diff.binary || !lang) return
    let alive = true
    // Shiki loads with the first diff, not at startup. A grammar that fails to load leaves the diff plain.
    import('./highlight')
      .then((m) => m.highlightDiff(diff.hunks, lang))
      .then((lines) => alive && lines && setDone({ diff, lines }), () => undefined)
    return () => {
      alive = false
    }
  }, [diff, path])
  return done && done.diff === diff ? done.lines : null
}

export function Code({ tokens }: { tokens: Token[] }) {
  return (
    <>
      {tokens.map((t, i) => (
        <span key={i} style={t.color || t.italic ? { color: t.color, fontStyle: t.italic ? 'italic' : undefined } : undefined}>
          {t.text}
        </span>
      ))}
    </>
  )
}

interface LinesProps {
  hunk: Hunk
  index: number
  tokens?: (Token[] | null)[] // syntax colors of each line, when ready
  partial: boolean
  verb: string
  icon: 'plus' | 'minus'
  picked: number[]
  onToggle: (hunk: number, line: number) => void
  onGroup: (lines: number[]) => void
}

function Lines({ hunk, index, tokens, partial, verb, icon, picked, onToggle, onGroup }: LinesProps) {
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
            <span className="t">{tokens?.[i] ? <Code tokens={tokens[i]!} /> : l.text}</span>
          </div>
        )
      })}
    </div>
  )
}
