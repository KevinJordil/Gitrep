import { useRef } from 'react'
import { clampPane, PANES, type Pane } from './panes'
import { useResizeHandle } from './useResize'

interface Props {
  pane: Pane
  width: number // current (displayed) width of the pane
  other: number // displayed width of the other side pane
  onSave: (width: number) => Promise<boolean> // resolves false when the save failed
}

// The handle on the inner edge of the sidebar or the right panel. While dragging, the width is written to the
// pane's CSS variable on .panes (no React render per move); it is saved when the button is released.
export function Splitter({ pane, width, other, onSave }: Props) {
  const { min, max, initial, cssVar, label } = PANES[pane]
  const clamp = (w: number) => clampPane(pane, w, other, window.innerWidth)
  const handleRef = useRef<HTMLDivElement>(null)
  const handlers = useResizeHandle({
    width,
    clamp,
    dir: pane === 'sidebar' ? 1 : -1, // moving right widens the sidebar and narrows the right panel
    step: 16,
    bigStep: 64,
    defaultWidth: clamp(initial),
    apply: (w) => handleRef.current?.parentElement?.style.setProperty(cssVar, `${w}px`),
    onSave
  })
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
      {...handlers}
    />
  )
}
