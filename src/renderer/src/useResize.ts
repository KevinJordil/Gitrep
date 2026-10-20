import { useEffect, useRef, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react'

const KEY_SAVE_DELAY = 400 // ms after the last arrow key

interface Options {
  width: number // current (displayed) width
  clamp: (w: number) => number
  dir: 1 | -1 // 1: moving right widens; -1: moving left widens
  step: number // px per arrow key press
  bigStep: number // with Shift
  defaultWidth: number // double-click target
  apply: (w: number) => void // shows a width (the CSS variable); no React render per move
  onSave: (w: number) => Promise<boolean> // resolves false when the save failed
}

// The pointer, keyboard and double-click behaviour shared by the pane splitters and the column handles.
// While dragging only `apply` runs; the width is saved when the button is released or after the last arrow key.
// When a save fails, or the drag is cancelled, the previous width is put back.
export function useResizeHandle({ width, clamp, dir, step, bigStep, defaultWidth, apply, onSave }: Options) {
  const keyed = useRef<{ w: number; from: number; timer: number } | null>(null) // arrow keys pending a save
  const save = (w: number, from: number) => {
    if (w === from) return
    void onSave(w).then((ok) => ok || apply(from))
  }
  useEffect(() => () => window.clearTimeout(keyed.current?.timer), [])

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return
    e.preventDefault()
    const handle = e.currentTarget
    const x0 = e.clientX
    let w = width
    handle.setPointerCapture(e.pointerId)
    document.body.classList.add('resizing')
    const move = (ev: PointerEvent) => {
      w = clamp(width + dir * (ev.clientX - x0))
      apply(w)
    }
    const end = (ev: PointerEvent) => {
      handle.removeEventListener('pointermove', move)
      handle.removeEventListener('pointerup', end)
      handle.removeEventListener('pointercancel', end)
      document.body.classList.remove('resizing')
      if (ev.type === 'pointercancel') apply(width)
      else save(w, width)
    }
    handle.addEventListener('pointermove', move)
    handle.addEventListener('pointerup', end)
    handle.addEventListener('pointercancel', end)
  }
  const onKeyDown = (e: ReactKeyboardEvent) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
    e.preventDefault()
    const delta = (e.shiftKey ? bigStep : step) * (e.key === 'ArrowRight' ? 1 : -1)
    const k = keyed.current ?? { w: width, from: width, timer: 0 }
    window.clearTimeout(k.timer)
    k.w = clamp(k.w + dir * delta)
    apply(k.w)
    k.timer = window.setTimeout(() => {
      keyed.current = null
      save(k.w, k.from)
    }, KEY_SAVE_DELAY)
    keyed.current = k
  }
  const onDoubleClick = () => {
    window.clearTimeout(keyed.current?.timer) // a pending arrow-key save must not overwrite the reset
    keyed.current = null
    apply(defaultWidth)
    save(defaultWidth, width)
  }
  return { onPointerDown, onKeyDown, onDoubleClick }
}
