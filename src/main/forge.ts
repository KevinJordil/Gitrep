import type { AccountInfo, ForgeKind } from '../shared/types'

// A git remote on a forge: the host (the key of its account) and the project path (GitLab groups and subgroups, or GitHub owner/repo).
export interface ForgeRemote {
  host: string
  port: number | null // the port of an http(s) remote; ssh ports say nothing about the web address
  scheme: 'https' | 'http'
  project: string
}

const HOST = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/
export const isHost = (h: unknown): h is string => typeof h === 'string' && h.length <= 253 && HOST.test(h)
const LOCAL = new Set(['localhost', '127.0.0.1'])

// git@host:group/sub/project.git, ssh://git@host:2222/group/project.git, https://host:8443/group/project(.git)
export function parseRemote(url: string): ForgeRemote | null {
  const scp = /^(?:[^@/\s]+@)?([^:/\s]{2,}):(?!\/)(.+)$/.exec(url)
  let host: string
  let port: number | null = null
  let scheme: 'https' | 'http' = 'https'
  let path: string
  if (scp && !url.includes('://')) {
    host = scp[1]
    path = scp[2]
  } else {
    let u: URL
    try {
      u = new URL(url)
    } catch {
      return null
    }
    if (!['ssh:', 'git+ssh:', 'https:', 'http:'].includes(u.protocol)) return null
    host = u.hostname
    if (u.protocol === 'http:' || u.protocol === 'https:') {
      port = u.port ? Number(u.port) : null
      scheme = u.protocol === 'http:' ? 'http' : 'https'
    }
    try {
      path = decodeURIComponent(u.pathname)
    } catch {
      return null
    }
  }
  host = host.toLowerCase()
  const project = path.replace(/^\/+|\/+$/g, '').replace(/\.git$/, '')
  if (!isHost(host) || !/^[^/]+(\/[^/]+)+$/.test(project)) return null
  return { host, port, scheme, project }
}

// The user's choice wins; then the public forges and hosts named like a GitLab instance. null: ask the user.
export function forgeKind(host: string, chosen: Record<string, ForgeKind>): ForgeKind | null {
  if (Object.hasOwn(chosen, host)) return chosen[host]
  if (host === 'github.com') return 'github'
  if (host === 'gitlab.com' || host.split('.').some((part) => part === 'gitlab' || part.startsWith('gitlab-'))) return 'gitlab'
  return null
}

// The web address of the instance, as first proposed for a remote (the Accounts dialog lets the user change it).
export function defaultUrl(r: ForgeRemote): string {
  const scheme = r.scheme === 'http' && LOCAL.has(r.host) ? 'http' : 'https'
  return `${scheme}://${r.host}${r.port ? `:${r.port}` : ''}`
}

// Tokens only travel over https; plain http is accepted for this computer only (local instances, tests).
// The host may differ from the remotes' host (an ssh alias from ~/.ssh/config).
export function checkUrl(url: string): string {
  let u: URL
  try {
    u = new URL(String(url).trim())
  } catch {
    throw new Error(`Not a valid address: ${url}`)
  }
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && LOCAL.has(u.hostname))) throw new Error('The instance address must start with https://')
  if (u.username || u.password || u.search || u.hash) throw new Error('The instance address must not contain a user name, a query or a fragment')
  return `${u.origin}${u.pathname.replace(/\/+$/, '')}`
}

export function apiBase(kind: ForgeKind, url: string): string {
  if (kind === 'gitlab') return `${url}/api/v4`
  return url === 'https://github.com' ? 'https://api.github.com' : `${url}/api/v3` // GitHub Enterprise Server
}

const TIMEOUT_MS = 15_000
const NAME = { gitlab: 'GitLab', github: 'GitHub' } as const

function headers(kind: ForgeKind, token: string): Record<string, string> {
  const common = { 'Content-Type': 'application/json', 'User-Agent': 'GitRep' }
  if (kind === 'gitlab') return { ...common, 'PRIVATE-TOKEN': token }
  return { ...common, Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' }
}

// The forge's own explanation, when its error body has one.
function reason(body: unknown): string {
  if (!body || typeof body !== 'object') return ''
  const b = body as Record<string, unknown>
  const parts = [b.message, b.error, b.error_description, ...(Array.isArray(b.errors) ? b.errors.map((e) => (typeof e === 'string' ? e : (e as Record<string, unknown>)?.message)) : [])]
  return parts
    .flatMap((p) => (typeof p === 'string' ? [p] : p && typeof p === 'object' ? Object.entries(p).map(([k, v]) => `${k} ${String(v)}`) : []))
    .filter(Boolean)
    .join('; ')
    .slice(0, 300)
}

// One JSON call to the forge's REST API. The token is only ever sent to the account's own address; errors never contain it.
export async function forgeRequest<T>(account: AccountInfo, token: string, method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
  const name = `${NAME[account.kind]} (${account.host})`
  let res: Response
  try {
    res = await fetch(apiBase(account.kind, account.url) + path, {
      method,
      headers: headers(account.kind, token),
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: 'error', // a redirect could carry the token elsewhere
      signal: AbortSignal.timeout(TIMEOUT_MS)
    })
  } catch (e) {
    const err = e as Error & { cause?: { code?: string; message?: string } }
    if (err.name === 'TimeoutError') throw new Error(`${name} did not answer within ${TIMEOUT_MS / 1000} s`)
    throw new Error(`Cannot reach ${name}: ${err.cause?.code ?? err.cause?.message ?? err.message}`)
  }
  const text = await res.text()
  let json: unknown = null
  try {
    json = text ? JSON.parse(text) : null
  } catch {
    json = null
  }
  if (res.ok) return json as T
  const why = reason(json)
  const detail = why ? `: ${why}` : ''
  if (res.status === 401) throw new Error(`${name} rejected the token (401): check it in Accounts${detail}`)
  if (res.status === 403) throw new Error(`${name} refused the request (403): the token lacks a permission${detail}`)
  if (res.status === 404) throw new Error(`${name}: not found (404), or the token cannot see this project${detail}`)
  if (res.status === 422 || res.status === 400) throw new Error(`${name} refused the data (${res.status})${detail}`)
  throw new Error(`${name} answered ${res.status}${detail}`)
}

// The user name the token belongs to (the connection test).
export async function currentUser(account: AccountInfo, token: string): Promise<string> {
  if (account.kind === 'gitlab') return (await forgeRequest<{ username: string }>(account, token, 'GET', '/user')).username
  return (await forgeRequest<{ login: string }>(account, token, 'GET', '/user')).login
}
