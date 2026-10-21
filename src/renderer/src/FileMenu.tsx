import { useEffect, useRef, type KeyboardEvent, type MouseEvent } from 'react'
import type { FileView } from './model'

// A file of the Changes panel or of a commit, and where its menu opens. rev: the commit (null: the working tree, from HEAD).
export interface FileMenuTarget {
  path: string
  rev: string | null
  x: number
  y: number
}

// Right-click, the ContextMenu key or Shift+F10 on a file row open its menu at (x, y).
export function fileMenuProps(open: (x: number, y: number) => void) {
  return {
    onContextMenu: (e: MouseEvent) => {
      e.preventDefault()
      open(e.clientX, e.clientY)
    },
    onKeyDown: (e: KeyboardEvent<HTMLElement>) => {
      if (e.key !== 'ContextMenu' && !(e.shiftKey && e.key === 'F10')) return
      e.preventDefault()
      const r = e.currentTarget.getBoundingClientRect()
      open(r.left + 24, r.bottom)
    }
  }
}

interface Props {
  target: FileMenuTarget
  onOpen: (view: FileView) => void
  onClose: () => void // must be stable (useCallback)
}

export function FileMenu({ target, onOpen, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null)

  // Keyboard users keep their place: refocus what had focus before the menu opened.
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null
    return () => prev?.focus?.()
  }, [])
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

  const onKey = (e: KeyboardEvent) => {
    const items = [...(ref.current?.querySelectorAll<HTMLButtonElement>('[role=menuitem]') ?? [])]
    const i = items.indexOf(document.activeElement as HTMLButtonElement)
    if (e.key === 'Escape') onClose()
    else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      items[(i + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length]?.focus()
    }
  }
  const act = (view: FileView) => () => {
    onClose()
    onOpen(view)
  }

  const left = Math.max(8, Math.min(target.x, window.innerWidth - 250))
  const top = Math.max(8, Math.min(target.y, window.innerHeight - 120))
  return (
    <div ref={ref} className="menu file-menu" role="menu" aria-label={`Actions on ${target.path}`} style={{ left, top }} onKeyDown={onKey} onContextMenu={(e) => e.preventDefault()}>
      <div className="menu-head">{target.path}</div>
      <button role="menuitem" className="menu-item" onClick={act('diff')}>
        File history
      </button>
      <button role="menuitem" className="menu-item" onClick={act('blame')}>
        Blame
      </button>
    </div>
  )
}
