import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { addRepo, applySettings, DEFAULT_CONFIG, loadConfig, removeRepo, saveConfig } from '../src/main/config'
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
    expect(loadConfig(file).settings).toEqual({ claudeModel: 'sonnet', claudePath: '', activeDays: 30, sidebarWidth: 232, rightWidth: 360 })
  })

  it('resets hand-edited settings that fail validation to their defaults', async () => {
    const file = join(await tempDir(), 'config.json')
    writeFileSync(file, JSON.stringify({ repos: [], openTabs: [], settings: { sidebarWidth: 'abc', activeDays: 'x', rightWidth: 5, claudeModel: 'sonnet' } }))
    expect(loadConfig(file).settings).toEqual({ claudeModel: 'sonnet', claudePath: '', activeDays: 30, sidebarWidth: 232, rightWidth: 360 })
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
})
