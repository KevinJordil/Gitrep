import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { FAKE_TOKEN, startFakeForge, type FakeForge } from '../e2e/fakeForge'
import { apiBase, checkUrl, currentUser, defaultUrl, forgeKind, forgeRequest, parseRemote } from '../src/main/forge'
import type { AccountInfo } from '../src/shared/types'

describe('parseRemote', () => {
  it('reads scp-like ssh, ssh:// with a port, and https remotes with subgroups', () => {
    expect(parseRemote('git@gitlab.example-company.ch:sensors/fw/sensor-fw.git')).toEqual({ host: 'gitlab.example-company.ch', port: null, scheme: 'https', project: 'sensors/fw/sensor-fw' })
    expect(parseRemote('ssh://git@gitlab.example-company.ch:2222/sensors/sensor-fw.git')).toEqual({ host: 'gitlab.example-company.ch', port: null, scheme: 'https', project: 'sensors/sensor-fw' })
    expect(parseRemote('https://Git.Example.com:8443/a/b/c/')).toEqual({ host: 'git.example.com', port: 8443, scheme: 'https', project: 'a/b/c' })
    expect(parseRemote('https://user@github.com/octo/repo')).toEqual({ host: 'github.com', port: null, scheme: 'https', project: 'octo/repo' })
    expect(parseRemote('http://127.0.0.1:9000/team/alpha.git')).toEqual({ host: '127.0.0.1', port: 9000, scheme: 'http', project: 'team/alpha' })
  })

  it('refuses local paths, file URLs and remotes without a project path', () => {
    expect(parseRemote('/home/k/origin.git')).toBeNull()
    expect(parseRemote('file:///srv/git/a.git')).toBeNull()
    expect(parseRemote('git@host:repo.git')).toBeNull()
    expect(parseRemote('C:\\repos\\a')).toBeNull()
  })
})

describe('parseRemote edge cases', () => {
  it('takes the real host, and refuses odd hosts, bad escapes and drive letters', () => {
    expect(parseRemote('https://gitlab.com@evil.com/a/b')?.host).toBe('evil.com')
    expect(parseRemote('https://evil.com./a/b')).toBeNull()
    expect(parseRemote('https://[::1]/a/b')).toBeNull()
    expect(parseRemote('https://h.ch/a/%zz')).toBeNull()
    expect(parseRemote('ssh://git@host:2222/group/sub/proj.git')).toEqual({ host: 'host', port: null, scheme: 'https', project: 'group/sub/proj' })
    expect(parseRemote('C:repos/a')).toBeNull()
    expect(parseRemote('C:\\repos\\a')).toBeNull()
  })
})

describe('forgeKind', () => {
  it('prefers the user choice, then knows the public forges and gitlab-named hosts', () => {
    expect(forgeKind('github.com', {})).toBe('github')
    expect(forgeKind('gitlab.com', {})).toBe('gitlab')
    expect(forgeKind('gitlab.example-company.ch', {})).toBe('gitlab')
    expect(forgeKind('code.example.com', {})).toBeNull()
    expect(forgeKind('code.example.com', { 'code.example.com': 'github' })).toBe('github')
    expect(forgeKind('mygitlabby.com', {})).toBeNull()
  })
})

describe('instance addresses', () => {
  it('proposes https on the remote host, http only for this computer', () => {
    expect(defaultUrl({ host: 'gitlab.x.ch', port: null, scheme: 'https', project: 'a/b' })).toBe('https://gitlab.x.ch')
    expect(defaultUrl({ host: 'gitlab.x.ch', port: 8080, scheme: 'http', project: 'a/b' })).toBe('https://gitlab.x.ch:8080')
    expect(defaultUrl({ host: '127.0.0.1', port: 9000, scheme: 'http', project: 'a/b' })).toBe('http://127.0.0.1:9000')
  })

  it('accepts https and local http, refuses the rest', () => {
    expect(checkUrl(' https://gitlab.x.ch/gitlab/ ')).toBe('https://gitlab.x.ch/gitlab')
    expect(checkUrl('http://localhost:9000')).toBe('http://localhost:9000')
    expect(() => checkUrl('http://gitlab.x.ch')).toThrow('must start with https://')
    expect(() => checkUrl('https://me:pw@gitlab.x.ch')).toThrow('must not contain')
    expect(() => checkUrl('nope')).toThrow('Not a valid address')
  })

  it('maps the instance to its API', () => {
    expect(apiBase('gitlab', 'https://gitlab.x.ch')).toBe('https://gitlab.x.ch/api/v4')
    expect(apiBase('github', 'https://github.com')).toBe('https://api.github.com')
    expect(apiBase('github', 'https://ghe.x.ch')).toBe('https://ghe.x.ch/api/v3')
  })
})

describe('forge requests', () => {
  let fake: FakeForge
  let gitlab: AccountInfo
  let github: AccountInfo
  beforeAll(async () => {
    fake = await startFakeForge()
    gitlab = { host: '127.0.0.1', kind: 'gitlab', url: fake.url, user: null }
    github = { host: 'localhost', kind: 'github', url: `http://localhost:${fake.port}`, user: null }
  })
  afterAll(() => fake.close())

  it('tests the token on each forge with its own header', async () => {
    expect(await currentUser(gitlab, FAKE_TOKEN)).toBe('k.dubois')
    expect(await currentUser(github, FAKE_TOKEN)).toBe('octo')
    expect(fake.calls.map((c) => c.token)).toEqual([FAKE_TOKEN, FAKE_TOKEN])
  })

  it('turns HTTP errors into messages without the token', async () => {
    const err = await currentUser(gitlab, 'wrong-token').catch((e: Error) => e.message)
    expect(err).toBe('GitLab (127.0.0.1) rejected the token (401): check it in Accounts: 401 Unauthorized')
    expect(err).not.toContain('wrong-token')
    fake.fail.push({ match: '/user', status: 403, message: 'insufficient_scope', times: 1 })
    await expect(currentUser(github, FAKE_TOKEN)).rejects.toThrow('GitHub (localhost) refused the request (403): the token lacks a permission: insufficient_scope')
    await expect(forgeRequest(gitlab, FAKE_TOKEN, 'GET', '/nothing')).rejects.toThrow('not found (404)')
  })

  it('says when the forge cannot be reached', async () => {
    const gone = await startFakeForge()
    await gone.close()
    const off: AccountInfo = { ...gitlab, url: gone.url }
    await expect(currentUser(off, FAKE_TOKEN)).rejects.toThrow('Cannot reach GitLab (127.0.0.1): ECONNREFUSED')
  })
})
