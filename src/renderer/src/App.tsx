import { useCallback, useEffect, useRef, useState } from 'react'
import type { Config, RepoSettingsPatch, Settings } from '../../shared/types'
import { AccountsDialog, type AccountSuggestion } from './AccountsDialog'
import { api } from './api'
import { Dashboard } from './Dashboard'
import { Dialog } from './Dialog'
import { errorText } from './format'
import { Icon, Logo } from './icons'
import { RepoView } from './RepoView'
import { ToastContext, type Notify, type ToastAction, type ToastKind } from './toast'
import { useLeaveGuard } from './unsaved'

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
  const [toasts, setToasts] = useState<Toast[]>([])
  const [closing, setClosing] = useState<string | null>(null)
  const [accounts, setAccounts] = useState<{ suggest: AccountSuggestion | null } | null>(null) // the open Accounts dialog
  const [accountsVersion, setAccountsVersion] = useState(0) // changes when an account is saved or removed: repo views look again
  const openAccounts = useCallback((suggest: AccountSuggestion | null) => setAccounts({ suggest }), [])
  const configRef = useRef<Config | null>(null)
  const queue = useRef<Promise<void>>(Promise.resolve())
  const tabsRef = useRef<HTMLElement>(null)
  const tabOrder = config ? ['dashboard', ...config.openTabs] : []

  // The wheel over the tabs scrolls them sideways; the page keeps a vertical wheel when the list cannot scroll.
  useEffect(() => {
    const el = tabsRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      if (Math.abs(e.deltaX) >= Math.abs(e.deltaY) || el.scrollWidth <= el.clientWidth) return
      e.preventDefault()
      el.scrollLeft += e.deltaY
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [config !== null])

  // The active tab stays visible when it is activated or opened.
  useEffect(() => {
    tabsRef.current?.querySelector('.tab.active')?.scrollIntoView({ inline: 'nearest', block: 'nearest' })
  }, [active, config?.openTabs.length])

  // Ctrl+Tab and Ctrl+Shift+Tab cycle the tabs, Ctrl+1 selects the Dashboard.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.ctrlKey || e.altKey || e.metaKey || document.querySelector('dialog[open], [role="dialog"]')) return
      if (e.key === '1' && !e.shiftKey) setActive('dashboard')
      else if (e.key === 'Tab' && tabOrder.length > 1) setActive(tabOrder[(tabOrder.indexOf(active) + (e.shiftKey ? -1 : 1) + tabOrder.length) % tabOrder.length])
      else return
      e.preventDefault()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

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
  const { guard, guardAll, dialog: leaveDialog } = useLeaveGuard()
  // The window is closing while an editor holds unsaved edits: ask about each, then close.
  useEffect(() => api.onCloseRequested(() => guardAll(() => void api.closeWindow())), [guardAll])
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
  const updateSettings = useCallback(
    (patch: Partial<Settings>) =>
      api.updateSettings(patch).then(
        async () => (await reload(), true),
        (e: unknown) => (notify('error', errorText(e)), false)
      ),
    [reload, notify]
  )

  const updateRepoSettings = useCallback(
    (path: string, patch: RepoSettingsPatch) =>
      api.updateRepoSettings(path, patch).then(
        async () => (await reload(), true),
        (e: unknown) => (notify('error', errorText(e)), false)
      ),
    [reload, notify]
  )

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
          <button className={`tab ${active === 'dashboard' ? 'active' : ''}`} onClick={() => setActive('dashboard')}>
            <Icon name="grid" size={15} /> Dashboard
          </button>
          <nav className="tabs" aria-label="Tabs" ref={tabsRef}>
            {config.openTabs.map((p) => (
              <div key={p} className={`tab ${active === p ? 'active' : ''}`}>
                <button className="tab-label" onClick={() => setActive(p)} title={p}>
                  <span>{nameOf(p)}</span>
                </button>
                <button className="tab-close" aria-label={`Close ${nameOf(p)}`} onClick={() => guard(p, () => setClosing(p))}>
                  <Icon name="close" size={12} stroke={2} />
                </button>
              </div>
            ))}
          </nav>
          <button className="iconbtn" style={{ alignSelf: 'center' }} aria-label="Add repository" title="Add repository" onClick={() => void addRepos()}>
            <Icon name="plus" size={14} stroke={2} />
          </button>
          <button className="iconbtn" style={{ alignSelf: 'center' }} aria-label="Accounts" title="GitLab and GitHub accounts" onClick={() => openAccounts(null)}>
            <Icon name="gear" size={15} />
          </button>
        </header>
        {active === 'dashboard' && <Dashboard repoCount={config.repos.length} onOpen={(p) => void openTab(p)} onAdd={() => void addRepos()} onChanged={() => void reload()} />}
        {config.openTabs.map((p) => (
          <div key={p} className="repo" style={{ display: active === p ? 'flex' : 'none' }}>
            <RepoView path={p} active={active === p} settings={config.settings} entry={config.repos.find((r) => r.path === p)} onSettings={updateSettings} onRepoSettings={updateRepoSettings} accountsVersion={accountsVersion} onAccounts={openAccounts} />
          </div>
        ))}
        {closing && (
          <Dialog
            title={`Close ${nameOf(closing)}?`}
            submit="Close tab"
            onSubmit={() => {
              const p = closing
              setClosing(null)
              void closeTab(p)
            }}
            onClose={() => setClosing(null)}
          >
            <p className="note">The repository stays on the dashboard. You can open it again from there.</p>
          </Dialog>
        )}
        {accounts && <AccountsDialog suggest={accounts.suggest} onChanged={() => setAccountsVersion((n) => n + 1)} onClose={() => setAccounts(null)} />}
        {leaveDialog}
        {toastList}
      </div>
    </ToastContext.Provider>
  )
}
