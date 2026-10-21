import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import { API_METHODS, type Api, type IpcResult } from '../shared/api'

const api = Object.fromEntries(
  API_METHODS.map((name) => [
    name,
    async (...args: unknown[]) => {
      const result = (await ipcRenderer.invoke(name, ...args)) as IpcResult
      if (!result.ok) throw new Error(result.error)
      return result.value
    }
  ])
) as unknown as Api

api.onRepoChanged = (cb) => {
  const handler = (_event: IpcRendererEvent, repo: string) => cb(repo)
  ipcRenderer.on('repo-changed', handler)
  return () => {
    ipcRenderer.removeListener('repo-changed', handler)
  }
}

api.onCloseRequested = (cb) => {
  const handler = () => cb()
  ipcRenderer.on('close-requested', handler)
  return () => {
    ipcRenderer.removeListener('close-requested', handler)
  }
}

contextBridge.exposeInMainWorld('api', api)
