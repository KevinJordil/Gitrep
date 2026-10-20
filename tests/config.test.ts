import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { addRepo, applyRepoSettings, applySettings, DEFAULT_CONFIG, DEFAULT_REVIEW_PROMPTS, loadConfig, removeRepo, saveConfig } from '../src/main/config'
import { tempDir } from './helpers'

describe('config', () => {
  it('returns defaults when the file does not exist', async () => {
    expect(loadConfig(join(await tempDir(), 'missing.json'))).toEqual(DEFAULT_CONFIG)
  })

  it('round-trips and fills missing settings with defaults', async () => {
    const file = join(await tempDir(), 'sub', 'config.json')
    saveConfig(file, { ...DEFAULT_CONFIG, repos: [{ path: '/r/a', name: 'a' }] })
    expect(loadConfig(file).repos).toEqual([{ path: '/r/a', name: 'a' }])
    writeFileSync(file, JSON.stringify({ repos: [], openTabs: [], settings: { claudeModel: 'sonnet' } }))
    expect(loadConfig(file).settings).toEqual({ claudeModel: 'sonnet', claudePath: '', activeDays: 30, sidebarWidth: 232, rightWidth: 360, commitInstructions: '', graphColumns: { graph: 0, author: 150, date: 110, sha: 70 }, forgeHosts: {}, reviewPrompts: DEFAULT_REVIEW_PROMPTS })
  })

  it('resets hand-edited settings that fail validation to their defaults', async () => {
    const file = join(await tempDir(), 'config.json')
    writeFileSync(file, JSON.stringify({ repos: [], openTabs: [], settings: { sidebarWidth: 'abc', activeDays: 'x', rightWidth: 5, claudeModel: 'sonnet' } }))
    expect(loadConfig(file).settings).toEqual({ claudeModel: 'sonnet', claudePath: '', activeDays: 30, sidebarWidth: 232, rightWidth: 360, commitInstructions: '', graphColumns: { graph: 0, author: 150, date: 110, sha: 70 }, forgeHosts: {}, reviewPrompts: DEFAULT_REVIEW_PROMPTS })
  })

  it('backs up a corrupt file instead of losing it', async () => {
    const file = join(await tempDir(), 'config.json')
    writeFileSync(file, '{oops')
    expect(loadConfig(file)).toEqual(DEFAULT_CONFIG)
    expect(readFileSync(`${file}.corrupt`, 'utf8')).toBe('{oops')
  })

  it('adds a repo once, keeps the list sorted, removes it with its tab', () => {
    let cfg = addRepo(DEFAULT_CONFIG, '/r/b')
    cfg = addRepo(cfg, '/r/a')
    cfg = addRepo(cfg, '/r/b')
    expect(cfg.repos).toEqual([{ path: '/r/a', name: 'a' }, { path: '/r/b', name: 'b' }])
    cfg = removeRepo({ ...cfg, openTabs: ['/r/a', '/r/b'] }, '/r/a')
    expect(cfg.repos.map((r) => r.path)).toEqual(['/r/b'])
    expect(cfg.openTabs).toEqual(['/r/b'])
  })

  it('applies the settings the app edits, refuses invalid values and the others', () => {
    expect(applySettings(DEFAULT_CONFIG, { activeDays: 90 }).settings.activeDays).toBe(90)
    expect(applySettings(DEFAULT_CONFIG, { activeDays: 0 }).settings.activeDays).toBe(0)
    expect(() => applySettings(DEFAULT_CONFIG, { activeDays: -1 })).toThrow('Invalid setting: activeDays')
    expect(() => applySettings(DEFAULT_CONFIG, { activeDays: 1.5 })).toThrow('Invalid setting: activeDays')
    expect(() => applySettings(DEFAULT_CONFIG, { claudePath: '/bin/sh' })).toThrow('Invalid setting: claudePath')
    expect(applySettings(DEFAULT_CONFIG, { sidebarWidth: 300, rightWidth: 420 }).settings).toMatchObject({ sidebarWidth: 300, rightWidth: 420 })
    expect(() => applySettings(DEFAULT_CONFIG, { rightWidth: 50 })).toThrow('Invalid setting: rightWidth')
    expect(() => applySettings(DEFAULT_CONFIG, { sidebarWidth: 250.5 })).toThrow('Invalid setting: sidebarWidth')
    expect(DEFAULT_CONFIG.settings.activeDays).toBe(30) // not mutated
    expect(() => applySettings(DEFAULT_CONFIG, { constructor: 1 } as never)).toThrow('Invalid setting: constructor')
    expect(() => applySettings(DEFAULT_CONFIG, { toString: 1 } as never)).toThrow('Invalid setting: toString')
    for (const bad of [null, 5, 'x', []]) expect(() => applySettings(DEFAULT_CONFIG, bad as never)).toThrow('Invalid settings')
  })

  it('accepts graph column widths of 48 to 480 px (graph: 0 or 40 to 480) and rejects anything else', () => {
    const ok = { graph: 40, author: 48, date: 200, sha: 480 }
    expect(applySettings(DEFAULT_CONFIG, { graphColumns: ok }).settings.graphColumns).toEqual(ok)
    expect(applySettings(DEFAULT_CONFIG, { graphColumns: { ...ok, graph: 0 } }).settings.graphColumns.graph).toBe(0)
    const bad: unknown[] = [
      { graph: 39, author: 150, date: 110, sha: 70 },
      { graph: 481, author: 150, date: 110, sha: 70 },
      { graph: 100.5, author: 150, date: 110, sha: 70 },
      { graph: 0, author: 0, date: 110, sha: 70 },
      { graph: 0, author: 47, date: 110, sha: 70 },
      { graph: 0, author: 150, date: 481, sha: 70 },
      { graph: 0, author: 150.5, date: 110, sha: 70 },
      { graph: 0, author: '150', date: 110, sha: 70 },
      { graph: 0, author: 150, date: 110 },
      { author: 150, date: 110, sha: 70 },
      { graph: 0, author: 150, date: 110, sha: 70, extra: 1 },
      [150, 110, 70],
      null,
      5
    ]
    for (const graphColumns of bad) expect(() => applySettings(DEFAULT_CONFIG, { graphColumns } as never)).toThrow('Invalid setting: graphColumns')
  })

  it('resets invalid saved graph columns to the defaults', async () => {
    const file = join(await tempDir(), 'config.json')
    writeFileSync(file, JSON.stringify({ repos: [], openTabs: [], settings: { graphColumns: { graph: 0, author: 10, date: 110, sha: 70 } } }))
    expect(loadConfig(file).settings.graphColumns).toEqual({ graph: 0, author: 150, date: 110, sha: 70 })
    writeFileSync(file, JSON.stringify({ repos: [], openTabs: [], settings: { graphColumns: { graph: 200, author: 200, date: 90, sha: 60 } } }))
    expect(loadConfig(file).settings.graphColumns).toEqual({ graph: 200, author: 200, date: 90, sha: 60 })
  })

  it('upgrades saved graph columns that predate the graph column without resetting them', async () => {
    const file = join(await tempDir(), 'config.json')
    writeFileSync(file, JSON.stringify({ repos: [], openTabs: [], settings: { graphColumns: { author: 200, date: 90, sha: 60 } } }))
    expect(loadConfig(file).settings.graphColumns).toEqual({ graph: 0, author: 200, date: 90, sha: 60 })
  })

  it('accepts commit instructions up to 4000 characters, globally and per repository', async () => {
    expect(applySettings(DEFAULT_CONFIG, { commitInstructions: 'x'.repeat(4000) }).settings.commitInstructions).toHaveLength(4000)
    for (const bad of ['x'.repeat(4001), 5, null]) expect(() => applySettings(DEFAULT_CONFIG, { commitInstructions: bad } as never)).toThrow('Invalid setting: commitInstructions')
    const cfg = { ...DEFAULT_CONFIG, repos: [{ path: '/r/a', name: 'a' }] }
    expect(applyRepoSettings(cfg, '/r/a', { commitInstructions: 'be brief' }).repos[0]).toEqual({ path: '/r/a', name: 'a', commitInstructions: 'be brief' })
    expect(cfg.repos[0]).toEqual({ path: '/r/a', name: 'a' }) // not mutated
    expect(() => applyRepoSettings(cfg, '/r/b', { commitInstructions: 'x' })).toThrow('Unknown repository')
    expect(() => applyRepoSettings(cfg, '/r/a', { name: 'z' } as never)).toThrow('Invalid setting: name')
    expect(() => applyRepoSettings(cfg, '/r/a', { toString: 1 } as never)).toThrow('Invalid setting: toString')
    expect(() => applyRepoSettings(cfg, '/r/a', { commitInstructions: 'x'.repeat(4001) })).toThrow('Invalid setting: commitInstructions')
    for (const bad of [null, 5, 'x', []]) expect(() => applyRepoSettings(cfg, '/r/a', bad as never)).toThrow('Invalid settings')
  })

  it('drops invalid saved commit instructions', async () => {
    const file = join(await tempDir(), 'config.json')
    const repos = [
      { path: '/a', name: 'a', commitInstructions: 'ok' },
      { path: '/b', name: 'b', commitInstructions: 5 },
      { path: '/c', name: 'c', commitInstructions: 'x'.repeat(4001) }
    ]
    writeFileSync(file, JSON.stringify({ repos, openTabs: [], settings: { commitInstructions: 7 } }))
    const cfg = loadConfig(file)
    expect(cfg.repos).toEqual([{ path: '/a', name: 'a', commitInstructions: 'ok' }, { path: '/b', name: 'b' }, { path: '/c', name: 'c' }])
    expect(cfg.settings.commitInstructions).toBe('')
  })

  it('tolerates a non-array repos list and non-object entries', async () => {
    const file = join(await tempDir(), 'config.json')
    writeFileSync(file, JSON.stringify({ repos: 'x', openTabs: [], settings: {} }))
    expect(loadConfig(file).repos).toEqual([])
    writeFileSync(file, JSON.stringify({ repos: [null, 5, { path: '/x' }, { path: '/a', name: 'a', commitInstructions: 5 }], openTabs: ['/a', null, 3], settings: {} }))
    expect(loadConfig(file).repos).toEqual([{ path: '/a', name: 'a' }])
    expect(loadConfig(file).openTabs).toEqual(['/a'])
  })

  it('accepts the forge chosen for a host, refuses bad hosts and unknown forges', () => {
    expect(applySettings(DEFAULT_CONFIG, { forgeHosts: { 'code.x.ch': 'gitlab', 'git.y.ch': 'github' } }).settings.forgeHosts).toEqual({ 'code.x.ch': 'gitlab', 'git.y.ch': 'github' })
    for (const forgeHosts of [{ 'code.x.ch': 'bitbucket' }, { '-x': 'gitlab' }, { 'a b': 'github' }, ['gitlab'], null, 'x']) expect(() => applySettings(DEFAULT_CONFIG, { forgeHosts } as never)).toThrow('Invalid setting: forgeHosts')
  })

  it('accepts up to 20 named review prompts with unique names, and one prompt per repository', () => {
    const prompts = [{ name: 'Default review', text: 'x' }, { name: 'Java style', text: 'y'.repeat(4000) }]
    expect(applySettings(DEFAULT_CONFIG, { reviewPrompts: prompts }).settings.reviewPrompts).toEqual(prompts)
    const bad: unknown[] = [[], [{ name: 'a', text: 'x' }, { name: 'a', text: 'y' }], [{ name: '', text: 'x' }], [{ name: ' a', text: 'x' }], [{ name: 'a', text: 'x'.repeat(4001) }], [{ name: 'a', text: 'x', extra: 1 }], Array.from({ length: 21 }, (_, i) => ({ name: `p${i}`, text: '' })), null]
    for (const reviewPrompts of bad) expect(() => applySettings(DEFAULT_CONFIG, { reviewPrompts } as never)).toThrow('Invalid setting: reviewPrompts')
    const cfg = { ...DEFAULT_CONFIG, repos: [{ path: '/r/a', name: 'a', commitInstructions: 'keep' }] }
    const own = { name: 'Firmware safety review', text: 'ISR re-entrancy' }
    const set = applyRepoSettings(cfg, '/r/a', { reviewPrompt: own })
    expect(set.repos[0]).toEqual({ path: '/r/a', name: 'a', commitInstructions: 'keep', reviewPrompt: own })
    expect(applyRepoSettings(set, '/r/a', { reviewPrompt: null }).repos[0]).toEqual({ path: '/r/a', name: 'a', commitInstructions: 'keep' })
    expect(() => applyRepoSettings(cfg, '/r/a', { reviewPrompt: { name: '', text: '' } })).toThrow('Invalid setting: reviewPrompt')
  })

  it('keeps a valid review prompt when the commit instructions of the same repository are invalid', async () => {
    const file = join(await tempDir(), 'config.json')
    writeFileSync(file, JSON.stringify({ repos: [{ path: '/a', name: 'a', commitInstructions: 5, reviewPrompt: { name: 'ok', text: 't' } }], openTabs: [], settings: {} }))
    expect(loadConfig(file).repos).toEqual([{ path: '/a', name: 'a', reviewPrompt: { name: 'ok', text: 't' } }])
  })

  it('drops an invalid saved repository prompt and resets invalid global prompts', async () => {
    const file = join(await tempDir(), 'config.json')
    const repos = [{ path: '/a', name: 'a', reviewPrompt: { name: 'ok', text: 't' } }, { path: '/b', name: 'b', reviewPrompt: { name: 5 } }]
    writeFileSync(file, JSON.stringify({ repos, openTabs: [], settings: { reviewPrompts: 'oops' } }))
    const cfg = loadConfig(file)
    expect(cfg.repos).toEqual([repos[0], { path: '/b', name: 'b' }])
    expect(cfg.settings.reviewPrompts).toEqual(DEFAULT_REVIEW_PROMPTS)
  })
})
