import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

// A local stand-in for the GitLab (/api/v4) and GitHub (/api/v3, Enterprise layout) REST APIs: no real network in tests.
export const FAKE_TOKEN = 'fake-token-123'

export interface FakeMr {
  project: string // group/sub/project
  iid: number
  title: string
  source: string
  target: string
  author: string
  sha: string // head sha; diff_refs.head_sha
  base: string // diff_refs base_sha and start_sha
  fork?: boolean // the source branch lives in a fork
}

export interface FakePr {
  repo: string // owner/repo
  number: number
  title: string
  owner: string // head repository owner
  branch: string
  base: string
  author: string
  sha: string
}

export interface FakeCall {
  method: string
  path: string // without the /api/v4 or /api/v3 prefix, query included
  body: unknown
  token: string
}

export interface FakeForge {
  url: string // http://127.0.0.1:<port>
  port: number
  mrs: FakeMr[]
  prs: FakePr[]
  calls: FakeCall[]
  fail: { match: string; status: number; message: string; times: number }[] // the next `times` calls whose path contains `match` fail
  delay: number // ms each POST waits before it is answered, to look at the screen while posting
  close: () => Promise<void>
}

const send = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(body === undefined ? '' : JSON.stringify(body))
}

const readBody = (req: IncomingMessage) =>
  new Promise<unknown>((resolve) => {
    let data = ''
    req.on('data', (c: Buffer) => (data += c.toString()))
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : null)
      } catch {
        resolve(data)
      }
    })
  })

export async function startFakeForge(): Promise<FakeForge> {
  const forge = { mrs: [], prs: [], calls: [], fail: [], delay: 0 } as unknown as FakeForge
  const server = createServer((req, res) => {
    void (async () => {
      const raw = req.url ?? ''
      const api = /^\/api\/v(3|4)(\/.*)$/.exec(raw)
      if (!api) return send(res, 404, { message: '404 Not Found' })
      const kind = api[1] === '4' ? 'gitlab' : 'github'
      const path = api[2]
      const token = String(kind === 'gitlab' ? req.headers['private-token'] ?? '' : (req.headers.authorization ?? '').replace(/^Bearer /, ''))
      const body = await readBody(req)
      forge.calls.push({ method: req.method ?? '', path, body, token })
      if (req.method === 'POST' && forge.delay) await new Promise((r) => setTimeout(r, forge.delay))
      if (token !== FAKE_TOKEN) return send(res, 401, { message: '401 Unauthorized' })
      const f = forge.fail.find((x) => x.times > 0 && path.includes(x.match))
      if (f) {
        f.times--
        return send(res, f.status, { message: f.message })
      }
      const [pathname, query = ''] = path.split('?')
      const q = new URLSearchParams(query)
      if (pathname === '/user') return send(res, 200, kind === 'gitlab' ? { username: 'k.dubois' } : { login: 'octo' })
      let m: RegExpExecArray | null
      if (kind === 'gitlab') {
        if ((m = /^\/projects\/([^/]+)\/merge_requests$/.exec(pathname)) && req.method === 'GET') {
          const project = decodeURIComponent(m[1])
          const list = forge.mrs.filter((x) => x.project === project && (!q.get('source_branch') || x.source === q.get('source_branch')))
          return send(res, 200, list.map((x) => ({ iid: x.iid, title: x.title, source_branch: x.source, target_branch: x.target, source_project_id: x.fork ? 2 : 1, target_project_id: 1, author: { username: x.author, name: x.author }, web_url: `http://gitlab.test/${project}/-/merge_requests/${x.iid}` })))
        }
        if ((m = /^\/projects\/([^/]+)\/merge_requests\/(\d+)$/.exec(pathname)) && req.method === 'GET') {
          const x = forge.mrs.find((y) => y.project === decodeURIComponent(m![1]) && y.iid === Number(m![2]))
          if (!x) return send(res, 404, { message: '404 Not found' })
          return send(res, 200, { iid: x.iid, title: x.title, source_branch: x.source, target_branch: x.target, sha: x.sha, author: { username: x.author, name: x.author }, web_url: `http://gitlab.test/${x.project}/-/merge_requests/${x.iid}`, diff_refs: { base_sha: x.base, start_sha: x.base, head_sha: x.sha } })
        }
        if (/^\/projects\/[^/]+\/merge_requests\/\d+\/(discussions|notes|draft_notes)$/.test(pathname) && req.method === 'POST') return send(res, 201, { id: forge.calls.length })
        if (/^\/projects\/[^/]+\/merge_requests\/\d+\/draft_notes\/bulk_publish$/.test(pathname) && req.method === 'POST') return send(res, 204, undefined)
      } else {
        if ((m = /^\/repos\/([^/]+\/[^/]+)\/pulls$/.exec(pathname)) && req.method === 'GET') {
          const head = q.get('head') ?? ''
          const list = forge.prs.filter((x) => x.repo === m![1] && (!head || `${x.owner}:${x.branch}` === head) && q.get('state') === 'open')
          return send(res, 200, list.map((x) => ({ number: x.number, title: x.title, user: { login: x.author }, base: { ref: x.base }, head: { ref: x.branch, sha: x.sha }, html_url: `http://github.test/${x.repo}/pull/${x.number}` })))
        }
        if (/^\/repos\/[^/]+\/[^/]+\/pulls\/\d+\/(comments|reviews)$/.test(pathname) && req.method === 'POST') return send(res, pathname.endsWith('comments') ? 201 : 200, { id: forge.calls.length })
      }
      send(res, 404, { message: 'Not Found' })
    })()
  })
  // Every address (IPv4 and IPv6): tests reach it as 127.0.0.1 (GitLab) and as localhost (GitHub).
  await new Promise<void>((resolve) => server.listen(0, resolve))
  forge.port = (server.address() as AddressInfo).port
  forge.url = `http://127.0.0.1:${forge.port}`
  forge.close = () =>
    new Promise((resolve) => {
      server.close(() => resolve())
      server.closeAllConnections() // keep-alive sockets would hold close() open
    })
  return forge
}
