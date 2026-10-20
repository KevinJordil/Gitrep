import { useCallback, useEffect, useRef, useState } from 'react'
import type { Config } from '../../shared/types'
import { api } from './api'
import { Dashboard } from './Dashboard'
import { errorText } from './format'
import { Icon, Logo } from './icons'
import { RepoView } from './RepoView'
import { ToastContext, type Notify, type ToastAction, type ToastKind } from './toast'

interface Toast {
  id: number
  kind: ToastKind
  text: string
  action?: ToastAction
}

let nextToastId = 1

export function App() {
  const [config, setConfig] = useState<Config | null>(null)
  const [active, setActive] = useState('dashboard')
  const [branches, setBranches] = useState<Record<string, string>>({})
  const [toasts, setToasts] = useState<Toast[]>([])
  const configRef = useRef<Config | null>(null)
  const queue = useRef<Promise<void>>(Promise.resolve())

  const dismiss = (id: number) => setToasts((t) => t.filter((x) => x.id !== id))
  // Info toasts go away by themselves; one with a button stays longer so it can be clicked.
  const notify = useCallback<Notify>((kind, text, action) => {
    const id = nextToastId++
    setToasts((t) => [...t.slice(-4), { id, kind, text, action }])
    if (kind === 'info') setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), action ? 10_000 : 5000)
  }, [])

  const reload = useCallback(async () => {
    try {
      const c = await api.getConfig()
      configRef.current = c
      setConfig(c)
    } catch (e) {
      notify('error', errorText(e))
    }
  }, [notify])

  useEffect(() => {
    void reload()
  }, [reload])

  useEffect(() => {
    if (config) api.setWatched(config.openTabs).catch((e: unknown) => notify('error', errorText(e)))
  }, [config, notify])

  // Tab changes run one after another, each computed from the latest config.
  const setTabs = (update: (tabs: string[]) => string[]) => {
    queue.current = queue.current.then(async () => {
      try {
        if (!configRef.current) return
        await api.setOpenTabs(update(configRef.current.openTabs))
        await reload()
      } catch (e) {
        notify('error', errorText(e))
      }
    })
    return queue.current
  }
  const openTab = async (path: string) => {
    await setTabs((tabs) => (tabs.includes(path) ? tabs : [...tabs, path]))
    setActive(path)
  }
  const closeTab = async (path: string) => {
    if (active === path) setActive('dashboard')
    await setTabs((tabs) => tabs.filter((t) => t !== path))
  }
  const addRepos = async () => {
    try {
      const added = await api.addRepos()
      await reload()
      if (added.length === 1) await openTab(added[0].path)
    } catch (e) {
      notify('error', errorText(e))
    }
  }
  const onBranch = useCallback((path: string, label: string) => setBranches((b) => (b[path] === label ? b : { ...b, [path]: label })), [])

  const toastList = (
    <div className="toasts" role="status">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.kind} ${t.action ? 'act' : ''}`}>
          {t.action && <Icon name="check" size={16} stroke={2} />}
          {t.kind === 'error' ? <pre>{t.text}</pre> : <span className="t">{t.text}</span>}
          {t.action && (
            <button
              className="toast-btn"
              onClick={() => {
                dismiss(t.id)
                t.action?.run()
              }}
            >
              {t.action.label}
            </button>
          )}
          <button className="tab-close" aria-label="Dismiss notification" onClick={() => dismiss(t.id)}>
            <Icon name="close" size={12} stroke={2} />
          </button>
        </div>
      ))}
    </div>
  )
  if (!config)
    return (
      <ToastContext.Provider value={notify}>
        <div className="app">{toastList}</div>
      </ToastContext.Provider>
    )
  const nameOf = (p: string) => config.repos.find((r) => r.path === p)?.name ?? p

  return (
    <ToastContext.Provider value={notify}>
      <div className="app">
        <header className="titlebar">
          <div className="brand">
            <Logo /> GitRep
          </div>
          <nav className="tabs" aria-label="Tabs">
            <button className={`tab ${active === 'dashboard' ? 'active' : ''}`} onClick={() => setActive('dashboard')}>
              <Icon name="grid" size={15} /> Dashboard
            </button>
            {config.openTabs.map((p) => (
              <div key={p} className={`tab ${active === p ? 'active' : ''}`}>
                <button className="tab-label" onClick={() => setActive(p)} title={p}>
                  <span>{nameOf(p)}</span>
                  <span className="tab-branch">{branches[p] ?? ''}</span>
                </button>
                <button className="tab-close" aria-label={`Close ${nameOf(p)}`} onClick={() => void closeTab(p)}>
                  <Icon name="close" size={12} stroke={2} />
                </button>
              </div>
            ))}
            <button className="iconbtn" style={{ marginBottom: 3, marginLeft: 4 }} aria-label="Add repository" title="Add repository" onClick={() => void addRepos()}>
              <Icon name="plus" size={14} stroke={2} />
            </button>
          </nav>
        </header>
        {active === 'dashboard' && <Dashboard repoCount={config.repos.length} onOpen={(p) => void openTab(p)} onAdd={() => void addRepos()} onChanged={() => void reload()} />}
        {config.openTabs.map((p) => (
          <div key={p} className="repo" style={{ display: active === p ? 'flex' : 'none' }}>
            <RepoView path={p} active={active === p} onBranch={onBranch} />
          </div>
        ))}
        {toastList}
      </div>
    </ToastContext.Provider>
  )
}
