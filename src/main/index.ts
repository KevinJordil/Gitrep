import { app, BrowserWindow, dialog, ipcMain, shell, type OpenDialogOptions } from 'electron'
import { spawn } from 'node:child_process'
import { existsSync, watch, type FSWatcher } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { API_METHODS, type Api, type IpcResult } from '../shared/api'
import type { Config, RepoEntry } from '../shared/types'
import { generateCommitMessage } from './claude'
import { addRepo, loadConfig, removeRepo, saveConfig } from './config'
import { git } from './git'
import * as repo from './repo'
import { smoke } from './smoke'

const SMOKE = !!process.env.GITREP_SMOKE
if (SMOKE) app.setPath('userData', join(tmpdir(), 'gitrep-smoke'))
// Test support: end-to-end tests point the app at a throw-away config directory.
if (process.env.GITREP_USER_DATA) app.setPath('userData', process.env.GITREP_USER_DATA)
if (!app.requestSingleInstanceLock()) app.exit(0)

const configFile = join(app.getPath('userData'), 'config.json')
let config: Config = loadConfig(configFile)
let win: BrowserWindow | null = null
const fetchErrors = new Map<string, string>()
const watchers = new Map<string, FSWatcher[]>()
const pending = new Map<string, NodeJS.Timeout>()

function setConfig(next: Config): void {
  config = next
  saveConfig(configFile, config)
}

const isRegistered = (path: string) => config.repos.some((r) => r.path === path)
const lastLine = (e: unknown) => (e instanceof Error ? e.message : String(e)).trim().split('\n').pop() ?? ''

// Every handler whose first argument is a repo path only accepts registered repos.
function forRepo<A extends unknown[], T>(fn: (path: string, ...args: A) => Promise<T>) {
  return (path: string, ...args: A): Promise<T> => {
    if (!isRegistered(path)) return Promise.reject(new Error(`Repository not registered: ${path}`))
    return fn(path, ...args)
  }
}

function launch(cmd: string, args: string[], cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, detached: true, stdio: 'ignore' })
    child.once('error', reject)
    child.once('spawn', () => {
      child.unref()
      resolve()
    })
  })
}

async function fetchOne(path: string): Promise<void> {
  try {
    await repo.fetchRepo(path)
    fetchErrors.delete(path)
  } catch (e) {
    fetchErrors.set(path, lastLine(e))
    throw e
  }
}

let fetching: Promise<void> | null = null

// Overlap guard: a slow network must not stack up fetch rounds.
function fetchAll(): Promise<void> {
  fetching ??= repo
    .mapLimit(config.repos, 4, (r) => fetchOne(r.path).catch(() => undefined))
    .then(() => undefined)
    .finally(() => {
      fetching = null
    })
  return fetching
}

function notifyChanged(path: string): void {
  clearTimeout(pending.get(path))
  pending.set(
    path,
    setTimeout(() => win?.webContents.send('repo-changed', path), 300)
  )
}

let wanted = new Set<string>()

function unwatch(p: string): void {
  watchers.get(p)?.forEach((w) => w.close())
  watchers.delete(p)
  clearTimeout(pending.get(p))
  pending.delete(p)
}

// Watch only .git (HEAD, index, refs, logs): a recursive watch of big work trees exhausts inotify.
async function setWatched(paths: string[]): Promise<void> {
  wanted = new Set(paths.filter(isRegistered))
  for (const p of [...watchers.keys()]) if (!wanted.has(p)) unwatch(p)
  for (const p of wanted) {
    if (watchers.has(p)) continue
    let dir: string
    try {
      dir = await repo.gitDir(p)
    } catch {
      continue // missing or broken repo: the dashboard shows the error
    }
    if (!wanted.has(p) || watchers.has(p)) continue // superseded while awaiting
    const ws: FSWatcher[] = []
    try {
      for (const d of [dir, join(dir, 'logs'), join(dir, 'refs', 'heads')]) {
        if (existsSync(d)) ws.push(watch(d, () => notifyChanged(p)).on('error', () => undefined))
      }
      watchers.set(p, ws)
    } catch {
      ws.forEach((w) => w.close())
    }
  }
}

async function addRepos(): Promise<RepoEntry[]> {
  const options: OpenDialogOptions = { title: 'Add git repositories', properties: ['openDirectory', 'multiSelections'] }
  const res = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)
  const added: RepoEntry[] = []
  for (const dir of res.filePaths) {
    const top = await git(dir, ['rev-parse', '--show-toplevel']).catch(() => {
      throw new Error(`This folder is not a git repository: ${dir}`)
    })
    setConfig(addRepo(config, top.trim()))
    added.push(config.repos.find((r) => r.path === top.trim())!)
  }
  return added
}

const handlers: Omit<Api, 'onRepoChanged'> = {
  getConfig: async () => config,
  addRepos,
  removeRepo: async (path) => {
    unwatch(path)
    fetchErrors.delete(path)
    setConfig(removeRepo(config, path))
  },
  setOpenTabs: async (paths) => setConfig({ ...config, openTabs: paths.filter(isRegistered) }),
  summaries: async () =>
    (await repo.mapLimit(config.repos, 6, (r) => repo.summary(r.path))).map((s) => ({ ...s, fetchError: fetchErrors.get(s.path) ?? null })),
  status: forRepo(repo.getStatus),
  log: forRepo((p) => repo.getLog(p)),
  branches: forRepo(repo.getBranches),
  diff: forRepo(repo.getDiff),
  stage: forRepo(repo.stage),
  unstage: forRepo(repo.unstage),
  discard: forRepo(repo.discard),
  applyLines: forRepo(repo.applyLines),
  commit: forRepo(repo.commit),
  lastMessage: forRepo(repo.lastMessage),
  generateMessage: forRepo((p) => generateCommitMessage(p, { model: config.settings.claudeModel, claudePath: config.settings.claudePath || undefined })),
  fetch: forRepo(fetchOne),
  fetchAll,
  pull: forRepo(repo.pull),
  push: forRepo(repo.push),
  switchBranch: forRepo(repo.switchBranch),
  openInCode: forRepo((p) => launch('code', [p], p)),
  openTerminal: forRepo((p) => launch('gnome-terminal', [`--working-directory=${p}`], p).catch(() => launch('x-terminal-emulator', [], p))),
  setWatched
}

for (const name of API_METHODS) {
  const fn = handlers[name] as (...args: unknown[]) => Promise<unknown>
  ipcMain.handle(name, async (_event, ...args: unknown[]): Promise<IpcResult> => {
    try {
      return { ok: true, value: await fn(...args) }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  })
}

function createWindow(): void {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    title: 'GitRep',
    backgroundColor: '#0d0f13',
    autoHideMenuBar: true,
    // Test support: GITREP_HIDDEN=1 keeps the window hidden (end-to-end runs).
    show: !SMOKE && !process.env.GITREP_HIDDEN,
    webPreferences: { preload: join(__dirname, '../preload/index.js'), contextIsolation: true, nodeIntegration: false, sandbox: true }
  })
  win.on('closed', () => {
    win = null
  })
  // A dropped file must not navigate away (the new page would get window.api).
  win.webContents.on('will-navigate', (event) => event.preventDefault())
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) void shell.openExternal(url)
    return { action: 'deny' }
  })
  if (process.env.ELECTRON_RENDERER_URL) void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  else void win.loadFile(join(__dirname, '../renderer/index.html'))
  if (SMOKE) smoke(win)
}

app.on('second-instance', () => {
  if (!win) return
  if (win.isMinimized()) win.restore()
  win.focus()
})

void app.whenReady().then(() => {
  createWindow()
  if (SMOKE) return
  setTimeout(() => void fetchAll(), 15_000)
  setInterval(() => void fetchAll(), 10 * 60_000)
})

app.on('window-all-closed', () => app.quit())
