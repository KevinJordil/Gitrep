import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { Branch, Commit, GraphScope, RepoStatus, ResetMode, Stash, Tag, UndoState } from '../../shared/types'
import { api } from './api'
import { ChangesPanel } from './ChangesPanel'
import { CommitMenu, type CommitAction } from './CommitMenu'
import { CommitPanel } from './CommitPanel'
import { PromptDialog } from './Dialog'
import { DiffView } from './DiffView'
import type { DropBranch } from './dnd'
import { errorText } from './format'
import { Graph } from './Graph'
import { layoutGraph, type GraphNode } from './graph'
import { Icon, type IconName } from './icons'
import { MergeMenu } from './MergeMenu'
import type { Focus, RunOp, RunOutcome, Selection } from './model'
import { OperationBanner } from './OperationBanner'
import { Sidebar } from './Sidebar'
import { StashDialog, StashPanel, StashView } from './Stash'
import { useToast } from './toast'

const ALL: GraphScope = { only: null, hidden: [] }
const WIP = 'WIP' // sha of the work-in-progress graph row (never a real sha)
const CONFLICTS = 'Stopped on conflicts: resolve them, stage the files, then click Continue'

interface Props {
  path: string
  active: boolean
  onBranch: (path: string, label: string) => void
}

export function RepoView({ path, active, onBranch }: Props) {
  const notify = useToast()
  const [status, setStatus] = useState<RepoStatus | null>(null)
  const [log, setLog] = useState<Commit[]>([])
  const [branches, setBranches] = useState<Branch[]>([])
  const [tags, setTags] = useState<Tag[]>([])
  const [stashes, setStashes] = useState<Stash[]>([])
  const [undo, setUndo] = useState<UndoState>({ undo: null, redo: null })
  const [focus, setFocus] = useState<Focus>({ kind: 'wip' })
  const [scope, setScope] = useState<GraphScope>(ALL)
  const [selection, setSelection] = useState<Selection | null>(null)
  const [menu, setMenu] = useState<{ commit: Commit; x: number; y: number } | null>(null)
  const [dialog, setDialog] = useState<ReactNode>(null)
  const [drop, setDrop] = useState<{ source: Branch; target: Branch; x: number; y: number } | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [version, setVersion] = useState(0)
  const lastError = useRef('')
  const lastStatus = useRef('')

  const report = useCallback(
    (e: unknown) => {
      const text = errorText(e)
      if (text !== lastError.current) notify('error', text)
      lastError.current = text
    },
    [notify]
  )

  // force: reload even when the status JSON is unchanged (an open diff may be stale). Polls do not force.
  const refreshStatus = useCallback(async (force = false) => {
    try {
      const s = await api.status(path)
      lastError.current = ''
      const json = JSON.stringify(s)
      if (!force && json === lastStatus.current) return
      lastStatus.current = json
      setStatus(s)
      setVersion((v) => v + 1)
      onBranch(path, s.branch ?? 'Detached HEAD')
    } catch (e) {
      report(e)
    }
  }, [path, onBranch, report])

  const request = useRef(0)
  // Keeps the previous object when the new one is JSON-equal, so memoized children do not re-render.
  const same = <T,>(next: T) => (prev: T) => (JSON.stringify(prev) === JSON.stringify(next) ? prev : next)

  const refreshAll = useCallback(async () => {
    const id = ++request.current
    await refreshStatus(true)
    try {
      const [l, b, t, s, u] = await Promise.all([api.log(path, scope), api.branches(path), api.tags(path), api.stashes(path), api.undoState(path)])
      if (id !== request.current) return // a newer load started; its result wins
      setLog(same(l))
      setBranches(same(b))
      setTags(same(t))
      setStashes(same(s))
      setUndo(same(u))
    } catch (e) {
      report(e)
    }
  }, [path, scope, refreshStatus, report])

  // A deleted branch must not stay isolated or hidden.
  useEffect(() => {
    if (!branches.length) return
    const names = new Set(branches.map((b) => b.name))
    setScope((s) => {
      const only = s.only && names.has(s.only) ? s.only : null
      const current = branches.find((b) => b.current)?.name
      const hidden = s.hidden.filter((h) => names.has(h) && h !== current)
      return only === s.only && hidden.length === s.hidden.length ? s : { only, hidden }
    })
  }, [branches])

  // A popped or dropped stash leaves the view.
  useEffect(() => {
    if (focus.kind === 'stash' && !stashes.some((s) => s.sha === focus.sha)) setFocus({ kind: 'wip' })
  }, [focus, stashes])

  useEffect(() => {
    if (active) void refreshAll()
  }, [active, refreshAll])

  useEffect(() => {
    if (!active) return
    const timer = setInterval(() => {
      if (document.hasFocus()) void refreshStatus()
    }, 5000)
    const off = api.onRepoChanged((r) => {
      if (r === path) void refreshAll()
    })
    const onFocus = () => void refreshAll()
    window.addEventListener('focus', onFocus)
    return () => {
      clearInterval(timer)
      off()
      window.removeEventListener('focus', onFocus)
    }
  }, [active, path, refreshAll, refreshStatus])

  // Keep the open diff on the file when it moves between staged and unstaged; close it when the file is clean.
  useEffect(() => {
    if (!selection || !status || selection.commit) return
    const inStaged = status.staged.find((f) => f.path === selection.path)
    const inUnstaged = status.unstaged.find((f) => f.path === selection.path)
    const here = selection.side === 'staged' ? inStaged : inUnstaged
    if (here) return
    if (selection.side !== 'staged' && inStaged) setSelection({ path: selection.path, side: 'staged' })
    else if (selection.side === 'staged' && inUnstaged) setSelection({ path: selection.path, side: inUnstaged.status === '?' ? 'untracked' : 'unstaged' })
    else setSelection(null)
  }, [status, selection])

  const run = useCallback<RunOp>(
    async (label, fn, done) => {
      setBusy(label)
      try {
        await fn()
        if (done) notify('info', done)
        return true
      } catch (e) {
        notify('error', errorText(e))
        return false
      } finally {
        setBusy(null)
        void refreshAll()
      }
    },
    [notify, refreshAll]
  )

  const focusOn = useCallback((f: Focus) => {
    setFocus(f)
    setSelection(null)
  }, [])
  // On conflicts, show the changes panel: its Conflicts group lists the files to resolve and stage.
  const runOutcome = useCallback<RunOutcome>(
    (label, fn, done) =>
      run(label, async () => {
        const conflicts = (await fn()) === 'conflicts'
        if (conflicts) focusOn({ kind: 'wip' })
        notify('info', conflicts ? CONFLICTS : done)
      }),
    [run, notify, focusOn]
  )
  // The toast says what was undone and offers the opposite move.
  const replay = useCallback(
    (dir: 'undo' | 'redo'): void => {
      void run(dir, async () => {
        const back = dir === 'undo' ? 'redo' : 'undo'
        notify('info', await api[dir](path), { label: back === 'redo' ? 'Redo' : 'Undo', run: () => replay(back) })
      })
    },
    [path, run, notify]
  )

  // Ctrl+Z, Ctrl+Shift+Z and Ctrl+Y in the active tab, except while typing or in a dialog.
  useEffect(() => {
    if (!active) return
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey) return
      const key = e.key.toLowerCase()
      const dir = key === 'z' ? (e.shiftKey ? 'redo' : 'undo') : key === 'y' && !e.shiftKey ? 'redo' : null
      if (!dir || (e.target as HTMLElement).closest?.('input, textarea, select, [contenteditable], dialog') || document.querySelector('dialog[open], [role="dialog"], [role="menu"]')) return
      e.preventDefault()
      if (!busy && undo[dir]) replay(dir)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [active, busy, undo, replay])

  const openMenu = useCallback((commit: Commit, x: number, y: number) => setMenu({ commit, x, y }), [])
  const closeMenu = useCallback(() => setMenu(null), [])
  const openDrop = useCallback<DropBranch>((source, target, x, y) => setDrop({ source, target, x, y }), [])
  const closeDrop = useCallback(() => setDrop(null), [])
  const closeDialog = () => setDialog(null)

  const newBranch = (at: string, label: string) =>
    setDialog(
      <PromptDialog
        title={`Create a branch at ${label}`}
        label="Branch name"
        submit="Create branch"
        checkbox="Check out the new branch"
        onSubmit={(name, _long, checkout) => run('branch', () => api.createBranch(path, name, at, checkout), `Branch ${name} created`)}
        onClose={closeDialog}
      />
    )

  const onCommitAction = (c: Commit, a: CommitAction) => {
    const short = c.sha.slice(0, 7)
    const target = status?.branch ?? 'HEAD'
    if (a === 'checkout') void run('checkout', () => api.checkoutCommit(path, c.sha), `Checked out ${short} (detached HEAD)`)
    else if (a === 'branch') newBranch(c.sha, short)
    else if (a === 'tag')
      setDialog(
        <PromptDialog
          title={`Create a tag at ${short}`}
          label="Tag name"
          submit="Create tag"
          textarea="Message (optional, makes an annotated tag)"
          onSubmit={(name, message) => run('tag', () => api.createTag(path, name, c.sha, message), `Tag ${name} created`)}
          onClose={closeDialog}
        />
      )
    else if (a === 'cherry-pick') void runOutcome('cherry-pick', () => api.cherryPick(path, c.sha), `Cherry-picked ${short} onto ${target}`)
    else if (a === 'revert') void runOutcome('revert', () => api.revert(path, c.sha), `Reverted ${short}`)
    else if (a === 'copy') api.copyText(c.sha).then(() => notify('info', `Copied ${short}`), (e: unknown) => notify('error', errorText(e)))
    else if (a === 'explain') focusOn({ kind: 'commit', sha: c.sha, explain: Date.now() })
    else {
      const mode = a.slice('reset-'.length) as ResetMode
      if (mode === 'hard' && !window.confirm(`Reset ${target} to ${short} and discard all uncommitted changes? Undo (Ctrl+Z) brings them back while GitRep is open.`)) return
      void run('reset', () => api.reset(path, c.sha, mode), `${target} reset to ${short} (${mode})`)
    }
  }

  const changes = status ? status.staged.length + status.unstaged.length + status.conflicted.length : 0
  const hasWip = changes > 0
  const head = status?.head ?? null
  const nodes = useMemo<GraphNode[]>(() => (hasWip ? [{ sha: WIP, parents: head ? [head] : [], wip: true }, ...log] : log), [log, hasWip, head])
  const rows = useMemo(() => layoutGraph(nodes), [nodes])
  const colors = useMemo(() => new Map(nodes.map((n, i) => [n.sha, rows[i].color])), [nodes, rows])
  const remoteNames = useMemo(() => new Set(branches.filter((b) => b.remote).map((b) => b.name)), [branches])
  const staged = status?.staged.length ?? 0
  const wipLabel = hasWip ? `${changes} modified file${changes === 1 ? '' : 's'}${staged ? ` · ${staged} staged` : ''}` : null
  const branchLabel = status ? (status.branch ?? `Detached HEAD (${status.head?.slice(0, 7) ?? '?'})`) : '…'
  const stash = focus.kind === 'stash' ? stashes.find((s) => s.sha === focus.sha) : undefined
  const stashBranch = (s: Stash) =>
    setDialog(
      <PromptDialog
        title={`Create a branch from "${s.message}"`}
        label="Branch name"
        submit="Create branch"
        onSubmit={(name) => runOutcome('branch', () => api.stashBranch(path, s.sha, name), `Branch ${name} created from the stash`)}
        onClose={closeDialog}
      />
    )
  const openCode = () => api.openInCode(path).catch((e: unknown) => notify('error', errorText(e)))
  // git refuses to delete a branch that is not merged: ask, then force.
  const deleteBranch = (b: Branch) =>
    void run('delete', async () => {
      try {
        await api.deleteBranch(path, b.name, false)
      } catch (e) {
        if (!errorText(e).includes('not fully merged')) throw e
        if (!window.confirm(`${b.name} is not fully merged. Delete it anyway? Ctrl+Z can restore it while GitRep is open.`)) return
        await api.deleteBranch(path, b.name, true)
      }
      notify('info', `Branch ${b.name} deleted`)
    })

  return (
    <>
      <div className="toolbar">
        <span className="branch-pill">
          <Icon name="branch" size={16} stroke={2} />
          {branchLabel}
        </span>
        <ToolButton icon="undo" label="Undo" title={undo.undo ? `Undo ${undo.undo}` : 'Nothing to undo'} busy={busy === 'undo'} disabled={!!busy || !undo.undo} onClick={() => replay('undo')} />
        <ToolButton icon="redo" label="Redo" title={undo.redo ? `Redo ${undo.redo}` : 'Nothing to redo'} busy={busy === 'redo'} disabled={!!busy || !undo.redo} onClick={() => replay('redo')} />
        <div className="tsep" />
        <ToolButton icon="fetch" label="Fetch" busy={busy === 'fetch'} disabled={!!busy} onClick={() => void run('fetch', () => api.fetch(path), 'Fetch complete')} />
        <ToolButton icon="pull" label="Pull" count={status?.behind ? `↓${status.behind}` : ''} busy={busy === 'pull'} disabled={!!busy} onClick={() => void runOutcome('pull', () => api.pull(path), 'Pull complete')} />
        <ToolButton icon="push" label="Push" count={status?.ahead ? `↑${status.ahead}` : ''} busy={busy === 'push'} disabled={!!busy} onClick={() => void run('push', () => api.push(path), 'Push complete')} />
        <div className="tsep" />
        <ToolButton icon="branch" label="Branch" busy={busy === 'branch'} disabled={!!busy || !head} onClick={() => head && newBranch(head, status?.branch ?? head.slice(0, 7))} />
        <ToolButton icon="stash" label="Stash" busy={busy === 'stash'} disabled={!!busy || !hasWip || !head} onClick={() => status && setDialog(<StashDialog repo={path} status={status} run={run} onClose={closeDialog} />)} />
        <ToolButton icon="pop" label="Pop" busy={busy === 'pop'} disabled={!!busy || !stashes.length} onClick={() => void runOutcome('pop', () => api.stashApply(path, stashes[0].sha, true), 'Stash applied and dropped')} />
        <div className="grow" />
        <button className="tbtn boxed" onClick={() => void openCode()}>
          <Icon name="code" /> VS Code
        </button>
        <button className="tbtn boxed" onClick={() => api.openTerminal(path).catch((e) => notify('error', errorText(e)))}>
          <Icon name="terminal" /> Terminal
        </button>
      </div>
      {status && <OperationBanner repo={path} status={status} busy={busy} run={run} runOutcome={runOutcome} onCode={() => void openCode()} />}
      <div className="panes">
        <Sidebar
          branches={branches}
          tags={tags}
          stashes={stashes}
          colors={colors}
          focus={focus}
          scope={scope}
          onFocus={focusOn}
          onScope={setScope}
          onDrop={openDrop}
          onDelete={deleteBranch}
          onSwitch={(b) => void run('switch', () => api.switchBranch(path, b.name, b.remote), `Switched to branch ${b.remote ? b.name.replace(/^[^/]+\//, '') : b.name}`)}
        />
        <section className="center">
          {selection ? (
            <DiffView key={`${selection.path}:${selection.side ?? selection.commit}`} repo={path} selection={selection} version={version} onBack={() => setSelection(null)} run={run} />
          ) : stash ? (
            <StashView key={stash.sha} repo={path} stash={stash} version={version} run={run} onBack={() => focusOn({ kind: 'wip' })} />
          ) : (
            <Graph
              repoName={path.split('/').pop() ?? path}
              active={active}
              commits={log}
              rows={rows}
              wip={wipLabel}
              head={head}
              focus={focus}
              branches={branches}
              scope={scope}
              remoteNames={remoteNames}
              onFocus={focusOn}
              onScope={setScope}
              onMenu={openMenu}
              onDrop={openDrop}
            />
          )}
        </section>
        {stash ? (
          <StashPanel key={stash.sha} repo={path} stash={stash} branch={status?.branch ?? null} busy={busy} run={run} runOutcome={runOutcome} onNewBranch={() => stashBranch(stash)} />
        ) : focus.kind === 'commit' ? (
          <CommitPanel key={`${focus.sha}:${focus.explain ?? ''}`} repo={path} sha={focus.sha} autoExplain={!!focus.explain} selection={selection} colors={colors} remoteNames={remoteNames} onSelect={setSelection} onFocus={focusOn} />
        ) : (
          <ChangesPanel repo={path} status={status} selection={selection} onSelect={setSelection} run={run} busy={busy} />
        )}
      </div>
      {menu && <CommitMenu commit={menu.commit} x={menu.x} y={menu.y} branch={status?.branch ?? null} head={head} onAction={(a) => onCommitAction(menu.commit, a)} onClose={closeMenu} />}
      {drop && <MergeMenu key={`${drop.source.name}>${drop.target.name}`} repo={path} source={drop.source} target={drop.target} status={status} x={drop.x} y={drop.y} runOutcome={runOutcome} onClose={closeDrop} />}
      {dialog}
    </>
  )
}

interface ToolButtonProps {
  icon: IconName
  label: string
  title?: string
  count?: string
  busy: boolean
  disabled: boolean
  onClick: () => void
}

function ToolButton({ icon, label, title, count, busy, disabled, onClick }: ToolButtonProps) {
  return (
    <button className="tbtn" title={title} disabled={disabled} onClick={onClick}>
      {busy ? <span className="spin" /> : <Icon name={icon} />}
      <span>{label}</span>
      {count ? <span className="count">{count}</span> : null}
    </button>
  )
}
