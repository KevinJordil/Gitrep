import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import type { Commit, ResetMode } from '../../shared/types'

export type CommitAction = 'checkout' | 'branch' | 'tag' | 'cherry-pick' | 'revert' | 'copy' | 'explain' | 'rebase-i' | `reset-${ResetMode}`

const RESETS: [ResetMode, string, string][] = [
  ['soft', 'Soft', 'Keeps the changes, staged'],
  ['mixed', 'Mixed', 'Keeps the changes, unstaged'],
  ['hard', 'Hard', 'Discards uncommitted changes · can be undone']
]

// Branch-only entries shown above the commit ones when the menu opens on a branch of the sidebar.
export interface RefItem {
  label: string
  run: () => void
  disabled?: boolean
  danger?: boolean
  claude?: boolean
  hint?: string
}

interface Props {
  commit: Commit
  branchActions?: { name: string; items: RefItem[] }
  x: number
  y: number
  branch: string | null // checked-out branch, null when detached
  head: string | null
  canRebase: boolean // a strict ancestor of HEAD on a checked-out branch
  onAction: (a: CommitAction) => void
  onClose: () => void // must be stable (useCallback)
  extra?: ReactNode // more items before Copy SHA (Review with Claude… on a branch tip)
}

export function CommitMenu({ commit, branchActions, x, y, branch, head, canRebase, onAction, onClose, extra }: Props) {
  const ref = useRef<HTMLDivElement>(null)
  const [sub, setSub] = useState(false)
  const target = branch ?? 'HEAD'

  // Keyboard users keep their place: refocus what had focus before the menu opened.
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null
    return () => prev?.focus?.()
  }, [])
  // Focus never falls to <body> while the submenu opens and closes.
  const subOpened = useRef(false)
  useLayoutEffect(() => {
    const menu = ref.current
    if (!menu) return
    if (sub && subOpened.current) menu.querySelector<HTMLButtonElement>('.menu.sub [role=menuitem]')?.focus()
    if (!sub && menu.contains(document.activeElement) === false && document.activeElement === document.body) menu.querySelector<HTMLButtonElement>('[aria-haspopup]')?.focus()
  }, [sub])
  useEffect(() => {
    ref.current?.querySelector<HTMLButtonElement>('[role=menuitem]')?.focus()
    const away = (e: Event) => {
      if (!ref.current?.contains(e.target as Node)) onClose()
    }
    window.addEventListener('mousedown', away)
    window.addEventListener('wheel', away)
    window.addEventListener('blur', onClose)
    window.addEventListener('resize', onClose)
    return () => {
      window.removeEventListener('mousedown', away)
      window.removeEventListener('wheel', away)
      window.removeEventListener('blur', onClose)
      window.removeEventListener('resize', onClose)
    }
  }, [onClose])

  const actRef = (run: () => void) => {
    onClose()
    run()
  }
  const act = (a: CommitAction) => {
    onClose()
    onAction(a)
  }
  // Closing the submenu while it holds focus: move focus to the Reset button first.
  const closeSub = () => {
    if (ref.current?.querySelector('.menu.sub')?.contains(document.activeElement)) ref.current.querySelector<HTMLButtonElement>('[aria-haspopup]')?.focus()
    subOpened.current = false
    setSub(false)
  }
  const onKey = (e: KeyboardEvent) => {
    const items = [...(ref.current?.querySelectorAll<HTMLButtonElement>('[role=menuitem]:not(:disabled)') ?? [])]
    const i = items.indexOf(document.activeElement as HTMLButtonElement)
    if (e.key === 'Escape') onClose()
    else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      items[(i + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length]?.focus()
    } else if (e.key === 'ArrowRight' && document.activeElement?.getAttribute('aria-haspopup')) {
      subOpened.current = true
      setSub(true)
    } else if (e.key === 'ArrowLeft') closeSub()
    else if (e.key === 'b' && !e.ctrlKey && !e.metaKey && !e.altKey) act('branch')
    else if (e.key === 't' && !e.ctrlKey && !e.metaKey && !e.altKey) act('tag')
    else if (e.key === 'c' && (e.ctrlKey || e.metaKey)) act('copy')
  }
  // Render helper, not a component: re-renders must keep the focused button.
  const item = (label: string, action: CommitAction, hint = '', disabled = false) => (
    <button role="menuitem" className="menu-item" disabled={disabled} onMouseEnter={closeSub} onClick={() => act(action)}>
      <span>{label}</span>
      {hint && <span className="hint">{hint}</span>}
    </button>
  )

  const left = Math.max(8, Math.min(x, window.innerWidth - 300))
  // Placed once measured: below the pointer, else above it, else pinned to the bottom edge (the CSS max-height scrolls the rest).
  const [top, setTop] = useState(Math.max(8, y))
  const [scroll, setScroll] = useState(false)
  useLayoutEffect(() => {
    const h = ref.current?.offsetHeight ?? 0
    const room = window.innerHeight - 8
    setScroll(h > room - 8)
    setTop(y + h <= room ? Math.max(8, y) : y - h >= 8 ? y - h : Math.max(8, room - h))
  }, [y])
  return (
    <div ref={ref} className={`menu ${scroll ? 'scroll' : ''}`} role="menu" aria-label={branchActions ? `Actions on branch ${branchActions.name}` : `Actions on commit ${commit.sha.slice(0, 7)}`} style={{ left, top }} onKeyDown={onKey} onContextMenu={(e) => e.preventDefault()}>
      <div className="menu-head">
        {branchActions ? `${branchActions.name} · ${commit.sha.slice(0, 7)}` : `${commit.sha.slice(0, 7)} · ${commit.subject}`}
      </div>
      {branchActions && (
        <>
          {branchActions.items.map((it) => (
            <button key={it.label} role="menuitem" className={`menu-item ${it.danger ? 'danger' : ''} ${it.claude ? 'claude' : ''}`} disabled={it.disabled} onMouseEnter={closeSub} onClick={() => actRef(it.run)}>
              <span>{it.label}</span>
              {it.hint && <span className="hint">{it.hint}</span>}
            </button>
          ))}
          <div className="menu-sep" role="separator" />
        </>
      )}
      {item('Check out this commit', 'checkout')}
      {item('Create branch here…', 'branch', 'B')}
      {item('Create tag here…', 'tag', 'T')}
      <div className="menu-sep" role="separator" />
      {item(`Cherry-pick onto ${target}`, 'cherry-pick', '', commit.sha === head)}
      {item('Revert this commit', 'revert')}
      <div className="menu-sep" role="separator" />
      <div className="menu-anchor">
        <button role="menuitem" className={`menu-item ${sub ? 'open' : ''}`} aria-haspopup="menu" aria-expanded={sub} onMouseEnter={() => {
            subOpened.current = false
            setSub(true)
          }} onClick={() => (sub ? closeSub() : setSub(true))}>
          <span>Reset {target} here</span>
          <span className="hint">›</span>
        </button>
        {sub && (
          <div className={`menu sub ${left > window.innerWidth - 600 ? 'left' : ''}`} role="menu" aria-label="Reset mode">
            {RESETS.map(([mode, label, desc]) => (
              <button key={mode} role="menuitem" className={`menu-item two ${mode === 'hard' ? 'danger' : ''}`} onClick={() => act(`reset-${mode}`)}>
                <span>{label}</span>
                <span className="desc">{desc}</span>
              </button>
            ))}
          </div>
        )}
      </div>
      {item('Rebase interactively from here…', 'rebase-i', '', !canRebase)}
      {extra && (
        <div className="contents" onMouseOver={closeSub}>
          {extra}
        </div>
      )}
      <div className="menu-sep" role="separator" />
      {item('Copy SHA', 'copy', 'Ctrl C')}
      {item('Explain with Claude', 'explain')}
    </div>
  )
}
