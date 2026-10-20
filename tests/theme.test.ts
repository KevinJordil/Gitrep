import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// The :root color tokens of the stylesheet, by name (without "--").
const css = readFileSync(join(__dirname, '../src/renderer/src/styles.css'), 'utf8')
const root = css.slice(css.indexOf(':root {'), css.indexOf('}', css.indexOf(':root {')))
const tokens = Object.fromEntries([...root.matchAll(/--([\w-]+):\s*(#[0-9a-f]{6});/gi)].map((m) => [m[1], m[2]]))

// WCAG 2 relative luminance and contrast ratio.
const luminance = (hex: string) => {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}
const contrast = (a: string, b: string) => {
  const [hi, lo] = [luminance(tokens[a]), luminance(tokens[b])].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

describe('theme tokens', () => {
  const pairs: [string, string][] = [
    ...['text', 'muted', 'faint'].flatMap((fg) => ['bg', 'panel', 'raised'].map((bg): [string, string] => [fg, bg])),
    ['add-t', 'add-bg'],
    ['del-t', 'del-bg'],
    ['ctx-t', 'panel'],
    ['on-primary', 'primary'],
    ['claude-fg', 'claude-bg'],
    ['warn-fg', 'warn-bg']
  ]
  it.each(pairs)('%s on %s reaches WCAG AA (4.5:1)', (fg, bg) => {
    expect(tokens[fg], fg).toBeDefined()
    expect(tokens[bg], bg).toBeDefined()
    expect(contrast(fg, bg)).toBeGreaterThanOrEqual(4.5)
  })

  it('has no hard-coded color outside :root', () => {
    expect(css.slice(css.indexOf('}', css.indexOf(':root {'))).match(/#[0-9a-f]{3,8}\b/gi)).toBeNull()
  })
})
