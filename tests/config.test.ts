import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { addRepo, DEFAULT_CONFIG, loadConfig, removeRepo, saveConfig } from '../src/main/config'
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
    expect(loadConfig(file).settings).toEqual({ claudeModel: 'sonnet', claudePath: '' })
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
})
