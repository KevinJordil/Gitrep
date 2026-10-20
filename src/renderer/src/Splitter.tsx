import { useEffect, useRef, type PointerEvent as ReactPointerEvent } from 'react'
import { clampPane, PANES, type Pane } from './panes'

interface Props {
  pane: Pane
  width: number // current (displayed) width of the pane
  other: number // displayed width of the other side pane
  onSave: (width: number) => Promise<boolean> // resolves false when the save failed
}

const KEY_SAVE_DELAY = 400 // ms after the last arrow key

// The handle on the inner edge of the sidebar or the right panel. While dragging, the width is written to the
// pane's CSS variable on .panes (no React render per move); it is saved when the button is released.
// When a save fails, or the drag is cancelled, the previous width is put back.
export function Splitter({ pane, width, other, onSave }: Props) {
  const { min, max, initial, cssVar, label } = PANES[pane]
  const dir = pane === 'sidebar' ? 1 : -1 // moving right widens the sidebar and narrows the right panel
  const clamp = (w: number) => clampPane(pane, w, other, window.innerWidth)
  const handleRef = useRef<HTMLDivElement>(null)
  const keyed = useRef<{ w: number; from: number; timer: number } | null>(null) // arrow keys pending a save

  const show = (w: number) => handleRef.current?.parentElement?.style.setProperty(cssVar, `${w}px`)
  const save = (w: number, from: number) => {
    if (w === from) return
    void onSave(w).then((ok) => ok || show(from))
  }
  useEffect(() => () => window.clearTimeout(keyed.current?.timer), [])

  const drag = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return
    e.preventDefault()
    const handle = e.currentTarget
    const x0 = e.clientX
    let w = width
    handle.setPointerCapture(e.pointerId)
    document.body.classList.add('resizing')
    const move = (ev: PointerEvent) => {
      w = clamp(width + dir * (ev.clientX - x0))
      show(w)
    }
    const end = (ev: PointerEvent) => {
      handle.removeEventListener('pointermove', move)
      handle.removeEventListener('pointerup', end)
      handle.removeEventListener('pointercancel', end)
      document.body.classList.remove('resizing')
      if (ev.type === 'pointercancel') show(width)
      else save(w, width)
    }
    handle.addEventListener('pointermove', move)
    handle.addEventListener('pointerup', end)
    handle.addEventListener('pointercancel', end)
  }
  const key = (e: React.KeyboardEvent) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
    e.preventDefault()
    const step = (e.shiftKey ? 64 : 16) * (e.key === 'ArrowRight' ? 1 : -1)
    const k = keyed.current ?? { w: width, from: width, timer: 0 }
    window.clearTimeout(k.timer)
    k.w = clamp(k.w + dir * step)
    show(k.w)
    k.timer = window.setTimeout(() => {
      keyed.current = null
      save(k.w, k.from)
    }, KEY_SAVE_DELAY)
    keyed.current = k
  }
  return (
    <div
      ref={handleRef}
      className={`splitter at-${pane}`}
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={width}
      aria-valuemin={min}
      aria-valuemax={max}
      tabIndex={0}
      title="Drag to resize, double-click to reset"
      onPointerDown={drag}
      onDoubleClick={() => save(clamp(initial), width)}
      onKeyDown={key}
    />
  )
}
