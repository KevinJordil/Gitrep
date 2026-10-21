import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { AccountInfo, ForgeKind } from '../shared/types'
import { checkUrl, currentUser, isHost } from './forge'

// Encryption of the tokens (Electron safeStorage in the app). unavailable(): why tokens cannot be stored, or null.
export interface Vault {
  unavailable(): string | null
  encrypt(text: string): Buffer
  decrypt(data: Buffer): string
}

interface Stored extends AccountInfo {
  token: string // encrypted, base64
}

const MAX_TOKEN = 1000

// The accounts file sits next to config.json but holds only encrypted tokens; a missing or unreadable file is no account.
function load(file: string): Stored[] {
  try {
    const list = JSON.parse(readFileSync(file, 'utf8')) as unknown
    return Array.isArray(list) ? list.filter((a): a is Stored => !!a && isHost(a.host) && (a.kind === 'gitlab' || a.kind === 'github') && typeof a.url === 'string' && typeof a.token === 'string') : []
  } catch {
    return []
  }
}

function save(file: string, list: Stored[]): void {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  rmSync(tmp, { force: true }) // a stale file would keep its own mode
  writeFileSync(tmp, JSON.stringify(list, null, 2), { mode: 0o600 })
  renameSync(tmp, file)
}

const info = ({ host, kind, url, user }: Stored): AccountInfo => ({ host, kind, url, user })

export const listAccounts = (file: string): AccountInfo[] => load(file).map(info)

// The account of a host and its decrypted token, null when none is stored.
export function accountFor(file: string, vault: Vault, host: string): { account: AccountInfo; token: string } | null {
  const a = load(file).find((x) => x.host === host)
  if (!a) return null
  const why = vault.unavailable()
  if (why) throw new Error(why)
  return { account: info(a), token: vault.decrypt(Buffer.from(a.token, 'base64')) }
}

// Tests the token on the forge first: only a token that works is stored, with the user name it belongs to.
export async function saveAccount(file: string, vault: Vault, host: string, kind: ForgeKind, url: string, token: string): Promise<AccountInfo> {
  if (!isHost(host)) throw new Error(`Invalid host: ${host}`)
  if (kind !== 'gitlab' && kind !== 'github') throw new Error(`Unknown forge: ${kind}`)
  const secret = String(token).trim()
  if (!secret || secret.length > MAX_TOKEN || /\s/.test(secret)) throw new Error('Paste the whole personal access token')
  const why = vault.unavailable()
  if (why) throw new Error(why)
  const account: AccountInfo = { host, kind, url: checkUrl(url), user: null }
  if (new URL(account.url).hostname !== host) throw new Error(`The instance URL (${new URL(account.url).hostname}) is not ${host}`)
  account.user = await currentUser(account, secret)
  save(file, [...load(file).filter((a) => a.host !== host), { ...account, token: vault.encrypt(secret).toString('base64') }])
  return account
}

// Runs the connection test again with the stored token and records the user name.
export async function testAccount(file: string, vault: Vault, host: string): Promise<AccountInfo> {
  const found = accountFor(file, vault, host)
  if (!found) throw new Error(`No account for ${host}`)
  const user = await currentUser(found.account, found.token)
  save(file, load(file).map((a) => (a.host === host ? { ...a, user } : a)))
  return { ...found.account, user }
}

export function removeAccount(file: string, host: string): void {
  const list = load(file)
  if (list.some((a) => a.host === host)) save(file, list.filter((a) => a.host !== host))
}

// End-to-end runs start Electron with --password-store=basic and set GITREP_TEST_PLAIN_TOKENS=1 to store tokens anyway.
// A packaged app never honours it: the switch cannot weaken a release.
export const plainTokensAllowed = (packaged: boolean, flag: string | undefined): boolean => !packaged && flag === '1'
