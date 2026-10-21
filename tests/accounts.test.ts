import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { FAKE_TOKEN, startFakeForge, type FakeForge } from '../e2e/fakeForge'
import { accountFor, listAccounts, plainTokensAllowed, removeAccount, saveAccount, testAccount, type Vault } from '../src/main/accounts'
import { tempDir } from './helpers'

// Reversible stand-in for safeStorage: the stored bytes must not be the token itself.
const vault: Vault = {
  unavailable: () => null,
  encrypt: (t) => Buffer.from([...Buffer.from(t)].reverse()),
  decrypt: (b) => Buffer.from([...b].reverse()).toString()
}

describe('accounts', () => {
  let fake: FakeForge
  beforeAll(async () => {
    fake = await startFakeForge()
  })
  afterAll(() => fake.close())

  it('stores a working token encrypted, per host, and never lists it', async () => {
    const file = join(await tempDir(), 'accounts.json')
    expect(await saveAccount(file, vault, '127.0.0.1', 'gitlab', `${fake.url}/`, FAKE_TOKEN)).toEqual({ host: '127.0.0.1', kind: 'gitlab', url: fake.url, user: 'k.dubois' })
    expect(readFileSync(file, 'utf8')).not.toContain(FAKE_TOKEN)
    expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(listAccounts(file)).toEqual([{ host: '127.0.0.1', kind: 'gitlab', url: fake.url, user: 'k.dubois' }])
    expect(accountFor(file, vault, '127.0.0.1')?.token).toBe(FAKE_TOKEN)
    expect(accountFor(file, vault, 'github.com')).toBeNull()
    expect((await testAccount(file, vault, '127.0.0.1')).user).toBe('k.dubois')
    removeAccount(file, '127.0.0.1')
    expect(listAccounts(file)).toEqual([])
  })

  it('refuses an instance URL that is not the host the account is for', async () => {
    const file = join(await tempDir(), 'accounts.json')
    await expect(saveAccount(file, vault, 'gitlab.example.com', 'gitlab', fake.url, FAKE_TOKEN)).rejects.toThrow('127.0.0.1')
    expect(listAccounts(file)).toEqual([])
  })

  it('stores nothing when the token does not work or cannot be encrypted', async () => {
    const file = join(await tempDir(), 'accounts.json')
    await expect(saveAccount(file, vault, '127.0.0.1', 'gitlab', fake.url, 'bad')).rejects.toThrow('rejected the token (401)')
    expect(listAccounts(file)).toEqual([])
    const locked: Vault = { ...vault, unavailable: () => 'No keyring' }
    await expect(saveAccount(file, locked, '127.0.0.1', 'gitlab', fake.url, FAKE_TOKEN)).rejects.toThrow('No keyring')
    await expect(saveAccount(file, vault, '127.0.0.1', 'gitlab', fake.url, 'two words')).rejects.toThrow('Paste the whole personal access token')
    await expect(saveAccount(file, vault, '-bad host', 'gitlab', fake.url, FAKE_TOKEN)).rejects.toThrow('Invalid host')
    expect(listAccounts(file)).toEqual([])
  })

  it('replaces an existing host, keeps it on a failed save, leaves no tmp file, throws when the vault is locked', async () => {
    const dir = await tempDir()
    const file = join(dir, 'accounts.json')
    await saveAccount(file, vault, '127.0.0.1', 'gitlab', fake.url, FAKE_TOKEN)
    await saveAccount(file, vault, '127.0.0.1', 'gitlab', `${fake.url}/x`, FAKE_TOKEN).catch(() => undefined)
    expect(listAccounts(file)).toHaveLength(1)
    const before = readFileSync(file, 'utf8')
    await expect(saveAccount(file, vault, '127.0.0.1', 'gitlab', fake.url, 'bad')).rejects.toThrow('401')
    expect(readFileSync(file, 'utf8')).toBe(before)
    expect(readdirSync(dir)).toEqual(['accounts.json'])
    expect(() => accountFor(file, { ...vault, unavailable: () => 'No keyring' }, '127.0.0.1')).toThrow('No keyring')
    writeFileSync(`${file}.tmp`, 'stale', { mode: 0o644 })
    await saveAccount(file, vault, '127.0.0.1', 'gitlab', fake.url, FAKE_TOKEN)
    expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(readdirSync(dir)).toEqual(['accounts.json'])
  })

  it('removing an unknown host does not write', async () => {
    const file = join(await tempDir(), 'accounts.json')
    removeAccount(file, 'nope.ch')
    expect(existsSync(file)).toBe(false)
  })

  it('reads a damaged file as no account', async () => {
    const file = join(await tempDir(), 'accounts.json')
    writeFileSync(file, '{not json')
    expect(listAccounts(file)).toEqual([])
    writeFileSync(file, JSON.stringify([{ host: 'x.ch', kind: 'svn', url: 'https://x.ch', token: 'aa' }]))
    expect(listAccounts(file)).toEqual([])
  })
})

describe('plainTokensAllowed', () => {
  it('honours the end-to-end switch only when unpackaged and exactly "1"', () => {
    expect(plainTokensAllowed(false, '1')).toBe(true)
    expect(plainTokensAllowed(true, '1')).toBe(false) // a packaged app ignores it
    for (const v of [undefined, '', '0', 'true', 'yes', ' 1']) expect(plainTokensAllowed(false, v)).toBe(false)
  })
})
