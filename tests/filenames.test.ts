import { readdirSync } from 'node:fs'
import { join, parse } from 'node:path'
import { describe, expect, it } from 'vitest'

// macOS and Windows file systems ignore case: `graph.ts` next to `Graph.tsx` breaks the build there.
describe('source file names', () => {
  it('never differ only by case or extension in one folder', () => {
    for (const dir of ['src/main', 'src/shared', 'src/renderer/src', 'tests', 'e2e']) {
      const names = readdirSync(join(__dirname, '..', dir)).map((f) => parse(f).name.toLowerCase())
      expect(names.filter((n, i) => names.indexOf(n) !== i), dir).toEqual([])
    }
  })
})
