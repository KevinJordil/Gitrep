// The two resizable side panes; the history, diff or editor in the center takes what is left.
export const PANES = {
  sidebar: { min: 160, max: 480, initial: 232, cssVar: '--side-w', label: 'Resize the sidebar' },
  right: { min: 280, max: 720, initial: 360, cssVar: '--right-w', label: 'Resize the right panel' }
} as const
export type Pane = keyof typeof PANES
export const CENTER_MIN = 360

// A width for `pane` within its bounds that leaves the center at least CENTER_MIN (when the window allows).
export function clampPane(pane: Pane, width: number, other: number, total: number): number {
  const { min, max } = PANES[pane]
  return Math.round(Math.max(min, Math.min(max, total - other - CENTER_MIN, width)))
}
