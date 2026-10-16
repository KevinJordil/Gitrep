import { copyFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { basename, dirname } from 'node:path'
import type { Config } from '../shared/types'

export const DEFAULT_CONFIG: Config = { repos: [], openTabs: [], settings: { claudeModel: 'haiku', claudePath: '' } }

export function loadConfig(file: string): Config {
  let raw: string
  try {
    raw = readFileSync(file, 'utf8')
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return structuredClone(DEFAULT_CONFIG)
    throw e
  }
  try {
    const parsed = JSON.parse(raw) as Partial<Config>
    return { ...structuredClone(DEFAULT_CONFIG), ...parsed, settings: { ...DEFAULT_CONFIG.settings, ...parsed.settings } }
  } catch {
    copyFileSync(file, `${file}.corrupt`) // keep the user's repo list recoverable
    return structuredClone(DEFAULT_CONFIG)
  }
}

export function saveConfig(file: string, cfg: Config): void {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  writeFileSync(tmp, JSON.stringify(cfg, null, 2))
  renameSync(tmp, file) // atomic: a crash never leaves a half-written config
}

export function addRepo(cfg: Config, path: string): Config {
  if (cfg.repos.some((r) => r.path === path)) return cfg
  const repos = [...cfg.repos, { path, name: basename(path) }].sort((a, b) => a.path.localeCompare(b.path))
  return { ...cfg, repos }
}

export function removeRepo(cfg: Config, path: string): Config {
  return { ...cfg, repos: cfg.repos.filter((r) => r.path !== path), openTabs: cfg.openTabs.filter((p) => p !== path) }
}
