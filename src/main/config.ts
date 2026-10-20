import { copyFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { basename, dirname } from 'node:path'
import { DEFAULT_GRAPH_COLUMNS, MAX_INSTRUCTIONS, GRAPH_COLUMN_MAX, GRAPH_COLUMN_MIN, GRAPH_LANES_MIN, MAX_PROMPT_NAME, MAX_PROMPT_TEXT, MAX_PROMPTS, type Config, type RepoEntry, type RepoSettingsPatch, type ReviewPrompt, type Settings } from '../shared/types'
import { isHost } from './forge'

export const DEFAULT_REVIEW_PROMPTS: ReviewPrompt[] = [
  { name: 'Default review', text: 'Look for bugs, unhandled errors, security issues, concurrency problems and missing tests. Ignore formatting. Write the comments in English.' }
]

export const DEFAULT_CONFIG: Config = { repos: [], openTabs: [], settings: { claudeModel: 'haiku', claudePath: '', activeDays: 30, sidebarWidth: 232, rightWidth: 360, graphColumns: DEFAULT_GRAPH_COLUMNS, commitInstructions: '', forgeHosts: {}, reviewPrompts: DEFAULT_REVIEW_PROMPTS } }

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
    const settings = { ...structuredClone(DEFAULT_CONFIG.settings), ...parsed.settings }
    const gc = settings.graphColumns as Record<string, unknown> | null
    if (gc && typeof gc === 'object' && !Array.isArray(gc) && Object.keys(gc).length === 3 && !('graph' in gc)) settings.graphColumns = { graph: 0, ...gc } as Settings['graphColumns'] // saved before the graph column existed
    for (const [key, valid] of Object.entries(EDITABLE)) if (!valid(settings[key as keyof Settings])) Object.assign(settings, { [key]: structuredClone(DEFAULT_CONFIG.settings[key as keyof Settings]) })
    const repos = (Array.isArray(parsed.repos) ? parsed.repos : [])
      .filter((r) => typeof r?.path === 'string' && typeof r.name === 'string')
      .map((r) => (r.commitInstructions === undefined || isInstructions(r.commitInstructions) ? r : withoutInstructions(r)))
      .map((r) => (r.reviewPrompt === undefined || isPrompt(r.reviewPrompt) ? r : withoutPrompt(r)))
    const openTabs = (Array.isArray(parsed.openTabs) ? parsed.openTabs : []).filter((t) => typeof t === 'string')
    return { ...structuredClone(DEFAULT_CONFIG), ...parsed, repos, openTabs, settings }
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

const isWidth = (v: unknown) => Number.isInteger(v) && (v as number) >= 100 && (v as number) <= 2000

const isInstructions = (v: unknown) => typeof v === 'string' && v.length <= MAX_INSTRUCTIONS

const isColumns = (v: unknown) => {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false
  const keys = Object.keys(v)
  return keys.length === 4 && Object.keys(DEFAULT_GRAPH_COLUMNS).every((k) => {
    const n = Reflect.get(v, k)
    const auto = k === 'graph' && n === 0 // the lanes column: 0 = automatic
    return keys.includes(k) && Number.isInteger(n) && (auto || (n >= (k === 'graph' ? GRAPH_LANES_MIN : GRAPH_COLUMN_MIN) && n <= GRAPH_COLUMN_MAX))
  })
}

export const isPrompt = (v: unknown): v is ReviewPrompt => {
  if (!v || typeof v !== 'object' || Array.isArray(v) || Object.keys(v).length !== 2) return false
  const { name, text } = v as Record<string, unknown>
  return typeof name === 'string' && name.trim() === name && name.length > 0 && name.length <= MAX_PROMPT_NAME && typeof text === 'string' && text.length <= MAX_PROMPT_TEXT
}

const isPrompts = (v: unknown) => Array.isArray(v) && v.length > 0 && v.length <= MAX_PROMPTS && v.every(isPrompt) && new Set(v.map((p: ReviewPrompt) => p.name)).size === v.length

const withoutInstructions = ({ commitInstructions: _, ...rest }: RepoEntry): RepoEntry => rest

const withoutPrompt = ({ reviewPrompt: _, ...rest }: RepoEntry): RepoEntry => rest

const isForgeHosts = (v: unknown) =>
  !!v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length <= 200 && Object.entries(v).every(([host, kind]) => isHost(host) && (kind === 'gitlab' || kind === 'github'))

// The settings the app changes itself, with their validation; the others (Claude model and path) are edited in the file.
const EDITABLE: Partial<Record<keyof Settings, (v: unknown) => boolean>> = {
  activeDays: (v) => Number.isInteger(v) && (v as number) >= 0,
  sidebarWidth: (v) => isWidth(v),
  rightWidth: (v) => isWidth(v),
  graphColumns: isColumns,
  commitInstructions: isInstructions,
  forgeHosts: isForgeHosts,
  reviewPrompts: isPrompts
}

export function applySettings(cfg: Config, patch: Partial<Settings>): Config {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('Invalid settings')
  for (const [key, value] of Object.entries(patch)) if (!Object.hasOwn(EDITABLE, key) || !EDITABLE[key as keyof Settings]?.(value)) throw new Error(`Invalid setting: ${key}`)
  return { ...cfg, settings: { ...cfg.settings, ...patch } }
}

// Per-repository settings the app edits, for a repository already registered: the commit message instructions and
// the repository's own review prompt (null removes it).
const REPO_EDITABLE: Record<keyof RepoSettingsPatch, (v: unknown) => boolean> = {
  commitInstructions: isInstructions,
  reviewPrompt: (v) => v === null || isPrompt(v)
}

export function applyRepoSettings(cfg: Config, path: string, patch: RepoSettingsPatch): Config {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('Invalid settings')
  if (!cfg.repos.some((r) => r.path === path)) throw new Error('Unknown repository')
  for (const [key, value] of Object.entries(patch)) if (!Object.hasOwn(REPO_EDITABLE, key) || !REPO_EDITABLE[key as keyof RepoSettingsPatch](value)) throw new Error(`Invalid setting: ${key}`)
  return {
    ...cfg,
    repos: cfg.repos.map((r) => {
      if (r.path !== path) return r
      const next = { ...r, ...patch }
      return patch.reviewPrompt === null ? withoutPrompt(next as RepoEntry) : (next as RepoEntry)
    })
  }
}
