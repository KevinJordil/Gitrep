import { describe, expect, it } from 'vitest'
import { CENTER_MIN, clampPane } from '../src/renderer/src/panes'

describe('clampPane', () => {
  it('keeps a width within the pane bounds', () => {
    expect(clampPane('sidebar', 300.4, 360, 1600)).toBe(300)
    expect(clampPane('sidebar', 50, 360, 1600)).toBe(160)
    expect(clampPane('sidebar', 900, 360, 1600)).toBe(480)
    expect(clampPane('right', 100, 232, 1600)).toBe(280)
    expect(clampPane('right', 2000, 232, 1600)).toBe(720)
  })

  it('leaves the center its minimum width, never going under the pane minimum', () => {
    expect(clampPane('right', 700, 400, 1200)).toBe(1200 - 400 - CENTER_MIN)
    expect(clampPane('sidebar', 400, 700, 900)).toBe(160)
  })
})
